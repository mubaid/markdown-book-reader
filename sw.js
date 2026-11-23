'use strict';

// Service worker for offline reading. Bump VERSION when shell logic changes.
//
// Version-param normalization (the subtle bit): pages request assets as
// /assets/app.js?v=<mtime>. Cache keys for /assets/* strip the v param, so
// the precached canonical entry matches offline requests, while online
// requests still go to the network first — an mtime bump therefore reaches
// installed PWAs on the next load instead of serving a stale cache forever.

const VERSION = 'v2';
const SHELL_CACHE = `mbr-shell-${VERSION}`;
const PAGE_CACHE = `mbr-runtime-${VERSION}`;
const IMAGE_CACHE = `mbr-images-${VERSION}`;
const MAX_IMAGE_ENTRIES = 150;

const SHELL_URLS = [
  '/',
  '/assets/style.css',
  '/assets/app.js',
  '/assets/settings.js',
  '/assets/annotations.js',
  '/assets/search.js',
  '/assets/tts.js',
  '/assets/fonts/literata-latin.woff2',
  '/assets/fonts/literata-latin-ext.woff2',
  '/assets/fonts/literata-italic-latin.woff2',
  '/assets/fonts/literata-italic-latin-ext.woff2',
  '/manifest.webmanifest',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png',
  '/assets/icons/maskable-512.png',
  '/assets/icons/apple-touch-icon.png',
];

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => Promise.all(SHELL_URLS.map(url => cache.add(url).catch(() => undefined))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(
        names.filter(name => name.startsWith('mbr-') && !name.endsWith(`-${VERSION}`))
          .map(name => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

function canonical(pathname) {
  return new Request(`${self.location.origin}${pathname}`);
}

function offlinePage() {
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Offline</title><link rel="stylesheet" href="/assets/style.css"></head>
<body class="error-page"><h1>You're offline</h1>
<p>Opened chapters still work. The shelf loads if it was cached.</p>
<p><a href="/">Try the library</a></p></body></html>`,
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

async function put(cacheName, request, response) {
  if (!response || !response.ok) return;
  const cache = await caches.open(cacheName);
  await cache.put(request, response);
  if (cacheName !== IMAGE_CACHE) return;
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_IMAGE_ENTRIES; i += 1) {
    await cache.delete(keys[i]); // insertion order ≈ oldest first (MVP LRU)
  }
}

async function respond(request, url) {
  const path = url.pathname;

  // /api/* (search): network-only; stage 3 surfaces its own offline message.
  if (path.startsWith('/api/')) return fetch(request);

  // Project assets: strip the ?v= param for cache keys.
  if (path.startsWith('/assets/')) {
    const canonicalRequest = canonical(path);
    if (url.search) {
      // Versioned request from HTML: network first so updates land.
      try {
        const response = await fetch(request);
        await put(PAGE_CACHE, canonicalRequest, response.clone());
        return response;
      } catch {
        const cached = await caches.match(canonicalRequest);
        return cached || Response.error();
      }
    }
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    await put(PAGE_CACHE, request, response.clone());
    return response;
  }

  // Covers and book images: cache-first, trimmed.
  if (IMAGE_EXTENSIONS.test(path)) {
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    await put(IMAGE_CACHE, request, response.clone());
    return response;
  }

  // HTML pages (catalog, author, chapters): network-first, cache fallback.
  // Cache under the query-free path so ?goto=/?q= variants don't multiply.
  try {
    const response = await fetch(request);
    await put(PAGE_CACHE, canonical(path), response.clone());
    return response;
  } catch {
    const cached = (await caches.match(request))
      || (await caches.match(canonical(path)))
      || (await caches.match('/'));
    return cached || offlinePage();
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(respond(request, url).catch(() => offlinePage()));
});
