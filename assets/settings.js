'use strict';

// Settings store + reader preferences panel (theme, typography, width, TTS voice).
// Loads on every page (catalog, author, reader). Writes through on change;
// if localStorage is blocked the panel still works for the current session.
(function () {
  const SETTINGS_KEY = 'markdown-book-reader:settings';

  const DEFAULTS = {
    theme: 'auto',
    fontSize: 19,        // px, slider 15–24
    fontFamily: 'serif', // 'serif' | 'sans'
    contentWidth: 720,   // px, slider 520–960
    ttsVoiceURI: null,
    ttsRate: 1,          // 0.7–1.5
  };

  const SERIF_STACK = "Georgia, 'Times New Roman', Times, serif";
  const SANS_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

  // In-session copy; persistence is best-effort.
  let settings = Object.assign({}, DEFAULTS);

  function safeParse(value) {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function load() {
    try {
      const stored = safeParse(localStorage.getItem(SETTINGS_KEY));
      if (stored && typeof stored === 'object') {
        for (const key of Object.keys(DEFAULTS)) {
          if (stored[key] !== undefined && stored[key] !== null) settings[key] = stored[key];
        }
      }
    } catch {
      /* storage blocked: session-only settings */
    }
    clampAll();
  }

  function clampAll() {
    settings.fontSize = Math.min(24, Math.max(15, Number(settings.fontSize) || DEFAULTS.fontSize));
    settings.contentWidth = Math.min(960, Math.max(520, Number(settings.contentWidth) || DEFAULTS.contentWidth));
    settings.ttsRate = Math.min(1.5, Math.max(0.7, Number(settings.ttsRate) || DEFAULTS.ttsRate));
    const themes = ['auto', 'light', 'sepia', 'dark', 'oled'];
    if (!themes.includes(settings.theme)) settings.theme = 'auto';
    if (settings.fontFamily !== 'sans') settings.fontFamily = 'serif';
  }

  function persist() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* storage full or blocked: settings apply for this session only */
    }
  }

  function save(patch) {
    Object.assign(settings, patch);
    clampAll();
    apply();
    persist();
  }

  // Same rules as the inline bootstrap in book.js (keep them in sync).
  const THEME_COLORS = { light: '#faf9f6', sepia: '#f2ead8', dark: '#1a1a1a', oled: '#000000' };

  function apply() {
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    root.dataset.font = settings.fontFamily;
    root.style.setProperty('--reader-font-size', `${settings.fontSize}px`);
    root.style.setProperty('--reader-font', settings.fontFamily === 'sans' ? SANS_STACK : SERIF_STACK);
    root.style.setProperty('--content-max', `${settings.contentWidth}px`);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      const color = settings.theme === 'auto' ? (dark ? '#1a1a1a' : '#faf9f6') : THEME_COLORS[settings.theme];
      meta.setAttribute('content', color || '#faf9f6');
    }
  }

  function ttsSupported() {
    return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  }

  // ── Panel shell (reused by search.js for its own panel) ─────────

  function isMobile() {
    return window.matchMedia('(max-width: 768px)').matches;
  }

  function buildPanel(id, title) {
    const panel = document.createElement('div');
    panel.className = 'reader-panel';
    panel.id = id;
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', title);
    panel.innerHTML = `<div class="panel-head"><span class="panel-title">${title}</span>`
      + `<button class="panel-close" type="button" aria-label="Close">✕</button></div>`;
    document.body.appendChild(panel);
    panel.querySelector('.panel-close').addEventListener('click', () => closePanel(panel));
    return panel;
  }

  function closePanel(panel) {
    panel.hidden = true;
    if (panel._toggle) panel._toggle.setAttribute('aria-expanded', 'false');
    // Keep the backdrop while any other panel is still open.
    if (!document.querySelector('.reader-panel:not([hidden])')) {
      const backdrop = document.getElementById('panel-backdrop');
      if (backdrop) backdrop.remove();
    }
  }

  function openPanel(panel, toggleButton, focus = true) {
    panel.hidden = false;
    panel._toggle = toggleButton || null;
    if (toggleButton) toggleButton.setAttribute('aria-expanded', 'true');
    if (isMobile()) {
      let backdrop = document.getElementById('panel-backdrop');
      if (!backdrop) {
        backdrop = document.createElement('div');
        backdrop.id = 'panel-backdrop';
        backdrop.className = 'panel-backdrop';
        backdrop.addEventListener('click', () => {
          document.querySelectorAll('.reader-panel:not([hidden])').forEach(closePanel);
        });
        document.body.appendChild(backdrop);
      }
    }
    if (focus) {
      const focusTarget = panel.querySelector('input, select, button:not(.panel-close)');
      if (focusTarget) focusTarget.focus();
    }
  }

  window.MBRPanel = { build: buildPanel, open: openPanel, close: closePanel, isMobile };

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      document.querySelectorAll('.reader-panel:not([hidden])').forEach(closePanel);
    }
  });

  // ── Settings panel UI ───────────────────────────────────────────

  const THEMES = [
    { id: 'auto', label: 'Auto', bg: 'linear-gradient(135deg, #faf9f6 50%, #1a1a1a 50%)' },
    { id: 'light', label: 'Light', bg: '#faf9f6' },
    { id: 'sepia', label: 'Sepia', bg: '#f2e9d5' },
    { id: 'dark', label: 'Dark', bg: '#1a1a1a' },
    { id: 'oled', label: 'OLED', bg: '#000' },
  ];

  function renderControls(panel) {
    const body = document.createElement('div');
    body.className = 'panel-body';

    // Theme swatches
    const themeGroup = el('div', 'panel-group');
    themeGroup.appendChild(label('Theme'));
    const swatches = el('div', 'theme-swatches');
    for (const theme of THEMES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'theme-swatch';
      btn.dataset.themeOption = theme.id;
      btn.setAttribute('aria-label', `${theme.label} theme`);
      btn.style.setProperty('--swatch-bg', theme.bg);
      btn.innerHTML = `<span class="swatch-circle"></span><span class="swatch-label">${theme.label}</span>`;
      btn.addEventListener('click', () => {
        save({ theme: theme.id });
        syncControls();
      });
      swatches.appendChild(btn);
    }
    themeGroup.appendChild(swatches);

    // Font size
    const sizeGroup = el('div', 'panel-group');
    const sizeLabel = label('Font size');
    const sizeValue = el('span', 'control-value');
    sizeLabel.appendChild(sizeValue);
    const sizeSlider = slider(15, 24, 1);
    sizeSlider.addEventListener('input', () => {
      save({ fontSize: Number(sizeSlider.value) });
      sizeValue.textContent = `${settings.fontSize} px`;
    });
    sizeGroup.appendChild(sizeLabel);
    sizeGroup.appendChild(sizeSlider);

    // Typeface
    const fontGroup = el('div', 'panel-group');
    fontGroup.appendChild(label('Typeface'));
    const fontRow = el('div', 'segmented');
    for (const id of ['serif', 'sans']) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'segment';
      btn.dataset.fontOption = id;
      btn.textContent = id === 'serif' ? 'Serif' : 'Sans';
      btn.style.fontFamily = id === 'serif' ? SERIF_STACK : SANS_STACK;
      btn.addEventListener('click', () => {
        save({ fontFamily: id });
        syncControls();
      });
      fontRow.appendChild(btn);
    }
    fontGroup.appendChild(fontRow);

    // Content width
    const widthGroup = el('div', 'panel-group');
    const widthLabel = label('Text width');
    const widthValue = el('span', 'control-value');
    widthLabel.appendChild(widthValue);
    const widthSlider = slider(520, 960, 20);
    widthSlider.addEventListener('input', () => {
      save({ contentWidth: Number(widthSlider.value) });
      widthValue.textContent = `${settings.contentWidth} px`;
    });
    widthGroup.appendChild(widthLabel);
    widthGroup.appendChild(widthSlider);

    // TTS voice + rate (only when speech synthesis exists in this browser)
    const ttsGroup = el('div', 'panel-group');
    ttsGroup.hidden = true;
    const voiceLabel = label('Read-aloud voice');
    const voiceSelect = document.createElement('select');
    voiceSelect.className = 'panel-select';
    const rateLabel = label('Speech rate');
    const rateValue = el('span', 'control-value');
    rateLabel.appendChild(rateValue);
    const rateSlider = slider(0.7, 1.5, 0.05);
    rateSlider.addEventListener('input', () => {
      save({ ttsRate: Number(rateSlider.value) });
      rateValue.textContent = `${Number(settings.ttsRate).toFixed(2)}×`;
    });
    ttsGroup.appendChild(voiceLabel);
    ttsGroup.appendChild(voiceSelect);
    ttsGroup.appendChild(rateLabel);
    ttsGroup.appendChild(rateSlider);

    body.appendChild(themeGroup);
    body.appendChild(sizeGroup);
    body.appendChild(fontGroup);
    body.appendChild(widthGroup);
    body.appendChild(ttsGroup);

    const resetRow = el('div', 'panel-group');
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'panel-reset';
    reset.textContent = 'Reset to defaults';
    reset.addEventListener('click', () => {
      settings = Object.assign({}, DEFAULTS);
      apply();
      persist();
      syncControls();
    });
    resetRow.appendChild(reset);
    body.appendChild(resetRow);
    panel.appendChild(body);

    function refreshVoices() {
      if (!ttsSupported()) return;
      ttsGroup.hidden = false;
      const voices = window.speechSynthesis.getVoices();
      if (!voices.length) return;
      const pageLang = (document.documentElement.lang || 'en').slice(0, 2);
      const sorted = voices.slice().sort((a, b) => {
        const aLocal = a.lang.startsWith(pageLang) ? 0 : 1;
        const bLocal = b.lang.startsWith(pageLang) ? 0 : 1;
        return (aLocal - bLocal) || a.name.localeCompare(b.name);
      });
      voiceSelect.replaceChildren();
      const automatic = document.createElement('option');
      automatic.value = '';
      automatic.textContent = 'Automatic (browser default)';
      voiceSelect.appendChild(automatic);
      for (const voice of sorted) {
        const option = document.createElement('option');
        option.value = voice.voiceURI;
        option.textContent = `${voice.name} (${voice.lang})`;
        voiceSelect.appendChild(option);
      }
      voiceSelect.value = settings.ttsVoiceURI || '';
    }

    voiceSelect.addEventListener('change', () => save({ ttsVoiceURI: voiceSelect.value || null }));
    if (ttsSupported()) {
      window.speechSynthesis.addEventListener('voiceschanged', refreshVoices);
      refreshVoices();
    }

    function syncControls() {
      sizeSlider.value = String(settings.fontSize);
      sizeValue.textContent = `${settings.fontSize} px`;
      widthSlider.value = String(settings.contentWidth);
      widthValue.textContent = `${settings.contentWidth} px`;
      rateSlider.value = String(settings.ttsRate);
      rateValue.textContent = `${Number(settings.ttsRate).toFixed(2)}×`;
      voiceSelect.value = settings.ttsVoiceURI || '';
      for (const btn of swatches.querySelectorAll('.theme-swatch')) {
        btn.classList.toggle('selected', btn.dataset.themeOption === settings.theme);
      }
      for (const btn of fontRow.querySelectorAll('.segment')) {
        btn.classList.toggle('selected', btn.dataset.fontOption === settings.fontFamily);
      }
      window.dispatchEvent(new CustomEvent('mbr-settings-changed', { detail: settings }));
    }

    window.MBRSettingsSync = syncControls;
    syncControls();
  }

  function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function label(text) {
    const node = el('label', 'panel-label');
    node.appendChild(document.createTextNode(text + ' '));
    return node;
  }

  function slider(min, max, step) {
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.className = 'panel-slider';
    return input;
  }

  // ── Boot ────────────────────────────────────────────────────────

  // Follow OS scheme changes while the theme is "auto" (theme-color meta).
  if (window.matchMedia) {
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    if (scheme.addEventListener) {
      scheme.addEventListener('change', () => {
        if (settings.theme === 'auto') apply();
      });
    }
  }

  function init() {
    load();
    apply();

    const triggers = document.querySelectorAll('[data-settings-toggle]');
    if (triggers.length === 0) return;

    const panel = buildPanel('settings-panel', 'Reading settings');
    renderControls(panel);
    for (const trigger of triggers) {
      trigger.setAttribute('aria-expanded', 'false');
      trigger.addEventListener('click', () => {
        if (panel.hidden) openPanel(panel, trigger);
        else closePanel(panel);
        if (window.MBRSettingsSync) window.MBRSettingsSync();
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
