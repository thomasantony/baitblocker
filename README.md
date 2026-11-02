# antirage: X ragebait filter (v0)

Chrome MV3 extension that scores x.com posts with Liquid AI d1 and hides or blurs ragebait. See `SPEC.md`.

```
npm install
npm run build      # → dist/
npm test
```

Load: `chrome://extensions` → Developer mode → Load unpacked → `dist/`. Click the toolbar icon for settings (API key, thresholds, seed import, export).

Fixtures: enable "Capture raw timeline responses" in settings, browse x.com, then export "captured responses" and save pieces into `fixtures/` (gitignored except `synthetic-*`).
