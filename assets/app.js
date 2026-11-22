'use strict';

(function () {
  const PROGRESS_PREFIX = 'markdown-book-reader:progress:';

  function safeParse(value) {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function loadProgress(bookId) {
    try {
      const raw = localStorage.getItem(PROGRESS_PREFIX + bookId);
      const parsed = raw ? safeParse(raw) : null;
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  function saveProgress(bookId, payload) {
    try {
      localStorage.setItem(PROGRESS_PREFIX + bookId, JSON.stringify(payload));
    } catch {
      /* storage full or blocked: reading still works */
    }
  }

  function chapterListFrom(element) {
    const list = safeParse(element.dataset.chapters || '[]');
    return Array.isArray(list) ? list : [];
  }

  function clamp01(value) {
    return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  }

  // ── Anchors ─────────────────────────────────────────────────────

  function normalize(text) {
    return String(text || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  function fnv1a(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
  }

  function stampBlocks(article) {
    const seen = new Map();
    const blocks = article.querySelectorAll('p, li, h2, h3, h4, blockquote, pre');
    const stamped = [];
    for (const block of blocks) {
      if (block.closest('.pagination')) continue;
      const text = normalize(block.textContent);
      if (!text) continue;
      const base = fnv1a(text);
      const count = (seen.get(base) || 0) + 1;
      seen.set(base, count);
      const anchor = count === 1 ? base : `${base}-${count}`;
      block.dataset.anchor = anchor;
      block.id = `blk-${anchor}`;
      stamped.push(block);
    }
    return stamped;
  }

  function elementForAnchor(anchor) {
    if (!anchor || !/^[a-z0-9-]+$/i.test(anchor)) return null;
    return document.querySelector(`article [data-anchor="${anchor}"]`);
  }

  function currentTopBlock(blocks) {
    if (blocks.length === 0) return null;
    const offset = window.innerWidth <= 768 ? 88 : 28;
    let above = null;
    for (const block of blocks) {
      const rect = block.getBoundingClientRect();
      if (rect.top <= offset) {
        above = block;
        continue;
      }
      break;
    }
    if (above) return above;
    return blocks.find(block => block.getBoundingClientRect().bottom > offset) || blocks[0];
  }

  // ── Reader ──────────────────────────────────────────────────────

  function initReader() {
    const body = document.body;
    const article = document.querySelector('article');
    if (!article) return;

    const bookId = body.dataset.bookId;
    const chapterId = body.dataset.chapterId;
    const chapterIndex = Number(body.dataset.chapterIndex) || 0;
    const chapterCount = Math.max(1, Number(body.dataset.chapterCount) || 1);
    const isEntry = body.dataset.entry === '1';
    const chapters = chapterListFrom(body);
    const saved = loadProgress(bookId);

    let redirecting = false;
    if (isEntry && saved && saved.chapterId && saved.chapterId !== chapterId) {
      if (chapters.length === 0 || chapters.includes(saved.chapterId)) {
        redirecting = true;
        window.location.replace(`/${encodeURIComponent(bookId)}/${encodeURIComponent(saved.chapterId)}`);
        return;
      }
    }

    const blocks = stampBlocks(article);
    const percentEl = document.querySelector('[data-progress-percent]');

    function updatePercent(bookFraction) {
      if (percentEl) percentEl.textContent = `${Math.round(clamp01(bookFraction) * 100)}%`;
    }

    if (saved && typeof saved.bookFraction === 'number') {
      updatePercent(saved.bookFraction);
    } else {
      updatePercent(chapterIndex / chapterCount);
    }

    let userMoved = false;
    let suppressSave = !isEntry && saved && saved.chapterId === chapterId;
    let restoredAt = 0;

    function maxScroll() {
      return Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    }

    function restore(savedProgress) {
      const target = elementForAnchor(savedProgress.anchor)
        || (savedProgress.blockId && /^blk-[a-z0-9-]+$/i.test(savedProgress.blockId)
          ? document.getElementById(savedProgress.blockId)
          : null);
      if (target) {
        target.scrollIntoView({ block: 'start' });
        return;
      }
      const fraction = clamp01(savedProgress.chapterFraction);
      if (fraction > 0) {
        window.scrollTo(0, Math.round(fraction * maxScroll()));
      }
    }

    function maybeRestore() {
      if (!saved || saved.chapterId !== chapterId || userMoved) return;
      restore(saved);
      restoredAt = Date.now();
    }

    maybeRestore();
    restoredAt = Date.now();
    window.setTimeout(() => {
      maybeRestore();
      suppressSave = false;
    }, 450);

    window.addEventListener('load', () => {
      if (Date.now() - restoredAt < 4000) maybeRestore();
    });

    for (const eventName of ['wheel', 'touchstart', 'touchmove', 'keydown', 'mousedown']) {
      window.addEventListener(eventName, () => {
        userMoved = true;
        suppressSave = false;
      }, { passive: true });
    }

    function persist() {
      if (redirecting || suppressSave) return;
      const block = currentTopBlock(blocks);
      const chapterFraction = clamp01(window.scrollY / maxScroll());
      const bookFraction = clamp01((chapterIndex + chapterFraction) / chapterCount);
      saveProgress(bookId, {
        chapterId,
        chapterIndex,
        blockId: block ? block.id : null,
        anchor: block ? block.dataset.anchor : null,
        chapterFraction,
        bookFraction,
        updatedAt: Date.now(),
      });
      updatePercent(bookFraction);
    }

    let lastSave = 0;
    let scheduled = false;

    function throttledPersist() {
      const now = Date.now();
      if (now - lastSave >= 400) {
        lastSave = now;
        persist();
      }
    }

    window.addEventListener('scroll', () => {
      // requestAnimationFrame is paused in background/hidden tabs, so save directly there.
      if (document.hidden) {
        throttledPersist();
        return;
      }
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(() => {
        scheduled = false;
        throttledPersist();
      });
    }, { passive: true });

    window.addEventListener('pagehide', persist);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') persist();
    });

    // Center the active chapter in the sidebar without touching page scroll.
    const sidebar = document.querySelector('.sidebar');
    const activeLink = document.querySelector('.sidebar nav a.active');
    if (sidebar && activeLink) {
      const target = activeLink.offsetTop - sidebar.clientHeight / 2;
      sidebar.scrollTop = Math.max(0, target);
    }
  }

  // ── Catalog ─────────────────────────────────────────────────────

  function initCatalog() {
    const grid = document.getElementById('book-grid');
    if (!grid) return;

    const cards = Array.from(grid.querySelectorAll('.book-card'));
    const decorated = cards.map((card, position) => {
      const bookId = card.dataset.bookId;
      const chapterCount = Math.max(1, Number(card.dataset.chapterCount) || 1);
      const chapters = chapterListFrom(card);
      const progress = loadProgress(bookId);
      let updatedAt = 0;

      if (progress) {
        updatedAt = Number(progress.updatedAt) || 0;
        const bookFraction = typeof progress.bookFraction === 'number'
          ? progress.bookFraction
          : ((Number(progress.chapterIndex) || 0) + clamp01(progress.chapterFraction)) / chapterCount;
        const percent = Math.round(clamp01(bookFraction) * 100);

        const bar = card.querySelector('[data-progress-bar]');
        if (bar) bar.style.width = `${percent}%`;

        const label = card.querySelector('[data-progress-label]');
        if (label) label.textContent = percent >= 99 ? 'Finished · 100%' : `Continue reading · ${percent}%`;

        const validChapter = progress.chapterId && (chapters.length === 0 || chapters.includes(progress.chapterId));
        if (validChapter) {
          card.setAttribute('href', `/${encodeURIComponent(bookId)}/${encodeURIComponent(progress.chapterId)}`);
        }
      }

      return { card, updatedAt, position };
    });

    decorated
      .sort((a, b) => (b.updatedAt - a.updatedAt) || (a.position - b.position))
      .forEach(item => grid.appendChild(item.card));
  }

  function init() {
    if (document.body.classList.contains('reader')) initReader();
    if (document.body.classList.contains('catalog-page')) initCatalog();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
