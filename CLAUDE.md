# Movie Vault (Daviscollection)

Single-page app for a private Blu-ray/4K/DVD collection. No build step, no framework, no package.json.

## Files

- `index.html` — all markup, CSS and app JavaScript (~105KB). This is the only file you normally need to read or edit.
- `seed-data.js` — defines `const SEED_DATA` with the 2,300+ title seed collection on one ~420KB line. **Do not read this file** unless the task is specifically about the seed data; it wastes a huge amount of context. To inspect it, use `grep`/`python` on slices instead of reading it whole.

## How it works

- State lives in localStorage under `movieVault.privateCollection.v1`; `seed-data.js` is only used when localStorage is empty (see `loadState`).
- Covers auto-load lazily for visible cards via IntersectionObserver (`setupVisibleCoverAutoload` → `queueAutoCover` → `autoLoadVisibleCover`), querying iTunes, Wikipedia and Wikidata (`lookupSmartCover`). Results are validated with `preloadImage` before saving, and cached in localStorage (`movieVault.smartCoverCache:v7:`).
- Removing a poster sets `posterRemoved:true` on the movie (blocks all auto-loading for it) and records the URL in a per-title reject list (`movieVault.coverRejects:v1:`) so the same wrong cover is never suggested by auto-load again.
- The app must keep working when opened from `file://` or GitHub Pages — keep everything dependency-free and relative.
