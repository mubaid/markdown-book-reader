# 📚 markdown-book-reader

**Your books. Your server. Your phone.**

Turn your EPUB, PDF, and Markdown books into a clean, phone-friendly reading website that runs entirely on your own machine. No cloud. No accounts. No API keys. No telemetry. Just you and your library, on any device on your Wi-Fi.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](package.json)
[![Python](https://img.shields.io/badge/python-%E2%89%A53.10-3776AB?logo=python&logoColor=white)](requirements.txt)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

---

## Why this exists

E-book apps want your library in their cloud, your reading habits in their analytics, and your money every month. Meanwhile the best reading device you own — your phone — is one browser tab away from your own server.

**markdown-book-reader** converts your DRM-free books into plain Markdown chapters and serves them as a fast, responsive website. Every book remembers the *exact paragraph* you stopped at. Everything is a file you can open, edit, and back up. If this project disappeared tomorrow, your library would still be readable in any text editor.

## Features

- 📖 **Three formats in, one library out** — EPUB, PDF, and native Markdown (single files or folders of chapters) all become the same clean chapter format.
- 🎯 **Paragraph-precise resume** — progress is anchored to a hash of the paragraph's text, not a scroll offset. Reconvert a book and your place survives.
- 📱 **Phone-first reader** — sidebar table of contents, prev/next chapter navigation, readable typography, progress percentage, dark-mode-friendly CSS.
- 🖼️ **A real shelf** — cover thumbnails, per-book progress bars, "continue reading" cards sorted by what you read last, author names that open a page with all of their books, and instant search by title or author.
- 🔒 **100% local & offline** — the server binds to your LAN; nothing leaves your network. Progress lives in your browser's `localStorage`.
- ✍️ **Hand-editable everything** — chapters are Markdown, metadata is JSON. Fix a bad conversion with any editor; changes appear on the next page load.
- 🔤 **Reading comfort** — in-app controls for theme (Auto/Light/Sepia/Dark/OLED), font size, typeface, and text width; saved per browser and applied before first paint.
- 🖍️ **Highlights & bookmarks** — select text to highlight in three colors, add notes, and jump back from the sidebar tabs. Highlights are anchored to paragraph text hashes, so they survive reconversion. Export all highlights as Markdown.
- 🔍 **In-book search** — full-text search across every chapter of a book with snippets and match counts; results jump to the exact paragraph and mark matches in the page.
- 🔊 **Read-aloud** — text-to-speech from your current paragraph, following along across paragraphs and chapters with auto-scroll. Voice and rate are configurable. See [Read-aloud limits](#read-aloud-limits).
- 🏷️ **Shelf tags & filters** — tag books, filter by status (Unread/Reading/Finished) and tags, sort by recency, title, author, or date added.
- 📲 **Install as an app** — PWA with offline reading: every chapter you open is cached, the next chapter is quietly cached too, and an **Offline** button in the reader makes a whole book readable in airplane mode. Offline caching needs HTTPS or `localhost` (a browser security rule); on plain `http://` LAN addresses the app still installs, but offline caching is unavailable.
- 🪶 **Tiny footprint** — one Node dependency (`marked`) and three Python converters. No database, no build step, no framework.

## Quickstart

Requirements: **Node.js 20+**, **Python 3.10+**, Linux or macOS.

```bash
git clone https://github.com/mubaid/markdown-book-reader.git
cd markdown-book-reader
npm install
npm run setup:python        # creates .venv with ebooklib, markdownify, PyMuPDF

# drop your .epub / .pdf / .md files into books/, then:
npm run convert
npm run serve
```

The server prints both addresses:

```
Library: http://localhost:9876
  phone: http://192.168.0.175:9876
```

Open the **phone** URL on any device on the same Wi-Fi. That's it — no signup, no config.

> Port already taken? `PORT=9877 npm run serve`

## Adding books

Drop `.epub`, `.pdf`, and/or `.md` files anywhere under `books/` (subfolders are fine) and run `npm run convert`. Each book becomes:

```
library/<book-id>/
  book.json               # title, authors, chapter order
  00-chapter-title.md     # one Markdown file per chapter
  01-next-chapter.md
  cover.jpg               # catalog thumbnail
  assets/                 # images extracted from the book
```

Already-converted books are skipped; re-run with `--force` after a book updates. Your saved reading position survives reconversion because anchors are based on paragraph text, not block numbers.

Convert a single source:

```bash
npm run convert -- books/my-book.epub
npm run convert -- books/My-Novel.md
npm run convert -- books/my-novel/      # folder of .md chapters
```

| Flag | Effect |
| --- | --- |
| `--force` | Reconvert books that already exist in `library/` |
| `--no-images` | Skip EPUB image extraction and Markdown image copying |
| `--no-cover` | Skip cover extraction/rendering/detection |

### Markdown novels

Two layouts, side by side with EPUB/PDF:

```text
books/My-Novel.md          # one file; split on its # or ## headings
books/My-Novel/            # one folder per book; each .md file is one chapter
  01-chapter-one.md
  02-chapter-two.md
```

- A folder with two or more direct `.md` files is **one book**, sorted naturally by filename (`2.md` before `10.md`).
- A loose `.md` file is **one book**, split on headings: one `#` plus two or more `##` uses the `#` as the book title and each `##` as a chapter; two or more `#` headings split on those. No usable headings → the whole file becomes a single chapter.
- Substantial preamble before the first chapter is kept as a "Front Matter" chapter.
- Relative `.md` links between chapter files are rewritten to the generated chapter IDs, so links keep working in the reader.
- Local images are copied into `assets/` with paths rewritten (`--no-images` keeps only the alt text).

Optional YAML front matter in the first file (or the single file):

```markdown
---
book_title: My Novel
author: Jane Doe
year: 2024
language: en
cover: cover.jpg
---
```

`title` is used per chapter in a folder book. For a single file, `book_title` (or `title`) overrides the heading-derived title. A byline like `Title - By Author` is split automatically when no front matter is present.

## Reading

| URL | What you get |
| --- | --- |
| `/` | Shelf of books with covers and progress bars, most recently read first |
| `/author/<author-slug>` | Every book by one author (e.g. `/author/anthony-david-adams`) |
| `/<book-id>/` | Opens your saved chapter automatically |
| `/<book-id>/<chapter-id>` | A chapter with sidebar contents and prev/next |

### How resume works

The browser stores progress in `localStorage` under `markdown-book-reader:progress:<book-id>`:

```json
{
  "chapterId": "02-chapter-2",
  "chapterIndex": 2,
  "anchor": "g3g8c7",
  "chapterFraction": 0.42,
  "bookFraction": 0.2,
  "updatedAt": 1760000000000
}
```

The chapter is restored first, then the paragraph whose normalized-text hash matches `anchor`. If a reconversion changes that paragraph, it falls back to the saved scroll fraction. Each book has its own key. Progress is per-browser and per-device — it does not sync between your phone and laptop (see [Roadmap](#roadmap)).

## Hand-editing

Everything in `library/` is plain files, so you can fix anything the converters get wrong:

- Edit chapter `.md` files — changes appear on the next page load, no rebuild or restart.
- Edit `book.json` to correct titles, authors, or chapter order.
- Keep chapter `id` values stable; saved resume positions refer to them.

Don't run `--force` on a book you've hand-edited unless you want the converter output to replace your edits. Without `--force`, existing books are left untouched.

## How it works

```
books/                ┌──────────────┐      library/<id>/           ┌───────────┐
  *.epub   ──────────▶│ convert_epub │──┐     book.json             │  Node HTTP │──▶ phone / laptop
  *.pdf    ──────────▶│ convert_pdf  │──┼──▶  NN-chapter.md  ──────▶│  + marked  │    browser reader
  *.md     ──────────▶│ convert_md   │──┘     cover.jpg, assets/    └───────────┘
                      └──────────────┘                                   │
                       Python, offline                          localStorage resume
```

All three converters emit the **same intermediate format** (`book.json` + chapter Markdown), so the server and reader are completely format-agnostic.

```
assets/           reader CSS and JS (resume + progress logic)
tools/convert     CLI dispatcher (Node)
tools/*.py        EPUB / PDF / Markdown converters
tools/lib/        shared Python helpers
book.js           library loading + HTML templates
server.js         HTTP server
```

## Limitations

- **EPUB DRM is not supported** — only DRM-free files you own.
- PDF extraction is text-first: equations and complex tables come out as plain text. Scanned PDFs need OCR before conversion.
- PDF images are not extracted (EPUB and Markdown images are).
- Two-column PDFs use a left-then-right reading-order heuristic; unusual layouts may need hand-editing.
- PDF chapter boundaries rely on the PDF's table of contents first, then font-size/heading detection.
- Markdown splitting needs consistent ATX headings (`#`, `##`) outside code fences.
- Markdown front matter is a simple `key: value` parser, not full YAML.
- Offline caching (service worker) only registers in a secure context: HTTPS or `localhost`. Browsers refuse service workers on plain `http://` LAN IPs, so phone offline reading needs a reverse proxy with TLS (or a tunnel) in front of the server.

### Read-aloud limits

Read-aloud uses the browser's built-in speech synthesis. It works while the screen is on; mobile browsers may suspend speech when the screen locks or the tab goes to the background (iOS Safari is the strictest). Voice quality depends on the voices your browser provides — Android Chrome and iOS Safari ship different sets. If your browser has no speech synthesis, the read-aloud buttons don't appear at all.

## Troubleshooting

**`No module named ebooklib` / `markdownify`** — run `npm run setup:python`, or check that `.venv/bin/python` exists.

**`Port 9876 is already in use`** — `PORT=9877 npm run serve`.

**A chapter 404s after renaming files** — re-run `npm run convert -- --force` or restore the file name recorded in `book.json`.

**Resume lands at the top** — the paragraph changed after reconversion, or `localStorage` was cleared. The scroll-fraction fallback is intentionally rough.

**Phone can't reach the server** — both devices must be on the same Wi-Fi; check your firewall allows inbound TCP on the port. Some routers isolate Wi-Fi clients ("AP isolation") — disable it or use a hotspot.

## Roadmap

Ideas, not promises — PRs welcome:

- [ ] PDF image extraction
- [ ] Optional OCR pass for scanned PDFs
- [ ] Cross-device progress sync (still local-first)
- [ ] Full YAML front matter support

## Contributing

Contributions are welcome! Fork the repo, create a branch, and open a pull request.

1. Keep it local-first: no cloud services, no accounts, no telemetry.
2. Keep the footprint small: new dependencies need a strong justification.
3. The converters must keep emitting the same `book.json` + Markdown format — the reader stays format-agnostic.
4. Test with a real book (EPUB *and* PDF if you touch conversion), and don't commit copyrighted book files — `books/` and `library/` are gitignored for exactly that reason.

## License

[MIT](LICENSE) © 2026 Mohamed Ubaid. Use it, fork it, ship it — just keep the copyright notice.

**Note:** this tool is for books you legally own. It does not strip DRM and ships with no book content.