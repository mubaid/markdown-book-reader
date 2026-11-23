'use strict';

// Highlights + bookmarks + sidebar tabs. Reader-only; runs after app.js
// (script order guarantees window.MBR exists and stampBlocks has run).
// Anchors are text hashes, so wrapping text in <mark> never changes
// block.textContent and anchor hashes stay stable across reloads.
(function () {
  const COLORS = ['yellow', 'green', 'blue'];

  function safeParse(value) {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function showToast(message) {
    let toast = document.getElementById('mbr-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'mbr-toast';
      toast.className = 'toast';
      toast.setAttribute('role', 'status');
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => toast.classList.remove('visible'), 2200);
  }

  window.MBRToast = showToast;

  function init() {
    const MBR = window.MBR;
    if (!MBR || !MBR.bookId) return;

    const key = `markdown-book-reader:annotations:${MBR.bookId}`;

    // ── Store ───────────────────────────────────────────────────
    let store = load();

    function load() {
      const fallback = { highlights: [], bookmarks: [] };
      try {
        const parsed = safeParse(localStorage.getItem(key));
        if (!parsed || typeof parsed !== 'object') return fallback;
        return {
          highlights: Array.isArray(parsed.highlights) ? parsed.highlights : [],
          bookmarks: Array.isArray(parsed.bookmarks) ? parsed.bookmarks : [],
        };
      } catch {
        return fallback;
      }
    }

    function save() {
      try {
        localStorage.setItem(key, JSON.stringify(store));
        return true;
      } catch {
        showToast('Storage full — item not saved');
        return false;
      }
    }

    function uid(prefix) {
      return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    }

    // ── Text-node offset math ───────────────────────────────────

    function textNodes(root) {
      const nodes = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
      return nodes;
    }

    // Wrap [start,end) character offsets of root.textContent in <mark>.
    function wrapRange(root, start, end, className, id) {
      let pos = 0;
      const segments = [];
      for (const node of textNodes(root)) {
        const length = node.nodeValue.length;
        const nodeStart = pos;
        const nodeEnd = pos + length;
        const segStart = Math.max(start, nodeStart);
        const segEnd = Math.min(end, nodeEnd);
        if (segStart < segEnd) segments.push({ node, from: segStart - nodeStart, to: segEnd - nodeStart });
        pos = nodeEnd;
      }
      // Wrap later segments first so earlier splitText calls don't invalidate
      // node references for the remaining segments.
      for (const seg of segments.reverse()) {
        const target = seg.node;
        const after = target.splitText(seg.to);
        const inside = target.splitText(seg.from);
        const mark = document.createElement('mark');
        mark.className = className;
        mark.dataset.hlId = id;
        target.parentNode.insertBefore(mark, inside);
        mark.appendChild(inside);
        void after;
      }
      return segments.length;
    }

    // Offset of a (node, offset) point inside root.textContent. Range-based so
    // element containers (offset = child index) work as well as text nodes.
    function pointOffset(root, node, offset) {
      try {
        const range = document.createRange();
        range.selectNodeContents(root);
        range.setEnd(node, offset);
        return range.toString().length;
      } catch {
        return -1;
      }
    }

    // ── Highlight re-application ────────────────────────────────

    function blockForAnchor(anchor) {
      if (!anchor || !/^[a-z0-9-]+$/i.test(anchor)) return null;
      return document.querySelector(`article [data-anchor="${anchor}"]`);
    }

    function applyHighlights() {
      for (const highlight of store.highlights) {
        if (highlight.chapterId !== MBR.chapterId) continue;
        const block = blockForAnchor(highlight.anchor);
        if (!block) continue; // kept in store, rendered greyed in the list
        wrapRange(block, highlight.start, highlight.end, `hl hl-${highlight.color}`, highlight.id);
      }
    }

    // ── Selection toolbar ───────────────────────────────────────

    let toolbar;
    let pendingSelection = null;
    let selectedColor = 'yellow';

    function buildToolbar() {
      toolbar = document.createElement('div');
      toolbar.className = 'hl-toolbar';
      toolbar.hidden = true;
      const dots = COLORS.map(color =>
        `<button type="button" class="hl-dot hl-dot-${color}" data-color="${color}" aria-label="Highlight ${color}"></button>`).join('');
      toolbar.innerHTML = `${dots}<button type="button" data-action="highlight">Highlight</button>`
        + `<button type="button" data-action="copy">Copy</button>`;
      document.body.appendChild(toolbar);

      toolbar.addEventListener('pointerdown', event => event.preventDefault()); // keep the selection alive
      toolbar.addEventListener('click', event => {
        const dot = event.target.closest('[data-color]');
        if (dot) {
          selectedColor = dot.dataset.color;
          markColorDots();
          return;
        }
        const action = event.target.closest('[data-action]');
        if (!action || !pendingSelection) return;
        if (action.dataset.action === 'highlight') createHighlights(pendingSelection);
        if (action.dataset.action === 'copy') copySelection(pendingSelection.text);
        hideToolbar();
        window.getSelection().removeAllRanges();
      });
      markColorDots();
    }

    function markColorDots() {
      for (const dot of toolbar.querySelectorAll('[data-color]')) {
        dot.classList.toggle('selected', dot.dataset.color === selectedColor);
      }
    }

    function hideToolbar() {
      toolbar.hidden = true;
      pendingSelection = null;
    }

    // Segment the current selection per stamped block; ignore anything
    // outside the article (sidebar, pagination, chrome).
    function captureSelection() {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
      const range = selection.getRangeAt(0);
      const text = selection.toString();
      if (!text.trim()) return null;

      const segments = [];
      // Innermost blocks only: a blockquote/loose list item and its paragraph
      // are both stamped, and processing both would wrap the range twice.
      const candidates = (MBR.leafBlocks && MBR.leafBlocks.length) ? MBR.leafBlocks : MBR.blocks;
      for (const block of candidates) {
        if (!range.intersectsNode(block)) continue;
        let start = 0;
        let end = block.textContent.length;
        if (range.startContainer === block || block.contains(range.startContainer)) {
          const value = pointOffset(block, range.startContainer, range.startOffset);
          if (value >= 0) start = value;
        }
        if (range.endContainer === block || block.contains(range.endContainer)) {
          const value = pointOffset(block, range.endContainer, range.endOffset);
          if (value >= 0) end = value;
        }
        if (end > start) {
          segments.push({ block, anchor: block.dataset.anchor, start, end, text: block.textContent.slice(start, end) });
        }
      }
      if (segments.length === 0) return null;
      return { segments, text, rect: range.getBoundingClientRect() };
    }

    function positionToolbar(captured) {
      const { rect } = captured;
      const barRect = { width: toolbar.offsetWidth || 240, height: toolbar.offsetHeight || 40 };
      let left = rect.left + rect.width / 2 - barRect.width / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - barRect.width - 8));
      let top = rect.top - barRect.height - 10;
      if (top < 8) top = Math.min(rect.bottom + 10, window.innerHeight - barRect.height - 8);
      toolbar.style.left = `${left}px`;
      toolbar.style.top = `${top}px`;
    }

    function createHighlights(captured) {
      const groupId = uid('g');
      const now = Date.now();
      const added = [];
      for (const segment of captured.segments) {
        const highlight = {
          id: uid('h'),
          chapterId: MBR.chapterId,
          anchor: segment.anchor,
          start: segment.start,
          end: segment.end,
          text: segment.text.trim().slice(0, 240),
          color: selectedColor,
          note: '',
          createdAt: now,
          groupId,
        };
        store.highlights.push(highlight);
        added.push(highlight);
      }
      if (!save()) {
        for (const highlight of added) store.highlights = store.highlights.filter(item => item.id !== highlight.id);
        return;
      }
      for (const highlight of added) {
        const block = blockForAnchor(highlight.anchor);
        if (block) wrapRange(block, highlight.start, highlight.end, `hl hl-${highlight.color}`, highlight.id);
      }
      renderLists();
    }

    function copySelection(text) {
      const done = () => showToast('Copied');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
      } else {
        fallbackCopy(text, done);
      }
    }

    function fallbackCopy(text, done) {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand('copy');
        done();
      } catch {
        /* copy unsupported; selection stays for manual copy */
      }
      area.remove();
    }

    let settleTimer = 0;

    function onSelectionChanged() {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        const captured = captureSelection();
        if (!captured) {
          hideToolbar();
          return;
        }
        pendingSelection = captured;
        toolbar.hidden = false;
        positionToolbar(captured);
      }, 300); // let touch selection handles settle before showing the bar
    }

    // ── Bookmarks ───────────────────────────────────────────────

    const bookmarkButton = document.querySelector('[data-bookmark-toggle]');

    function bookmarkAtTop() {
      return store.bookmarks.find(item => item.chapterId === MBR.chapterId && item.anchor === currentAnchor());
    }

    function currentAnchor() {
      const block = MBR.currentTopBlock();
      return block ? block.dataset.anchor : null;
    }

    function syncBookmarkButton() {
      if (!bookmarkButton) return;
      const saved = Boolean(bookmarkAtTop());
      bookmarkButton.classList.toggle('active', saved);
      bookmarkButton.setAttribute('aria-pressed', String(saved));
    }

    function toggleBookmark() {
      const block = MBR.currentTopBlock();
      if (!block) return;
      const anchor = block.dataset.anchor;
      const existing = store.bookmarks.find(item => item.chapterId === MBR.chapterId && item.anchor === anchor);
      if (existing) {
        store.bookmarks = store.bookmarks.filter(item => item !== existing);
        save();
        showToast('Bookmark removed');
      } else {
        const bookmark = {
          id: uid('b'),
          chapterId: MBR.chapterId,
          anchor,
          label: block.textContent.trim().replace(/\s+/g, ' ').slice(0, 60),
          createdAt: Date.now(),
        };
        store.bookmarks.push(bookmark);
        save();
        showToast('Bookmarked');
      }
      syncBookmarkButton();
      renderLists();
    }

    // ── Sidebar tabs + lists ────────────────────────────────────

    const tabs = Array.from(document.querySelectorAll('[data-sidebar-tab]'));
    const panes = {
      contents: document.getElementById('sidebar-tab-contents'),
      bookmarks: document.getElementById('sidebar-tab-bookmarks'),
      highlights: document.getElementById('sidebar-tab-highlights'),
    };

    function activateTab(name) {
      for (const tab of tabs) {
        const on = tab.dataset.sidebarTab === name;
        tab.classList.toggle('selected', on);
        tab.setAttribute('aria-selected', String(on));
      }
      for (const [paneName, pane] of Object.entries(panes)) {
        if (pane) pane.hidden = paneName !== name;
      }
    }

    function chapterMeta(chapterId) {
      const index = MBR.chapters.indexOf(chapterId);
      const titleEl = Array.from(document.querySelectorAll('#sidebar-tab-contents a'))
        .find(anchor => anchor.getAttribute('href') === `/${MBR.bookId}/${chapterId}`);
      const title = titleEl ? titleEl.textContent.replace(/^\s*\d+\s*/, '').trim() : chapterId;
      return { number: index >= 0 ? index + 1 : '?', title };
    }

    function navigateTo(chapterId, anchor) {
      if (chapterId === MBR.chapterId) {
        if (!MBR.goToAnchor(anchor)) showToast('Paragraph changed or removed');
        document.getElementById('sidebar-toggle').checked = false;
      } else {
        window.location.href = `/${encodeURIComponent(MBR.bookId)}/${encodeURIComponent(chapterId)}?goto=${encodeURIComponent(anchor)}`;
      }
    }

    function makeItem({ label, color, stale, note, onJump, onDelete, onNote, showNote }) {
      const item = document.createElement('div');
      item.className = 'annot-item' + (stale ? ' stale' : '');

      const jump = document.createElement('button');
      jump.type = 'button';
      jump.className = 'annot-jump';
      if (color) {
        const swatch = document.createElement('span');
        swatch.className = `hl-dot hl-dot-${color}`;
        jump.appendChild(swatch);
      }
      const text = document.createElement('span');
      text.className = 'annot-label';
      text.textContent = label; // escaped by textContent
      jump.appendChild(text);
      jump.addEventListener('click', onJump);
      item.appendChild(jump);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'annot-delete';
      remove.setAttribute('aria-label', 'Delete');
      remove.textContent = '✕';
      remove.addEventListener('click', onDelete);
      item.appendChild(remove);

      if (showNote) {
        const noteField = document.createElement('textarea');
        noteField.className = 'annot-note';
        noteField.rows = 2;
        noteField.placeholder = 'Add a note…';
        noteField.value = note || '';
        noteField.addEventListener('blur', () => {
          const value = noteField.value.trim();
          if (value !== (note || '')) onNote(value);
        });
        item.appendChild(noteField);
      }
      return item;
    }

    function unwrapHighlight(id) {
      // Highlight ids are alphanumeric (uid()), safe for the attribute selector.
      for (const mark of document.querySelectorAll(`mark.hl[data-hl-id="${id}"]`)) {
        const parent = mark.parentNode;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
      }
    }

    function renderLists() {
      const bookmarksList = document.getElementById('bookmarks-items');
      const highlightsList = document.getElementById('highlights-items');
      if (bookmarksList) {
        bookmarksList.replaceChildren();
        const sorted = store.bookmarks.slice().sort((a, b) =>
          (MBR.chapters.indexOf(a.chapterId) - MBR.chapters.indexOf(b.chapterId)) || (a.createdAt - b.createdAt));
        for (const bookmark of sorted) {
          const meta = chapterMeta(bookmark.chapterId);
          const stale = bookmark.chapterId === MBR.chapterId && !blockForAnchor(bookmark.anchor);
          const item = makeItem({
            label: `${meta.number}. ${bookmark.label}${stale ? ' (paragraph changed)' : ''}`,
            stale,
            onJump: () => navigateTo(bookmark.chapterId, bookmark.anchor),
            onDelete: () => {
              store.bookmarks = store.bookmarks.filter(item2 => item2 !== bookmark);
              save();
              renderLists();
              syncBookmarkButton();
            },
          });
          bookmarksList.appendChild(item);
        }
        if (sorted.length === 0) {
          bookmarksList.appendChild(emptyHint('No bookmarks yet. Tap 🔖 while reading.'));
        }
      }
      if (highlightsList) {
        highlightsList.replaceChildren();
        const sorted = store.highlights.slice().sort((a, b) =>
          (MBR.chapters.indexOf(a.chapterId) - MBR.chapters.indexOf(b.chapterId)) || (a.createdAt - b.createdAt));
        for (const highlight of sorted) {
          const meta = chapterMeta(highlight.chapterId);
          const stale = highlight.chapterId === MBR.chapterId && !blockForAnchor(highlight.anchor);
          const item = makeItem({
            label: `${meta.number}. ${highlight.text}${stale ? ' (paragraph changed)' : ''}`,
            color: highlight.color,
            stale,
            note: highlight.note,
            showNote: true,
            onJump: () => navigateTo(highlight.chapterId, highlight.anchor),
            onDelete: () => {
              unwrapHighlight(highlight.id);
              store.highlights = store.highlights.filter(item2 => item2 !== highlight);
              save();
              renderLists();
            },
            onNote: value => {
              highlight.note = value;
              save();
            },
          });
          highlightsList.appendChild(item);
        }
        if (sorted.length === 0) {
          highlightsList.appendChild(emptyHint('No highlights yet. Select text while reading.'));
        }
      }
    }

    function emptyHint(message) {
      const hint = document.createElement('p');
      hint.className = 'annot-empty';
      hint.textContent = message;
      return hint;
    }

    // ── Export ──────────────────────────────────────────────────

    function exportMarkdown() {
      if (store.highlights.length === 0) {
        showToast('Nothing to export yet');
        return;
      }
      const bookTitle = document.querySelector('.sidebar .subtitle')?.firstChild?.textContent?.trim() || MBR.bookId;
      const lines = [`# ${bookTitle} — highlights`, ''];
      for (const chapterId of MBR.chapters) {
        const chapterHighlights = store.highlights.filter(item => item.chapterId === chapterId);
        if (chapterHighlights.length === 0) continue;
        const meta = chapterMeta(chapterId);
        lines.push(`## ${meta.number}. ${meta.title}`, '');
        for (const highlight of chapterHighlights) {
          lines.push(`> ${highlight.text.replace(/\n+/g, ' ')}`);
          if (highlight.note) lines.push(`>`, `> Note: ${highlight.note.replace(/\n+/g, ' ')}`);
          lines.push('', `[Open chapter](/${encodeURIComponent(MBR.bookId)}/${encodeURIComponent(chapterId)}?goto=${encodeURIComponent(highlight.anchor)})`, '');
        }
      }
      const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${MBR.bookId}-highlights.md`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }

    // ── Boot ────────────────────────────────────────────────────

    applyHighlights();
    buildToolbar();
    document.addEventListener('selectionchange', onSelectionChanged);
    window.addEventListener('scroll', () => hideToolbar(), { passive: true });
    document.addEventListener('pointerdown', event => {
      if (!event.target.closest('.hl-toolbar')) hideToolbar();
    }, true);

    if (bookmarkButton) bookmarkButton.addEventListener('click', toggleBookmark);
    for (const tab of tabs) {
      tab.addEventListener('click', () => activateTab(tab.dataset.sidebarTab));
    }
    const exportButton = document.querySelector('[data-export-highlights]');
    if (exportButton) exportButton.addEventListener('click', exportMarkdown);

    renderLists();
    syncBookmarkButton();

    // Bookmark state follows scrolling.
    let syncScheduled = false;
    window.addEventListener('scroll', () => {
      if (syncScheduled) return;
      syncScheduled = true;
      window.requestAnimationFrame(() => {
        syncScheduled = false;
        syncBookmarkButton();
      });
    }, { passive: true });

    // URL q= param is handled by search.js; nothing to do here.
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
