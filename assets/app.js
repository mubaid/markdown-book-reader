'use strict';

(function () {
  const PROGRESS_PREFIX = 'markdown-book-reader:progress:';

  // Service workers (and therefore offline caching) only exist in secure
  // contexts: HTTPS or localhost. Plain-LAN http gets no offline support.
  const SW_AVAILABLE = 'serviceWorker' in navigator
    && (window.isSecureContext
      || ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname));

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

  // Subtle scroll-reveal for top-level chapter blocks. Opt-in: the hidden
  // state lives under .reveal-ready, added only when motion is allowed, so
  // no-JS/print/reduced-motion always show full content. sync() instantly
  // reveals on-screen blocks after programmatic restore jumps — no fade at
  // the saved reading position.
  function createReveal(article) {
    if (!('IntersectionObserver' in window)) return null;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
    const blocks = Array.from(article.querySelectorAll(':scope > *'));
    if (blocks.length === 0) return null;
    const io = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      }
    }, { rootMargin: '0px 0px -6% 0px' });
    function sync() {
      const vh = window.innerHeight;
      for (const block of blocks) {
        if (block.classList.contains('in')) continue;
        const rect = block.getBoundingClientRect();
        if (rect.top < vh && rect.bottom > 0) {
          block.classList.add('reveal-instant', 'in');
          io.unobserve(block);
        }
      }
      window.requestAnimationFrame(() => {
        for (const block of blocks) block.classList.remove('reveal-instant');
      });
    }
    article.classList.add('reveal-ready');
    for (const block of blocks) {
      block.classList.add('reveal');
      io.observe(block);
    }
    sync();
    return { sync };
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
    // Containers (blockquote, loose li) and their child paragraphs both get
    // stamped. Consumers that act on text (highlights, read-aloud, search)
    // must use the innermost blocks only, or the same text is processed twice.
    // Mark every stamped block that has a stamped descendant, then keep the
    // rest. Stamping itself stays untouched: saved anchors keep working.
    const blockSet = new Set(blocks);
    const containers = new Set();
    for (const block of blocks) {
      for (let ancestor = block.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (blockSet.has(ancestor)) containers.add(ancestor);
      }
    }
    const leafBlocks = blocks.filter(block => !containers.has(block));
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
    let manualMove = false;
    let lastJump = null;
    let suppressSave = !isEntry && saved && saved.chapterId === chapterId;
    let restoredAt = 0;

    // Scroll to a stamped block, remembering it so it can be re-anchored once
    // images above it have loaded and changed the layout.
    function jumpTo(anchor) {
      const target = elementForAnchor(anchor);
      if (!target) return false;
      target.scrollIntoView({ block: 'start' });
      lastJump = anchor;
      return true;
    }

    // URL navigation convention: ?goto=<anchor> beats saved-progress restore,
    // but only when the anchor actually exists — a stale link must not wipe
    // the saved position.
    const params = new URLSearchParams(window.location.search);
    const gotoAnchor = params.get('goto');
    let jumped = false;
    if (gotoAnchor && jumpTo(gotoAnchor)) {
      jumped = true;
      userMoved = true;
      suppressSave = false;
    }

    function maxScroll() {
      return Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    }

    const reveal = createReveal(article);

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
      if (reveal) reveal.sync();
    }

    maybeRestore();
    restoredAt = Date.now();
    window.setTimeout(() => {
      maybeRestore();
      suppressSave = false;
    }, 450);

    window.addEventListener('load', () => {
      // Images above a ?goto=/search/highlight target can load after the jump
      // and push it out of place. Re-anchor once everything has loaded.
      if (lastJump && !manualMove) {
        const target = elementForAnchor(lastJump);
        if (target) {
          target.scrollIntoView({ block: 'start' });
          persist();
        }
      }
      if (Date.now() - restoredAt < 4000) maybeRestore();
    });

    for (const eventName of ['wheel', 'touchstart', 'touchmove', 'keydown', 'mousedown']) {
      window.addEventListener(eventName, () => {
        userMoved = true;
        manualMove = true;
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

    // After a ?goto= jump, persist once so progress follows the jump.
    if (jumped) persist();

    // Center the active chapter in the sidebar (Contents tab) without touching page scroll.
    const sidebar = document.querySelector('.sidebar');
    const activeLink = document.querySelector('#sidebar-tab-contents a.active');
    if (sidebar && activeLink) {
      const target = activeLink.offsetTop - sidebar.clientHeight / 2;
      sidebar.scrollTop = Math.max(0, target);
    }

    // Core API for annotations.js / search.js / tts.js (script order guarantees this exists).
    window.MBR = {
      bookId,
      chapterId,
      chapterIndex,
      chapters,
      blocks,
      leafBlocks,
      currentTopBlock: () => currentTopBlock(blocks),
      normalize,
      fnv1a,
      goToAnchor(anchor) {
        if (!jumpTo(anchor)) return false;
        userMoved = true;
        suppressSave = false;
        persist();
        return true;
      },
    };

    if (offlineSupported()) initOfflineReader(window.MBR);
  }

  // ── Offline support (PWA) ───────────────────────────────────────
  //
  // The service worker caches every chapter page it serves (sw.js). On top of
  // that we: (1) quietly prefetch the next chapter after each read, so "next"
  // works offline, and (2) offer an "Offline" button that walks all chapters
  // of the book (plus their images) into the cache.

  const OFFLINE_PREFIX = 'markdown-book-reader:offline:';

  function offlineSupported() {
    return 'serviceWorker' in navigator && window.isSecureContext;
  }

  function isOfflineSaved(bookId) {
    try {
      return Boolean(localStorage.getItem(OFFLINE_PREFIX + bookId));
    } catch {
      return false;
    }
  }

  function markOfflineSaved(bookId, value) {
    try {
      if (value) localStorage.setItem(OFFLINE_PREFIX + bookId, String(Date.now()));
      else localStorage.removeItem(OFFLINE_PREFIX + bookId);
    } catch {
      /* storage blocked: button state is session-only */
    }
  }

  function chapterUrl(bookId, chapterId) {
    return `/${encodeURIComponent(bookId)}/${encodeURIComponent(chapterId)}`;
  }

  // Fetching a chapter HTML does not fetch its <img> children; pull them
  // through the service worker explicitly so offline pages show images too.
  async function cacheChapterResources(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const img of doc.querySelectorAll('img[src]')) {
      try {
        const url = new URL(img.getAttribute('src'), window.location.origin);
        if (url.origin === window.location.origin) await fetch(url);
      } catch {
        /* skip unreadable image URLs */
      }
    }
  }

  function initOfflineReader(mbr) {
    const actions = document.querySelector('.reader-actions');
    if (!actions) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'meta-button';
    button.setAttribute('aria-label', 'Make this book available offline');
    let saved = isOfflineSaved(mbr.bookId);
    let busy = false;

    function render() {
      button.textContent = saved ? 'Offline ✓' : 'Offline';
      button.classList.toggle('active', saved);
      button.disabled = busy;
    }

    render();
    actions.insertBefore(button, actions.firstChild);

    button.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      render();
      const toast = message => window.MBRToast && window.MBRToast(message);
      // Make sure a worker is actually in control, or nothing gets cached.
      try {
        await navigator.serviceWorker.ready;
      } catch {
        /* older browsers: proceed, fetches just won't be cached */
      }
      let done = 0;
      for (const chapterId of mbr.chapters) {
        try {
          const response = await fetch(chapterUrl(mbr.bookId, chapterId));
          if (!response.ok) throw new Error(String(response.status));
          await cacheChapterResources(await response.text());
        } catch {
          busy = false;
          render();
          toast('Could not finish — check your connection');
          return;
        }
        done += 1;
        toast(`Making offline · ${done}/${mbr.chapters.length} chapters`);
      }
      busy = false;
      saved = true;
      markOfflineSaved(mbr.bookId, true);
      render();
      toast('Ready to read offline');
    });

    // One chapter ahead, cached quietly, so "next" works offline by default.
    const nextId = mbr.chapters[mbr.chapterIndex + 1];
    if (nextId && !saved && navigator.onLine) {
      window.setTimeout(() => {
        fetch(chapterUrl(mbr.bookId, nextId))
          .then(response => (response.ok ? response.text() : null))
          .then(html => (html ? cacheChapterResources(html) : null))
          .catch(() => {
            /* prefetch is best-effort */
          });
      }, 1500);
    }
  }

  // ── Catalog ─────────────────────────────────────────────────────

  const TAGS_KEY = 'markdown-book-reader:tags';

  function loadTags() {
    try {
      const parsed = safeParse(localStorage.getItem(TAGS_KEY));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveTags(tags) {
    try {
      localStorage.setItem(TAGS_KEY, JSON.stringify(tags));
    } catch {
      /* storage blocked: tags work for this session only */
    }
  }

  function initCatalog() {
    const grid = document.getElementById('book-grid');
    if (!grid) return;

    let tags = loadTags();

    const cards = Array.from(grid.querySelectorAll('.book-card'));
    const decorated = cards.map((card, position) => {
      const bookId = card.dataset.bookId;
      const chapterCount = Math.max(1, Number(card.dataset.chapterCount) || 1);
      const chapters = chapterListFrom(card);
      const progress = loadProgress(bookId);
      let updatedAt = 0;
      let fraction = 0;

      if (progress) {
        updatedAt = Number(progress.updatedAt) || 0;
        fraction = typeof progress.bookFraction === 'number'
          ? progress.bookFraction
          : ((Number(progress.chapterIndex) || 0) + clamp01(progress.chapterFraction)) / chapterCount;
        fraction = clamp01(fraction);
        const percent = Math.round(fraction * 100);

        const bar = card.querySelector('[data-progress-bar]');
        if (bar) bar.style.width = `${percent}%`;

        const label = card.querySelector('[data-progress-label]');
        if (label) label.textContent = percent >= 99 ? 'Finished · 100%' : `Continue reading · ${percent}%`;

        const validChapter = progress.chapterId && (chapters.length === 0 || chapters.includes(progress.chapterId));
        const link = card.querySelector('.book-link');
        if (validChapter && link) {
          link.setAttribute('href', `/${encodeURIComponent(bookId)}/${encodeURIComponent(progress.chapterId)}`);
        }
      }

      return {
        card,
        bookId,
        position,
        updatedAt,
        fraction,
        hasProgress: Boolean(progress),
        title: (card.querySelector('h2')?.textContent || '').trim(),
        author: (card.querySelector('.book-authors .author-link')?.textContent || '').trim(),
        convertedAt: card.dataset.convertedAt || '',
      };
    });

    // ── Status, tags, filter state ──────────────────────────────

    const STATUSES = [
      { id: 'all', label: 'All' },
      { id: 'unread', label: 'Unread' },
      { id: 'reading', label: 'Reading' },
      { id: 'finished', label: 'Finished' },
    ];

    const SORTS = [
      { id: 'recent', label: 'Recently read' },
      { id: 'title', label: 'Title' },
      { id: 'author', label: 'Author' },
      { id: 'added', label: 'Recently added' },
    ];

    const state = { status: 'all', selectedTags: [], sort: 'recent', query: '' };

    function statusOf(item) {
      if (!item.hasProgress) return 'unread';
      if (item.fraction >= 0.99) return 'finished';
      return 'reading';
    }

    function tagsOf(bookId) {
      const list = tags[bookId];
      return Array.isArray(list) ? list : [];
    }

    function usedTags() {
      const set = new Set();
      for (const item of decorated) {
        for (const tag of tagsOf(item.bookId)) set.add(tag);
      }
      return Array.from(set).sort();
    }

    // ── Filter bar ──────────────────────────────────────────────

    const filterBar = document.getElementById('filter-bar');
    let countEl = null;

    function renderFilterBar() {
      if (!filterBar) return;
      filterBar.replaceChildren();

      const statusRow = document.createElement('div');
      statusRow.className = 'chip-row';
      for (const status of STATUSES) {
        statusRow.appendChild(chip(status.label, `status:${status.id}`, state.status === status.id));
      }
      filterBar.appendChild(statusRow);

      const used = usedTags();
      if (used.length > 0) {
        const tagRow = document.createElement('div');
        tagRow.className = 'chip-row';
        for (const tag of used) {
          tagRow.appendChild(chip(`#${tag}`, `tag:${tag}`, state.selectedTags.includes(tag)));
        }
        filterBar.appendChild(tagRow);
      }

      const controls = document.createElement('div');
      controls.className = 'filter-controls';
      const sortSelect = document.createElement('select');
      sortSelect.className = 'filter-sort';
      sortSelect.setAttribute('aria-label', 'Sort books');
      for (const sort of SORTS) {
        const option = document.createElement('option');
        option.value = sort.id;
        option.textContent = sort.label;
        if (sort.id === state.sort) option.selected = true;
        sortSelect.appendChild(option);
      }
      sortSelect.addEventListener('change', () => {
        state.sort = sortSelect.value;
        applyAll();
      });
      controls.appendChild(sortSelect);
      countEl = document.createElement('span');
      countEl.className = 'filter-count';
      controls.appendChild(countEl);
      filterBar.appendChild(controls);

      filterBar.hidden = false;
    }

    function chip(label, key, selected) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip' + (selected ? ' selected' : '');
      button.textContent = label;
      button.addEventListener('click', () => {
        if (key.startsWith('status:')) {
          state.status = key.slice(7);
        } else {
          const tag = key.slice(4);
          state.selectedTags = state.selectedTags.includes(tag)
            ? state.selectedTags.filter(item => item !== tag)
            : state.selectedTags.concat(tag);
        }
        renderFilterBar();
        applyAll();
      });
      return button;
    }

    // ── Filtering + sorting ─────────────────────────────────────

    function matches(item) {
      const query = state.query;
      const haystack = `${item.card.dataset.search || ''} ${tagsOf(item.bookId).join(' ')}`.toLowerCase();
      if (query && !haystack.includes(query)) return false;
      if (state.status !== 'all' && statusOf(item) !== state.status) return false;
      for (const tag of state.selectedTags) {
        if (!tagsOf(item.bookId).includes(tag)) return false;
      }
      return true;
    }

    function sortItems() {
      const items = decorated.slice();
      if (state.sort === 'title') {
        items.sort((a, b) => a.title.localeCompare(b.title));
      } else if (state.sort === 'author') {
        items.sort((a, b) => (a.author.localeCompare(b.author)) || a.title.localeCompare(b.title));
      } else if (state.sort === 'added') {
        items.sort((a, b) => String(b.convertedAt).localeCompare(String(a.convertedAt)) || (a.position - b.position));
      } else {
        items.sort((a, b) => (b.updatedAt - a.updatedAt) || (a.position - b.position));
      }
      for (const item of items) grid.appendChild(item.card);
    }

    function updateCardTags(item) {
      const container = item.card.querySelector('[data-book-tags]');
      if (!container) return;
      container.replaceChildren();
      for (const tag of tagsOf(item.bookId)) {
        const chipEl = document.createElement('span');
        chipEl.className = 'card-tag';
        chipEl.textContent = tag;
        container.appendChild(chipEl);
      }
    }

    const searchInput = document.getElementById('book-search');
    const emptyMessage = document.getElementById('search-empty');

    function applyAll() {
      sortItems();
      let visible = 0;
      for (const item of decorated) {
        const match = matches(item);
        item.card.hidden = !match;
        if (match) visible += 1;
      }
      if (countEl) countEl.textContent = `${visible} of ${decorated.length} books`;
      if (emptyMessage) {
        const filtering = Boolean(state.query) || state.status !== 'all' || state.selectedTags.length > 0;
        emptyMessage.hidden = !filtering || visible > 0;
        emptyMessage.textContent = state.query ? 'No books match your search.' : 'No books match these filters.';
      }
    }

    if (searchInput) {
      searchInput.addEventListener('input', () => {
        state.query = searchInput.value.trim().toLowerCase();
        applyAll();
      });
    }

    // ── Tag editor popover ──────────────────────────────────────

    let popover = null;
    let popoverItem = null;

    function closePopover() {
      if (popover) popover.remove();
      popover = null;
      popoverItem = null;
    }

    function openPopover(item, button) {
      closePopover();
      popoverItem = item;
      popover = document.createElement('div');
      popover.className = 'tag-popover';
      popover.setAttribute('role', 'dialog');
      popover.setAttribute('aria-label', `Tags for ${item.title}`);

      const list = document.createElement('div');
      list.className = 'tag-popover-chips';
      const current = tagsOf(item.bookId);
      if (current.length === 0) {
        const hint = document.createElement('span');
        hint.className = 'tag-popover-empty';
        hint.textContent = 'No tags yet';
        list.appendChild(hint);
      }
      for (const tag of current) {
        const chipEl = document.createElement('span');
        chipEl.className = 'popover-chip';
        const labelEl = document.createElement('span');
        labelEl.textContent = tag;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.setAttribute('aria-label', `Remove tag ${tag}`);
        remove.textContent = '✕';
        remove.addEventListener('click', () => {
          const next = tagsOf(item.bookId).filter(value => value !== tag);
          if (next.length) tags[item.bookId] = next;
          else delete tags[item.bookId];
          saveTags(tags);
          updateCardTags(item);
          openPopover(item, button);
          renderFilterBar();
          applyAll();
        });
        chipEl.appendChild(labelEl);
        chipEl.appendChild(remove);
        list.appendChild(chipEl);
      }

      const addInput = document.createElement('input');
      addInput.type = 'text';
      addInput.className = 'tag-add';
      addInput.placeholder = 'Add tag, press Enter';
      addInput.maxLength = 24;
      addInput.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const value = addInput.value.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 24);
        if (!value || tagsOf(item.bookId).includes(value)) return;
        tags[item.bookId] = tagsOf(item.bookId).concat(value);
        saveTags(tags);
        addInput.value = '';
        updateCardTags(item);
        openPopover(item, button);
        popover.querySelector('.tag-add').focus();
        renderFilterBar();
        applyAll();
      });

      popover.appendChild(list);
      popover.appendChild(addInput);
      document.body.appendChild(popover);

      const rect = button.getBoundingClientRect();
      const width = popover.offsetWidth || 220;
      const height = popover.offsetHeight || 160;
      let left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
      let top = rect.bottom + 6;
      if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
      popover.style.left = `${left}px`;
      popover.style.top = `${top}px`;
    }

    document.addEventListener('pointerdown', event => {
      if (!popover) return;
      if (!event.target.closest('.tag-popover') && !event.target.closest('[data-tag-toggle]')) closePopover();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') closePopover();
    });
    window.addEventListener('scroll', closePopover, { passive: true });

    for (const item of decorated) {
      updateCardTags(item);
      const button = item.card.querySelector('[data-tag-toggle]');
      if (button) {
        button.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          if (popover && popoverItem === item) closePopover();
          else openPopover(item, button);
        });
      }
    }

    renderFilterBar();
    applyAll();

    // iOS has no install prompt: point at Share → Add to Home Screen once.
    // Only where offline caching can actually work (secure context), so the
    // hint never promises offline reading on plain-LAN http.
    const installHint = document.getElementById('install-hint');
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
      || window.navigator.standalone === true;
    if (installHint && isIOS && !standalone && SW_AVAILABLE) installHint.hidden = false;
  }

  function init() {
    if (document.body.classList.contains('reader')) initReader();
    if (document.body.classList.contains('catalog-page')) initCatalog();
  }

  // Service worker: only where it can actually work, so no inert registration
  // on plain-LAN http.
  if (SW_AVAILABLE) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        /* offline support unavailable; reading works regardless */
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
