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

// Version static asset URLs by mtime so cached CSS/JS is replaced when it changes.
function assetHref(name) {
  try {
    const stat = fs.statSync(path.join(__dirname, 'assets', name));
    return `/assets/${name}?v=${Math.floor(stat.mtimeMs)}`;
  } catch {
    return `/assets/${name}`;
  }
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

function authorSlug(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

function authorNames(book) {
  const names = Array.isArray(book.authors) ? book.authors.filter(Boolean) : [];
  const transliterated = Array.isArray(book.authorsTransliterated) ? book.authorsTransliterated : [];
  return names.map((name, index) => {
    const latin = typeof transliterated[index] === 'string' ? transliterated[index].trim() : '';
    return { name, latin: latin || name };
  });
}

function authorHref(name, latin) {
  return `/author/${authorSlug(latin || name)}`;
}

function authorLine(book) {
  const authors = authorNames(book);
  const names = authors.length
    ? authors
      .map(author => `<a class="author-link" href="${esc(authorHref(author.name, author.latin))}">${esc(author.name)}</a>`)
      .join(', ')
    : 'Unknown author';
  const year = book.year ? ` · ${esc(book.year)}` : '';
  return `${names}${year}`;
}

function findAuthor(slug) {
  if (!isSafeId(slug)) return null;
  let name = null;
  const books = [];
  for (const book of listBooks()) {
    const matched = authorNames(book).find(author => authorSlug(author.latin) === slug);
    if (!matched) continue;
    if (!name) name = matched.name;
    books.push(book);
  }
  return name ? { name, books } : null;
}

// ── Catalog ────────────────────────────────────────────────────────

function renderBookCards(books) {
  return books.map(book => {
    const cover = coverPath(book);
    const coverHtml = cover
      ? `<img src="${esc(cover)}" alt="Cover of ${esc(book.title)}" loading="lazy">`
      : `<span class="cover-fallback" aria-hidden="true">${esc(book.title.slice(0, 1))}</span>`;
    const searchText = [
      book.title,
      book.titleTransliterated,
      book.titleEnglish,
      ...authorNames(book).flatMap(author => [author.name, author.latin]),
    ].filter(Boolean).join(' ');
    return `      <div class="book-card" data-book-id="${esc(book.id)}" data-search="${esc(searchText)}" data-chapter-count="${book.chapters.length}" data-chapters="${esc(JSON.stringify(book.chapters.map(chapter => chapter.id)))}">
        <a class="book-link" href="/${esc(book.id)}/" aria-label="Open ${esc(book.title)}"></a>
        <div class="book-cover">${coverHtml}</div>
        <div class="book-info">
          <h2>${esc(book.title)}</h2>
          <p class="book-authors">${authorLine(book)}</p>
          <div class="book-progress" aria-hidden="true"><span data-progress-bar></span></div>
          <p class="book-status" data-progress-label>Start reading</p>
        </div>
      </div>`;
  }).join('\n');
}

function renderCatalog(books) {
  const body = books.length === 0
    ? `<div class="empty-state">
        <h2>Your shelf is empty</h2>
        <p>Drop <code>.epub</code>, <code>.pdf</code>, or <code>.md</code> files into <code>books/</code>, then run:</p>
        <pre><code>npm run convert</code></pre>
        <p>Books you have read show up here with a progress bar.</p>
      </div>`
    : `<div class="book-grid" id="book-grid">\n${renderBookCards(books)}\n      </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Library</title>
  <link rel="stylesheet" href="${assetHref('style.css')}">
</head>
<body class="catalog-page">
  <header class="catalog-header">
    <h1>Library</h1>
    <p class="catalog-subtitle">${books.length} book${books.length === 1 ? '' : 's'} on the shelf</p>
    <input type="search" id="book-search" class="book-search" placeholder="Search by title or author" aria-label="Search books by title or author" autocomplete="off" spellcheck="false">
  </header>
  <main class="catalog-main">
      ${body}
      <p class="search-empty" id="search-empty" role="status" hidden>No books match your search.</p>
  </main>
  <script src="${assetHref('app.js')}"></script>
</body>
</html>`;
}

// ── Author page ────────────────────────────────────────────────────

function renderAuthorPage(author, books) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(author.name)} — Library</title>
  <link rel="stylesheet" href="${assetHref('style.css')}">
</head>
<body class="catalog-page">
  <header class="catalog-header">
    <p class="catalog-back"><a href="/">← Library</a></p>
    <h1>${esc(author.name)}</h1>
    <p class="catalog-subtitle">${books.length} book${books.length === 1 ? '' : 's'} in the library</p>
  </header>
  <main class="catalog-main">
      <div class="book-grid" id="book-grid">
${renderBookCards(books)}
      </div>
  </main>
  <script src="${assetHref('app.js')}"></script>
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
      <p class="subtitle">${esc(book.title)}<br><span class="sidebar-authors">${authorLine(book)}</span></p>
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
  <link rel="stylesheet" href="${assetHref('style.css')}">
</head>
<body class="reader" data-book-id="${esc(book.id)}" data-chapter-id="${esc(chapter.id)}"
      data-chapter-index="${index}" data-chapter-count="${book.chapters.length}"
      data-chapters="${esc(JSON.stringify(book.chapters.map(item => item.id)))}"${entryFlag}>
  <input type="checkbox" id="sidebar-toggle" class="sidebar-toggle-checkbox">
  <div class="layout">
    <label for="sidebar-toggle" class="hamburger" aria-label="Toggle chapters">☰</label>
    <aside class="sidebar">
      <label for="sidebar-toggle" class="sidebar-close" aria-label="Close chapters">✕</label>
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
  <script src="${assetHref('app.js')}"></script>
</body>
</html>`;
}

module.exports = {
  LIBRARY_DIR,
  isSafeId,
  isSafeFile,
  readBook,
  listBooks,
  findAuthor,
  readChapter,
  renderCatalog,
  renderAuthorPage,
  renderReaderPage,
  bookDir,
  esc,
};
