/*
 * On-Screen Keyboard, Dedicated Inverted-T Arrow Pad & Native Device Keyboard
 * Bridge for the Plexus P/20 Web Emulator (xterm.js + xterm-pty).
 *
 * Three modes:
 * - Full: QWERTY + UNIX toolbar + inverted-T VT100 Arrow Pad
 * - Pad: jumbo thumb-friendly inverted-T Arrows + SPACE / ENTER / BKSP / CTRL+C
 * - Device: built-in iOS / Android soft keyboard paired with a compact UNIX
 *   accessory bar (ESC, TAB, CTRL+C, CTRL+D, CTRL+Z, sticky CTRL, and inline
 *   arrow keys) that stays open without dismissing the keyboard.
 */

const SHIFT_DOUBLE_TAP_MS = 380;
const REPEAT_DELAY_MS = 340;
const REPEAT_INTERVAL_MS = 80;
const NATIVE_SENTINEL = '\u200B';

const SMART_CHAR_MAP = {
  '\u2018': "'",
  '\u2019': "'",
  '\u201a': "'",
  '\u201b': "'",
  '\u201c': '"',
  '\u201d': '"',
  '\u201e': '"',
  '\u201f': '"',
  '\u2013': '-',
  '\u2014': '--',
  '\u2026': '...',
  '\u00a0': ' ',
  '\u00b4': "'",
  '\u02dc': '~'
};

const NATIVE_SPECIAL_KEYS = {
  Escape: '\x1b',
  Tab: '\t',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F',
  Delete: '\x1b[3~'
};

const TOOLBAR_KEYS = [
  { label: 'ESC', seq: '\x1b', repeat: false, title: 'Escape (0x1B)' },
  { label: 'TAB', seq: '\t', repeat: true, title: 'Tab (0x09)' },
  {
    label: 'CTRL+C',
    seq: '\x03',
    repeat: false,
    cls: 'osk-key-warn',
    title: 'Send Ctrl+C / Interrupt (0x03)'
  },
  { label: 'CTRL+D', seq: '\x04', repeat: false, title: 'Send Ctrl+D / EOF (0x04)' },
  { label: 'CTRL+Z', seq: '\x1a', repeat: false, title: 'Send Ctrl+Z (0x1A)' }
];

const QWERTY_ROWS = [
  [
    { normal: '1', shifted: '!' },
    { normal: '2', shifted: '@' },
    { normal: '3', shifted: '#' },
    { normal: '4', shifted: '$' },
    { normal: '5', shifted: '%' },
    { normal: '6', shifted: '^' },
    { normal: '7', shifted: '&' },
    { normal: '8', shifted: '*' },
    { normal: '9', shifted: '(' },
    { normal: '0', shifted: ')' },
    { normal: '-', shifted: '_' },
    { normal: '=', shifted: '+' },
    {
      label: '\u232B',
      seq: '\x7f',
      repeat: true,
      weight: 1.55,
      cls: 'osk-key-fn',
      title: 'Backspace (0x7F)',
      ariaLabel: 'Backspace'
    }
  ],
  [
    { normal: 'q', shifted: 'Q' },
    { normal: 'w', shifted: 'W' },
    { normal: 'e', shifted: 'E' },
    { normal: 'r', shifted: 'R' },
    { normal: 't', shifted: 'T' },
    { normal: 'y', shifted: 'Y' },
    { normal: 'u', shifted: 'U' },
    { normal: 'i', shifted: 'I' },
    { normal: 'o', shifted: 'O' },
    { normal: 'p', shifted: 'P' },
    { normal: '[', shifted: '{' },
    { normal: ']', shifted: '}' },
    { normal: '\\', shifted: '|', weight: 1.15 }
  ],
  [
    { normal: 'a', shifted: 'A' },
    { normal: 's', shifted: 'S' },
    { normal: 'd', shifted: 'D' },
    { normal: 'f', shifted: 'F' },
    { normal: 'g', shifted: 'G' },
    { normal: 'h', shifted: 'H' },
    { normal: 'j', shifted: 'J' },
    { normal: 'k', shifted: 'K' },
    { normal: 'l', shifted: 'L' },
    { normal: ';', shifted: ':' },
    { normal: "'", shifted: '"' },
    {
      label: 'ENTER',
      seq: '\r',
      repeat: false,
      weight: 1.9,
      cls: 'osk-key-enter',
      title: 'Enter / Return'
    }
  ],
  [
    {
      mod: 'shift',
      label: 'SHIFT',
      weight: 1.6,
      cls: 'osk-key-mod',
      title: 'Tap for Shift, double-tap for Caps Lock'
    },
    { normal: 'z', shifted: 'Z' },
    { normal: 'x', shifted: 'X' },
    { normal: 'c', shifted: 'C' },
    { normal: 'v', shifted: 'V' },
    { normal: 'b', shifted: 'B' },
    { normal: 'n', shifted: 'N' },
    { normal: 'm', shifted: 'M' },
    { normal: ',', shifted: '<' },
    { normal: '.', shifted: '>' },
    { normal: '/', shifted: '?' },
    { normal: '`', shifted: '~' }
  ],
  [
    {
      mod: 'ctrl',
      label: 'CTRL',
      weight: 1.45,
      cls: 'osk-key-mod',
      title: 'Ctrl modifier (tap to arm for next key)'
    },
    {
      label: 'SPACE',
      seq: ' ',
      repeat: true,
      weight: 6.2,
      cls: 'osk-key-space',
      title: 'Space bar'
    },
    {
      label: 'DEL',
      seq: '\x7f',
      repeat: true,
      weight: 1.45,
      cls: 'osk-key-fn',
      title: 'Delete / Backspace (0x7F)'
    }
  ]
];

function sanitizeMode(raw) {
  if (raw === 'pad') return 'pad';
  if (raw === 'native') return 'native';
  return 'full';
}

function normalizeSmartText(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    out += Object.prototype.hasOwnProperty.call(SMART_CHAR_MAP, ch)
      ? SMART_CHAR_MAP[ch]
      : ch;
  }
  return out;
}

function charToUnixSeq(ch, ctrlActive) {
  if (ch === '\r' || ch === '\n') return '\r';
  if (ch === '\t') return '\t';

  if (ctrlActive) {
    const upper = ch.toUpperCase();
    const code = upper.charCodeAt(0);
    if (code >= 65 && code <= 90) {
      return String.fromCharCode(code - 64);
    }
    if (ch === '[' || ch === '{') return '\x1b';
    if (ch === '\\' || ch === '|') return '\x1c';
    if (ch === ']' || ch === '}') return '\x1d';
    if (ch === '^' || ch === '6') return '\x1e';
    if (ch === '_' || ch === '-') return '\x1f';
    if (ch === ' ' || ch === '@') return '\x00';
  }

  const code = ch.charCodeAt(0);
  if (code >= 0x20 && code <= 0x7e) {
    return ch;
  }
  return null;
}

export function createOnScreenKeyboard(container, sendStr, options = {}) {
  if (!container) {
    return {
      isVisible: () => false,
      setVisible: () => {},
      toggleVisible: () => {},
      getMode: () => 'full',
      setMode: () => {},
      focusNativeInput: () => {},
      blurNativeInput: () => {},
      isNativeInputFocused: () => false,
      releaseAll: () => {}
    };
  }

  const onVisibilityChange =
    typeof options.onVisibilityChange === 'function' ? options.onVisibilityChange : () => {};
  const onModeChange =
    typeof options.onModeChange === 'function' ? options.onModeChange : () => {};
  const onNativeFocusChange =
    typeof options.onNativeFocusChange === 'function' ? options.onNativeFocusChange : () => {};

  const emit = (str) => {
    if (str && typeof sendStr === 'function') {
      sendStr(str);
    }
  };

  let visible = false;
  let mode = sanitizeMode(options.initialMode);
  let shiftState = 0; // 0 = off, 1 = one-shot, 2 = locked
  let ctrlArmed = false;
  let lastShiftTapAt = 0;

  let bodyFullEl = null;
  let bodyPadEl = null;
  let bodyNativeEl = null;
  let btnModeFull = null;
  let btnModePad = null;
  let btnModeNative = null;

  let nativeInput = null;
  let nativeInputWrap = null;
  let nativeLabelEl = null;
  let nativeOpenHintEl = null;
  let nativeDismissBtn = null;
  let nativeFocused = false;
  let nativeComposing = false;
  let nativeCommittedText = '';

  const printableButtons = [];
  const modButtons = { shift: [], ctrl: [] };
  const activePointers = new Map();

  let viewportSyncActive = false;

  function syncVisualViewportHeight() {
    if (typeof window === 'undefined' || !document.documentElement) return;
    const vv = window.visualViewport;
    if (vv && vv.height > 0) {
      document.documentElement.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
    } else if (window.innerHeight > 0) {
      document.documentElement.style.setProperty('--vvh', `${window.innerHeight}px`);
    }
  }

  function updateViewportTracking() {
    const active = Boolean(visible && mode === 'native' && nativeFocused);
    const shell = document.getElementById('app-shell');
    if (shell) {
      shell.classList.toggle('has-native-kb', active);
    }
    if (active === viewportSyncActive) {
      if (active) syncVisualViewportHeight();
      return;
    }
    viewportSyncActive = active;
    if (typeof window === 'undefined') return;
    const vv = window.visualViewport;
    if (active) {
      syncVisualViewportHeight();
      if (vv) {
        vv.addEventListener('resize', syncVisualViewportHeight);
        vv.addEventListener('scroll', syncVisualViewportHeight);
      }
      window.addEventListener('resize', syncVisualViewportHeight);
    } else {
      if (vv) {
        vv.removeEventListener('resize', syncVisualViewportHeight);
        vv.removeEventListener('scroll', syncVisualViewportHeight);
      }
      window.removeEventListener('resize', syncVisualViewportHeight);
      if (document.documentElement) {
        document.documentElement.style.removeProperty('--vvh');
      }
    }
  }

  function refreshNativeStatusUI() {
    if (!nativeInputWrap) return;
    nativeInputWrap.classList.toggle('is-focused', nativeFocused);
    nativeInputWrap.classList.toggle('is-ctrl-armed', ctrlArmed);

    if (nativeLabelEl) {
      if (ctrlArmed) {
        nativeLabelEl.textContent = nativeFocused
          ? 'CTRL armed \u2014 type next key'
          : 'CTRL armed \u2014 tap here to type';
      } else if (nativeFocused) {
        nativeLabelEl.textContent = 'Device keyboard active';
      } else {
        nativeLabelEl.textContent = 'Tap here for device keyboard';
      }
    }
    if (nativeOpenHintEl) {
      nativeOpenHintEl.hidden = nativeFocused;
    }
    if (nativeDismissBtn) {
      nativeDismissBtn.hidden = !nativeFocused;
    }
    updateViewportTracking();
  }

  function refreshModifierUI() {
    const shifted = shiftState > 0;
    for (const btn of modButtons.shift) {
      btn.classList.toggle('is-active', shiftState === 1);
      btn.classList.toggle('is-locked', shiftState === 2);
      btn.setAttribute('aria-pressed', String(shifted));
      btn.textContent = shiftState === 2 ? 'CAPS' : 'SHIFT';
    }
    for (const btn of modButtons.ctrl) {
      btn.classList.toggle('is-active', ctrlArmed);
      btn.setAttribute('aria-pressed', String(ctrlArmed));
    }
    for (const entry of printableButtons) {
      const { def, mainSpan, subSpan } = entry;
      const isLetter = def.normal >= 'a' && def.normal <= 'z';
      if (isLetter) {
        mainSpan.textContent = shifted ? def.shifted : def.normal;
      } else {
        mainSpan.textContent = shifted ? def.shifted : def.normal;
        if (subSpan) {
          subSpan.textContent = shifted ? def.normal : def.shifted;
        }
      }
    }
    refreshNativeStatusUI();
  }

  function clearOneShotModifiers() {
    let changed = false;
    if (shiftState === 1) {
      shiftState = 0;
      changed = true;
    }
    if (ctrlArmed) {
      ctrlArmed = false;
      changed = true;
    }
    if (changed) refreshModifierUI();
  }

  function sendKeyDef(def) {
    if (def.seq) {
      emit(def.seq);
      clearOneShotModifiers();
      return;
    }

    if (def.normal !== undefined) {
      const ch = shiftState > 0 ? def.shifted : def.normal;
      const seq = charToUnixSeq(ch, ctrlArmed);
      if (seq) {
        emit(seq);
      }
      clearOneShotModifiers();
    }
  }

  function releasePointer(pointerId) {
    const entry = activePointers.get(pointerId);
    if (!entry) return;
    if (entry.delayId) window.clearTimeout(entry.delayId);
    if (entry.intervalId) window.clearInterval(entry.intervalId);
    entry.btn.classList.remove('is-pressed');
    activePointers.delete(pointerId);
  }

  function releaseAll() {
    for (const pointerId of Array.from(activePointers.keys())) {
      releasePointer(pointerId);
    }
    let changed = false;
    if (shiftState === 1) {
      shiftState = 0;
      changed = true;
    }
    if (ctrlArmed) {
      ctrlArmed = false;
      changed = true;
    }
    if (changed) refreshModifierUI();
  }

  function handleModifierPress(mod) {
    const now = Date.now();
    if (mod === 'shift') {
      if (shiftState === 0) {
        shiftState = 1;
        lastShiftTapAt = now;
      } else if (shiftState === 1) {
        if (now - lastShiftTapAt <= SHIFT_DOUBLE_TAP_MS) {
          shiftState = 2;
        } else {
          shiftState = 0;
        }
        lastShiftTapAt = 0;
      } else {
        shiftState = 0;
        lastShiftTapAt = 0;
      }
      refreshModifierUI();
    } else if (mod === 'ctrl') {
      ctrlArmed = !ctrlArmed;
      refreshModifierUI();
    }
  }

  function handleKeyDown(def, btn, e) {
    e.preventDefault();
    if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') {
      return;
    }

    if (def.mod) {
      handleModifierPress(def.mod);
      return;
    }

    const pointerId = e.pointerId !== undefined ? e.pointerId : 0;
    releasePointer(pointerId);

    btn.classList.add('is-pressed');
    try {
      if (typeof btn.setPointerCapture === 'function' && e.pointerId !== undefined) {
        btn.setPointerCapture(e.pointerId);
      }
    } catch {
      // Ignore synthetic or unsupported pointer capture
    }

    sendKeyDef(def);

    const entry = { btn, delayId: 0, intervalId: 0 };
    if (def.repeat) {
      entry.delayId = window.setTimeout(() => {
        entry.delayId = 0;
        if (!activePointers.has(pointerId)) return;
        sendKeyDef(def);
        entry.intervalId = window.setInterval(() => {
          if (!activePointers.has(pointerId)) return;
          sendKeyDef(def);
        }, REPEAT_INTERVAL_MS);
      }, REPEAT_DELAY_MS);
    }
    activePointers.set(pointerId, entry);
  }

  /* ---- Native Device Keyboard Input Bridge ---- */

  function placeNativeCaretAtEnd() {
    if (!nativeInput) return;
    const len = nativeInput.value.length;
    try {
      nativeInput.setSelectionRange(len, len);
    } catch {
      // Ignore browsers that reject selectionRange when unfocused
    }
  }

  function resetNativeBuffer() {
    nativeCommittedText = '';
    if (!nativeInput) return;
    nativeInput.value = NATIVE_SENTINEL;
    placeNativeCaretAtEnd();
  }

  function sendNativeBackspace(count = 1) {
    if (count <= 0) return;
    emit('\x7f'.repeat(count));
    if (ctrlArmed) {
      ctrlArmed = false;
      refreshModifierUI();
    }
  }

  function sendNativeText(text) {
    if (!text) return;
    const normalized = normalizeSmartText(text);
    let out = '';
    for (let i = 0; i < normalized.length; i++) {
      const ch = normalized[i];
      if (ch === '\r' && normalized[i + 1] === '\n') {
        i++;
      }
      const seq = charToUnixSeq(ch, ctrlArmed);
      if (seq) {
        out += seq;
        if (ctrlArmed) {
          ctrlArmed = false;
          refreshModifierUI();
        }
      }
    }
    if (out) {
      emit(out);
    }
  }

  function applyNativeDiff(nextText) {
    let prefixLen = 0;
    const minLen = Math.min(nativeCommittedText.length, nextText.length);
    while (prefixLen < minLen && nativeCommittedText[prefixLen] === nextText[prefixLen]) {
      prefixLen++;
    }
    const deletes = nativeCommittedText.length - prefixLen;
    const inserted = nextText.slice(prefixLen);
    if (deletes > 0) {
      sendNativeBackspace(deletes);
    }
    if (inserted.length > 0) {
      sendNativeText(inserted);
    }
    nativeCommittedText = nextText;
  }

  function syncNativeInput(isComposing) {
    if (!nativeInput) return;
    const raw = nativeInput.value || '';

    if (raw.length === 0) {
      if (nativeCommittedText.length > 0) {
        sendNativeBackspace(nativeCommittedText.length);
      } else {
        sendNativeBackspace(1);
      }
      resetNativeBuffer();
      return;
    }

    const stripped = raw.split(NATIVE_SENTINEL).join('');

    if (stripped.length === 0) {
      if (nativeCommittedText.length > 0) {
        sendNativeBackspace(nativeCommittedText.length);
        nativeCommittedText = '';
      }
      if (!isComposing && raw !== NATIVE_SENTINEL) {
        resetNativeBuffer();
      }
      return;
    }

    applyNativeDiff(stripped);

    if (!isComposing) {
      resetNativeBuffer();
    }
  }

  function focusNativeInput() {
    if (!nativeInput || !visible || mode !== 'native') return;
    if (bodyNativeEl && bodyNativeEl.hidden) {
      bodyNativeEl.hidden = false;
    }
    // Synchronously flush layout so iOS Safari allows focus() inside the user tap
    void nativeInput.offsetWidth;
    if (!nativeComposing && !nativeInput.value) {
      resetNativeBuffer();
    }
    try {
      nativeInput.focus({ preventScroll: true });
    } catch {
      nativeInput.focus();
    }
    placeNativeCaretAtEnd();
  }

  function blurNativeInput() {
    if (!nativeInput) return;
    nativeComposing = false;
    resetNativeBuffer();
    if (document.activeElement === nativeInput) {
      nativeInput.blur();
    }
    if (nativeFocused) {
      nativeFocused = false;
      refreshNativeStatusUI();
      onNativeFocusChange(false);
    }
  }

  function wireNativeInputEvents(inputEl) {
    inputEl.value = NATIVE_SENTINEL;

    inputEl.addEventListener('focus', () => {
      nativeFocused = true;
      nativeComposing = false;
      resetNativeBuffer();
      refreshNativeStatusUI();
      onNativeFocusChange(true);
    });

    inputEl.addEventListener('blur', () => {
      nativeFocused = false;
      nativeComposing = false;
      resetNativeBuffer();
      refreshNativeStatusUI();
      onNativeFocusChange(false);
    });

    inputEl.addEventListener('click', () => {
      placeNativeCaretAtEnd();
    });

    inputEl.addEventListener('compositionstart', () => {
      nativeComposing = true;
    });

    inputEl.addEventListener('compositionend', () => {
      nativeComposing = false;
      syncNativeInput(false);
    });

    inputEl.addEventListener('beforeinput', (e) => {
      if (
        e.inputType === 'deleteContentBackward' &&
        !nativeComposing &&
        inputEl.selectionStart === 0 &&
        inputEl.selectionEnd === 0
      ) {
        e.preventDefault();
        sendNativeBackspace(1);
        resetNativeBuffer();
      }
    });

    inputEl.addEventListener('input', (e) => {
      const composing = Boolean(nativeComposing || e.isComposing);
      syncNativeInput(composing);
    });

    inputEl.addEventListener('keydown', (e) => {
      if (e.metaKey || e.altKey) return;

      if (e.ctrlKey) {
        const k = e.key;
        if (k && k.length === 1) {
          const seq = charToUnixSeq(k, true);
          if (seq) {
            e.preventDefault();
            emit(seq);
            return;
          }
        }
      }

      const special = NATIVE_SPECIAL_KEYS[e.key] || NATIVE_SPECIAL_KEYS[e.code];
      if (special) {
        e.preventDefault();
        emit(special);
        return;
      }

      if (
        !nativeComposing &&
        !e.isComposing &&
        e.key === 'Backspace' &&
        inputEl.value.length === 0
      ) {
        e.preventDefault();
        sendNativeBackspace(1);
        resetNativeBuffer();
      }
    });
  }

  function createKeyButton(def, extraClass = '') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.tabIndex = -1;
    btn.className = ['osk-key', def.cls || '', extraClass].filter(Boolean).join(' ');

    if (def.weight) {
      btn.style.flexGrow = String(def.weight);
    }
    if (def.title) {
      btn.title = def.title;
    }
    if (def.ariaLabel) {
      btn.setAttribute('aria-label', def.ariaLabel);
    }

    if (def.mod) {
      btn.textContent = def.label || '';
      btn.setAttribute('aria-pressed', 'false');
      if (def.mod === 'shift') {
        modButtons.shift.push(btn);
      } else if (def.mod === 'ctrl') {
        modButtons.ctrl.push(btn);
      }
    } else if (def.normal !== undefined) {
      const isLetter = def.normal >= 'a' && def.normal <= 'z';
      const mainSpan = document.createElement('span');
      mainSpan.className = 'osk-key-main';
      mainSpan.textContent = def.normal;

      let subSpan = null;
      if (!isLetter && def.shifted) {
        subSpan = document.createElement('span');
        subSpan.className = 'osk-key-sub';
        subSpan.textContent = def.shifted;
        btn.appendChild(subSpan);
      }
      btn.appendChild(mainSpan);
      printableButtons.push({ el: btn, mainSpan, subSpan, def });
    } else {
      btn.textContent = def.label || '';
    }

    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('pointerdown', (e) => handleKeyDown(def, btn, e));
    const onUp = (e) => {
      e.preventDefault();
      releasePointer(e.pointerId !== undefined ? e.pointerId : 0);
    };
    btn.addEventListener('pointerup', onUp);
    btn.addEventListener('pointercancel', onUp);
    btn.addEventListener('lostpointercapture', (e) => {
      releasePointer(e.pointerId !== undefined ? e.pointerId : 0);
    });

    return btn;
  }

  function createArrowCluster(sizeClass = '') {
    const grid = document.createElement('div');
    grid.className = ['osk-arrows', sizeClass].filter(Boolean).join(' ');
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', 'Arrow keys');

    const arrows = [
      {
        label: '\u25B2',
        seq: '\x1b[A',
        repeat: true,
        cls: 'osk-key-arrow osk-arrow-up',
        title: 'Arrow Up',
        ariaLabel: 'Arrow Up'
      },
      {
        label: '\u25C0',
        seq: '\x1b[D',
        repeat: true,
        cls: 'osk-key-arrow osk-arrow-left',
        title: 'Arrow Left',
        ariaLabel: 'Arrow Left'
      },
      {
        label: '\u25BC',
        seq: '\x1b[B',
        repeat: true,
        cls: 'osk-key-arrow osk-arrow-down',
        title: 'Arrow Down',
        ariaLabel: 'Arrow Down'
      },
      {
        label: '\u25B6',
        seq: '\x1b[C',
        repeat: true,
        cls: 'osk-key-arrow osk-arrow-right',
        title: 'Arrow Right',
        ariaLabel: 'Arrow Right'
      }
    ];

    for (const def of arrows) {
      grid.appendChild(createKeyButton(def));
    }
    return grid;
  }

  function buildDOM() {
    container.innerHTML = '';

    const inner = document.createElement('div');
    inner.className = 'osk-inner';

    // Top utility row
    const toolbar = document.createElement('div');
    toolbar.className = 'osk-toolbar';

    const fnGroup = document.createElement('div');
    fnGroup.className = 'osk-fn-group';
    fnGroup.setAttribute('role', 'group');
    fnGroup.setAttribute('aria-label', 'UNIX terminal keys');
    for (const def of TOOLBAR_KEYS) {
      fnGroup.appendChild(createKeyButton(def, 'osk-key-top'));
    }

    const controls = document.createElement('div');
    controls.className = 'osk-mode-group';
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', 'Keyboard layout');

    btnModeFull = document.createElement('button');
    btnModeFull.type = 'button';
    btnModeFull.className = 'osk-ctrl-btn';
    btnModeFull.textContent = 'Full';
    btnModeFull.title = 'Full QWERTY + Arrow Pad';
    btnModeFull.addEventListener('click', () => setMode('full'));

    btnModePad = document.createElement('button');
    btnModePad.type = 'button';
    btnModePad.className = 'osk-ctrl-btn';
    btnModePad.textContent = 'Pad';
    btnModePad.title = 'Compact Arrow Pad + Action Keys';
    btnModePad.addEventListener('click', () => setMode('pad'));

    btnModeNative = document.createElement('button');
    btnModeNative.type = 'button';
    btnModeNative.className = 'osk-ctrl-btn';
    btnModeNative.textContent = 'Device';
    btnModeNative.title = 'Use built-in iOS / Android device keyboard';
    btnModeNative.addEventListener('click', () => setMode('native', { focusNative: true }));

    const btnHide = document.createElement('button');
    btnHide.type = 'button';
    btnHide.className = 'osk-ctrl-btn osk-ctrl-hide';
    btnHide.textContent = 'Hide';
    btnHide.title = 'Hide keyboard bar (Alt+K)';
    btnHide.setAttribute('aria-label', 'Hide keyboard bar');
    btnHide.addEventListener('click', () => setVisible(false));

    controls.appendChild(btnModeFull);
    controls.appendChild(btnModePad);
    controls.appendChild(btnModeNative);
    controls.appendChild(btnHide);

    toolbar.appendChild(fnGroup);
    toolbar.appendChild(controls);
    inner.appendChild(toolbar);

    // Full mode: QWERTY rows + dedicated inverted-T arrow pad
    bodyFullEl = document.createElement('div');
    bodyFullEl.className = 'osk-body-full';

    const qwerty = document.createElement('div');
    qwerty.className = 'osk-qwerty';

    for (const rowDef of QWERTY_ROWS) {
      const rowEl = document.createElement('div');
      rowEl.className = 'osk-row';
      for (const keyDef of rowDef) {
        rowEl.appendChild(createKeyButton(keyDef));
      }
      qwerty.appendChild(rowEl);
    }

    const arrowsWrap = document.createElement('div');
    arrowsWrap.className = 'osk-arrows-wrap';
    arrowsWrap.appendChild(createArrowCluster());

    bodyFullEl.appendChild(qwerty);
    bodyFullEl.appendChild(arrowsWrap);
    inner.appendChild(bodyFullEl);

    // Pad mode: jumbo inverted-T arrow pad + big thumb action keys
    bodyPadEl = document.createElement('div');
    bodyPadEl.className = 'osk-body-pad';

    const padLeft = document.createElement('div');
    padLeft.className = 'osk-pad-left';
    padLeft.appendChild(createArrowCluster('osk-arrows-lg'));

    const padRight = document.createElement('div');
    padRight.className = 'osk-pad-actions';
    padRight.appendChild(
      createKeyButton(
        { label: 'SPACE', seq: ' ', repeat: true, title: 'Space bar' },
        'osk-pad-btn osk-pad-primary'
      )
    );
    padRight.appendChild(
      createKeyButton(
        { label: 'ENTER', seq: '\r', repeat: false, title: 'Enter / Return' },
        'osk-pad-btn osk-key-enter'
      )
    );
    padRight.appendChild(
      createKeyButton(
        {
          label: '\u232B BKSP',
          seq: '\x7f',
          repeat: true,
          title: 'Backspace (0x7F)',
          ariaLabel: 'Backspace'
        },
        'osk-pad-btn osk-key-fn'
      )
    );
    padRight.appendChild(
      createKeyButton(
        { label: 'CTRL+C', seq: '\x03', repeat: false, title: 'Send Ctrl+C (0x03)' },
        'osk-pad-btn osk-key-warn'
      )
    );

    bodyPadEl.appendChild(padLeft);
    bodyPadEl.appendChild(padRight);
    inner.appendChild(bodyPadEl);

    // Device (Native iOS / Android) mode: CTRL + inline arrows + native keyboard input bridge
    bodyNativeEl = document.createElement('div');
    bodyNativeEl.className = 'osk-body-native';

    const nativeControls = document.createElement('div');
    nativeControls.className = 'osk-native-controls';

    const nativeCtrlBtn = createKeyButton(
      {
        mod: 'ctrl',
        label: 'CTRL',
        cls: 'osk-key-mod',
        title: 'Arm Ctrl for next key typed on device keyboard'
      },
      'osk-native-ctrl'
    );
    nativeControls.appendChild(nativeCtrlBtn);

    const nativeArrows = document.createElement('div');
    nativeArrows.className = 'osk-native-arrows';
    nativeArrows.setAttribute('role', 'group');
    nativeArrows.setAttribute('aria-label', 'Arrow keys');
    nativeArrows.appendChild(
      createKeyButton(
        { label: '\u25C0', seq: '\x1b[D', repeat: true, title: 'Arrow Left', ariaLabel: 'Arrow Left' },
        'osk-key-arrow osk-native-arrow'
      )
    );
    nativeArrows.appendChild(
      createKeyButton(
        { label: '\u25B2', seq: '\x1b[A', repeat: true, title: 'Arrow Up', ariaLabel: 'Arrow Up' },
        'osk-key-arrow osk-native-arrow'
      )
    );
    nativeArrows.appendChild(
      createKeyButton(
        { label: '\u25BC', seq: '\x1b[B', repeat: true, title: 'Arrow Down', ariaLabel: 'Arrow Down' },
        'osk-key-arrow osk-native-arrow'
      )
    );
    nativeArrows.appendChild(
      createKeyButton(
        { label: '\u25B6', seq: '\x1b[C', repeat: true, title: 'Arrow Right', ariaLabel: 'Arrow Right' },
        'osk-key-arrow osk-native-arrow'
      )
    );
    nativeControls.appendChild(nativeArrows);

    nativeInputWrap = document.createElement('div');
    nativeInputWrap.className = 'osk-native-input-wrap';

    nativeInput = document.createElement('textarea');
    nativeInput.className = 'osk-native-input';
    nativeInput.rows = 1;
    nativeInput.setAttribute('autocomplete', 'off');
    nativeInput.setAttribute('autocorrect', 'off');
    nativeInput.setAttribute('autocapitalize', 'none');
    nativeInput.setAttribute('spellcheck', 'false');
    nativeInput.setAttribute('inputmode', 'text');
    nativeInput.setAttribute('enterkeyhint', 'send');
    nativeInput.setAttribute('data-gramm', 'false');
    nativeInput.setAttribute('aria-label', 'Device keyboard input for Plexus P/20');
    wireNativeInputEvents(nativeInput);

    const statusOverlay = document.createElement('div');
    statusOverlay.className = 'osk-native-status';
    statusOverlay.setAttribute('aria-hidden', 'true');

    const statusDot = document.createElement('span');
    statusDot.className = 'osk-native-dot';

    nativeLabelEl = document.createElement('span');
    nativeLabelEl.className = 'osk-native-label';
    nativeLabelEl.textContent = 'Tap here for device keyboard';

    statusOverlay.appendChild(statusDot);
    statusOverlay.appendChild(nativeLabelEl);

    nativeOpenHintEl = document.createElement('span');
    nativeOpenHintEl.className = 'osk-native-hint';
    nativeOpenHintEl.setAttribute('aria-hidden', 'true');
    nativeOpenHintEl.textContent = 'Open';

    nativeDismissBtn = document.createElement('button');
    nativeDismissBtn.type = 'button';
    nativeDismissBtn.tabIndex = -1;
    nativeDismissBtn.className = 'osk-native-dismiss';
    nativeDismissBtn.textContent = 'Done';
    nativeDismissBtn.title = 'Dismiss device keyboard';
    nativeDismissBtn.setAttribute('aria-label', 'Dismiss device keyboard');
    nativeDismissBtn.hidden = true;
    nativeDismissBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      blurNativeInput();
    });

    nativeInputWrap.appendChild(nativeInput);
    nativeInputWrap.appendChild(statusOverlay);
    nativeInputWrap.appendChild(nativeOpenHintEl);
    nativeInputWrap.appendChild(nativeDismissBtn);

    bodyNativeEl.appendChild(nativeControls);
    bodyNativeEl.appendChild(nativeInputWrap);
    inner.appendChild(bodyNativeEl);

    container.appendChild(inner);
  }

  function applyModeUI() {
    const isFull = mode === 'full';
    const isPad = mode === 'pad';
    const isNative = mode === 'native';

    if (bodyFullEl) bodyFullEl.hidden = !isFull;
    if (bodyPadEl) bodyPadEl.hidden = !isPad;
    if (bodyNativeEl) bodyNativeEl.hidden = !isNative;

    if (btnModeFull) {
      btnModeFull.classList.toggle('is-active', isFull);
      btnModeFull.setAttribute('aria-pressed', String(isFull));
    }
    if (btnModePad) {
      btnModePad.classList.toggle('is-active', isPad);
      btnModePad.setAttribute('aria-pressed', String(isPad));
    }
    if (btnModeNative) {
      btnModeNative.classList.toggle('is-active', isNative);
      btnModeNative.setAttribute('aria-pressed', String(isNative));
    }
    container.dataset.mode = mode;
    refreshNativeStatusUI();
  }

  function setMode(nextMode, { focusNative = false } = {}) {
    const clean = sanitizeMode(nextMode);
    if (clean !== 'native') {
      blurNativeInput();
    }
    if (clean === mode && bodyFullEl) {
      applyModeUI();
      if (clean === 'native' && focusNative && visible) {
        focusNativeInput();
      }
      return;
    }
    releaseAll();
    mode = clean;
    applyModeUI();
    onModeChange(mode);
    if (mode === 'native' && focusNative && visible) {
      focusNativeInput();
    }
  }

  function setVisible(nextVisible, { focusNative = false } = {}) {
    const flag = Boolean(nextVisible);
    visible = flag;
    container.hidden = !flag;
    if (!flag) {
      releaseAll();
      blurNativeInput();
    } else if (mode === 'native' && focusNative) {
      focusNativeInput();
    }
    refreshNativeStatusUI();
    onVisibilityChange(visible);
  }

  function toggleVisible(opts) {
    setVisible(!visible, opts);
  }

  buildDOM();
  applyModeUI();
  refreshModifierUI();
  container.hidden = true;

  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseAll();
  });

  return {
    isVisible: () => visible,
    setVisible,
    toggleVisible,
    getMode: () => mode,
    setMode,
    focusNativeInput,
    blurNativeInput,
    isNativeInputFocused: () => nativeFocused,
    releaseAll
  };
}
