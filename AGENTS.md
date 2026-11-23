# AGENTS.md

Self-hosted, local-first ebook reader. A Node HTTP server renders Markdown chapters produced by Python converters from EPUB/PDF/Markdown sources. No build step, no database, no framework, one npm dependency (`marked`).

## Commands

```bash
npm install
npm run setup:python        # creates .venv (ebooklib, markdownify, PyMuPDF)
npm run convert             # convert everything in books/ (skips existing)
npm run convert -- books/my-book.epub
npm run convert -- --force  # overwrite library output
npm run serve               # http://localhost:9876 + LAN URL
```

- Requirements: Node >= 20, Python >= 3.10, Linux/macOS. `setup:python` hardcodes `.venv/bin/pip`; the converter falls back to `python3` with a warning if `.venv` is missing.
- `books/` and `library/` are gitignored and ship empty; a fresh clone shows an empty shelf until you add a source and run `npm run convert`.
- There are no test, lint, typecheck, build, or CI scripts. Verify manually by converting a book and loading the affected page/API; do not claim automated tests passed.
- `PORT=9877 npm run serve` / `HOST=127.0.0.1 npm run serve`.
- Editing `server.js` or `book.js` requires restarting `npm run serve`. Editing `assets/*`, `sw.js`, `manifest.webmanifest`, or files under `library/` does not: they are read per request, and asset URLs are cache-busted by mtime.

## Wiring

- `server.js` — GET/HEAD-only router. Routes: `/`, `/assets/*`, `/author/*`, `/favicon.ico`, `/sw.js`, `/manifest.webmanifest`, `/<bookId>/...`, and one API: `GET /api/<bookId>/search?q=`.
- `book.js` — library loading (`readBook`, `listBooks`, `readChapter`) plus every HTML template (`renderCatalog`, `renderAuthorPage`, `renderReaderPage`). `renderMarkdown()` is `marked.parse` plus `wrapTakeaways()`.
- `tools/convert` — Node CLI dispatcher; calls `tools/convert_epub.py`, `convert_pdf.py`, or `convert_md.py` with `--out/--id/--source-file`. Shared Python helpers live in `tools/lib/common.py`.
- `assets/app.js` — catalog + reader core; exposes `window.MBR` (`blocks`, `normalize`, `fnv1a`, `currentTopBlock`, `goToAnchor`, ids). `settings.js` also exposes `window.MBRPanel` / `window.MBRSettingsSync`; `annotations.js` exposes `window.MBRToast`.
- Reader-only scripts load in a fixed order: `settings.js`, `app.js`, `annotations.js`, `search.js`, `tts.js`. Catalog/author pages load only `settings.js` + `app.js`.
- Node code is CommonJS (`"type": "commonjs"`); browser files are classic IIFEs sharing the globals above. No bundler, no ES modules, no build step.
- Search API: `q` must be 2–100 chars, matched literally and case-insensitively; at most 50 chapter results, no index or cache.
- `sw.js` — service worker for offline shell/chapters/images; `manifest.webmanifest` — PWA metadata.

## Invariants

- **Anchors are the data contract.** `app.js` stamps each `p/li/h2/h3/h4/blockquote/pre` with an FNV-1a hash of `normalize(textContent)`. Resume positions and highlights are keyed to those hashes. Never change `normalize()`/`fnv1a()`, and never change a block's `textContent` (wrap text nodes only), or saved state breaks.
- **Chapter ids are stable.** `book.json` chapter `id` must match `^[a-z0-9][a-z0-9-]*$`; chapter `file` must match `^[A-Za-z0-9._-]+$`. Renaming ids loses progress/highlights. The book id is the `library/` directory name; the server overrides `book.json`'s `id` with it.
- **One library format.** All converters must emit the same `book.json` fields (`id`, `title`, `authors`, `year`, `language`, `source`, `cover`, `chapters`, `convertedAt`, `converter`) and Markdown chapter files. Changing the format means updating all three converters and `book.js` together.
- **Keep the duplicate settings bootstrap in sync.** `SETTINGS_BOOTSTRAP` in `book.js` applies theme/font/width before first paint; its rules must match `apply()` in `assets/settings.js`.
- **Server stays read-only.** Only GET/HEAD. New routes must validate ids/files (`isSafeId`, `isSafeFile`, `safeJoin`) and must not add server-side user state.
- **Local-first.** No accounts, telemetry, external APIs/CDNs, or outbound requests; self-host fonts under `assets/fonts/`. New npm/Python dependencies need strong justification.
- Escape all book metadata interpolated into HTML with `esc()`; user input must never become a regex (search is literal substring matching).
- State is per-browser `localStorage`, namespaced `markdown-book-reader:*`; there is no cross-device sync.
- URL conventions: `?goto=<anchor>` beats saved-progress restore; `?tts=1` auto-starts read-aloud on the next chapter.

## Conversion notes

- `npm run convert` is idempotent: an existing `library/<id>/book.json` is skipped. `--force` replaces converter output and destroys hand edits; avoid it on edited books.
- Book id = slug of source filename/folder; a short hash suffix avoids collisions with a different source. A folder with 2+ direct `.md` files is one book; a loose `.md` is one book split on headings.
- `book.json` is hand-editable and re-read per request. Optional `titleTransliterated`, `titleEnglish`, and `authorsTransliterated` fields feed shelf search/author links.
- Converter flags: `--force`, `--no-images`, `--no-cover`.

## PWA / caching gotchas

- `assetHref()` appends `?v=<mtime>`; the SW strips `v` when building `/assets/*` cache keys. Add new static assets to `SHELL_URLS` in `sw.js` if they must work offline.
- Bump `VERSION` in `sw.js` when shell logic or precache contents change. `sw.js` is served with `no-store` and `Service-Worker-Allowed: /`.
- `/api/*` is network-only in the SW; offline search must surface an explicit message instead of spinning.
- Offline caching only works in a secure context (HTTPS or localhost); plain `http://` LAN gets no service worker. To test a PWA update, reload twice or unregister the SW in DevTools.

## Don't commit

- `books/*` and `library/*` — gitignored; copyrighted book files and generated output.
- `IMPLEMENTATION-PLAN.md` — untracked local planning doc; the file itself says not to commit it.
- `node_modules/`, `.venv/`, `__pycache__/`.

`README.md` covers user-facing behavior, setup, and known limitations; this file covers engineering invariants.
