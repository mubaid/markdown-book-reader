'use strict';

const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

const LIBRARY_DIR = path.join(__dirname, 'library');
const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/;
const SAFE_FILE = /^[A-Za-z0-9._-]+$/;

marked.setOptions({ gfm: true, breaks: false });

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isSafeId(id) {
  return typeof id === 'string' && SAFE_ID.test(id);
}

function isSafeFile(name) {
  return typeof name === 'string' && SAFE_FILE.test(name) && name !== '.' && name !== '..';
}

function bookDir(bookId) {
  return path.join(LIBRARY_DIR, bookId);
}

function readBook(bookId) {
  if (!isSafeId(bookId)) return null;
  try {
    const book = JSON.parse(fs.readFileSync(path.join(bookDir(bookId), 'book.json'), 'utf-8'));
    if (!book || !Array.isArray(book.chapters) || book.chapters.length === 0) return null;
    // The directory is the source of truth for routing, even if book.json was hand-edited.
    book.id = bookId;
    if (typeof book.title !== 'string' || !book.title.trim()) book.title = bookId;
    book.chapters = book.chapters.filter(chapter =>
      chapter && isSafeId(chapter.id) && isSafeFile(chapter.file) && typeof chapter.title === 'string'
    );
    return book.chapters.length > 0 ? book : null;
  } catch {
    return null;
  }
}

function listBooks() {
  let dirs;
  try {
    dirs = fs.readdirSync(LIBRARY_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  return dirs
    .filter(entry => entry.isDirectory() && isSafeId(entry.name))
    .map(entry => readBook(entry.name))
    .filter(Boolean)
    .sort((a, b) => {
      const byDate = String(b.convertedAt || '').localeCompare(String(a.convertedAt || ''));
      return byDate !== 0 ? byDate : String(a.title).localeCompare(String(b.title));
    });
}

function readChapter(book, chapterId) {
  const chapter = book.chapters.find(item => item.id === chapterId);
  if (!chapter) return null;
  const root = bookDir(book.id);
  const filePath = path.resolve(root, chapter.file);
  if (!filePath.startsWith(root + path.sep)) return null;
  try {
    return { chapter, markdown: fs.readFileSync(filePath, 'utf-8') };
  } catch {
    return null;
  }
}

function renderMarkdown(markdown) {
  return marked.parse(markdown);
}

function coverPath(book) {
  if (!book.cover || !isSafeFile(book.cover)) return null;
  const filePath = path.join(bookDir(book.id), book.cover);
  return fs.existsSync(filePath) ? `/${book.id}/${book.cover}` : null;
}

function authorLine(book) {
  const authors = Array.isArray(book.authors) ? book.authors.filter(Boolean).join(', ') : '';
  const year = book.year ? ` · ${book.year}` : '';
  return `${authors || 'Unknown author'}${year}`;
}

// ── Catalog ────────────────────────────────────────────────────────

function renderCatalog(books) {
  const cards = books.map(book => {
    const cover = coverPath(book);
    const coverHtml = cover
      ? `<img src="${esc(cover)}" alt="Cover of ${esc(book.title)}" loading="lazy">`
      : `<span class="cover-fallback" aria-hidden="true">${esc(book.title.slice(0, 1))}</span>`;
    return `      <a class="book-card" href="/${esc(book.id)}/" data-book-id="${esc(book.id)}" data-chapter-count="${book.chapters.length}" data-chapters="${esc(JSON.stringify(book.chapters.map(chapter => chapter.id)))}">
        <div class="book-cover">${coverHtml}</div>
        <div class="book-info">
          <h2>${esc(book.title)}</h2>
          <p class="book-authors">${esc(authorLine(book))}</p>
          <div class="book-progress" aria-hidden="true"><span data-progress-bar></span></div>
          <p class="book-status" data-progress-label>Start reading</p>
        </div>
      </a>`;
  }).join('\n');

  const body = books.length === 0
    ? `<div class="empty-state">
        <h2>Your shelf is empty</h2>
        <p>Drop <code>.epub</code>, <code>.pdf</code>, or <code>.md</code> files into <code>books/</code>, then run:</p>
        <pre><code>npm run convert</code></pre>
        <p>Books you have read show up here with a progress bar.</p>
      </div>`
    : `<div class="book-grid" id="book-grid">\n${cards}\n      </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Library</title>
  <link rel="stylesheet" href="/assets/style.css">
</head>
<body class="catalog-page">
  <header class="catalog-header">
    <h1>Library</h1>
    <p class="catalog-subtitle">${books.length} book${books.length === 1 ? '' : 's'} on the shelf</p>
  </header>
  <main class="catalog-main">
      ${body}
  </main>
  <script src="/assets/app.js"></script>
</body>
</html>`;
}

// ── Reader ─────────────────────────────────────────────────────────

function renderSidebar(book, activeId) {
  const links = book.chapters.map((chapter, index) => {
    const active = chapter.id === activeId ? ' class="active" aria-current="page"' : '';
    return `        <a href="/${esc(book.id)}/${esc(chapter.id)}"${active}><span class="toc-number">${index + 1}</span> ${esc(chapter.title)}</a>`;
  }).join('\n');

  return `      <a href="/" class="logo">Library</a>
      <p class="subtitle">${esc(book.title)}<br><span class="sidebar-authors">${esc(authorLine(book))}</span></p>
      <nav>
${links}
      </nav>`;
}

function renderPagination(book, index) {
  const prev = index > 0 ? book.chapters[index - 1] : null;
  const next = index < book.chapters.length - 1 ? book.chapters[index + 1] : null;
  const prevLink = prev
    ? `<a href="/${esc(book.id)}/${esc(prev.id)}" class="prev">← ${esc(prev.title)}</a>`
    : '<span></span>';
  const nextLink = next
    ? `<a href="/${esc(book.id)}/${esc(next.id)}" class="next">${esc(next.title)} →</a>`
    : '<span></span>';
  return `      <div class="pagination">\n        ${prevLink}\n        ${nextLink}\n      </div>`;
}

function renderReaderPage(book, chapter, index, markdown, options = {}) {
  const contentHtml = renderMarkdown(markdown);
  const entryFlag = options.entry ? ' data-entry="1"' : '';

  return `<!DOCTYPE html>
<html lang="${esc(book.language || 'en')}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(chapter.title)} — ${esc(book.title)}</title>
  <link rel="stylesheet" href="/assets/style.css">
</head>
<body class="reader" data-book-id="${esc(book.id)}" data-chapter-id="${esc(chapter.id)}"
      data-chapter-index="${index}" data-chapter-count="${book.chapters.length}"
      data-chapters="${esc(JSON.stringify(book.chapters.map(item => item.id)))}"${entryFlag}>
  <input type="checkbox" id="sidebar-toggle" class="sidebar-toggle-checkbox">
  <div class="layout">
    <label for="sidebar-toggle" class="hamburger" aria-label="Toggle chapters">☰</label>
    <aside class="sidebar">
${renderSidebar(book, chapter.id)}
    </aside>
    <main>
      <div class="reader-meta">
        <a href="/" class="back-link">← Library</a>
        <span class="chapter-counter">Chapter ${index + 1} of ${book.chapters.length}</span>
        <span class="reader-progress" data-progress-percent>0%</span>
      </div>
      <article>
        ${contentHtml}
      </article>
${renderPagination(book, index)}
    </main>
  </div>
  <script src="/assets/app.js"></script>
</body>
</html>`;
}

module.exports = {
  LIBRARY_DIR,
  isSafeId,
  isSafeFile,
  readBook,
  listBooks,
  readChapter,
  renderCatalog,
  renderReaderPage,
  bookDir,
  esc,
};
