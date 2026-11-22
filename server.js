#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  LIBRARY_DIR,
  bookDir,
  isSafeFile,
  listBooks,
  findAuthor,
  readBook,
  readChapter,
  renderCatalog,
  renderAuthorPage,
  renderReaderPage,
} = require('./book');

const PORT = Number(process.env.PORT) || 9876;
const HOST = process.env.HOST || '0.0.0.0';
const ASSETS_DIR = path.join(__dirname, 'assets');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function mimeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function send(req, res, status, contentType, body, cache = 'no-store', extraHeaders = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf-8');
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': payload.length,
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  if (req.method === 'HEAD') res.end();
  else res.end(payload);
}

function html(req, res, status, body) {
  send(req, res, status, 'text/html; charset=utf-8', body);
}

function notFound(req, res) {
  html(req, res, 404, `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Not found</title><link rel="stylesheet" href="/assets/style.css"></head>
<body class="error-page"><h1>404 — Not found</h1><p><a href="/">Back to the library</a></p></body></html>`);
}

function serverError(req, res, error) {
  console.error(error);
  html(req, res, 500, `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Server error</title><link rel="stylesheet" href="/assets/style.css"></head>
<body class="error-page"><h1>500 — Cannot render this page</h1><p><a href="/">Back to the library</a></p></body></html>`);
}

function safeJoin(root, relativePath) {
  const filePath = path.resolve(root, relativePath);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) return null;
  return filePath;
}

function serveFile(req, res, filePath, cache = 'no-store') {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      notFound(req, res);
      return;
    }
    send(req, res, 200, mimeFor(filePath), data, cache);
  });
}

function serveProjectAsset(req, res, segments) {
  // /assets/<file> and /assets/<dir>/<file> (icons), each segment validated.
  const relative = segments.slice(1);
  if (relative.length === 0 || relative.length > 2 || !relative.every(isSafeFile)) {
    notFound(req, res);
    return;
  }
  const filePath = safeJoin(ASSETS_DIR, relative.join(path.sep));
  if (!filePath) {
    notFound(req, res);
    return;
  }
  serveFile(req, res, filePath, 'public, max-age=3600');
}

function serveBookAsset(req, res, book, segments) {
  // /<bookId>/assets/<file>
  const relative = segments.slice(2);
  if (relative.length === 0 || !relative.every(isSafeFile)) {
    notFound(req, res);
    return;
  }
  const filePath = safeJoin(path.join(bookDir(book.id), 'assets'), relative.join('/'));
  if (!filePath) {
    notFound(req, res);
    return;
  }
  serveFile(req, res, filePath, 'public, max-age=86400');
}

// ── In-book search (GET /api/<bookId>/search?q=) ─────────────────
//
// Plain substring scan, linear over chapter Markdown files. No index, no cache:
// the library is small Markdown files and this is milliseconds even on the
// 4-core box. User input is never compiled into a regex, so regex
// metacharacters in q are matched literally.
//
// Note on matching: the server matches raw lowercased Markdown; the client
// marks matches via normalize() (NFKC, punctuation-stripped), so a result may
// occasionally be marked slightly differently than the snippet. Accepted.

const SEARCH_SNIPPET_RADIUS = 60;
const SEARCH_MAX_RESULTS = 50;

function buildSnippet(markdown, index, termLength) {
  const start = Math.max(0, index - SEARCH_SNIPPET_RADIUS);
  const end = Math.min(markdown.length, index + termLength + SEARCH_SNIPPET_RADIUS);
  let text = markdown.slice(start, end);
  // Strip obvious Markdown noise; keep link text.
  text = text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*#{1,6}[ \t]*/gm, '')
    .replace(/~~/g, '')
    .replace(/[*_`>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${start > 0 ? '…' : ''}${text}${end < markdown.length ? '…' : ''}`;
}

function searchBook(book, term) {
  const needle = term.toLowerCase();
  const results = [];
  let total = 0;
  for (let i = 0; i < book.chapters.length && results.length < SEARCH_MAX_RESULTS; i += 1) {
    const chapter = book.chapters[i];
    const read = readChapter(book, chapter.id);
    if (!read) continue;
    const haystack = read.markdown.toLowerCase();
    let matchCount = 0;
    let snippet = '';
    let from = 0;
    for (;;) {
      const index = haystack.indexOf(needle, from);
      if (index === -1) break;
      matchCount += 1;
      if (!snippet) snippet = buildSnippet(read.markdown, index, needle.length);
      from = index + needle.length;
    }
    if (matchCount > 0) {
      results.push({
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        chapterIndex: i,
        snippet,
        matchCount,
      });
      total += matchCount;
    }
  }
  return { query: term, total, results };
}

function sendJson(req, res, status, payload) {
  send(req, res, status, 'application/json; charset=utf-8', JSON.stringify(payload));
}

function handleApi(req, res, segments, searchParams) {
  // Only reserved route so far: /api/<bookId>/search
  if (segments.length !== 3 || segments[2] !== 'search') {
    notFound(req, res);
    return;
  }
  const book = readBook(segments[1]);
  if (!book) {
    sendJson(req, res, 404, { error: 'Book not found' });
    return;
  }
  const term = String(searchParams.get('q') || '').trim();
  if (term.length < 2 || term.length > 100) {
    sendJson(req, res, 400, { error: 'Query must be 2–100 characters' });
    return;
  }
  sendJson(req, res, 200, searchBook(book, term));
}

function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(req, res, 405, 'text/plain; charset=utf-8', 'Method not allowed');
    return;
  }

  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    notFound(req, res);
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    notFound(req, res);
    return;
  }

  const trimmed = pathname.replace(/\/+$/, '');
  const segments = trimmed.split('/').filter(Boolean);

  if (segments.length === 0) {
    html(req, res, 200, renderCatalog(listBooks()));
    return;
  }

  // Only the exact search route is reserved; anything else under /api falls
  // through to normal book routing (a book id of "api" stays reachable).
  if (segments[0] === 'api' && segments.length === 3 && segments[2] === 'search') {
    handleApi(req, res, segments, url.searchParams);
    return;
  }

  // PWA root files. The SW script itself must never be cached, and
  // Service-Worker-Allowed lets it control the whole site from the root.
  if (segments[0] === 'sw.js' && segments.length === 1) {
    send(req, res, 200, 'application/javascript; charset=utf-8',
      fs.readFileSync(path.join(__dirname, 'sw.js')), 'no-store',
      { 'Service-Worker-Allowed': '/' });
    return;
  }

  if (segments[0] === 'manifest.webmanifest' && segments.length === 1) {
    send(req, res, 200, 'application/manifest+json; charset=utf-8',
      fs.readFileSync(path.join(__dirname, 'manifest.webmanifest')));
    return;
  }

  if (segments[0] === 'assets') {
    serveProjectAsset(req, res, segments);
    return;
  }

  if (segments[0] === 'favicon.ico') {
    send(req, res, 204, 'image/x-icon', '');
    return;
  }

  if (segments[0] === 'author') {
    const author = segments.length === 2 ? findAuthor(segments[1]) : null;
    if (!author) {
      notFound(req, res);
      return;
    }
    html(req, res, 200, renderAuthorPage(author, author.books));
    return;
  }

  const book = readBook(segments[0]);
  if (!book) {
    notFound(req, res);
    return;
  }

  if (segments.length === 1) {
    const first = book.chapters[0];
    const result = readChapter(book, first.id);
    if (!result) {
      notFound(req, res);
      return;
    }
    html(req, res, 200, renderReaderPage(book, result.chapter, 0, result.markdown, { entry: true }));
    return;
  }

  if (segments.length === 2 && segments[1] === 'assets') {
    notFound(req, res);
    return;
  }

  if (segments[1] === 'assets') {
    serveBookAsset(req, res, book, segments);
    return;
  }

  if (segments.length === 2 && book.cover === segments[1]) {
    const coverPath = safeJoin(bookDir(book.id), book.cover);
    if (!coverPath) {
      notFound(req, res);
      return;
    }
    serveFile(req, res, coverPath, 'public, max-age=86400');
    return;
  }

  if (segments.length === 2) {
    const result = readChapter(book, segments[1]);
    if (!result) {
      notFound(req, res);
      return;
    }
    const index = book.chapters.findIndex(chapter => chapter.id === result.chapter.id);
    html(req, res, 200, renderReaderPage(book, result.chapter, index, result.markdown));
    return;
  }

  notFound(req, res);
}

const server = http.createServer((req, res) => {
  try {
    handle(req, res);
  } catch (error) {
    serverError(req, res, error);
  }
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Set PORT=<other> and try again.`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, HOST, () => {
  console.log(`Library: http://localhost:${PORT}`);
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) {
        console.log(`  phone: http://${address.address}:${PORT}`);
      }
    }
  }
  console.log(`Serving ${LIBRARY_DIR}`);
});
