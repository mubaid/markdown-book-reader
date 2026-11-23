'use strict';

// Read-aloud via the Web Speech API. Reader-only.
// Capability gate first: if this browser has no speech synthesis, no buttons
// are rendered at all. Voice + rate come from the shared settings store.
//
// Known limits (also in README): mobile browsers may suspend speech when the
// screen locks or the tab hides — iOS is the strictest. This is screen-on
// read-aloud, and the help text says so.
(function () {
  const MAX_CHUNK = 200; // Chrome truncates long utterances; keep chunks short.

  if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) return;

  function safeParse(value) {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function readSettings() {
    try {
      const parsed = safeParse(localStorage.getItem('markdown-book-reader:settings'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  // Split text into ≤MAX_CHUNK pieces at sentence boundaries where possible.
  function chunkText(text) {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return [];
    const sentences = clean.match(/[^.!?…]+[.!?…]*\s*/g) || [clean];
    const chunks = [];
    let current = '';
    for (const sentence of sentences) {
      const piece = sentence.trim();
      if (piece.length > MAX_CHUNK) {
        if (current) { chunks.push(current); current = ''; }
        // Hard-split very long sentences at word boundaries.
        let rest = piece;
        while (rest.length > MAX_CHUNK) {
          let cut = rest.lastIndexOf(' ', MAX_CHUNK);
          if (cut < 40) cut = MAX_CHUNK;
          chunks.push(rest.slice(0, cut).trim());
          rest = rest.slice(cut).trim();
        }
        if (rest) current = rest;
      } else if ((current + ' ' + piece).trim().length <= MAX_CHUNK) {
        current = (current + ' ' + piece).trim();
      } else {
        if (current) chunks.push(current);
        current = piece;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  function init() {
    const MBR = window.MBR;
    if (!MBR || !MBR.blocks || MBR.blocks.length === 0) return;

    // ── UI: play/pause + stop, only rendered because TTS is supported ──
    const actions = document.querySelector('.reader-actions');
    if (!actions) return;

    const playButton = document.createElement('button');
    playButton.type = 'button';
    playButton.className = 'meta-button';
    playButton.setAttribute('aria-label', 'Read aloud');
    playButton.textContent = '▶';

    const stopButton = document.createElement('button');
    stopButton.type = 'button';
    stopButton.className = 'meta-button';
    stopButton.setAttribute('aria-label', 'Stop reading');
    stopButton.textContent = '⏹';
    stopButton.hidden = true;

    actions.insertBefore(stopButton, actions.firstChild);
    actions.insertBefore(playButton, stopButton);

    const help = document.createElement('div');
    help.className = 'tts-help';
    help.hidden = true;
    help.textContent = 'Read-aloud works while the screen is on. Locking the screen or switching tabs may stop speech (browser limit).';
    actions.parentElement.insertAdjacentElement('afterend', help); // directly after .reader-meta

    // ── Engine ──────────────────────────────────────────────────

    let queue = []; // [{ text, block, last }]
    let cursor = -1;
    let playing = false;
    let paused = false;
    // Bumped on every start/stop. Utterance events fire asynchronously, so a
    // stale onend/onend from a cancelled utterance must not touch the queue
    // (it would skip chunks or auto-advance to the next chapter after Stop).
    let generation = 0;
    let keepAlive = 0;

    function preferredVoice() {
      const settings = readSettings();
      const voices = window.speechSynthesis.getVoices();
      if (settings.ttsVoiceURI) {
        const chosen = voices.find(voice => voice.voiceURI === settings.ttsVoiceURI);
        if (chosen) return chosen;
      }
      const lang = (document.documentElement.lang || 'en').slice(0, 2);
      return voices.find(voice => voice.lang.startsWith(lang)) || voices[0] || null;
    }

    function rate() {
      const value = Number(readSettings().ttsRate);
      return Math.min(1.5, Math.max(0.7, value || 1));
    }

    function setActive(block) {
      for (const mark of document.querySelectorAll('.tts-active')) mark.classList.remove('tts-active');
      if (block) {
        block.classList.add('tts-active');
        block.scrollIntoView({ block: 'nearest' });
      }
    }

    function buildQueueFrom(fromBlock) {
      // Innermost blocks only: containers (blockquote, loose list items) and
      // their paragraphs are both stamped, so reading MBR.blocks would speak
      // every quote/list item twice.
      const source = (MBR.leafBlocks && MBR.leafBlocks.length) ? MBR.leafBlocks : MBR.blocks;
      let startIndex = 0;
      if (fromBlock) {
        const exact = source.indexOf(fromBlock);
        if (exact >= 0) {
          startIndex = exact;
        } else {
          // currentTopBlock() can return a container; begin at its first leaf.
          const inside = source.findIndex(block => fromBlock.contains(block));
          if (inside >= 0) startIndex = inside;
        }
      }
      queue = [];
      for (let i = startIndex; i < source.length; i += 1) {
        const block = source[i];
        const chunks = chunkText(block.textContent);
        for (const text of chunks) queue.push({ text, block });
      }
      cursor = 0;
    }

    function updateButtons() {
      playButton.classList.toggle('active', playing && !paused);
      playButton.textContent = playing && !paused ? '⏸' : '▶';
      playButton.setAttribute('aria-label', playing && !paused ? 'Pause reading' : 'Read aloud');
      stopButton.hidden = !playing && !paused;
      help.hidden = !playing && !paused;
    }

    function stop(options = {}) {
      generation += 1; // invalidate events from any in-flight utterance
      window.speechSynthesis.cancel();
      playing = false;
      paused = false;
      queue = [];
      cursor = -1;
      clearInterval(keepAlive);
      setActive(null);
      updateButtons();
      if (options.toast) window.MBRToast && window.MBRToast(options.toast);
    }

    function speakCurrent() {
      const item = queue[cursor];
      if (!item) {
        finishChapter();
        return;
      }
      const gen = generation;
      setActive(item.block);
      const utterance = new window.SpeechSynthesisUtterance(item.text);
      const voice = preferredVoice();
      if (voice) utterance.voice = voice;
      utterance.rate = rate();
      let advanced = false;
      const advance = () => {
        if (advanced || gen !== generation) return;
        advanced = true;
        cursor += 1;
        if (cursor < queue.length) speakCurrent();
        else finishChapter();
      };
      utterance.onend = advance;
      utterance.onerror = event => {
        if (advanced || gen !== generation) return;
        advanced = true;
        const error = event && event.error;
        if (error === 'interrupted' || error === 'canceled') return;
        if (error === 'not-allowed') {
          // iOS refuses speech without a user gesture (e.g. ?tts=1 chapter
          // auto-advance). Keep the position; tapping ▶ resumes from here.
          playing = false;
          paused = false;
          clearInterval(keepAlive);
          updateButtons();
          window.MBRToast && window.MBRToast('Tap ▶ to continue reading');
          return;
        }
        // A failing voice must not fast-walk the queue (that would skip the
        // whole chapter and auto-navigate in milliseconds).
        stop({ toast: 'Read-aloud stopped — this browser refused to speak' });
      };
      window.speechSynthesis.speak(utterance);
    }

    function finishChapter() {
      if (!playing) return;
      const nextId = MBR.chapters[MBR.chapterIndex + 1];
      if (nextId) {
        // Auto-advance; the ?tts=1 param makes the next page start speaking.
        window.location.href = `/${encodeURIComponent(MBR.bookId)}/${encodeURIComponent(nextId)}?tts=1`;
        return;
      }
      stop({ toast: 'Reached the end of the book' });
    }

    function start(fromBlock) {
      if (playing) return;
      generation += 1; // stale events from a previous session must not advance this queue
      window.speechSynthesis.cancel(); // clear any leftover queue from iOS quirks
      buildQueueFrom(fromBlock);
      playing = true;
      paused = false;
      updateButtons();
      speakCurrent();
      // Chrome sometimes stalls long queues; nudging keeps speech flowing.
      clearInterval(keepAlive);
      keepAlive = setInterval(() => {
        if (playing && !paused && window.speechSynthesis.paused) window.speechSynthesis.resume();
      }, 10000);
    }

    playButton.addEventListener('click', () => {
      if (!playing) {
        start(MBR.currentTopBlock());
      } else if (paused) {
        paused = false;
        window.speechSynthesis.resume();
        updateButtons();
      } else {
        paused = true;
        window.speechSynthesis.pause();
        updateButtons();
      }
    });

    stopButton.addEventListener('click', () => stop());

    // Full reset (not just cancel): bfcache restores must not show a stale
    // "playing" UI, and the keep-alive interval must not survive the page.
    window.addEventListener('pagehide', () => stop());

    // Chapter auto-advance entry: speak from the top of this chapter.
    const params = new URLSearchParams(window.location.search);
    if (params.get('tts') === '1') {
      start(null);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
