/*
 * On-Screen Keyboard & Arrow Pad for the Lobo MAX-80 Web Emulator.
 *
 * Features:
 * - Full QWERTY layout + dedicated inverted-T arrow keys + MAX-80 special keys
 *   (ESC, BREAK, F1..F4, TAB, CTRL, SHIFT/Shift Lock).
 * - Compact "Pad" mode with jumbo thumb-friendly inverted-T arrows and action
 *   keys (SPACE, ENTER, BKSP, CTRL+C) for games and LDV Desktop on phones.
 * - Multi-touch pointer support: hold an arrow key with one thumb while tapping
 *   SPACE/ENTER with the other. Uses emulator.keyHold(slot, ch) on slots
 *   200..255 (disjoint from physical keyboard slots 0..199 in keyboard.js),
 *   falling back to emulator.keyQueue(ch) for shifted/Ctrl/queued characters.
 */

import {
  K_UP,
  K_DOWN,
  K_LEFT,
  K_RIGHT,
  K_F1,
  K_F2,
  K_F3,
  K_F4,
  K_BREAK
} from './keyboard.js';

const OSK_SLOT_BASE = 200;
const OSK_SLOT_COUNT = 56; // slots 200..255
const SHIFT_DOUBLE_TAP_MS = 450;

const TOOLBAR_KEYS = [
  { label: 'ESC', code: 0x1b, title: 'Escape' },
  { label: 'BRK', code: K_BREAK, title: 'MAX-80 BREAK key', cls: 'osk-key-warn' },
  { label: 'F1', code: K_F1, title: 'MAX-80 F1' },
  { label: 'F2', code: K_F2, title: 'MAX-80 F2' },
  { label: 'F3', code: K_F3, title: 'MAX-80 F3' },
  { label: 'F4', code: K_F4, title: 'MAX-80 F4' },
  { label: 'TAB', code: 0x09, title: 'Tab' }
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
    { normal: '=', shifted: '+' }
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
    { normal: ']', shifted: '}' }
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
    { normal: "'", shifted: '"' }
  ],
  [
    { mod: 'shift', label: 'SHIFT', weight: 1.5, cls: 'osk-key-mod' },
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
    { label: '\u232B', code: 0x08, weight: 1.5, cls: 'osk-key-fn', title: 'Backspace', ariaLabel: 'Backspace' }
  ],
  [
    { mod: 'ctrl', label: 'CTRL', weight: 1.4, cls: 'osk-key-mod' },
    { normal: '`', shifted: '~', weight: 1.0 },
    { normal: '\\', shifted: '|', weight: 1.0 },
    { label: 'SPACE', code: 0x20, weight: 4.8, cls: 'osk-key-space' },
    { label: 'ENTER', code: 0x0d, weight: 2.2, cls: 'osk-key-enter' }
  ]
];

export function createOnScreenKeyboard(container, emulator, opts = {}) {
  const onVisibilityChange =
    typeof opts.onVisibilityChange === 'function' ? opts.onVisibilityChange : () => {};
  const onModeChange =
    typeof opts.onModeChange === 'function' ? opts.onModeChange : () => {};
  const onPowerNeeded =
    typeof opts.onPowerNeeded === 'function' ? opts.onPowerNeeded : () => {};

  let visible = false;
  let mode = opts.initialMode === 'pad' ? 'pad' : 'full';
  let shiftState = 'off'; // 'off' | 'oneshot' | 'locked'
  let ctrlState = 'off';  // 'off' | 'oneshot'
  let lastShiftTap = 0;
  let powerHintShown = false;

  // Multi-touch state: pointerId -> { slot, el, held, mod }
  const activePointers = new Map();
  const usedSlots = new Set();
  const heldMods = { shift: 0, ctrl: 0 };
  const modUsedWhileHeld = { shift: false, ctrl: false };

  const printableButtons = []; // { el, mainSpan, subSpan, def }
  const modButtons = { shift: [], ctrl: [] };

  let bodyFullEl = null;
  let bodyPadEl = null;
  let btnModeFull = null;
  let btnModePad = null;

  function allocSlot() {
    for (let i = 0; i < OSK_SLOT_COUNT; i++) {
      const slot = OSK_SLOT_BASE + i;
      if (!usedSlots.has(slot)) {
        usedSlots.add(slot);
        return slot;
      }
    }
    return OSK_SLOT_BASE + OSK_SLOT_COUNT - 1;
  }

  function freeSlot(slot) {
    if (slot !== null && slot !== undefined) {
      usedSlots.delete(slot);
    }
  }

  function isShiftActive() {
    return shiftState !== 'off' || heldMods.shift > 0;
  }

  function isCtrlActive() {
    return ctrlState !== 'off' || heldMods.ctrl > 0;
  }

  function refreshKeyLegends() {
    const shifted = isShiftActive();
    const ctrl = isCtrlActive();

    for (const item of printableButtons) {
      const { mainSpan, subSpan, def } = item;
      const isLetter = def.normal >= 'a' && def.normal <= 'z';
      if (isLetter) {
        mainSpan.textContent = shifted || ctrl ? def.shifted : def.normal;
        if (subSpan) subSpan.textContent = '';
      } else {
        mainSpan.textContent = shifted ? def.shifted : def.normal;
        if (subSpan) subSpan.textContent = shifted ? def.normal : def.shifted;
      }
    }

    for (const el of modButtons.shift) {
      el.classList.toggle('is-active', shiftState === 'oneshot' || heldMods.shift > 0);
      el.classList.toggle('is-locked', shiftState === 'locked');
      el.setAttribute('aria-pressed', String(shifted));
      el.textContent = shiftState === 'locked' ? 'CAPS' : 'SHIFT';
    }

    for (const el of modButtons.ctrl) {
      el.classList.toggle('is-active', ctrl);
      el.setAttribute('aria-pressed', String(ctrl));
    }
  }

  function consumeOneShotModifiers() {
    let changed = false;
    if (heldMods.shift > 0) {
      modUsedWhileHeld.shift = true;
    } else if (shiftState === 'oneshot') {
      shiftState = 'off';
      changed = true;
    }
    if (heldMods.ctrl > 0) {
      modUsedWhileHeld.ctrl = true;
    } else if (ctrlState === 'oneshot') {
      ctrlState = 'off';
      changed = true;
    }
    if (changed) {
      refreshKeyLegends();
    }
  }

  function resolveChar(def) {
    if (typeof def.queueCode === 'number') {
      return { ch: def.queueCode, forceQueue: true };
    }
    if (typeof def.code === 'number') {
      return { ch: def.code, forceQueue: false };
    }

    const ctrl = isCtrlActive();
    const shifted = isShiftActive();

    if (ctrl) {
      const ch = def.normal;
      if (ch >= 'a' && ch <= 'z') {
        return { ch: ch.charCodeAt(0) - 96, forceQueue: true };
      }
      if (ch === '[') {
        return { ch: 0x1b, forceQueue: true };
      }
      return { ch: 0, forceQueue: true };
    }

    const glyph = shifted ? def.shifted : def.normal;
    if (!glyph) return { ch: 0, forceQueue: true };
    return { ch: glyph.charCodeAt(0), forceQueue: shifted };
  }

  function handleModifierDown(mod, el, pointerId) {
    el.classList.add('is-pressed');
    if (mod === 'shift') {
      heldMods.shift++;
      modUsedWhileHeld.shift = false;
      const now = Date.now();
      if (shiftState === 'locked') {
        shiftState = 'off';
      } else if (shiftState === 'oneshot') {
        shiftState = now - lastShiftTap <= SHIFT_DOUBLE_TAP_MS ? 'locked' : 'off';
      } else {
        shiftState = 'oneshot';
      }
      lastShiftTap = now;
    } else if (mod === 'ctrl') {
      heldMods.ctrl++;
      modUsedWhileHeld.ctrl = false;
      ctrlState = ctrlState === 'oneshot' ? 'off' : 'oneshot';
    }

    activePointers.set(pointerId, { slot: null, el, held: false, mod });
    refreshKeyLegends();
  }

  function handleKeyDown(def, el, e) {
    e.preventDefault();
    if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') {
      return;
    }

    const pointerId = e.pointerId !== undefined ? e.pointerId : 0;
    if (activePointers.has(pointerId)) {
      releasePointer(pointerId);
    }

    try {
      if (typeof el.setPointerCapture === 'function' && e.pointerId !== undefined) {
        el.setPointerCapture(e.pointerId);
      }
    } catch {
      // Ignore capture errors on synthetic events
    }

    if (def.mod) {
      handleModifierDown(def.mod, el, pointerId);
      return;
    }

    el.classList.add('is-pressed');

    if (!emulator || typeof emulator.isPoweredOn !== 'function' || !emulator.isPoweredOn()) {
      activePointers.set(pointerId, { slot: null, el, held: false, mod: null });
      if (!powerHintShown) {
        powerHintShown = true;
        onPowerNeeded();
      }
      return;
    }

    powerHintShown = false;
    const { ch, forceQueue } = resolveChar(def);
    let slot = null;
    let held = false;

    if (ch > 0) {
      if (!forceQueue && typeof emulator.keyHold === 'function') {
        slot = allocSlot();
        const ok = emulator.keyHold(slot, ch);
        if (ok) {
          held = true;
        } else {
          freeSlot(slot);
          slot = null;
          emulator.keyQueue(ch);
        }
      } else if (typeof emulator.keyQueue === 'function') {
        emulator.keyQueue(ch);
      }
    }

    activePointers.set(pointerId, { slot, el, held, mod: null });
    consumeOneShotModifiers();
  }

  function releasePointer(pointerId) {
    const entry = activePointers.get(pointerId);
    if (!entry) return;
    activePointers.delete(pointerId);

    entry.el.classList.remove('is-pressed');

    if (entry.mod === 'shift') {
      heldMods.shift = Math.max(0, heldMods.shift - 1);
      if (heldMods.shift === 0 && modUsedWhileHeld.shift && shiftState === 'oneshot') {
        shiftState = 'off';
        modUsedWhileHeld.shift = false;
      }
      refreshKeyLegends();
    } else if (entry.mod === 'ctrl') {
      heldMods.ctrl = Math.max(0, heldMods.ctrl - 1);
      if (heldMods.ctrl === 0 && modUsedWhileHeld.ctrl && ctrlState === 'oneshot') {
        ctrlState = 'off';
        modUsedWhileHeld.ctrl = false;
      }
      refreshKeyLegends();
    }

    if (entry.held && entry.slot !== null) {
      try {
        if (emulator && typeof emulator.keyUnhold === 'function') {
          emulator.keyUnhold(entry.slot);
        }
      } finally {
        freeSlot(entry.slot);
      }
    }
  }

  function releaseAll() {
    const ids = Array.from(activePointers.keys());
    for (const id of ids) {
      releasePointer(id);
    }
    usedSlots.clear();
    heldMods.shift = 0;
    heldMods.ctrl = 0;
    modUsedWhileHeld.shift = false;
    modUsedWhileHeld.ctrl = false;
  }

  function createKeyButton(def, extraClass = '') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.tabIndex = -1;
    btn.className = `osk-key${def.cls ? ' ' + def.cls : ''}${extraClass ? ' ' + extraClass : ''}`;
    if (def.title) btn.title = def.title;
    if (def.ariaLabel) {
      btn.setAttribute('aria-label', def.ariaLabel);
    } else if (def.label) {
      btn.setAttribute('aria-label', def.label);
    } else if (def.normal) {
      btn.setAttribute('aria-label', def.normal);
    }

    if (def.weight) {
      btn.style.flex = `${def.weight} 1 0`;
    }

    if (def.mod) {
      btn.textContent = def.label;
      btn.setAttribute('aria-pressed', 'false');
      if (modButtons[def.mod]) {
        modButtons[def.mod].push(btn);
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
    btn.addEventListener('contextmenu', (e) => e.preventDefault());

    return btn;
  }

  function createArrowCluster(sizeClass = '') {
    const cluster = document.createElement('div');
    cluster.className = `osk-arrows${sizeClass ? ' ' + sizeClass : ''}`;
    cluster.setAttribute('role', 'group');
    cluster.setAttribute('aria-label', 'MAX-80 Arrow keys');

    const up = createKeyButton(
      { label: '\u25B2', code: K_UP, title: 'Arrow Up', ariaLabel: 'Arrow Up' },
      'osk-key-arrow osk-arrow-up'
    );
    const left = createKeyButton(
      { label: '\u25C0', code: K_LEFT, title: 'Arrow Left', ariaLabel: 'Arrow Left' },
      'osk-key-arrow osk-arrow-left'
    );
    const down = createKeyButton(
      { label: '\u25BC', code: K_DOWN, title: 'Arrow Down', ariaLabel: 'Arrow Down' },
      'osk-key-arrow osk-arrow-down'
    );
    const right = createKeyButton(
      { label: '\u25B6', code: K_RIGHT, title: 'Arrow Right', ariaLabel: 'Arrow Right' },
      'osk-key-arrow osk-arrow-right'
    );

    cluster.appendChild(up);
    cluster.appendChild(left);
    cluster.appendChild(down);
    cluster.appendChild(right);
    return cluster;
  }

  function buildDOM() {
    container.innerHTML = '';

    const inner = document.createElement('div');
    inner.className = 'osk-inner';

    // Top function/control toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'osk-toolbar';

    const fnGroup = document.createElement('div');
    fnGroup.className = 'osk-fn-group';
    for (const def of TOOLBAR_KEYS) {
      fnGroup.appendChild(createKeyButton(def, 'osk-key-top'));
    }

    const controls = document.createElement('div');
    controls.className = 'osk-mode-group';

    btnModeFull = document.createElement('button');
    btnModeFull.type = 'button';
    btnModeFull.className = 'osk-ctrl-btn';
    btnModeFull.textContent = 'Full';
    btnModeFull.title = 'Full QWERTY keyboard + Arrow keys';
    btnModeFull.addEventListener('click', () => setMode('full'));

    btnModePad = document.createElement('button');
    btnModePad.type = 'button';
    btnModePad.className = 'osk-ctrl-btn';
    btnModePad.textContent = 'Pad';
    btnModePad.title = 'Compact Arrow Pad + Action keys';
    btnModePad.addEventListener('click', () => setMode('pad'));

    const btnHide = document.createElement('button');
    btnHide.type = 'button';
    btnHide.className = 'osk-ctrl-btn osk-ctrl-hide';
    btnHide.textContent = 'Hide';
    btnHide.title = 'Hide on-screen keyboard (Alt+K)';
    btnHide.setAttribute('aria-label', 'Hide on-screen keyboard');
    btnHide.addEventListener('click', () => setVisible(false));

    controls.appendChild(btnModeFull);
    controls.appendChild(btnModePad);
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
        { label: 'SPACE', code: 0x20, title: 'Space bar' },
        'osk-pad-btn osk-pad-primary'
      )
    );
    padRight.appendChild(
      createKeyButton(
        { label: 'ENTER', code: 0x0d, title: 'Enter / Return' },
        'osk-pad-btn osk-key-enter'
      )
    );
    padRight.appendChild(
      createKeyButton(
        { label: '\u232B BKSP', code: 0x08, title: 'Backspace', ariaLabel: 'Backspace' },
        'osk-pad-btn osk-key-fn'
      )
    );
    padRight.appendChild(
      createKeyButton(
        { label: 'CTRL+C', queueCode: 3, title: 'Send Ctrl+C (Break / Abort)' },
        'osk-pad-btn osk-key-warn'
      )
    );

    bodyPadEl.appendChild(padLeft);
    bodyPadEl.appendChild(padRight);
    inner.appendChild(bodyPadEl);

    container.appendChild(inner);
  }

  function applyModeUI() {
    const isPad = mode === 'pad';
    if (bodyFullEl) bodyFullEl.hidden = isPad;
    if (bodyPadEl) bodyPadEl.hidden = !isPad;
    if (btnModeFull) {
      btnModeFull.classList.toggle('is-active', !isPad);
      btnModeFull.setAttribute('aria-pressed', String(!isPad));
    }
    if (btnModePad) {
      btnModePad.classList.toggle('is-active', isPad);
      btnModePad.setAttribute('aria-pressed', String(isPad));
    }
    container.dataset.mode = mode;
  }

  function setMode(nextMode) {
    const clean = nextMode === 'pad' ? 'pad' : 'full';
    if (clean === mode && bodyFullEl) {
      applyModeUI();
      return;
    }
    releaseAll();
    mode = clean;
    applyModeUI();
    onModeChange(mode);
  }

  function setVisible(nextVisible) {
    const flag = Boolean(nextVisible);
    if (!flag) {
      releaseAll();
    }
    visible = flag;
    container.hidden = !visible;
    onVisibilityChange(visible);
  }

  function onWindowBlur() {
    releaseAll();
  }

  function onDocVisibility() {
    if (typeof document !== 'undefined' && document.hidden) {
      releaseAll();
    }
  }

  buildDOM();
  applyModeUI();
  refreshKeyLegends();
  container.hidden = !visible;

  if (typeof window !== 'undefined') {
    window.addEventListener('blur', onWindowBlur);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onDocVisibility);
  }

  return {
    setVisible,
    isVisible: () => visible,
    toggleVisible: () => setVisible(!visible),
    setMode,
    getMode: () => mode,
    releaseAll,
    resetPowerHint: () => {
      powerHintShown = false;
    },
    destroy() {
      releaseAll();
      if (typeof window !== 'undefined') {
        window.removeEventListener('blur', onWindowBlur);
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onDocVisibility);
      }
    }
  };
}
