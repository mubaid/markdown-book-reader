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

// FOUC guard: applies theme/font/width settings before first paint.
// Keep in sync with apply() in assets/settings.js.
const SETTINGS_BOOTSTRAP = `<script>(function(){try{var raw=localStorage.getItem('markdown-book-reader:settings');var s=raw?JSON.parse(raw):{};var r=document.documentElement;var themes=['auto','light','sepia','dark','oled'];r.dataset.theme=themes.indexOf(s.theme)>=0?s.theme:'auto';r.dataset.font=s.fontFamily==='sans'?'sans':'serif';if(s.fontSize)r.style.setProperty('--reader-font-size',s.fontSize+'px');if(s.contentWidth)r.style.setProperty('--content-max',s.contentWidth+'px');if(s.fontFamily==='sans')r.style.setProperty('--reader-font',"-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif");}catch(e){document.documentElement.dataset.theme='auto';}})();</script>`;

const SETTINGS_BUTTON = '<button class="meta-button" type="button" data-settings-toggle aria-label="Text settings">Aa</button>';

// PWA head links, identical on every page type.
const PWA_HEAD = '<meta name="theme-color" content="#faf9f6">\n  '
  + '<link rel="manifest" href="/manifest.webmanifest">\n  '
  + '<link rel="apple-touch-icon" href="/assets/icons/apple-touch-icon.png">';

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

// Wrap a "Key Takeaways" section (its heading through the next heading of
// the same or higher level, or end of chapter) in a styled callout container.
// No match → html unchanged. Headings inside blockquotes are skipped so the
// wrapper can never cut across another element's closing tag.
function wrapTakeaways(html) {
  const headingRe = /<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/g;
  const headings = [];
  let match;
  while ((match = headingRe.exec(html)) !== null) {
    headings.push({
      level: Number(match[1]),
      start: match.index,
      end: headingRe.lastIndex,
      text: match[3].replace(/<[^>]*>/g, ''),
    });
  }
  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i];
    if (!/^\s*(?:★\s*)?(?:\d+[.):-]\s*)?key takeaways\s*$/i.test(heading.text)) continue;
    const before = html.slice(0, heading.start);
    const opens = (before.match(/<blockquote/g) || []).length;
    const closes = (before.match(/<\/blockquote>/g) || []).length;
    if (opens !== closes) continue;
    let stop = html.length;
    for (let j = i + 1; j < headings.length; j += 1) {
      if (headings[j].level <= heading.level) {
        stop = headings[j].start;
        break;
      }
    }
    return `${before}<section class="takeaways">\n${html.slice(heading.start, stop)}</section>\n${html.slice(stop)}`;
  }
  return html;
}

function renderMarkdown(markdown) {
  return wrapTakeaways(marked.parse(markdown));
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
  const slug = authorSlug(latin || name);
  // A name with no Latin characters and no transliteration has no usable
  // slug; link nowhere instead of emitting a dead /author/ URL.
  return slug ? `/author/${slug}` : null;
}

function authorLine(book) {
  const authors = authorNames(book);
  const names = authors.length
    ? authors
      .map(author => {
        const href = authorHref(author.name, author.latin);
        return href
          ? `<a class="author-link" href="${esc(href)}">${esc(author.name)}</a>`
          : `<span class="author-link">${esc(author.name)}</span>`;
      })
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
    return `      <div class="book-card" data-book-id="${esc(book.id)}" data-search="${esc(searchText)}" data-chapter-count="${book.chapters.length}" data-chapters="${esc(JSON.stringify(book.chapters.map(chapter => chapter.id)))}" data-converted-at="${esc(book.convertedAt || '')}">
        <a class="book-link" href="/${esc(book.id)}/" aria-label="Open ${esc(book.title)}"></a>
        <div class="book-cover">${coverHtml}</div>
        <div class="book-info">
          <h2>${esc(book.title)}</h2>
          <p class="book-authors">${authorLine(book)}</p>
          <div class="book-progress" aria-hidden="true"><span data-progress-bar></span></div>
          <div class="book-card-footer">
            <p class="book-status" data-progress-label>Start reading</p>
            <button type="button" class="tag-button" data-tag-toggle aria-label="Edit tags for ${esc(book.title)}">🏷</button>
          </div>
          <div class="book-tags" data-book-tags></div>
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
  ${SETTINGS_BOOTSTRAP}
  <link rel="stylesheet" href="${assetHref('style.css')}">
  ${PWA_HEAD}
</head>
<body class="catalog-page">
  <header class="catalog-header">
    <div class="catalog-header-row">
      <h1>Library</h1>
      ${SETTINGS_BUTTON}
    </div>
    <p class="catalog-subtitle">${books.length} book${books.length === 1 ? '' : 's'} on the shelf</p>
    <input type="search" id="book-search" class="book-search" placeholder="Search by title or author" aria-label="Search books by title or author" autocomplete="off" spellcheck="false">
    <div class="filter-bar" id="filter-bar" hidden></div>
  </header>
  <main class="catalog-main">
      ${body}
      <p class="search-empty" id="search-empty" role="status" hidden>No books match your search.</p>
      <p class="install-hint" id="install-hint" hidden>Want offline reading? On iPhone: Share → Add to Home Screen. Opened chapters keep working without a connection.</p>
  </main>
  <script src="${assetHref('settings.js')}"></script>
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
  ${SETTINGS_BOOTSTRAP}
  <link rel="stylesheet" href="${assetHref('style.css')}">
  ${PWA_HEAD}
</head>
<body class="catalog-page">
  <header class="catalog-header">
    <p class="catalog-back"><a href="/">← Library</a></p>
    <div class="catalog-header-row">
      <h1>${esc(author.name)}</h1>
      ${SETTINGS_BUTTON}
    </div>
    <p class="catalog-subtitle">${books.length} book${books.length === 1 ? '' : 's'} in the library</p>
    <input type="search" id="book-search" class="book-search" placeholder="Search by title or author" aria-label="Search books by title or author" autocomplete="off" spellcheck="false">
    <div class="filter-bar" id="filter-bar" hidden></div>
  </header>
  <main class="catalog-main">
      <div class="book-grid" id="book-grid">
${renderBookCards(books)}
      </div>
      <p class="search-empty" id="search-empty" role="status" hidden>No books match your search.</p>
  </main>
  <script src="${assetHref('settings.js')}"></script>
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
      <div class="sidebar-tabs" role="tablist" aria-label="Sidebar sections">
        <button type="button" class="sidebar-tab selected" data-sidebar-tab="contents" role="tab" aria-selected="true">Contents</button>
        <button type="button" class="sidebar-tab" data-sidebar-tab="bookmarks" role="tab" aria-selected="false">Bookmarks</button>
        <button type="button" class="sidebar-tab" data-sidebar-tab="highlights" role="tab" aria-selected="false">Highlights</button>
      </div>
      <nav id="sidebar-tab-contents" role="tabpanel" aria-label="Chapters">
${links}
      </nav>
      <div id="sidebar-tab-bookmarks" class="annot-pane" role="tabpanel" aria-label="Bookmarks" hidden>
        <div class="annot-items" id="bookmarks-items"></div>
      </div>
      <div id="sidebar-tab-highlights" class="annot-pane" role="tabpanel" aria-label="Highlights" hidden>
        <button type="button" class="annot-export" data-export-highlights>Export Markdown</button>
        <div class="annot-items" id="highlights-items"></div>
      </div>`;
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
  ${SETTINGS_BOOTSTRAP}
  <link rel="stylesheet" href="${assetHref('style.css')}">
  ${PWA_HEAD}
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
        <span class="reader-actions">
          <button class="meta-button" type="button" data-bookmark-toggle aria-label="Bookmark this paragraph" aria-pressed="false">🔖</button>
          <button class="meta-button" type="button" data-search-toggle aria-label="Search this book" aria-expanded="false">🔍</button>
          ${SETTINGS_BUTTON}
        </span>
        <span class="reader-progress" data-progress-percent>0%</span>
      </div>
      <article>
        ${contentHtml}
      </article>
${renderPagination(book, index)}
    </main>
  </div>
  <script src="${assetHref('settings.js')}"></script>
  <script src="${assetHref('app.js')}"></script>
  <script src="${assetHref('annotations.js')}"></script>
  <script src="${assetHref('search.js')}"></script>
  <script src="${assetHref('tts.js')}"></script>
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
