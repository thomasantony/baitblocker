# X Ragebait Filter: v0 Implementation Spec

Build a personal Chrome extension (Manifest V3) that scores posts on x.com with a hosted decision model (Liquid AI d1), hides or blurs ragebait and racist content, and records passive feedback for later tuning. Single user, no backend.

## Ground rules for the implementing agent

- Two external interfaces are only partly known. **Verify before coding against them**:
  1. **d1 API.** Secondary sources say the endpoint is `POST https://api.liquid.ai/decisions/v1/systemone`, with model IDs `d1` / `d1.1`. It takes text plus typed questions (yes/no, choice, score) and returns calibrated probabilities instead of generated text. Find Liquid AI's official docs for the request/response schema, auth header, and batching limits. If you can't reach the docs, stop and ask; do not guess the schema.
  2. **X's internal timeline JSON.** Field paths drift. Capture real responses from a logged-in session into `fixtures/` and write the parser against those.
- Keep all code behind small interfaces (`ScoringClient`, `TimelineParser`) so d1 can be swapped for a local model or another API later.
- No network calls except to `api.liquid.ai`. No automated blocking, muting, or posting on X in v0.

## Non-goals (do not build in v0)

Learned combiner, rubric optimizer, local inference, embeddings, account-country lookup, harvesting posts from blocked profiles, auto-mute/block, crowdsourcing, Firefox/Android.

## Stack

TypeScript, esbuild (or Vite) bundling to `dist/`, Vitest for tests. IndexedDB through the small `idb` wrapper; no other runtime dependencies.

## Files

```
manifest.json
src/inject.ts        MAIN-world script: wraps fetch/XHR, parses timeline responses
src/content.ts       isolated-world content script: DOM matching, UI states, label capture
src/background.ts    service worker: queue, d1 calls, cache, author scores, storage
src/parser.ts        TimelineParser: response JSON -> Post[]
src/scoring.ts       ScoringClient interface + D1Client implementation
src/combine.ts       question probabilities -> single score + decision
src/db.ts            IndexedDB schema and helpers
src/options.html/.ts settings, seed import, export
config/questions.json
fixtures/            captured X responses (gitignored if they contain personal data)
test/                parser, combine, db tests
```

`manifest.json` essentials:
- `content_scripts`: `inject.js` with `"world": "MAIN"` and `content.js` (isolated world), both at `document_start` on `https://x.com/*`.
- `host_permissions`: `https://x.com/*`, `https://api.liquid.ai/*`.
- `permissions`: `storage`.

## Data flow

1. **Intercept (`inject.ts`).**
   - Wrap `window.fetch` and `XMLHttpRequest`. For responses whose URL matches X's GraphQL timeline operations (`HomeTimeline`, `HomeLatestTimeline`, `TweetDetail`, `UserTweets`, `SearchTimeline`), clone the body and parse it.
   - Forward `Post[]` to `content.ts` via `window.postMessage` with a namespaced type.
   - Never block or alter X's own response.
2. **Parse (`parser.ts`).** Walk the JSON recursively and collect every object with `__typename === "Tweet"` (also unwrap `TweetWithVisibilityResults`). Extract:
   - `id`: `rest_id`
   - `text`: `note_tweet.note_tweet_results.result.text` if present (long posts), else `legacy.full_text`
   - `author`: screen name, checking both `core.user_results.result.core.screen_name` and `core.user_results.result.legacy.screen_name`
   - `quotedText`: same extraction on `quoted_status_result.result`
   - `isReply`: `legacy.in_reply_to_status_id_str` present

   Deduplicate by `id`. Every missing field is tolerated, never thrown. Fallback: if a post appears in the DOM but never came through the parser, scrape its text from `[data-testid="tweetText"]`.
3. **Score (`background.ts`).**
   - Check the cache; skip known IDs.
   - Posts by seeded authors are decided as `hide` without calling d1.
   - Otherwise queue, batch (size per d1 docs; flush every ~300 ms or at batch size), and send post text + quoted text to d1 with the questions from `config/questions.json`.
   - Store per-question probabilities, the combined score, and the decision. Return the decision to the tab.
4. **Combine (`combine.ts`).** Use the formula and thresholds in `questions.json`, with no learning in v0.
5. **Render (`content.ts`).**
   - Match DOM `article` elements to post IDs via the `a[href*="/status/"]` link inside the post's timestamp.
   - X virtualizes the timeline and recycles elements, so use a `MutationObserver` and re-apply state by post ID on every mutation, and remove stale state from recycled elements.
6. **Record.** All feedback goes to IndexedDB (schema below).

## Questions and combiner (`config/questions.json`)

```json
{
  "version": 1,
  "questions": [
    { "id": "outgroup_contempt", "text": "Does this post portray a group of people (by race, nationality, religion, politics, or gender) as contemptible, subhuman, or a threat?" },
    { "id": "slurs", "text": "Does this post contain slurs or dehumanizing language about a group?" },
    { "id": "provocation", "text": "Is this post engineered to provoke angry replies or quote-posts, such as a deliberately inflammatory or wrong take?" },
    { "id": "fabricated", "text": "Does this post make an inflammatory claim that is unsourced, unfalsifiable, or likely fabricated?" },
    { "id": "engagement_bait", "text": "Is this a culture-war engagement prompt (\"who agrees?\", \"thoughts?\", polls about groups) rather than information or genuine discussion?" }
  ],
  "combine": {
    "max_of": ["slurs", "outgroup_contempt"],
    "weighted": { "provocation": 0.5, "engagement_bait": 0.3, "fabricated": 0.2 }
  },
  "thresholds": { "hide": 0.85, "blur": 0.4 }
}
```

`score = max(p[max_of...], sum(w_i * p_i for weighted))`. Decision: `hide` if score ≥ hide, `blur` if ≥ blur, else `show`. Thresholds must be editable in options.

## UI states

- **unscored:** opacity 0.5 until the decision arrives. No layout shift.
- **hide:** collapse to a one-line bar: `Hidden · ragebait 0.91 · @handle · [show]`. Name the top-scoring question instead of "ragebait" when it is `slurs` or `outgroup_contempt`.
- **blur:** CSS blur on the post body with an overlay of three buttons: `ragebait`, `racist`, `fine`. Clicking any button records a label and unblurs.
- **show:** untouched, plus a small hover-only flag button to label a missed post `ragebait` / `racist`.
- Every hidden or blurred post's bar shows the author's running score (below).

## Storage (IndexedDB, database `rbf`, version 1)

| Store | Key | Fields |
| --- | --- | --- |
| `posts` | `id` | `text`, `quotedText`, `author`, `seenAt`, `probs` (question id → p), `score`, `decision`, `questionsVersion` |
| `labels` | auto | `postId`, `label` (`ragebait` / `racist` / `fine`), `source` (`user_button`, `show_click`, `account_seed`), `at` |
| `authors` | `handle` | `alpha`, `beta`, `seeded` (bool), `seedText`, `postsSeen` |

- **Author score:** a Beta-distribution running estimate. Start each author at `alpha = 1`, `beta = 1`; after each scored post add `score` to `alpha` and `1 - score` to `beta`. Display `alpha / (alpha + beta)`. No automatic action based on it in v0.
- **`show_click`:** clicking `show` on a hidden post records `label: "fine"` with `source: "show_click"`, a weak false-positive signal.

## Options page

- d1 API key: stored in `chrome.storage.local`, never logged.
- Thresholds and a toggle per UI state.
- Daily token budget (default 1M input tokens). When exceeded, stop scoring and show posts unscored.
- **Seed import:** paste JSON in the form `[{ "handle": "...", "text": "..." }]` produced by the block-list scroll script. Upsert each into `authors` with `seeded: true`.
- **Export:** download `labels.jsonl` (each label joined with its post record) and `authors.jsonl`.
- Stats: posts scored today, tokens used, counts per decision.

## Tests

- **Parser:** against captured fixtures (at least `HomeTimeline`, `TweetDetail` with quotes and replies, and one long post). Assert IDs, text, author, and quoted text. Include a fixture with missing fields.
- **Combine:** threshold edges and the max-vs-weighted logic.
- **Scoring:** the D1 client behind a mock; test batching, cache hits, budget cutoff, and the seeded-author short-circuit.

## Acceptance criteria

1. Load unpacked, set the API key, open the home timeline. Posts get decisions within ~1 s, with no visible layout jump.
2. Scrolling far down and back up keeps the correct state on every post: no state leaking onto recycled elements.
3. Reloading the page re-uses cached decisions without calling d1.
4. Seeded authors' posts are hidden (e.g., in quotes or replies) with zero d1 calls.
5. Labels from all three sources appear in the export.
6. Breaking X's JSON (e.g., renaming a field in a fixture) degrades to the DOM fallback rather than crashing.

## Planned next steps (context only, do not build)

- **v0.1:** fit a logistic-regression combiner over the question probabilities from the stored labels, replacing the hand weights.
- **v0.2:** an offline Python script that reads `labels.jsonl` and runs a rubric-optimization loop (LLM proposes question rewrites, d1 scores them on dev/holdout) to emit a new `questions.json`.
- **v0.3:** a background-tab harvester for posts from seeded (blocked) authors, rate-limited to about one profile per minute.
