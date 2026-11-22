'use strict';

// In-book search: panel UI against GET /api/<bookId>/search, plus
// <mark class="search-hit"> marking in the current chapter. Reader-only.
//
// Server matches raw lowercased text; here block selection uses
// MBR.normalize() (NFKC, punctuation-stripped) and marking wraps
// case-insensitive raw occurrences. A normalized-only match (e.g. different
// diacritics handling) may therefore mark slightly differently than the
// snippet — accepted trade-off, noted in the plan.
(function () {
  function safeParse(value) {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function init() {
    const MBR = window.MBR;
    const toggle = document.querySelector('[data-search-toggle]');
    if (!MBR || !toggle || !window.MBRPanel) return;

    const panel = window.MBRPanel.build('search-panel', 'Search this book');

    const body = document.createElement('div');
    body.className = 'panel-body';
    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'search-input';
    input.placeholder = 'Search this book…';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Search this book');
    const results = document.createElement('div');
    results.className = 'search-results';
    results.setAttribute('role', 'status');
    body.appendChild(input);
    body.appendChild(results);
    panel.appendChild(body);

    // Slim bar announcing per-chapter hit count.
    const bar = document.createElement('div');
    bar.className = 'search-bar';
    bar.hidden = true;
    document.body.appendChild(bar);

    let currentTerm = '';
    let lastResponse = null;

    // ── Marking ─────────────────────────────────────────────────

    function textNodes(root) {
      const nodes = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
      return nodes;
    }

    function wrapRange(root, start, end) {
      let pos = 0;
      const segments = [];
      for (const node of textNodes(root)) {
        const length = node.nodeValue.length;
        const segStart = Math.max(start, pos);
        const segEnd = Math.min(end, pos + length);
        if (segStart < segEnd) segments.push({ node, from: segStart - pos, to: segEnd - pos });
        pos += length;
      }
      for (const seg of segments.reverse()) {
        const target = seg.node;
        target.splitText(seg.to);
        const inside = target.splitText(seg.from);
        const mark = document.createElement('mark');
        mark.className = 'search-hit';
        target.parentNode.insertBefore(mark, inside);
        mark.appendChild(inside);
      }
      return segments.length;
    }

    function markBlock(block, needle) {
      const haystack = block.textContent.toLowerCase();
      const positions = [];
      let from = 0;
      for (;;) {
        const index = haystack.indexOf(needle, from);
        if (index === -1) break;
        positions.push([index, index + needle.length]);
        from = index + Math.max(1, needle.length);
      }
      let count = 0;
      // Wrap in reverse so earlier offsets stay valid.
      for (const [start, end] of positions.reverse()) count += wrapRange(block, start, end);
      return count;
    }

    function clearMarks() {
      for (const mark of document.querySelectorAll('mark.search-hit')) {
        const parent = mark.parentNode;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
      }
      bar.hidden = true;
    }

    function matchedBlocks(term) {
      const normalized = MBR.normalize(term);
      if (!normalized) return [];
      return MBR.blocks.filter(block => MBR.normalize(block.textContent).includes(normalized));
    }

    function markChapter(term) {
      clearMarks();
      currentTerm = term;
      const needle = term.toLowerCase();
      let count = 0;
      for (const block of matchedBlocks(term)) count += markBlock(block, needle);
      return count;
    }

    function showBar(count) {
      bar.replaceChildren();
      const text = document.createElement('span');
      text.textContent = `${count} match${count === 1 ? '' : 'es'} in this chapter`;
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'search-bar-clear';
      clear.textContent = '✕ clear';
      clear.addEventListener('click', clearSearch);
      bar.appendChild(text);
      bar.appendChild(clear);
      bar.hidden = count === 0;
    }

    function clearSearch() {
      clearMarks();
      currentTerm = '';
      window.history.replaceState(null, '', window.location.pathname);
    }

    // ── Panel + results ─────────────────────────────────────────

    function openPanel(focus = true) {
      window.MBRPanel.open(panel, toggle, focus);
      toggle.setAttribute('aria-expanded', 'true');
    }

    function closePanel() {
      window.MBRPanel.close(panel);
      toggle.setAttribute('aria-expanded', 'false');
    }

    function renderResults(payload) {
      lastResponse = payload;
      results.replaceChildren();
      if (!payload.results.length) {
        const empty = document.createElement('p');
        empty.className = 'search-empty-hint';
        empty.textContent = 'No matches in this book.';
        results.appendChild(empty);
        return;
      }
      const summary = document.createElement('p');
      summary.className = 'search-summary';
      summary.textContent = `${payload.total} match${payload.total === 1 ? '' : 'es'} in ${payload.results.length} chapter${payload.results.length === 1 ? '' : 's'}`;
      results.appendChild(summary);
      for (const hit of payload.results) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'search-result';
        const title = document.createElement('span');
        title.className = 'search-result-title';
        title.textContent = `${hit.chapterIndex + 1}. ${hit.chapterTitle}`;
        const snippet = document.createElement('span');
        snippet.className = 'search-result-snippet';
        snippet.textContent = hit.snippet;
        const count = document.createElement('span');
        count.className = 'search-result-count';
        count.textContent = String(hit.matchCount);
        item.appendChild(title);
        item.appendChild(snippet);
        item.appendChild(count);
        item.addEventListener('click', () => openResult(hit));
        results.appendChild(item);
      }
    }

    function openResult(hit) {
      const term = lastResponse ? lastResponse.query : currentTerm;
      if (hit.chapterId === MBR.chapterId) {
        const count = markChapter(term);
        showBar(count);
        const blocks = matchedBlocks(term);
        if (blocks.length > 0) MBR.goToAnchor(blocks[0].dataset.anchor);
        closePanel();
      } else {
        // The target page's search.js marks matches and jumps from ?q=.
        window.location.href = `/${encodeURIComponent(MBR.bookId)}/${encodeURIComponent(hit.chapterId)}?q=${encodeURIComponent(lastResponse.query)}`;
      }
    }

    let debounceTimer = 0;

    function runSearch(term) {
      fetch(`/api/${encodeURIComponent(MBR.bookId)}/search?q=${encodeURIComponent(term)}`)
        .then(response => {
          if (!response.ok) throw new Error(String(response.status));
          return response.json();
        })
        .then(payload => {
          if (payload.query === input.value.trim()) renderResults(payload);
        })
        .catch(() => {
          // Offline or server unreachable: say so instead of spinning.
          results.replaceChildren();
          const hint = document.createElement('p');
          hint.className = 'search-empty-hint';
          hint.textContent = 'Search needs the server.';
          results.appendChild(hint);
        });
    }

    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      const term = input.value.trim();
      if (term.length < 2) {
        results.replaceChildren();
        return;
      }
      debounceTimer = setTimeout(() => runSearch(term), 250);
    });

    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const first = results.querySelector('.search-result');
        if (first) first.click();
      }
    });

    toggle.addEventListener('click', () => {
      if (panel.hidden) {
        openPanel();
        if (lastResponse) renderResults(lastResponse);
      } else {
        closePanel();
      }
    });

    // "/" focuses search when not already typing in a field.
    document.addEventListener('keydown', event => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement
        && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) {
        return;
      }
      event.preventDefault();
      openPanel();
      input.focus();
      input.select();
    });

    // ── On load: ?q= marks matches and jumps to the first one ───

    const params = new URLSearchParams(window.location.search);
    const initialTerm = (params.get('q') || '').trim();
    if (initialTerm.length >= 2) {
      const count = markChapter(initialTerm);
      showBar(count);
      if (count > 0) {
        const blocks = matchedBlocks(initialTerm);
        if (blocks.length > 0 && !params.get('goto')) MBR.goToAnchor(blocks[0].dataset.anchor);
      }
      // Show the panel without focusing the input: on phones the keyboard
      // would pop up right after tapping a search result.
      openPanel(false);
      input.value = initialTerm;
      runSearch(initialTerm);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
