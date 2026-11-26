/*
 * Compucorp 665 Web Emulator UI Controller
 * Manages top control bar, live hardware status bar, collapsible 20-key Omega
 * function keystrip, floppy drive cards A:..D:, auto-staging default disks,
 * built-in disk library, Diablo 630 printer capture modal, hardware settings,
 * paste modal, and confirmation dialogs.
 */

import {
  Cc665Emulator,
  DISK_SIZE,
  PHOSPHOR_RGB,
  VIDEO_PROMS,
  MAPPER_PORTS,
  renderDiabloText
} from './emulator.js?v=6';
import { attachKeyboard, OMEGA_KEYS, K_BREAK, K_RESET } from './keyboard.js';

import { createOnScreenKeyboard } from './osk.js?v=7';

const STORAGE_KEY = 'cc665.web.settings.v1';
const DRIVE_LETTERS = ['A:', 'B:', 'C:', 'D:'];

const DEFAULT_SETTINGS = Object.freeze({
  boards: 2,
  mexBoards: 0,
  mainsHz: 60,
  fast: false,
  romSwitch: false,
  lowerPage: false,
  pmReadback: false,
  mapperPort: 0,
  mapperCoversRom: false,
  pb5: false,
  jt1: false,
  ctc3: false,
  c60: false,
  videoProm: 'us',
  xcpmKeys: false,
  drivePct: 0,
  ramFill: -1,
  prnBusyMs: 0,
  centronics: false,
  jPort: 0x10,
  jWprot: false,
  wprot: [false, false, false, false],
  phosphor: 'cyan'
});

/* ---- Settings Persistence ---- */

function sanitizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const rawBoards = Number(src.boards);
  const boards =
    Number.isInteger(rawBoards) && rawBoards >= 0 && rawBoards <= 4
      ? rawBoards
      : DEFAULT_SETTINGS.boards;
  const rawMex = Number(src.mexBoards);
  const mexBoards =
    Number.isInteger(rawMex) && rawMex >= 0 && rawMex <= 3
      ? rawMex
      : DEFAULT_SETTINGS.mexBoards;
  const mainsHz = Number(src.mainsHz) === 50 ? 50 : 60;
  const fast = Boolean(src.fast);
  const romSwitch = Boolean(src.romSwitch);
  const lowerPage = Boolean(src.lowerPage);
  const pmReadback = Boolean(src.pmReadback);
  const rawMapper = Number(src.mapperPort);
  const mapperPort = MAPPER_PORTS.has(rawMapper) ? rawMapper : 0;
  const mapperCoversRom = Boolean(src.mapperCoversRom);
  const pb5 = Boolean(src.pb5);
  const jt1 = Boolean(src.jt1);
  const ctc3 = Boolean(src.ctc3);
  const c60 = Boolean(src.c60);
  const videoProm =
    typeof src.videoProm === 'string' && VIDEO_PROMS.has(src.videoProm)
      ? src.videoProm
      : DEFAULT_SETTINGS.videoProm;
  const xcpmKeys = Boolean(src.xcpmKeys);
  const rawDrivePct = Number(src.drivePct);
  const drivePct = Number.isFinite(rawDrivePct)
    ? Math.max(-10, Math.min(10, Math.round(rawDrivePct)))
    : 0;
  const rawRamFill = Number(src.ramFill);
  const ramFill =
    Number.isFinite(rawRamFill) && rawRamFill >= 0
      ? Math.max(0, Math.min(255, Math.round(rawRamFill)))
      : -1;
  const rawPrnBusy = Number(src.prnBusyMs);
  const prnBusyMs = Number.isFinite(rawPrnBusy)
    ? Math.max(0, Math.min(500, Math.round(rawPrnBusy)))
    : 0;
  const centronics = Boolean(src.centronics);
  const jPort = Number(src.jPort) === 0x14 ? 0x14 : 0x10;
  const jWprot = Boolean(src.jWprot);
  const wprot = [0, 1, 2, 3].map((i) =>
    Array.isArray(src.wprot) ? Boolean(src.wprot[i]) : false
  );
  const phosphor =
    typeof src.phosphor === 'string' && Object.prototype.hasOwnProperty.call(PHOSPHOR_RGB, src.phosphor)
      ? src.phosphor
      : DEFAULT_SETTINGS.phosphor;

  return {
    boards,
    mexBoards,
    mainsHz,
    fast,
    romSwitch,
    lowerPage,
    pmReadback,
    mapperPort,
    mapperCoversRom,
    pb5,
    jt1,
    ctc3,
    c60,
    videoProm,
    xcpmKeys,
    drivePct,
    ramFill,
    prnBusyMs,
    centronics,
    jPort,
    jWprot,
    wprot,
    phosphor
  };
}

function loadStoredSettings() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return sanitizeSettings(DEFAULT_SETTINGS);
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return sanitizeSettings(DEFAULT_SETTINGS);
  }
}

function saveStoredSettings(settings) {
  try {
    const clean = sanitizeSettings(settings);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // Ignore storage quota / private browsing errors
  }
}

/* ---- DOM References ---- */

const dom = {
  powerBadge: document.getElementById('power-badge'),
  powerBadgeText: document.getElementById('power-badge-text'),
  btnPower: document.getElementById('btn-power'),
  btnPowerText: document.getElementById('btn-power-text'),
  btnReset: document.getElementById('btn-reset'),
  btnBreak: document.getElementById('btn-break'),
  btnFast: document.getElementById('btn-fast'),
  btnLibrary: document.getElementById('btn-library'),
  libraryCountBadge: document.getElementById('library-count-badge'),
  btnKeystrip: document.getElementById('btn-keystrip'),
  btnPrinter: document.getElementById('btn-printer'),
  printerCountBadge: document.getElementById('printer-count-badge'),
  btnPaste: document.getElementById('btn-paste'),
  btnMute: document.getElementById('btn-mute'),
  btnMuteIcon: document.getElementById('btn-mute-icon'),
  btnMuteText: document.getElementById('btn-mute-text'),
  btnFullscreen: document.getElementById('btn-fullscreen'),
  btnSettings: document.getElementById('btn-settings'),
  btnAbout: document.getElementById('btn-about'),

  screenContainer: document.getElementById('screen-container'),
  canvas: document.getElementById('screen-canvas'),
  screenDropOverlay: document.getElementById('screen-drop-overlay'),
  toastContainer: document.getElementById('toast-container'),

  hardwareStatusBar: document.getElementById('hardware-status-bar'),
  hwMemText: document.getElementById('hw-mem-text'),
  hwMainsText: document.getElementById('hw-mains-text'),
  hwFlagsSep: document.getElementById('hw-flags-sep'),
  hwFlagsText: document.getElementById('hw-flags-text'),
  btnHwSer: document.getElementById('btn-hw-ser'),
  hwSerLed: document.getElementById('hw-ser-led'),
  hwSerBytes: document.getElementById('hw-ser-bytes'),
  hwSpeedText: document.getElementById('hw-speed-text'),

  omegaKeystrip: document.getElementById('omega-keystrip'),
  btnKeystripCtrl: document.getElementById('btn-keystrip-ctrl'),
  keystripHint: document.getElementById('keystrip-hint'),
  btnKeystripClose: document.getElementById('btn-keystrip-close'),
  keystripGrid: document.getElementById('keystrip-grid'),

  drivesStrip: document.getElementById('drives-strip'),
  drives: [0, 1, 2, 3].map((d) => ({
    card: document.getElementById(`drive-card-${d}`),
    led: document.getElementById(`drive-led-${d}`),
    pos: document.getElementById(`drive-pos-${d}`),
    unfmt: document.getElementById(`drive-unfmt-${d}`),
    mod: document.getElementById(`drive-mod-${d}`),
    name: document.getElementById(`drive-name-${d}`),
    btnInsert: document.getElementById(`drive-insert-${d}`),
    btnUnfmt: document.getElementById(`drive-unfmt-btn-${d}`),
    btnSave: document.getElementById(`drive-save-${d}`),
    btnEject: document.getElementById(`drive-eject-${d}`),
    btnWp: document.getElementById(`drive-wp-${d}`),
    fileInput: document.getElementById(`drive-file-${d}`)
  })),

  modalLibrary: document.getElementById('modal-library'),
  btnLibraryBootOmegaSuite: document.getElementById('btn-library-boot-omega-suite'),
  btnCloseLibrary: document.getElementById('btn-close-library'),
  btnLibraryDone: document.getElementById('btn-library-done'),
  librarySearch: document.getElementById('library-search'),
  libraryCategories: document.getElementById('library-categories'),
  libraryList: document.getElementById('library-list'),
  libraryStatusText: document.getElementById('library-status-text'),

  modalSettings: document.getElementById('modal-settings'),
  btnCloseSettings: document.getElementById('btn-close-settings'),
  btnSettingsClose: document.getElementById('btn-settings-close'),
  btnSettingsReset: document.getElementById('btn-settings-reset'),
  btnToolScreenshot: document.getElementById('btn-tool-screenshot'),
  btnToolDumpMem: document.getElementById('btn-tool-dump-mem'),
  settingsRestartBanner: document.getElementById('settings-restart-banner'),
  btnSettingsRestartNow: document.getElementById('btn-settings-restart-now'),
  settingsBoards: document.getElementById('settings-boards'),
  settingsMexBoards: document.getElementById('settings-mex-boards'),
  settingsMapperPort: document.getElementById('settings-mapper-port'),
  settingsMains60: document.getElementById('settings-mains-60'),
  settingsMains50: document.getElementById('settings-mains-50'),
  settingsC60: document.getElementById('settings-c60'),
  settingsVideoProm: document.getElementById('settings-video-prom'),
  settingsRomSwitch: document.getElementById('settings-rom-switch'),
  settingsLowerPage: document.getElementById('settings-lower-page'),
  settingsPmReadback: document.getElementById('settings-pm-readback'),
  settingsMapperCoversRom: document.getElementById('settings-mapper-covers-rom'),
  settingsPb5: document.getElementById('settings-pb5'),
  settingsJt1: document.getElementById('settings-jt1'),
  settingsCtc3: document.getElementById('settings-ctc3'),
  settingsXcpmKeys: document.getElementById('settings-xcpm-keys'),
  settingsCentronics: document.getElementById('settings-centronics'),
  settingsHdStatus: document.getElementById('settings-hd-status'),
  btnHdInsert: document.getElementById('btn-hd-insert'),
  btnHdBlank: document.getElementById('btn-hd-blank'),
  btnHdSave: document.getElementById('btn-hd-save'),
  btnHdEject: document.getElementById('btn-hd-eject'),
  inputHdFile: document.getElementById('input-hd-file'),
  settingsJStatus: document.getElementById('settings-j-status'),
  btnJInsert: document.getElementById('btn-j-insert'),
  btnJBlank: document.getElementById('btn-j-blank'),
  btnJSave: document.getElementById('btn-j-save'),
  btnJEject: document.getElementById('btn-j-eject'),
  inputJFile: document.getElementById('input-j-file'),
  settingsJPort: document.getElementById('settings-j-port'),
  settingsJWprot: document.getElementById('settings-j-wprot'),
  settingsDrivePct: document.getElementById('settings-drive-pct'),
  settingsRamFill: document.getElementById('settings-ram-fill'),
  settingsPrnBusy: document.getElementById('settings-prn-busy'),
  settingsWprot: [0, 1, 2, 3].map((d) =>
    document.getElementById(`settings-wprot-${d}`)
  ),
  settingsPhosphorCyan: document.getElementById('settings-phosphor-cyan'),
  settingsPhosphorWhite: document.getElementById('settings-phosphor-white'),
  settingsPhosphorGreen: document.getElementById('settings-phosphor-green'),
  settingsPhosphorAmber: document.getElementById('settings-phosphor-amber'),

  modalPrinter: document.getElementById('modal-printer'),
  printerSubtitle: document.getElementById('printer-subtitle'),
  btnPrinterSrcSio: document.getElementById('btn-printer-src-sio'),
  btnPrinterSrcCen: document.getElementById('btn-printer-src-cen'),
  btnPrinterViewRendered: document.getElementById('btn-printer-view-rendered'),
  btnPrinterViewRaw: document.getElementById('btn-printer-view-raw'),
  btnClosePrinter: document.getElementById('btn-close-printer'),
  printerOutput: document.getElementById('printer-output'),
  btnPrinterCopy: document.getElementById('btn-printer-copy'),
  btnPrinterDlTxt: document.getElementById('btn-printer-dl-txt'),
  btnPrinterDlBin: document.getElementById('btn-printer-dl-bin'),
  btnPrinterClear: document.getElementById('btn-printer-clear'),
  btnPrinterClose: document.getElementById('btn-printer-close'),

  modalPaste: document.getElementById('modal-paste'),
  btnClosePaste: document.getElementById('btn-close-paste'),
  pasteTextarea: document.getElementById('paste-textarea'),
  btnPasteClipboard: document.getElementById('btn-paste-clipboard'),
  btnPasteCancel: document.getElementById('btn-paste-cancel'),
  btnPasteSend: document.getElementById('btn-paste-send'),

  modalAbout: document.getElementById('modal-about'),
  btnCloseAbout: document.getElementById('btn-close-about'),
  btnAboutClose: document.getElementById('btn-about-close'),

  modalUnsaved: document.getElementById('modal-unsaved'),
  modalUnsavedDesc: document.getElementById('modal-unsaved-desc'),
  btnUnsavedCancel: document.getElementById('btn-unsaved-cancel'),
  btnUnsavedDiscard: document.getElementById('btn-unsaved-discard'),
  btnUnsavedSave: document.getElementById('btn-unsaved-save'),

  modalMemWarn: document.getElementById('modal-mem-warn'),
  modalMemWarnDesc: document.getElementById('modal-mem-warn-desc'),
  btnMemWarnContinue: document.getElementById('btn-mem-warn-continue'),
  btnMemWarnFix: document.getElementById('btn-mem-warn-fix')
};

/* ---- Application State ---- */

const initialSettings = loadStoredSettings();
const emu = new Cc665Emulator(initialSettings);
const keysButton = document.getElementById('btn-keys');
const rememberKeyboard = (key, value) => { try { localStorage.setItem('cc665.osk.' + key, value); } catch {} };
const readKeyboard = key => { try { return localStorage.getItem('cc665.osk.' + key); } catch { return null; } };
const osk = createOnScreenKeyboard(document.getElementById('osk-dock'), emu, {
  initialMode: readKeyboard('mode'),
  onModeChange: mode => rememberKeyboard('mode', mode),
  onVisibilityChange: visible => {
    keysButton.setAttribute('aria-pressed', String(visible));
    keysButton.classList.toggle('is-active', visible);
    rememberKeyboard('visible', String(visible));
  },
  onPowerNeeded: () => showToast('Power on the Compucorp to type', 'info'),
  onToggleKeystrip: () => handleToggleKeystrip()
});
keysButton.addEventListener('click', () => {
  const opening = !osk.isVisible();
  osk.setVisible(opening, { focusNative: opening });
});
if (dom.screenContainer) {
  dom.screenContainer.addEventListener('click', () => {
    if (osk.isVisible() && osk.getMode() === 'native' && !isAnyModalOpen()) {
      osk.focusNativeInput();
    }
  });
}
const savedKeyboardVisibility = readKeyboard('visible');
osk.setVisible(savedKeyboardVisibility === null
  ? matchMedia('(pointer: coarse)').matches || matchMedia('(hover: none)').matches || innerWidth <= 900
  : savedKeyboardVisibility === 'true');


let libraryManifest = null;
let libraryDisks = [];
let libraryCategory = 'All';
let libraryQuery = '';
let libraryLoadingId = null;

let keystripVisible = false;
let keystripCtrlActive = false;
let keystripButtons = [];

let printerSource = 'sio'; // 'sio' | 'cen'
let printerViewMode = 'rendered'; // 'rendered' | 'raw'
let lastRenderedPrinterKey = '';

/* ---- Toast Notifications ---- */

function showToast(message, type = 'info', durationMs = 3400) {
  if (!dom.toastContainer || !message) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  dom.toastContainer.appendChild(el);

  window.setTimeout(() => {
    if (el.parentNode) {
      el.parentNode.removeChild(el);
    }
  }, durationMs);
}

/* ---- Modal Management & Keyboard Blocking ---- */

const ALL_MODALS = [
  dom.modalUnsaved,
  dom.modalMemWarn,
  dom.modalLibrary,
  dom.modalSettings,
  dom.modalPrinter,
  dom.modalPaste,
  dom.modalAbout
];

function isAnyModalOpen() {
  return ALL_MODALS.some((m) => m && !m.hidden);
}

function isKeyboardBlocked() {
  if (isAnyModalOpen()) return true;
  const active = document.activeElement;
  if (!active) return false;
  const tag = active.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (active.isContentEditable) return true;
  return false;
}

function openModal(modalEl, focusEl = null) {
  if (!modalEl) return;
  osk.releaseAll();
  osk.blurNativeInput();
  modalEl.hidden = false;
  if (focusEl && typeof focusEl.focus === 'function') {
    window.requestAnimationFrame(() => focusEl.focus());
  }
}

function closeModal(modalEl) {
  if (!modalEl) return;
  modalEl.hidden = true;
  if (!isAnyModalOpen() && dom.screenContainer) {
    dom.screenContainer.focus();
  }
}

/* ---- Formatting Helpers ---- */

function formatByteCount(n) {
  const count = Number(n) || 0;
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`;
  return `${(count / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTrackSide(track, side) {
  const t = Math.max(0, Number(track) | 0);
  const s = Math.max(0, Number(side) | 0);
  return `T${String(t).padStart(2, '0')} S${s}`;
}

function formatMexSlot(slot) {
  if (!slot || typeof slot.card !== 'number' || typeof slot.bank !== 'number') return '--';
  const portHex = (0xf6 - slot.card).toString(16).toUpperCase();
  return `${portHex}/${String(slot.bank).padStart(2, '0')}`;
}

function formatMemStatus(telemetry) {
  const mexBoards = Number(telemetry?.mexBoards) || 0;
  if (mexBoards > 0) {
    const eStr = formatMexSlot(telemetry?.mexE);
    const cStr = formatMexSlot(telemetry?.mexC);
    return `MEX${mexBoards} (${mexBoards * 256}K) \u00B7 E:${eStr} C:${cStr}`;
  }
  const boards = Number(telemetry?.boards) || 0;
  const memLayout = boards > 0 ? `64K+${boards}\u00D764K` : '64K';
  const card = telemetry?.mappedCard;
  const bank = telemetry?.mappedBank;
  const mappedLabel =
    typeof card === 'number' && card >= 0 && typeof bank === 'number' && bank >= 0
      ? `CARD${card} BANK${bank}`
      : 'MAIN';
  return `MEM ${memLayout} \u00B7 C000: ${mappedLabel}`;
}

function formatSpeedReadout(telemetry) {
  if (!telemetry || !telemetry.poweredOn) return '--';
  const ratio = telemetry.speedRatio;
  const modeLabel = telemetry.fast ? 'FAST' : 'REAL';
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0) {
    return `\u2026 ${modeLabel}`;
  }
  const digits = ratio >= 10 ? 1 : 2;
  return `${ratio.toFixed(digits)}\u00D7 ${modeLabel}`;
}

/* ---- Omega 20-Key Function Keystrip ---- */

function buildOmegaKeystrip() {
  if (!dom.keystripGrid) return;
  dom.keystripGrid.innerHTML = '';
  keystripButtons = [];

  for (const item of OMEGA_KEYS) {
    const fkeyName = item.fkey || item.fKey || `F${(item.index % 10) + 1}`;
    const shortcutLabel = item.alt ? `\u2325${fkeyName}` : fkeyName;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'omega-key-btn';
    btn.dataset.index = String(item.index);

    const topRow = document.createElement('span');
    topRow.className = 'omega-key-top';

    const keySpan = document.createElement('span');
    keySpan.textContent = shortcutLabel;
    topRow.appendChild(keySpan);

    const subSpan = document.createElement('span');
    subSpan.className = 'omega-key-sub';
    subSpan.textContent = item.ctrl ? `^${item.ctrl}` : '';
    topRow.appendChild(subSpan);

    const mainLabel = document.createElement('span');
    mainLabel.className = 'omega-key-label';
    mainLabel.textContent = item.plain;

    btn.appendChild(topRow);
    btn.appendChild(mainLabel);

    btn.addEventListener('click', () => {
      handleOmegaKeyClick(item);
    });

    dom.keystripGrid.appendChild(btn);
    keystripButtons.push({ item, btn, mainLabel, subSpan, shortcutLabel });
  }

  renderOmegaKeystrip();
}

function renderOmegaKeystrip() {
  if (!dom.omegaKeystrip) return;
  dom.omegaKeystrip.hidden = !keystripVisible;
  dom.btnKeystrip.classList.toggle('is-active', keystripVisible);
  dom.btnKeystrip.setAttribute('aria-pressed', String(keystripVisible));

  dom.btnKeystripCtrl.classList.toggle('is-active', keystripCtrlActive);
  dom.btnKeystripCtrl.setAttribute('aria-pressed', String(keystripCtrlActive));

  if (dom.keystripHint) {
    dom.keystripHint.textContent = keystripCtrlActive
      ? 'Ctrl active: click a highlighted key to send its secondary Control command'
      : 'Click to send Omega function key \u00B7 F1\u2013F10 & Alt+F1\u2013F10';
  }

  for (const entry of keystripButtons) {
    const { item, btn, mainLabel, subSpan, shortcutLabel } = entry;
    const hasCtrl = Boolean(item.ctrl);
    btn.classList.toggle('is-ctrl-mode', keystripCtrlActive);
    btn.classList.toggle('is-ctrl-empty', keystripCtrlActive && !hasCtrl);

    if (keystripCtrlActive) {
      mainLabel.textContent = hasCtrl ? item.ctrl : item.plain;
      subSpan.textContent = hasCtrl ? item.plain : '';
      btn.title = hasCtrl
        ? `Ctrl+${shortcutLabel}: ${item.ctrl} (Plain: ${item.plain})`
        : `${shortcutLabel}: ${item.plain}`;
    } else {
      mainLabel.textContent = item.plain;
      subSpan.textContent = hasCtrl ? `^${item.ctrl}` : '';
      btn.title = hasCtrl
        ? `${shortcutLabel}: ${item.plain} (Ctrl: ${item.ctrl})`
        : `${shortcutLabel}: ${item.plain}`;
    }
  }
}

function handleToggleKeystrip() {
  keystripVisible = !keystripVisible;
  if (!keystripVisible) {
    keystripCtrlActive = false;
  }
  renderOmegaKeystrip();
  if (dom.screenContainer) {
    dom.screenContainer.focus();
  }
}

function handleToggleKeystripCtrl() {
  keystripCtrlActive = !keystripCtrlActive;
  renderOmegaKeystrip();
  if (dom.screenContainer) {
    dom.screenContainer.focus();
  }
}

function handleOmegaKeyClick(item) {
  if (!emu.isPoweredOn()) {
    showToast('Power on the Compucorp 665 before sending Omega function keys.', 'warn');
    return;
  }
  const useCtrl = keystripCtrlActive && Boolean(item.ctrl);
  const code = useCtrl ? item.codeCtrl : item.codePlain;
  emu.keyQueue(code);

  if (keystripCtrlActive) {
    keystripCtrlActive = false;
    renderOmegaKeystrip();
  }
  if (dom.screenContainer) {
    dom.screenContainer.focus();
  }
}

/* ---- Rendering UI State ---- */

function renderTopbar(telemetry) {
  const powered = Boolean(emu.isPoweredOn());
  const settings = sanitizeSettings(emu.getSettings());
  const fast = powered ? Boolean(telemetry.fast) : Boolean(settings.fast);
  const muted = Boolean(emu.isMuted());

  dom.powerBadge.classList.remove('status-off', 'status-on', 'status-fast');
  if (!powered) {
    dom.powerBadge.classList.add('status-off');
    dom.powerBadgeText.textContent = 'OFF';
    dom.btnPowerText.textContent = 'Power';
    dom.btnPower.classList.remove('is-power-on');
  } else if (fast) {
    dom.powerBadge.classList.add('status-fast');
    dom.powerBadgeText.textContent = 'FAST';
    dom.btnPowerText.textContent = 'Power';
    dom.btnPower.classList.add('is-power-on');
  } else {
    dom.powerBadge.classList.add('status-on');
    dom.powerBadgeText.textContent = 'ON';
    dom.btnPowerText.textContent = 'Power';
    dom.btnPower.classList.add('is-power-on');
  }

  dom.btnReset.disabled = !powered;
  dom.btnBreak.disabled = !powered;

  dom.btnFast.classList.toggle('is-active', fast);
  dom.btnFast.setAttribute('aria-pressed', String(fast));

  const totalPrinterBytes =
    (Number(telemetry?.printerBytes) || 0) + (Number(telemetry?.cenBytes) || 0);
  if (totalPrinterBytes > 0) {
    dom.printerCountBadge.hidden = false;
    dom.printerCountBadge.textContent = formatByteCount(totalPrinterBytes);
  } else {
    dom.printerCountBadge.hidden = true;
    dom.printerCountBadge.textContent = '0 B';
  }

  dom.btnMute.classList.toggle('is-active', muted);
  dom.btnMute.setAttribute('aria-pressed', String(muted));
  dom.btnMuteIcon.textContent = muted ? '\u{1F507}' : '\u{1F50A}';
  dom.btnMuteText.textContent = muted ? 'Muted' : 'Sound';
}

function renderHardwareStatusBar(telemetry) {
  dom.hwMemText.textContent = formatMemStatus(telemetry);
  dom.hwMainsText.textContent = `MAINS ${telemetry.mainsHz || 60} Hz`;

  const flags = [];
  if (telemetry?.c60Active) flags.push('60-LINE');
  if (telemetry?.pb5) flags.push('PB5');
  if (telemetry?.jt1) flags.push('JT1');
  if (telemetry?.xcpmKeys) flags.push('XCPM');
  if (telemetry?.hdLoaded) flags.push('HD');
  if (Number(telemetry?.jUnits) > 0) flags.push(`691\u00D7${telemetry.jUnits}`);
  if (telemetry?.cenEnabled) flags.push('CEN');
  if (dom.hwFlagsText && dom.hwFlagsSep) {
    const show = flags.length > 0;
    dom.hwFlagsSep.hidden = !show;
    dom.hwFlagsText.hidden = !show;
    dom.hwFlagsText.textContent = flags.join(' ');
  }

  const serBusy = Boolean(telemetry.serBusy);
  const totalPrinterBytes =
    (Number(telemetry.printerBytes) || 0) + (Number(telemetry.cenBytes) || 0);
  dom.hwSerLed.classList.toggle('is-active', serBusy);
  dom.hwSerBytes.textContent = formatByteCount(totalPrinterBytes);

  dom.hwSpeedText.textContent = formatSpeedReadout(telemetry);
  dom.hwSpeedText.classList.toggle('is-fast', Boolean(telemetry.poweredOn && telemetry.fast));
}

function renderDrives() {
  const settings = sanitizeSettings(emu.getSettings());
  for (let d = 0; d < 4; d++) {
    const slot = dom.drives[d];
    const st = emu.getDriveState(d) || {
      drive: d,
      loaded: false,
      unformatted: false,
      name: '',
      changed: false,
      wprot: settings.wprot[d],
      busy: false,
      track: 0,
      side: 0,
      cyls: 0,
      sides: 0,
      headerId: ''
    };

    const loaded = Boolean(st.loaded);
    const unformatted = Boolean(loaded && st.unformatted);
    const modified = Boolean(loaded && st.changed);
    const wprot = Boolean(st.wprot);
    const busy = Boolean(loaded && st.busy);

    slot.card.classList.toggle('is-loaded', loaded);
    slot.card.classList.toggle('is-modified', modified);
    slot.card.classList.toggle('is-busy', busy);

    slot.led.classList.toggle('is-busy', busy);
    slot.led.classList.toggle('is-loaded', loaded && !busy);

    if (loaded) {
      slot.pos.hidden = false;
      slot.pos.textContent = formatTrackSide(st.track, st.side);
    } else {
      slot.pos.hidden = true;
      slot.pos.textContent = 'T00 S0';
    }

    slot.unfmt.hidden = !unformatted;
    slot.mod.hidden = !modified;

    let displayName = 'Empty';
    if (loaded) {
      displayName = unformatted ? 'Unformatted' : st.name || 'Disk';
    }
    const geomSuffix =
      loaded && st.cyls > 0 && st.sides > 0 ? ` [${st.cyls}T\u00D7${st.sides}S]` : '';
    const idSuffix =
      loaded && st.headerId ? ` (ID: ${String(st.headerId).toUpperCase()})` : '';
    slot.name.textContent = displayName;
    slot.name.title = `${displayName}${geomSuffix}${idSuffix}`;
    slot.name.classList.toggle('is-empty', !loaded);

    slot.btnSave.disabled = !loaded;
    slot.btnEject.disabled = !loaded;

    slot.btnWp.classList.toggle('is-active', wprot);
    slot.btnWp.setAttribute('aria-pressed', String(wprot));
  }
}

function syncSettingsModalFromEmu() {
  const s = sanitizeSettings(emu.getSettings());

  dom.settingsBoards.value = String(s.boards);
  if (dom.settingsMexBoards) dom.settingsMexBoards.value = String(s.mexBoards);
  if (dom.settingsMapperPort) dom.settingsMapperPort.value = String(s.mapperPort);
  dom.settingsMains60.checked = s.mainsHz !== 50;
  dom.settingsMains50.checked = s.mainsHz === 50;

  if (dom.settingsC60) dom.settingsC60.checked = Boolean(s.c60);
  if (dom.settingsVideoProm) dom.settingsVideoProm.value = s.videoProm;

  dom.settingsRomSwitch.checked = Boolean(s.romSwitch);
  dom.settingsLowerPage.checked = Boolean(s.lowerPage);
  if (dom.settingsPmReadback) dom.settingsPmReadback.checked = Boolean(s.pmReadback);
  if (dom.settingsMapperCoversRom) dom.settingsMapperCoversRom.checked = Boolean(s.mapperCoversRom);
  if (dom.settingsPb5) dom.settingsPb5.checked = Boolean(s.pb5);
  if (dom.settingsJt1) dom.settingsJt1.checked = Boolean(s.jt1);
  if (dom.settingsCtc3) dom.settingsCtc3.checked = Boolean(s.ctc3);
  if (dom.settingsXcpmKeys) dom.settingsXcpmKeys.checked = Boolean(s.xcpmKeys);
  if (dom.settingsCentronics) dom.settingsCentronics.checked = Boolean(s.centronics);

  if (dom.settingsJPort) dom.settingsJPort.value = String(s.jPort);
  if (dom.settingsJWprot) dom.settingsJWprot.checked = Boolean(s.jWprot);
  if (dom.settingsDrivePct) dom.settingsDrivePct.value = String(s.drivePct);
  if (dom.settingsRamFill) dom.settingsRamFill.value = String(s.ramFill);
  if (dom.settingsPrnBusy) dom.settingsPrnBusy.value = String(s.prnBusyMs);

  const hd = emu.getWinchesterState();
  if (dom.settingsHdStatus) {
    if (hd.loaded) {
      dom.settingsHdStatus.textContent = `${hd.name} (${formatByteCount(hd.size)})`;
      dom.settingsHdStatus.classList.remove('is-empty');
    } else {
      dom.settingsHdStatus.textContent = 'Not attached';
      dom.settingsHdStatus.classList.add('is-empty');
    }
  }
  if (dom.btnHdSave) dom.btnHdSave.disabled = !hd.loaded;
  if (dom.btnHdEject) dom.btnHdEject.disabled = !hd.loaded;

  const carts = emu.getCartridgeState();
  if (dom.settingsJStatus) {
    if (carts.length > 0) {
      const names = carts.map((c) => `U${c.unit}:${c.name}`).join(', ');
      dom.settingsJStatus.textContent = `${carts.length} unit${carts.length === 1 ? '' : 's'} (${names})`;
      dom.settingsJStatus.classList.remove('is-empty');
    } else {
      dom.settingsJStatus.textContent = '0 units attached';
      dom.settingsJStatus.classList.add('is-empty');
    }
  }
  if (dom.btnJSave) dom.btnJSave.disabled = carts.length === 0;
  if (dom.btnJEject) dom.btnJEject.disabled = carts.length === 0;
  if (dom.btnJInsert) dom.btnJInsert.disabled = carts.length >= 4;
  if (dom.btnJBlank) dom.btnJBlank.disabled = carts.length >= 4;

  if (dom.btnToolDumpMem) dom.btnToolDumpMem.disabled = !emu.isPoweredOn();

  for (let d = 0; d < 4; d++) {
    if (dom.settingsWprot[d]) {
      dom.settingsWprot[d].checked = Boolean(s.wprot[d]);
    }
  }

  dom.settingsPhosphorCyan.checked = s.phosphor === 'cyan';
  dom.settingsPhosphorWhite.checked = s.phosphor === 'white';
  dom.settingsPhosphorGreen.checked = s.phosphor === 'green';
  dom.settingsPhosphorAmber.checked = s.phosphor === 'amber';

  dom.settingsRestartBanner.hidden = !emu.needsRestart();
}

function formatRawPrinterHexAndAscii(bytes) {
  const lines = [];
  const rowSize = 16;
  for (let offset = 0; offset < bytes.length; offset += rowSize) {
    const slice = bytes.subarray(offset, Math.min(bytes.length, offset + rowSize));
    const hexParts = [];
    let asciiPart = '';
    for (let i = 0; i < rowSize; i++) {
      if (i < slice.length) {
        const b = slice[i];
        hexParts.push(b.toString(16).toUpperCase().padStart(2, '0'));
        asciiPart += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
      } else {
        hexParts.push('  ');
        asciiPart += ' ';
      }
    }
    const addr = offset.toString(16).toUpperCase().padStart(6, '0');
    const leftHex = hexParts.slice(0, 8).join(' ');
    const rightHex = hexParts.slice(8).join(' ');
    lines.push(`${addr}  ${leftHex}  ${rightHex}  |${asciiPart}|`);
  }
  return lines.join('\n');
}

function getActivePrinterBytes() {
  return printerSource === 'cen' ? emu.getCentronicsBytes() : emu.getPrinterBytes();
}

function renderPrinterModal(force = false) {
  if (dom.modalPrinter.hidden && !force) return;
  const telemetry = emu.getTelemetry();
  const sioCount = Number(telemetry?.printerBytes) || 0;
  const cenCount = Number(telemetry?.cenBytes) || 0;
  const key = `${printerSource}:${printerViewMode}:${sioCount}:${cenCount}:${telemetry?.cenEnabled ? 1 : 0}`;
  if (!force && key === lastRenderedPrinterKey) return;
  lastRenderedPrinterKey = key;

  const isCen = printerSource === 'cen';
  if (dom.btnPrinterSrcSio) {
    dom.btnPrinterSrcSio.classList.toggle('is-active', !isCen);
    dom.btnPrinterSrcSio.setAttribute('aria-pressed', String(!isCen));
    dom.btnPrinterSrcSio.textContent = sioCount > 0 ? `SIO B (${formatByteCount(sioCount)})` : 'SIO B';
  }
  if (dom.btnPrinterSrcCen) {
    dom.btnPrinterSrcCen.classList.toggle('is-active', isCen);
    dom.btnPrinterSrcCen.setAttribute('aria-pressed', String(isCen));
    dom.btnPrinterSrcCen.textContent = cenCount > 0 ? `Centronics (${formatByteCount(cenCount)})` : 'Centronics (-n)';
  }

  const bytes = getActivePrinterBytes();
  const hasBytes = bytes.length > 0;

  dom.btnPrinterViewRendered.classList.toggle('is-active', printerViewMode === 'rendered');
  dom.btnPrinterViewRendered.setAttribute('aria-pressed', String(printerViewMode === 'rendered'));
  dom.btnPrinterViewRaw.classList.toggle('is-active', printerViewMode === 'raw');
  dom.btnPrinterViewRaw.setAttribute('aria-pressed', String(printerViewMode === 'raw'));

  dom.btnPrinterCopy.disabled = !hasBytes;
  dom.btnPrinterDlTxt.disabled = !hasBytes;
  dom.btnPrinterDlBin.disabled = !hasBytes;
  dom.btnPrinterClear.disabled = !hasBytes;

  if (!hasBytes) {
    if (isCen) {
      dom.printerSubtitle.textContent = telemetry?.cenEnabled
        ? '0 bytes captured \u00B7 Centronics Parallel Printer Card (-n)'
        : 'Centronics card disabled \u00B7 Enable in Settings (-n) and Hard Restart';
      dom.printerOutput.textContent = telemetry?.cenEnabled
        ? 'Waiting for parallel output on the Centronics port (00h/01h)...'
        : 'Enable "Centronics parallel printer card (-n)" in Hardware Settings and Hard Restart to capture parallel printer output.';
    } else {
      dom.printerSubtitle.textContent = '0 bytes captured \u00B7 Diablo 630 Daisy-Wheel Decoder';
      dom.printerOutput.textContent = 'Press PRINT (F4) in Omega to capture printer output.';
    }
    dom.printerOutput.classList.add('is-placeholder');
    return;
  }

  dom.printerOutput.classList.remove('is-placeholder');
  if (printerViewMode === 'rendered') {
    if (isCen) {
      dom.printerSubtitle.textContent = `${bytes.length} bytes captured \u00B7 Centronics Parallel Text`;
      dom.printerOutput.textContent = emu.getCentronicsText() || '(No printable characters decoded yet)';
    } else {
      const decoded = renderDiabloText(bytes);
      const unknownKeys = Object.keys(decoded.unknown || {});
      const unknownNote =
        unknownKeys.length > 0
          ? ` \u00B7 ${unknownKeys.length} unmapped control code${unknownKeys.length === 1 ? '' : 's'}`
          : '';
      dom.printerSubtitle.textContent = `${bytes.length} bytes captured \u00B7 Diablo 630 Rendered Text${unknownNote}`;
      dom.printerOutput.textContent = decoded.text || '(No printable characters decoded yet)';
    }
  } else {
    const label = isCen ? 'Centronics Raw Hex & ASCII' : 'SIO B Raw Hex & ASCII Stream';
    dom.printerSubtitle.textContent = `${bytes.length} bytes captured \u00B7 ${label}`;
    dom.printerOutput.textContent = formatRawPrinterHexAndAscii(bytes);
  }
}

function renderAll() {
  const telemetry = emu.getTelemetry();
  renderTopbar(telemetry);
  renderHardwareStatusBar(telemetry);
  renderDrives();
  if (!dom.modalSettings.hidden) {
    syncSettingsModalFromEmu();
  }
  if (!dom.modalPrinter.hidden) {
    renderPrinterModal(false);
  }
}

/* ---- Save Disk As (Browser Download) ---- */

function triggerBrowserDownload(bytes, filename, mimeType = 'application/octet-stream') {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const blob = new Blob([arr], { type: mimeType });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function buildSaveFilename(drive, rawName, format = 'img') {
  const ext = format === 'cc665' ? '.cc665' : '.img';
  const fallback = `cc665-drive-${'abcd'[drive]}${ext}`;
  if (!rawName || typeof rawName !== 'string') return fallback;
  const trimmed = rawName.trim();
  if (!trimmed || trimmed === 'Unformatted disk') return fallback;
  const base = trimmed.replace(/\.(img|cc665|hfe|scp)$/i, '');
  return `${base || `cc665-drive-${'abcd'[drive]}`}${ext}`;
}

function downloadDriveDisk(drive, format = 'img') {
  try {
    const saved = emu.saveDiskBytes(drive, format);
    if (!saved || !saved.imgBytes) {
      showToast(`Drive ${DRIVE_LETTERS[drive]} has no disk to save.`, 'warn');
      return false;
    }
    const fmt = saved.format === 'cc665' ? 'cc665' : format;
    const filename = buildSaveFilename(drive, saved.name, fmt);
    triggerBrowserDownload(saved.imgBytes, filename);
    renderAll();
    showToast(`Saved ${filename} from Drive ${DRIVE_LETTERS[drive]}`, 'success');
    return true;
  } catch (err) {
    showToast(
      `Failed to save Drive ${DRIVE_LETTERS[drive]}: ${err?.message || err}`,
      'error'
    );
    return false;
  }
}

/* ---- Unsaved Disk Changes Confirmation Dialog ---- */

let activeUnsavedResolver = null;

function resolveUnsavedModal(result) {
  closeModal(dom.modalUnsaved);
  const resolver = activeUnsavedResolver;
  activeUnsavedResolver = null;
  if (resolver) resolver(result);
}

function confirmUnsavedDrive(drive, actionLabel = 'continue') {
  const st = emu.getDriveState(drive);
  if (!st || !st.loaded || !st.changed) {
    return Promise.resolve(true);
  }

  if (activeUnsavedResolver) {
    resolveUnsavedModal(false);
  }

  const diskLabel = st.name || 'the current disk';
  dom.modalUnsavedDesc.textContent =
    `Drive ${DRIVE_LETTERS[drive]} (${diskLabel}) has unsaved modifications in memory. ` +
    `If you ${actionLabel} without saving, those changes will be lost.`;

  return new Promise((resolve) => {
    activeUnsavedResolver = resolve;

    dom.btnUnsavedSave.onclick = () => {
      const ok = downloadDriveDisk(drive);
      if (ok) {
        resolveUnsavedModal(true);
      }
    };
    dom.btnUnsavedDiscard.onclick = () => {
      resolveUnsavedModal(true);
    };
    dom.btnUnsavedCancel.onclick = () => {
      resolveUnsavedModal(false);
    };

    openModal(dom.modalUnsaved, dom.btnUnsavedSave);
  });
}

async function confirmAllUnsavedDrives(actionLabel = 'continue') {
  for (let d = 0; d < 4; d++) {
    const ok = await confirmUnsavedDrive(d, actionLabel);
    if (!ok) return false;
  }
  return true;
}

/* ---- Memory Board Warning Dialog (0 Boards with boot.img) ---- */

let activeMemWarnResolver = null;

function resolveMemWarnModal(choice) {
  closeModal(dom.modalMemWarn);
  const resolver = activeMemWarnResolver;
  activeMemWarnResolver = null;
  if (resolver) resolver(choice);
}

function promptMemoryBoardWarning() {
  if (activeMemWarnResolver) {
    resolveMemWarnModal('cancel');
  }

  return new Promise((resolve) => {
    activeMemWarnResolver = resolve;
    dom.btnMemWarnFix.onclick = () => resolveMemWarnModal('fix');
    dom.btnMemWarnContinue.onclick = () => resolveMemWarnModal('continue');
    openModal(dom.modalMemWarn, dom.btnMemWarnFix);
  });
}

function isOmegaBootDiskInDriveA() {
  const st = emu.getDriveState(0);
  if (!st || !st.loaded || st.unformatted) return false;
  const name = String(st.name || '').toLowerCase();
  return name === 'boot.img' || name.endsWith('/boot.img');
}

/* ---- Disk Operations ---- */

async function insertBytesIntoDrive(
  drive,
  filename,
  imgUint8Array,
  idUint8Array = null,
  { skipUnsavedCheck = false, silent = false } = {}
) {
  if (!(imgUint8Array instanceof Uint8Array) || imgUint8Array.length === 0) {
    showToast(`Invalid or empty disk image "${filename}".`, 'error', 4500);
    return false;
  }

  if (!skipUnsavedCheck) {
    const ok = await confirmUnsavedDrive(drive, 'insert another disk');
    if (!ok) return false;
  }

  const ok = emu.insertDiskBytes(drive, filename, imgUint8Array, idUint8Array);
  renderAll();
  if (!ok) return false;

  if (!silent) {
    showToast(`Inserted ${filename} in Drive ${DRIVE_LETTERS[drive]}`, 'success');
  }
  return true;
}

async function handleLocalFilesForDrive(drive, fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;

  let imgFile = null;
  let idFile = null;

  for (const f of files) {
    const lower = f.name.toLowerCase();
    if (
      lower.endsWith('.img') ||
      lower.endsWith('.cc665') ||
      lower.endsWith('.hfe') ||
      lower.endsWith('.scp')
    ) {
      imgFile = f;
    } else if (lower.endsWith('.id')) {
      idFile = f;
    }
  }

  if (!imgFile) {
    const rejectedName = files[0]?.name || 'file';
    showToast(
      `Unsupported file "${rejectedName}". Select a .img, .cc665, .hfe, or .scp floppy image.`,
      'error',
      4500
    );
    return;
  }

  try {
    const imgBuf = await imgFile.arrayBuffer();
    const imgBytes = new Uint8Array(imgBuf);
    if (imgBytes.length === 0) {
      showToast(`Disk image "${imgFile.name}" is empty.`, 'error', 4500);
      return;
    }

    let idBytes = null;
    if (idFile && imgFile.name.toLowerCase().endsWith('.img')) {
      const idBuf = await idFile.arrayBuffer();
      if (idBuf.byteLength === 3) {
        idBytes = new Uint8Array(idBuf);
      } else {
        showToast(
          `Ignored "${idFile.name}" (expected 3-byte header ID, got ${idBuf.byteLength} bytes).`,
          'warn'
        );
      }
    }

    await insertBytesIntoDrive(drive, imgFile.name, imgBytes, idBytes);
  } catch (err) {
    showToast(`Error reading ${imgFile.name}: ${err?.message || err}`, 'error');
  }
}

async function handleUnformattedDisk(drive) {
  const ok = await confirmUnsavedDrive(drive, 'insert an unformatted disk');
  if (!ok) return;
  const res = emu.insertUnformatted(drive);
  renderAll();
  if (res) {
    showToast(
      `Inserted unformatted disk in Drive ${DRIVE_LETTERS[drive]} (use Omega COMMAND P D to prepare)`,
      'info'
    );
  }
}

async function handleEjectDisk(drive) {
  const st = emu.getDriveState(drive);
  if (!st || !st.loaded) return;
  const ok = await confirmUnsavedDrive(drive, 'eject it');
  if (!ok) return;
  emu.ejectDisk(drive);
  renderAll();
  showToast(`Ejected disk from Drive ${DRIVE_LETTERS[drive]}`, 'info');
}

function handleToggleWriteProtect(drive) {
  const st = emu.getDriveState(drive);
  const current = st ? Boolean(st.wprot) : Boolean(emu.getSettings().wprot?.[drive]);
  const next = !current;
  emu.setWriteProtect(drive, next);

  const settings = sanitizeSettings(emu.getSettings());
  settings.wprot[drive] = next;
  emu.updateSettings({ wprot: settings.wprot });
  saveStoredSettings(emu.getSettings());
  renderAll();
  showToast(
    `Drive ${DRIVE_LETTERS[drive]} write protection ${next ? 'enabled' : 'disabled'}`,
    'info'
  );
}

/* ---- Power & Machine Controls ---- */

async function performPowerOn() {
  const settings = sanitizeSettings(emu.getSettings());
  if (settings.boards === 0 && isOmegaBootDiskInDriveA()) {
    const choice = await promptMemoryBoardWarning();
    if (choice === 'cancel') return;
    if (choice === 'fix') {
      emu.updateSettings({ boards: 2 });
      saveStoredSettings(emu.getSettings());
      renderAll();
      showToast('Paged Memory Boards set to 2 (64K + 128K)', 'info');
    }
  }

  try {
    await emu.powerOn();
    renderAll();
    dom.screenContainer.focus();
  } catch (err) {
    showToast(`Power On failed: ${err?.message || err}`, 'error');
  }
}

async function performPowerOff() {
  if (!emu.isPoweredOn()) return;
  const ok = await confirmAllUnsavedDrives('power off the machine');
  if (!ok) return;
  try {
    osk.releaseAll();
    emu.powerOff();
    renderAll();
    showToast('Compucorp 665 powered off', 'info');
  } catch (err) {
    showToast(`Power Off failed: ${err?.message || err}`, 'error');
  }
}

function performSoftReset() {
  if (!emu.isPoweredOn()) return;
  emu.softReset();
  renderAll();
  showToast('Compucorp 665 soft reset (Z80 reset)', 'info');
  dom.screenContainer.focus();
}

async function performHardRestart() {
  const ok = await confirmAllUnsavedDrives('hard-restart the machine');
  if (!ok) return;

  const settings = sanitizeSettings(emu.getSettings());
  if (settings.boards === 0 && isOmegaBootDiskInDriveA()) {
    const choice = await promptMemoryBoardWarning();
    if (choice === 'cancel') return;
    if (choice === 'fix') {
      emu.updateSettings({ boards: 2 });
      saveStoredSettings(emu.getSettings());
      renderAll();
      showToast('Paged Memory Boards set to 2 (64K + 128K)', 'info');
    }
  }

  try {
    if (emu.isPoweredOn()) {
      await emu.restart();
    } else {
      await emu.powerOn();
    }
    renderAll();
    showToast('Compucorp 665 restarted', 'info');
    dom.screenContainer.focus();
  } catch (err) {
    showToast(`Hard Restart failed: ${err?.message || err}`, 'error');
  }
}

function performMonitorBreak() {
  if (!emu.isPoweredOn()) return;
  emu.sendBreak();
  showToast('Sent Monitor Break', 'info');
  dom.screenContainer.focus();
}

function handleToggleFast() {
  const current = emu.getSettings().fast;
  const next = !current;
  emu.setFast(next);
  emu.updateSettings({ fast: next });
  saveStoredSettings(emu.getSettings());
  renderAll();
}

function handleToggleMute() {
  const next = !emu.isMuted();
  emu.setMuted(next);
  renderAll();
}

async function handleToggleFullscreen() {
  if (window.matchMedia('(max-width: 640px), (hover: none), (pointer: coarse)').matches) return;
  const target = dom.screenContainer;
  if (!target) return;
  try {
    if (!document.fullscreenElement) {
      await target.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  } catch (err) {
    showToast(`Fullscreen unavailable: ${err?.message || err}`, 'warn');
  }
}

/* ---- Built-In Disk Library & Auto-Staging Default Disks ---- */

async function fetchLibraryDiskAssets(disk) {
  const relPath = String(disk.file || '').replace(/^\.?\//, '');
  if (!relPath) {
    throw new Error('Disk entry has no file path');
  }
  const imgUrl = `./${relPath}`;
  const imgResp = await fetch(imgUrl);
  if (!imgResp.ok) {
    throw new Error(`HTTP ${imgResp.status} fetching ${imgUrl}`);
  }
  const imgBytes = new Uint8Array(await imgResp.arrayBuffer());
  const filename = relPath.split('/').pop() || `${disk.id || 'disk'}.img`;

  let idBytes = null;
  if (disk.idFile) {
    const idRel = String(disk.idFile).replace(/^\.?\//, '');
    try {
      const idResp = await fetch(`./${idRel}`);
      if (idResp.ok) {
        const rawId = new Uint8Array(await idResp.arrayBuffer());
        if (rawId.length === 3) {
          idBytes = rawId;
        }
      }
    } catch {
      // Optional .id companion; fall back to headerId hex if present
    }
  }
  if (!idBytes && typeof disk.headerId === 'string' && /^[0-9a-fA-F]{6}$/.test(disk.headerId)) {
    const h = disk.headerId;
    idBytes = new Uint8Array([
      Number.parseInt(h.slice(0, 2), 16),
      Number.parseInt(h.slice(2, 4), 16),
      Number.parseInt(h.slice(4, 6), 16)
    ]);
  }

  return { filename, imgBytes, idBytes };
}

async function autoStageDefaultDisks(manifest) {
  if (!manifest || !manifest.defaults || emu.isPoweredOn()) return;
  const disks = Array.isArray(manifest.disks) ? manifest.disks : [];

  const stageIfEmpty = async (drive, diskId) => {
    if (!diskId) return;
    const current = emu.getDriveState(drive);
    if (current && current.loaded) return;
    const entry = disks.find((d) => d.id === diskId);
    if (!entry) return;
    try {
      const { filename, imgBytes, idBytes } = await fetchLibraryDiskAssets(entry);
      // Verify machine is still off and drive is still empty after async fetch
      const after = emu.getDriveState(drive);
      if (emu.isPoweredOn() || (after && after.loaded)) return;
      await insertBytesIntoDrive(drive, filename, imgBytes, idBytes, {
        skipUnsavedCheck: true,
        silent: true
      });
    } catch {
      // Non-fatal if default disk asset cannot be fetched
    }
  };

  await Promise.all([
    stageIfEmpty(0, manifest.defaults.driveA),
    stageIfEmpty(1, manifest.defaults.driveB)
  ]);
  renderAll();
}

async function loadLibraryManifest() {
  try {
    const resp = await fetch('./disks/manifest.json');
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = await resp.json();
    libraryManifest = data;
    libraryDisks = Array.isArray(data?.disks) ? data.disks : [];
  } catch {
    libraryManifest = null;
    libraryDisks = [];
  }

  if (libraryDisks.length > 0) {
    dom.libraryCountBadge.hidden = false;
    dom.libraryCountBadge.textContent = String(libraryDisks.length);
  } else {
    dom.libraryCountBadge.hidden = true;
  }

  const hasOmegaBoot = libraryDisks.some((d) => d.id === 'omega-boot');
  const hasOmegaDocs = libraryDisks.some((d) => d.id === 'omega-docs');
  if (dom.btnLibraryBootOmegaSuite) {
    dom.btnLibraryBootOmegaSuite.hidden = !(hasOmegaBoot && hasOmegaDocs);
  }

  renderLibraryCategories();
  renderLibraryList();

  if (libraryManifest) {
    await autoStageDefaultDisks(libraryManifest);
  }
}

function getLibraryCategories() {
  const cats = ['All'];
  const seen = new Set(cats);
  for (const d of libraryDisks) {
    const c = d.category || 'Other';
    if (!seen.has(c)) {
      seen.add(c);
      cats.push(c);
    }
  }
  return cats;
}

function renderLibraryCategories() {
  if (!dom.libraryCategories) return;
  dom.libraryCategories.innerHTML = '';
  const cats = getLibraryCategories();
  if (!cats.includes(libraryCategory)) {
    libraryCategory = 'All';
  }

  for (const cat of cats) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `cat-tab${cat === libraryCategory ? ' is-active' : ''}`;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(cat === libraryCategory));
    btn.textContent = cat;
    btn.addEventListener('click', () => {
      libraryCategory = cat;
      renderLibraryCategories();
      renderLibraryList();
    });
    dom.libraryCategories.appendChild(btn);
  }
}

function formatDiskSizeBadge(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
    return '308 KB';
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function renderLibraryList() {
  if (!dom.libraryList) return;
  dom.libraryList.innerHTML = '';

  if (libraryDisks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'lib-empty';
    empty.textContent =
      'No built-in disk manifest found (./disks/manifest.json). You can still insert any local 315,392-byte .img disk image into Drives A: through D:.';
    dom.libraryList.appendChild(empty);
    dom.libraryStatusText.textContent = '0 bundled disks available';
    return;
  }

  const q = libraryQuery.trim().toLowerCase();
  const filtered = libraryDisks.filter((disk) => {
    if (libraryCategory !== 'All' && (disk.category || 'Other') !== libraryCategory) {
      return false;
    }
    if (!q) return true;
    const haystack = [
      disk.title,
      disk.description,
      disk.category,
      disk.file,
      disk.id,
      disk.headerId
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });

  dom.libraryStatusText.textContent = `Showing ${filtered.length} of ${libraryDisks.length} bundled disk images`;

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'lib-empty';
    empty.textContent = 'No disk images match your search or category filter.';
    dom.libraryList.appendChild(empty);
    return;
  }

  for (const disk of filtered) {
    const card = document.createElement('div');
    card.className = 'lib-card';

    const main = document.createElement('div');
    main.className = 'lib-card-main';

    const header = document.createElement('div');
    header.className = 'lib-card-header';

    const title = document.createElement('span');
    title.className = 'lib-card-title';
    title.textContent = disk.title || disk.id || 'Untitled Disk';
    header.appendChild(title);

    const badges = document.createElement('div');
    badges.className = 'lib-card-badges';

    if (disk.category) {
      const catBadge = document.createElement('span');
      catBadge.className = 'badge badge-cat';
      catBadge.textContent = disk.category;
      badges.appendChild(catBadge);
    }

    const sizeBadge = document.createElement('span');
    sizeBadge.className = 'badge badge-size';
    sizeBadge.textContent = formatDiskSizeBadge(disk.size);
    badges.appendChild(sizeBadge);

    if (disk.headerId) {
      const idBadge = document.createElement('span');
      idBadge.className = 'badge badge-id';
      idBadge.textContent = `ID ${String(disk.headerId).toUpperCase()}`;
      badges.appendChild(idBadge);
    }

    if (typeof disk.minBoards === 'number' && disk.minBoards > 0) {
      const memBadge = document.createElement('span');
      memBadge.className = 'badge badge-unfmt';
      memBadge.textContent = `\u2265${disk.minBoards} Board${disk.minBoards === 1 ? '' : 's'}`;
      badges.appendChild(memBadge);
    }

    if (disk.requiresPb5) {
      const pb5Badge = document.createElement('span');
      pb5Badge.className = 'badge badge-id';
      pb5Badge.textContent = 'PB5';
      pb5Badge.title = 'Automatically enables PB5 ROM-off mod (-5) when booted';
      badges.appendChild(pb5Badge);
    }

    header.appendChild(badges);
    main.appendChild(header);

    if (disk.description) {
      const desc = document.createElement('p');
      desc.className = 'lib-card-desc';
      desc.textContent = disk.description;
      main.appendChild(desc);
    }

    const actions = document.createElement('div');
    actions.className = 'lib-card-actions';

    const isBusy = libraryLoadingId === disk.id;

    const btnBootA = document.createElement('button');
    btnBootA.type = 'button';
    btnBootA.className = 'btn btn-primary btn-sm';
    btnBootA.disabled = Boolean(libraryLoadingId);
    btnBootA.textContent = isBusy ? 'Loading...' : 'Boot in A:';
    btnBootA.title = 'Stage disk in Drive A:, ensure required hardware settings, and boot/restart';
    btnBootA.addEventListener('click', () => handleLibraryBootInA(disk));

    const btnMountB = document.createElement('button');
    btnMountB.type = 'button';
    btnMountB.className = 'btn btn-sm';
    btnMountB.disabled = Boolean(libraryLoadingId);
    btnMountB.textContent = 'Mount in B:';
    btnMountB.title = 'Mount disk in Drive B: without restarting';
    btnMountB.addEventListener('click', () => handleLibraryMountInB(disk));

    actions.appendChild(btnBootA);
    actions.appendChild(btnMountB);

    card.appendChild(main);
    card.appendChild(actions);
    dom.libraryList.appendChild(card);
  }
}

function ensureMinBoardsForDisk(disk) {
  const settings = sanitizeSettings(emu.getSettings());
  const updates = {};
  const notes = [];

  const minBoards = Number(disk?.minBoards) || 0;
  if (minBoards > 0 && settings.boards < minBoards) {
    const nextBoards = Math.max(2, minBoards);
    updates.boards = nextBoards;
    notes.push(`Paged Memory Boards \u2192 ${nextBoards}`);
  }
  if (disk?.requiresPb5 && !settings.pb5) {
    updates.pb5 = true;
    notes.push('PB5 ROM-off (-5)');
  }
  if (disk?.xcpmKeys && !settings.xcpmKeys) {
    updates.xcpmKeys = true;
    emu.setXcpmKeys(true);
    notes.push('xcpmz80 keys (-Z)');
  }

  if (Object.keys(updates).length > 0) {
    emu.updateSettings(updates);
    saveStoredSettings(emu.getSettings());
    showToast(
      `Enabled ${notes.join(', ')} for ${disk.title || 'disk'}.`,
      'info',
      4500
    );
  }
}

async function handleLibraryBootInA(disk) {
  if (libraryLoadingId) return;

  const unsavedOk = emu.isPoweredOn()
    ? await confirmAllUnsavedDrives(`boot ${disk.title || 'selected disk'}`)
    : await confirmUnsavedDrive(0, `boot ${disk.title || 'selected disk'}`);
  if (!unsavedOk) return;

  libraryLoadingId = disk.id || 'loading';
  renderLibraryList();

  try {
    const { filename, imgBytes, idBytes } = await fetchLibraryDiskAssets(disk);
    ensureMinBoardsForDisk(disk);

    const inserted = await insertBytesIntoDrive(0, filename, imgBytes, idBytes, {
      skipUnsavedCheck: true,
      silent: true
    });
    if (!inserted) return;

    closeModal(dom.modalLibrary);

    if (emu.isPoweredOn()) {
      await emu.restart();
    } else {
      await emu.powerOn();
    }
    renderAll();
    showToast(`Booting ${disk.title || filename} in Drive A:`, 'success');
    dom.screenContainer.focus();
  } catch (err) {
    showToast(`Failed to boot ${disk.title}: ${err?.message || err}`, 'error');
  } finally {
    libraryLoadingId = null;
    renderLibraryList();
  }
}

async function handleLibraryMountInB(disk) {
  if (libraryLoadingId) return;

  const ok = await confirmUnsavedDrive(1, 'mount another disk in Drive B:');
  if (!ok) return;

  libraryLoadingId = disk.id || 'loading';
  renderLibraryList();

  try {
    const { filename, imgBytes, idBytes } = await fetchLibraryDiskAssets(disk);
    closeModal(dom.modalLibrary);
    await insertBytesIntoDrive(1, filename, imgBytes, idBytes, {
      skipUnsavedCheck: true
    });
    dom.screenContainer.focus();
  } catch (err) {
    showToast(`Failed to mount ${disk.title}: ${err?.message || err}`, 'error');
  } finally {
    libraryLoadingId = null;
    renderLibraryList();
  }
}

async function handleLibraryBootOmegaSuite() {
  if (libraryLoadingId) return;
  const bootDisk = libraryDisks.find((d) => d.id === 'omega-boot');
  const docsDisk = libraryDisks.find((d) => d.id === 'omega-docs');
  if (!bootDisk || !docsDisk) return;

  const unsavedOk = await confirmAllUnsavedDrives('boot the Omega Suite');
  if (!unsavedOk) return;

  libraryLoadingId = 'omega-boot';
  renderLibraryList();

  try {
    const [bootAssets, docsAssets] = await Promise.all([
      fetchLibraryDiskAssets(bootDisk),
      fetchLibraryDiskAssets(docsDisk)
    ]);

    ensureMinBoardsForDisk(bootDisk);

    const okA = await insertBytesIntoDrive(
      0,
      bootAssets.filename,
      bootAssets.imgBytes,
      bootAssets.idBytes,
      { skipUnsavedCheck: true, silent: true }
    );
    const okB = await insertBytesIntoDrive(
      1,
      docsAssets.filename,
      docsAssets.imgBytes,
      docsAssets.idBytes,
      { skipUnsavedCheck: true, silent: true }
    );
    if (!okA || !okB) return;

    closeModal(dom.modalLibrary);

    if (emu.isPoweredOn()) {
      await emu.restart();
    } else {
      await emu.powerOn();
    }
    renderAll();
    showToast('Booting Omega Suite (A: boot.img + B: docs.img)', 'success');
    dom.screenContainer.focus();
  } catch (err) {
    showToast(`Failed to boot Omega Suite: ${err?.message || err}`, 'error');
  } finally {
    libraryLoadingId = null;
    renderLibraryList();
  }
}

/* ---- Settings Modal Events ---- */

function wireSettingsEvents() {
  const applySetting = (partial) => {
    emu.updateSettings(partial);
    saveStoredSettings(emu.getSettings());
    renderAll();
  };

  dom.settingsBoards.addEventListener('change', () => {
    const boards = Number.parseInt(dom.settingsBoards.value, 10);
    if (Number.isInteger(boards) && boards >= 0 && boards <= 4) {
      applySetting({ boards });
      if (boards === 0) {
        showToast('Note: Omega requires at least 1 paged memory board.', 'warn');
      }
    }
  });

  dom.settingsMexBoards?.addEventListener('change', () => {
    const mexBoards = Number.parseInt(dom.settingsMexBoards.value, 10);
    if (Number.isInteger(mexBoards) && mexBoards >= 0 && mexBoards <= 3) {
      applySetting({ mexBoards });
    }
  });

  dom.settingsMapperPort?.addEventListener('change', () => {
    const mapperPort = Number.parseInt(dom.settingsMapperPort.value, 10);
    if (MAPPER_PORTS.has(mapperPort)) {
      applySetting({ mapperPort });
    }
  });

  const onMainsChange = () => {
    const mainsHz = dom.settingsMains50.checked ? 50 : 60;
    applySetting({ mainsHz });
  };
  dom.settingsMains60.addEventListener('change', onMainsChange);
  dom.settingsMains50.addEventListener('change', onMainsChange);

  dom.settingsC60?.addEventListener('change', () => {
    applySetting({ c60: Boolean(dom.settingsC60.checked) });
  });

  dom.settingsVideoProm?.addEventListener('change', () => {
    const prom = dom.settingsVideoProm.value;
    if (VIDEO_PROMS.has(prom)) {
      emu.setVideoProm(prom);
      saveStoredSettings(emu.getSettings());
      syncSettingsModalFromEmu();
      showToast(`Video glyph PROM switched to ${prom}`, 'info');
    }
  });

  dom.settingsRomSwitch.addEventListener('change', () => {
    applySetting({ romSwitch: Boolean(dom.settingsRomSwitch.checked) });
  });

  dom.settingsLowerPage.addEventListener('change', () => {
    applySetting({ lowerPage: Boolean(dom.settingsLowerPage.checked) });
  });

  dom.settingsPmReadback?.addEventListener('change', () => {
    applySetting({ pmReadback: Boolean(dom.settingsPmReadback.checked) });
  });

  dom.settingsMapperCoversRom?.addEventListener('change', () => {
    applySetting({ mapperCoversRom: Boolean(dom.settingsMapperCoversRom.checked) });
  });

  dom.settingsPb5?.addEventListener('change', () => {
    applySetting({ pb5: Boolean(dom.settingsPb5.checked) });
  });

  dom.settingsJt1?.addEventListener('change', () => {
    const on = Boolean(dom.settingsJt1.checked);
    emu.setJt1(on);
    saveStoredSettings(emu.getSettings());
    renderAll();
  });

  dom.settingsCtc3?.addEventListener('change', () => {
    applySetting({ ctc3: Boolean(dom.settingsCtc3.checked) });
  });

  dom.settingsXcpmKeys?.addEventListener('change', () => {
    const on = Boolean(dom.settingsXcpmKeys.checked);
    emu.setXcpmKeys(on);
    saveStoredSettings(emu.getSettings());
    renderAll();
  });

  dom.settingsCentronics?.addEventListener('change', () => {
    applySetting({ centronics: Boolean(dom.settingsCentronics.checked) });
  });

  // Winchester Hard Disk (-W)
  dom.btnHdInsert?.addEventListener('click', () => {
    if (!dom.inputHdFile) return;
    dom.inputHdFile.value = '';
    dom.inputHdFile.click();
  });
  dom.inputHdFile?.addEventListener('change', async () => {
    const file = dom.inputHdFile.files?.[0];
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const res = emu.insertWinchesterBytes(file.name, bytes);
      renderAll();
      if (res.ok) {
        showToast(`Attached Winchester image ${file.name} (${formatByteCount(res.size)})`, 'success');
      } else {
        showToast(res.error || 'Failed to mount Winchester image.', 'error');
      }
    } catch (err) {
      showToast(`Error reading ${file.name}: ${err?.message || err}`, 'error');
    }
  });
  dom.btnHdBlank?.addEventListener('click', () => {
    const res = emu.insertBlankWinchester(4896);
    renderAll();
    if (res.ok) {
      showToast('Attached blank 5 MB Winchester hard disk', 'success');
    } else {
      showToast(res.error || 'Failed to attach blank Winchester disk.', 'error');
    }
  });
  dom.btnHdSave?.addEventListener('click', () => {
    const saved = emu.saveWinchesterBytes();
    if (!saved) {
      showToast('No Winchester hard disk attached to save.', 'warn');
      return;
    }
    triggerBrowserDownload(saved.bytes, saved.name);
    showToast(`Saved ${saved.name}`, 'success');
  });
  dom.btnHdEject?.addEventListener('click', () => {
    emu.ejectWinchester();
    renderAll();
    showToast('Ejected Winchester hard disk', 'info');
  });

  // 691 Cartridge Hard Disk (-J)
  dom.btnJInsert?.addEventListener('click', () => {
    if (!dom.inputJFile) return;
    dom.inputJFile.value = '';
    dom.inputJFile.click();
  });
  dom.inputJFile?.addEventListener('change', async () => {
    const file = dom.inputJFile.files?.[0];
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const res = emu.insertCartridgeBytes(file.name, bytes);
      renderAll();
      if (res.ok) {
        showToast(`Attached 691 Cartridge Unit ${res.unit}: ${file.name}`, 'success');
      } else {
        showToast(res.error || 'Failed to attach 691 cartridge image.', 'error');
      }
    } catch (err) {
      showToast(`Error reading ${file.name}: ${err?.message || err}`, 'error');
    }
  });
  dom.btnJBlank?.addEventListener('click', () => {
    const res = emu.insertBlankCartridge();
    renderAll();
    if (res.ok) {
      showToast(`Attached blank 691 Cartridge Unit ${res.unit}`, 'success');
    } else {
      showToast(res.error || 'Failed to attach blank 691 cartridge.', 'error');
    }
  });
  dom.btnJSave?.addEventListener('click', () => {
    const saved = emu.saveCartridgeBytes(0);
    if (!saved) {
      showToast('No 691 Cartridge Unit 0 available to save.', 'warn');
      return;
    }
    triggerBrowserDownload(saved.bytes, saved.name);
    showToast(`Saved ${saved.name}`, 'success');
  });
  dom.btnJEject?.addEventListener('click', () => {
    emu.ejectAllCartridges();
    renderAll();
    showToast('Ejected all 691 cartridge units', 'info');
  });
  dom.settingsJPort?.addEventListener('change', () => {
    const jPort = Number.parseInt(dom.settingsJPort.value, 10) === 0x14 ? 0x14 : 0x10;
    applySetting({ jPort });
  });
  dom.settingsJWprot?.addEventListener('change', () => {
    const on = Boolean(dom.settingsJWprot.checked);
    emu.setJWprot(on);
    saveStoredSettings(emu.getSettings());
    renderAll();
  });

  // Timing & Calibration
  dom.settingsDrivePct?.addEventListener('change', () => {
    const raw = Number.parseInt(dom.settingsDrivePct.value, 10);
    const drivePct = Number.isFinite(raw) ? Math.max(-10, Math.min(10, raw)) : 0;
    applySetting({ drivePct });
  });
  dom.settingsRamFill?.addEventListener('change', () => {
    const raw = Number.parseInt(dom.settingsRamFill.value, 10);
    const ramFill = Number.isFinite(raw) && raw >= 0 ? Math.min(255, raw) : -1;
    applySetting({ ramFill });
  });
  dom.settingsPrnBusy?.addEventListener('change', () => {
    const raw = Number.parseInt(dom.settingsPrnBusy.value, 10);
    const prnBusyMs = Number.isFinite(raw) ? Math.max(0, Math.min(500, raw)) : 0;
    applySetting({ prnBusyMs });
  });

  // Tools: Save Screen PNG & Dump Memory
  dom.btnToolScreenshot?.addEventListener('click', () => {
    if (!dom.canvas) return;
    try {
      const dataUrl = dom.canvas.toDataURL('image/png');
      const link = document.createElement('a');
      link.href = dataUrl;
      link.download = 'cc665-screen.png';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showToast('Saved cc665-screen.png', 'success');
    } catch (err) {
      showToast(`Screenshot failed: ${err?.message || err}`, 'error');
    }
  });

  dom.btnToolDumpMem?.addEventListener('click', () => {
    const bytes = emu.dumpMemoryBytes();
    if (!bytes || bytes.length === 0) {
      showToast('Power on the Compucorp 665 before dumping memory.', 'warn');
      return;
    }
    triggerBrowserDownload(bytes, 'cc665-ram-64k.bin');
    showToast(`Downloaded cc665-ram-64k.bin (${formatByteCount(bytes.length)})`, 'success');
  });

  for (let d = 0; d < 4; d++) {
    dom.settingsWprot[d]?.addEventListener('change', (e) => {
      const checked = Boolean(e.target.checked);
      emu.setWriteProtect(d, checked);
      const s = sanitizeSettings(emu.getSettings());
      s.wprot[d] = checked;
      emu.updateSettings({ wprot: s.wprot });
      saveStoredSettings(emu.getSettings());
      renderAll();
    });
  }

  const onPhosphorChange = (mode) => {
    emu.setPhosphor(mode);
    emu.updateSettings({ phosphor: mode });
    saveStoredSettings(emu.getSettings());
    syncSettingsModalFromEmu();
  };
  dom.settingsPhosphorCyan.addEventListener('change', () => {
    if (dom.settingsPhosphorCyan.checked) onPhosphorChange('cyan');
  });
  dom.settingsPhosphorWhite.addEventListener('change', () => {
    if (dom.settingsPhosphorWhite.checked) onPhosphorChange('white');
  });
  dom.settingsPhosphorGreen.addEventListener('change', () => {
    if (dom.settingsPhosphorGreen.checked) onPhosphorChange('green');
  });
  dom.settingsPhosphorAmber.addEventListener('change', () => {
    if (dom.settingsPhosphorAmber.checked) onPhosphorChange('amber');
  });

  dom.btnSettingsRestartNow.addEventListener('click', async () => {
    closeModal(dom.modalSettings);
    await performHardRestart();
  });

  dom.btnSettingsReset.addEventListener('click', () => {
    const def = sanitizeSettings(DEFAULT_SETTINGS);
    emu.setFast(def.fast);
    emu.setPhosphor(def.phosphor);
    emu.setVideoProm(def.videoProm);
    emu.setJt1(def.jt1);
    emu.setXcpmKeys(def.xcpmKeys);
    emu.setJWprot(def.jWprot);
    for (let d = 0; d < 4; d++) {
      emu.setWriteProtect(d, def.wprot[d]);
    }
    emu.updateSettings(def);
    saveStoredSettings(emu.getSettings());
    renderAll();
    showToast('Settings reset to defaults (2 boards, 60 Hz, US PROM, 665 Cyan)', 'info');
  });
}

/* ---- Printer Output Modal ---- */

function openPrinterModal() {
  renderPrinterModal(true);
  openModal(dom.modalPrinter, dom.btnPrinterClose);
}

async function handleCopyPrinterText() {
  const bytes = getActivePrinterBytes();
  if (bytes.length === 0) return;
  const content =
    printerViewMode === 'rendered'
      ? printerSource === 'cen'
        ? emu.getCentronicsText()
        : renderDiabloText(bytes).text
      : formatRawPrinterHexAndAscii(bytes);

  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(content);
      showToast('Copied printer output to clipboard', 'success');
      return;
    } catch {
      // Fallback below
    }
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = content;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('Copied printer output to clipboard', 'success');
  } catch {
    showToast('Could not copy automatically; select text and press Ctrl+C.', 'warn');
  }
}

function handleDownloadPrinterTxt() {
  const bytes = getActivePrinterBytes();
  if (bytes.length === 0) return;
  const text = printerSource === 'cen' ? emu.getCentronicsText() : renderDiabloText(bytes).text;
  const name = printerSource === 'cen' ? 'cc665-centronics.txt' : 'cc665-printer.txt';
  const encoded = new TextEncoder().encode(text);
  triggerBrowserDownload(encoded, name, 'text/plain;charset=utf-8');
  showToast(`Downloaded ${name}`, 'success');
}

function handleDownloadPrinterBin() {
  const bytes = getActivePrinterBytes();
  if (bytes.length === 0) return;
  const name = printerSource === 'cen' ? 'cc665-centronics-raw.bin' : 'cc665-printer-raw.bin';
  triggerBrowserDownload(bytes, name, 'application/octet-stream');
  showToast(`Downloaded ${name}`, 'success');
}

function handleClearPrinter() {
  if (printerSource === 'cen') {
    emu.clearCentronics();
  } else {
    emu.clearPrinter();
  }
  lastRenderedPrinterKey = '';
  renderPrinterModal(true);
  renderAll();
  showToast(
    `Cleared ${printerSource === 'cen' ? 'Centronics' : 'SIO B'} printer output`,
    'info'
  );
}

/* ---- Paste Text Modal ---- */

function openPasteModal() {
  dom.pasteTextarea.value = '';
  openModal(dom.modalPaste, dom.pasteTextarea);
}

function handleSendPaste() {
  const text = dom.pasteTextarea.value;
  if (!text) {
    closeModal(dom.modalPaste);
    return;
  }
  if (!emu.isPoweredOn()) {
    showToast('Power on the Compucorp 665 before pasting text.', 'warn');
    return;
  }
  emu.pasteText(text);
  closeModal(dom.modalPaste);
  showToast(
    `Queued ${text.length} character${text.length === 1 ? '' : 's'} to Compucorp 665`,
    'info'
  );
}

async function handleReadClipboardIntoPaste() {
  if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
    showToast('Clipboard API unavailable; press Ctrl+V / Cmd+V in the text box.', 'warn');
    dom.pasteTextarea.focus();
    return;
  }
  try {
    const clip = await navigator.clipboard.readText();
    dom.pasteTextarea.value = clip;
    dom.pasteTextarea.focus();
  } catch {
    showToast('Paste directly into the box with Ctrl+V / Cmd+V.', 'info');
    dom.pasteTextarea.focus();
  }
}

/* ---- Drag-and-Drop Support (Screen Viewport & Drive Cards) ---- */

function hasDraggedFiles(e) {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  return Array.from(types).includes('Files');
}

function wireDragAndDrop() {
  // Screen viewport drops into Drive A:
  let screenDragDepth = 0;
  dom.screenContainer.addEventListener('dragenter', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    screenDragDepth++;
    dom.screenDropOverlay.hidden = false;
  });

  dom.screenContainer.addEventListener('dragover', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  dom.screenContainer.addEventListener('dragleave', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    screenDragDepth = Math.max(0, screenDragDepth - 1);
    if (screenDragDepth === 0) {
      dom.screenDropOverlay.hidden = true;
    }
  });

  dom.screenContainer.addEventListener('drop', async (e) => {
    e.preventDefault();
    screenDragDepth = 0;
    dom.screenDropOverlay.hidden = true;
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      await handleLocalFilesForDrive(0, files);
    }
  });

  // Individual drive cards A:..D:
  for (let d = 0; d < 4; d++) {
    const card = dom.drives[d].card;
    let cardDepth = 0;

    card.addEventListener('dragenter', (e) => {
      if (!hasDraggedFiles(e)) return;
      e.preventDefault();
      cardDepth++;
      card.classList.add('is-dragover');
    });

    card.addEventListener('dragover', (e) => {
      if (!hasDraggedFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });

    card.addEventListener('dragleave', (e) => {
      if (!hasDraggedFiles(e)) return;
      e.preventDefault();
      cardDepth = Math.max(0, cardDepth - 1);
      if (cardDepth === 0) {
        card.classList.remove('is-dragover');
      }
    });

    card.addEventListener('drop', async (e) => {
      e.preventDefault();
      cardDepth = 0;
      card.classList.remove('is-dragover');
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        await handleLocalFilesForDrive(d, files);
      }
    });
  }
}

/* ---- Event Listeners & Global Shortcuts ---- */

function wireControls() {
  // Topbar buttons
  dom.btnPower.addEventListener('click', async () => {
    if (emu.isPoweredOn()) {
      await performPowerOff();
    } else {
      await performPowerOn();
    }
  });

  dom.btnReset.addEventListener('click', async (e) => {
    if (e.shiftKey) {
      await performHardRestart();
    } else {
      performSoftReset();
    }
  });

  dom.btnBreak.addEventListener('click', () => {
    performMonitorBreak();
  });

  dom.btnFast.addEventListener('click', () => {
    handleToggleFast();
  });

  dom.btnLibrary.addEventListener('click', () => {
    renderLibraryCategories();
    renderLibraryList();
    openModal(dom.modalLibrary, dom.librarySearch);
  });

  dom.btnKeystrip.addEventListener('click', () => {
    handleToggleKeystrip();
  });

  dom.btnPrinter.addEventListener('click', () => {
    openPrinterModal();
  });

  dom.btnHwSer.addEventListener('click', () => {
    openPrinterModal();
  });

  dom.btnPaste.addEventListener('click', () => {
    openPasteModal();
  });

  dom.btnMute.addEventListener('click', () => {
    handleToggleMute();
  });

  dom.btnFullscreen.addEventListener('click', () => {
    handleToggleFullscreen();
  });

  dom.btnSettings.addEventListener('click', () => {
    syncSettingsModalFromEmu();
    openModal(dom.modalSettings, dom.settingsBoards);
  });

  dom.btnAbout.addEventListener('click', () => {
    openModal(dom.modalAbout, dom.btnAboutClose);
  });

  // Keystrip bar controls
  dom.btnKeystripCtrl.addEventListener('click', () => {
    handleToggleKeystripCtrl();
  });
  dom.btnKeystripClose.addEventListener('click', () => {
    if (keystripVisible) {
      handleToggleKeystrip();
    }
  });

  // Drive cards A:..D:
  for (let d = 0; d < 4; d++) {
    const slot = dom.drives[d];
    slot.btnInsert.addEventListener('click', () => {
      slot.fileInput.value = '';
      slot.fileInput.click();
    });
    slot.fileInput.addEventListener('change', async () => {
      const files = slot.fileInput.files;
      if (files && files.length > 0) {
        await handleLocalFilesForDrive(d, files);
      }
    });
    slot.btnUnfmt.addEventListener('click', () => handleUnformattedDisk(d));
    slot.btnSave.addEventListener('click', (e) =>
      downloadDriveDisk(d, e.shiftKey ? 'cc665' : 'img')
    );
    slot.btnEject.addEventListener('click', () => handleEjectDisk(d));
    slot.btnWp.addEventListener('click', () => handleToggleWriteProtect(d));
  }

  // Library Modal events
  dom.btnLibraryBootOmegaSuite.addEventListener('click', () => handleLibraryBootOmegaSuite());
  dom.btnCloseLibrary.addEventListener('click', () => closeModal(dom.modalLibrary));
  dom.btnLibraryDone.addEventListener('click', () => closeModal(dom.modalLibrary));
  dom.librarySearch.addEventListener('input', () => {
    libraryQuery = dom.librarySearch.value || '';
    renderLibraryList();
  });

  // Settings Modal close
  dom.btnCloseSettings.addEventListener('click', () => closeModal(dom.modalSettings));
  dom.btnSettingsClose.addEventListener('click', () => closeModal(dom.modalSettings));

  // Printer Modal events
  dom.btnClosePrinter.addEventListener('click', () => closeModal(dom.modalPrinter));
  dom.btnPrinterClose.addEventListener('click', () => closeModal(dom.modalPrinter));
  dom.btnPrinterSrcSio?.addEventListener('click', () => {
    printerSource = 'sio';
    renderPrinterModal(true);
  });
  dom.btnPrinterSrcCen?.addEventListener('click', () => {
    printerSource = 'cen';
    renderPrinterModal(true);
  });
  dom.btnPrinterViewRendered.addEventListener('click', () => {
    printerViewMode = 'rendered';
    renderPrinterModal(true);
  });
  dom.btnPrinterViewRaw.addEventListener('click', () => {
    printerViewMode = 'raw';
    renderPrinterModal(true);
  });
  dom.btnPrinterCopy.addEventListener('click', () => handleCopyPrinterText());
  dom.btnPrinterDlTxt.addEventListener('click', () => handleDownloadPrinterTxt());
  dom.btnPrinterDlBin.addEventListener('click', () => handleDownloadPrinterBin());
  dom.btnPrinterClear.addEventListener('click', () => handleClearPrinter());

  // Paste Modal events
  dom.btnClosePaste.addEventListener('click', () => closeModal(dom.modalPaste));
  dom.btnPasteCancel.addEventListener('click', () => closeModal(dom.modalPaste));
  dom.btnPasteSend.addEventListener('click', () => handleSendPaste());
  dom.btnPasteClipboard.addEventListener('click', () => handleReadClipboardIntoPaste());

  // About Modal close
  dom.btnCloseAbout.addEventListener('click', () => closeModal(dom.modalAbout));
  dom.btnAboutClose.addEventListener('click', () => closeModal(dom.modalAbout));

  // Click on backdrop outside modal panel to close
  for (const modal of [
    dom.modalLibrary,
    dom.modalSettings,
    dom.modalPrinter,
    dom.modalPaste,
    dom.modalAbout
  ]) {
    modal.addEventListener('mousedown', (e) => {
      if (e.target === modal) {
        closeModal(modal);
      }
    });
  }
  dom.modalUnsaved.addEventListener('mousedown', (e) => {
    if (e.target === dom.modalUnsaved) {
      resolveUnsavedModal(false);
    }
  });
  dom.modalMemWarn.addEventListener('mousedown', (e) => {
    if (e.target === dom.modalMemWarn) {
      resolveMemWarnModal('cancel');
    }
  });

  // UI Keyboard Shortcuts (Alt+1..4, Alt+R, Alt+B, Alt+F, Alt+K, Alt+P, Alt+,, Escape for open modals)
  // NOTE: Never intercept Ctrl shortcuts (Ctrl belongs to the 665) or Alt+F1..F10 (belong to Omega)!
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && isAnyModalOpen()) {
        e.preventDefault();
        e.stopPropagation();
        if (!dom.modalUnsaved.hidden) {
          resolveUnsavedModal(false);
        } else if (!dom.modalMemWarn.hidden) {
          resolveMemWarnModal('cancel');
        } else if (!dom.modalPaste.hidden) {
          closeModal(dom.modalPaste);
        } else if (!dom.modalPrinter.hidden) {
          closeModal(dom.modalPrinter);
        } else if (!dom.modalSettings.hidden) {
          closeModal(dom.modalSettings);
        } else if (!dom.modalLibrary.hidden) {
          closeModal(dom.modalLibrary);
        } else if (!dom.modalAbout.hidden) {
          closeModal(dom.modalAbout);
        }
        return;
      }

      if (!e.altKey || e.ctrlKey || e.metaKey) return;

      // Never intercept Alt+F1..F10 (Omega right-side function keys)
      if (/^F([1-9]|10)$/i.test(e.key) || /^F([1-9]|10)$/i.test(e.code)) {
        return;
      }

      const key = e.key.toLowerCase();
      const code = e.code || '';
      if (
        key === '1' || key === '2' || key === '3' || key === '4' ||
        code === 'Digit1' || code === 'Digit2' || code === 'Digit3' || code === 'Digit4'
      ) {
        e.preventDefault();
        const digit = /^[1-4]$/.test(key) ? key : code.slice(-1);
        const drive = Number.parseInt(digit, 10) - 1;
        const input = dom.drives[drive]?.fileInput;
        if (input) {
          input.value = '';
          input.click();
        }
      } else if (key === 'r' || code === 'KeyR') {
        e.preventDefault();
        if (emu.isPoweredOn()) {
          if (e.shiftKey) {
            performHardRestart();
          } else {
            performSoftReset();
          }
        }
      } else if (key === 'b' || code === 'KeyB') {
        e.preventDefault();
        if (emu.isPoweredOn()) {
          performMonitorBreak();
        }
      } else if (key === 'f' || code === 'KeyF') {
        e.preventDefault();
        handleToggleFast();
      } else if (key === 'k' || code === 'KeyK') {
        e.preventDefault();
        const opening = !osk.isVisible();
        osk.setVisible(opening, { focusNative: opening });
      } else if (key === 'p' || code === 'KeyP') {
        e.preventDefault();
        if (!dom.modalPrinter.hidden) {
          closeModal(dom.modalPrinter);
        } else {
          openPrinterModal();
        }
      } else if (key === ',' || code === 'Comma') {
        e.preventDefault();
        syncSettingsModalFromEmu();
        openModal(dom.modalSettings, dom.settingsBoards);
      }
    },
    true
  );

  // Warn before closing/reloading browser tab when any drive has unsaved writes
  window.addEventListener('beforeunload', (e) => {
    if (emu.hasUnsavedChanges()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

/* ---- Application Bootstrap ---- */

async function bootstrap() {
  // Touch K_BREAK and K_RESET imports so bundlers/linters see them as used
  void K_BREAK;
  void K_RESET;

  buildOmegaKeystrip();
  wireSettingsEvents();
  wireControls();
  wireDragAndDrop();

  attachKeyboard(window, emu, {
    isBlocked: () => isKeyboardBlocked(),
    onToggleFast: () => handleToggleFast()
  });

  renderAll();

  // Load built-in disk library manifest & auto-stage defaults in parallel with ROM init
  loadLibraryManifest();

  try {
    await emu.init({
      canvas: dom.canvas,
      romUrl: './cc665_rom.bin',
      promLUrl: './cc665_prom_l.bin',
      promHUrl: './cc665_prom_h.bin',
      logoUrl: './cc665_logo.png',
      onStateChange: () => {
        renderAll();
      },
      onError: (msg) => {
        showToast(String(msg || 'Emulator error'), 'error', 5000);
      }
    });
    renderAll();
  } catch (err) {
    showToast(
      `Failed to initialize Compucorp 665 ROM/assets: ${err?.message || err}`,
      'error',
      6000
    );
  }
}

bootstrap();
