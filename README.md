# antirage: X ragebait filter (v0)

Chrome MV3 extension that hides US-politics and ideology bait (minimum wage in dollars, healthcare/taxes, Democrats vs Republicans, capitalism vs socialism, "nobody wants self-driving cars") posted by accounts based outside the US.

How it decides:
1. d1 answers two questions (`config/questions.json`): `us_politics` and `ideology_bait`; topic score = max.
2. Only if the topic score clears the blur threshold, the author's "Account based in" is fetched from X's `AboutAccountQuery` (the profile's About page) using your logged-in session, and cached in IndexedDB for 30 days (1 day when X has no value). X allows ~50 lookups per 15 min; the fetcher spaces requests and waits out the window.
3. Allowed countries (default `United States`, `North America`; editable in settings) → shown. Anywhere else → hidden/blurred. Authors already cached as US-based skip d1 entirely.

X rotates the query id on deploys. If lookups start failing (`stale_query` in the console), open any profile's About page once and the extension learns the new id.

Limitation: d1 only sees post text, so bait that lives entirely in an image is missed.

Original v0 spec (ragebait questions, now replaced): `SPEC.md`.

```
npm install
npm run build      # → dist/
npm test
```

Load: `chrome://extensions` → Developer mode → Load unpacked → `dist/`. Click the toolbar icon for settings (API key, thresholds, seed import, export).

Fixtures: enable "Capture raw timeline responses" in settings, browse x.com, then export "captured responses" and save pieces into `fixtures/` (gitignored except `synthetic-*`).

Eval: export labels from settings, then `npm run eval -- ~/Downloads/labels.jsonl [config.json] [--verbose]` to see how a questions config decides on your labeled posts (d1 answers cached in `.eval-cache.json`).
