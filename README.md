# antirage

A personal Chrome extension for x.com. It hides US-politics and ideology bait posted by accounts based outside the US: the minimum wage in dollars, US healthcare and taxes, Democrats vs Republicans, capitalism vs socialism, "nobody wants self-driving cars", and similar engagement farming.

It is not published on the Chrome Web Store. You build it from source and load it as an unpacked extension (steps below).

## Install in Chrome

You need:

- **Chrome** (or another Chromium browser such as Edge, Brave or Arc).
- **Node.js** (a recent LTS release) and **git**, to build the extension.
- A **Liquid AI API key** for the d1 decision model. Create one from Liquid AI's developer docs at [docs.liquid.ai](https://docs.liquid.ai). Billing is per input token; see [liquid.ai/pricing](https://www.liquid.ai/pricing).
- To be **logged in to x.com** in that browser. Country lookups use your X session.

Steps:

1. Get the code and build it:

   ```bash
   git clone <this repository's URL> antirage
   cd antirage
   npm install
   npm run build
   ```

   This creates a `dist/` folder, which is the extension.

2. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, and choose the `dist/` folder.

3. Click the extension's toolbar icon (pin it from the puzzle-piece menu if it is hidden). The settings page opens. Paste your Liquid API key and click **Save**.

4. Open or reload x.com. Posts are dimmed briefly while they are scored, then shown, blurred, or collapsed into a one-line "Hidden" bar with a **show** button.

### Updating

```bash
git pull
npm install
npm run build
```

Then click the reload icon on the extension's card in `chrome://extensions` and reload any open x.com tabs.

### Uninstalling

Click **Remove** on the extension's card in `chrome://extensions`. That deletes its settings and cached data.

### Permissions and privacy

- `x.com`: reads the timeline data X already sends your browser, and looks up authors' "Account based in" with your session (the same request X's "About this account" page makes).
- `api.liquid.ai`: post text and attached photos are sent to Liquid AI's d1 API for scoring, with your API key.
- `pbs.twimg.com`: downloads attached photos so they can be sent to d1.
- `storage`: settings, your API key, and caches stay in the browser. Nothing else leaves it, and the extension never posts, likes, mutes or blocks on X.

## Settings

- **d1 API key, model and daily token budget.** Scoring stops for the day once the budget is used up, and posts are shown unscored.
- **Countries never filtered.** Defaults to `United States, North America`, matching what X shows on About pages.
- **Thresholds.** Defaults: hide at 0.8 or above, blur from 0.5.
- **UI toggles**: dim while scoring, hide, blur, the flag button on shown posts, and whether attached photos are sent.
- **Seed blocked accounts**: import handles (JSON or CSV) whose posts are always hidden.
- **Export** of your labels and cached authors, for tuning.

## How it decides

1. **Topic.** d1 answers two yes/no questions about each post's own text and photos (`config/questions.json`):
   - `us_politics`: US politics or economics written as if the author lives in the US.
   - `ideology_bait`: a sweeping, slogan-style take on capitalism, socialism, the rich, or modern technology.

   The topic score is the higher of the two.
2. **Country.** Only when the topic score reaches the blur threshold, the extension looks up the author's "Account based in" (X's `AboutAccountQuery`). Results are cached for 30 days, or 1 day when X has no value. X allows about 50 lookups per 15 minutes, so requests are spaced out and pause when the limit is close.
3. **Decision.** Authors based in an allowed country are shown. Anywhere else, the post is hidden or blurred by its topic score. Authors already cached as US-based skip d1 entirely.

**Photos.** Up to 2 of a post's own photos are sent to d1 as 360×360 JPEGs, which is enough for it to read text in an image. That costs about 180 extra input tokens per photo. Videos and GIFs are not scored.

**Quote posts.** The quoted post is scored on its own (its text, photos and author's country), and the quoting post is scored without it.

- If only the quote is bait, just the embedded quote box is blurred. The quoting post stays visible.
- If the quoting post endorses a bait quote ("this 👆 so true", "💯"), it is treated as bait too. This takes one extra single-question d1 call (`stance` in `config/questions.json`), made only when the quote scored as bait. At 0.8 or above, the quoting post inherits the quote's score, and its own author's country decides.
- A reply that pushes back on a bait quote ("engagement bait, don't reply") is shown unless its own words reach the hide threshold.

## Troubleshooting

- **Nothing happens.** Check that the API key is saved, that you are logged in to x.com, and that you reloaded the tab after installing or updating.
- **Posts stay dimmed for a long time.** The country lookup limit is probably used up. It resets within 15 minutes, and cached authors are not looked up again.
- **Country lookups fail.** X changes the lookup request's id when it deploys. Open any profile's "About this account" page once and the extension picks up the new id. The page console shows `[rbf] country lookup failed … stale_query` while this is the cause.

## Development

```bash
npm run watch      # rebuild dist/ on change
npm test           # vitest
npm run typecheck
```

Fixtures: enable "Capture raw timeline responses" in settings, browse x.com, export "captured responses", and save pieces into `fixtures/` (gitignored except `synthetic-*`).

Eval: export labels from settings, then run `npm run eval -- ~/Downloads/labels.jsonl [config.json] [--verbose]` to see how a questions config decides on your labeled posts. d1 answers are cached in `.eval-cache.json`, and the key is read from `$LIQUID_API_KEY` or `liquid_token.txt`.

`SPEC.md` is the original v0 spec, from when the extension scored general ragebait; its questions have since been replaced.
