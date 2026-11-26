import { Max80Emulator, BOOT_DEVICES } from './emulator.js';
import { attachKeyboard } from './keyboard.js';
import { createOnScreenKeyboard } from './osk.js';

const STORAGE_KEY = 'max80.web.settings.v1';
const OSK_STORAGE_KEY = 'max80.web.osk.v1';
const DRIVE_LETTERS = ['A:', 'B:', 'C:', 'D:'];

const BOOT_DEVICE_NAMES =
  Array.isArray(BOOT_DEVICES) && BOOT_DEVICES.length === 8
    ? BOOT_DEVICES
    : [
        'None',
        '5-inch floppy',
        '8-inch floppy',
        '5-inch winchester',
        '8-inch winchester',
        '5-inch backup floppy',
        '8-inch backup floppy',
        'SASI hard disk'
      ];

const DEFAULT_SETTINGS = Object.freeze({
  dips: 2,
  memMode: '128',
  mem64: false,
  quick: false,
  fast: false,
  timeSet: false,
  three: [false, false, false, false],
  wprot: [false, false, false, false],
  phosphor: 'white'
});

/* ---- Settings Persistence ---- */

function sanitizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const dips =
    typeof src.dips === 'number' && Number.isFinite(src.dips)
      ? src.dips & 0xff
      : DEFAULT_SETTINGS.dips;
  const memMode =
    src.memMode === '64' || src.memMode === '64f' || src.memMode === '128'
      ? src.memMode
      : src.mem64
        ? '64'
        : '128';
  const mem64 = memMode !== '128';
  const quick = Boolean(src.quick);
  const fast = Boolean(src.fast);
  const timeSet = Boolean(src.timeSet);
  const three = [0, 1, 2, 3].map((i) =>
    Array.isArray(src.three) ? Boolean(src.three[i]) : false
  );
  const wprot = [0, 1, 2, 3].map((i) =>
    Array.isArray(src.wprot) ? Boolean(src.wprot[i]) : false
  );
  const phosphor = ['white', 'green', 'amber'].includes(src.phosphor)
    ? src.phosphor
    : 'white';

  return { dips, memMode, mem64, quick, fast, timeSet, three, wprot, phosphor };
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

function sanitizeOskMode(mode) {
  if (mode === 'pad' || mode === 'native') return mode;
  return 'full';
}

function loadOskPrefs() {
  try {
    const raw = window.localStorage.getItem(OSK_STORAGE_KEY);
    if (!raw) return { visible: null, mode: 'full' };
    const parsed = JSON.parse(raw);
    return {
      visible: typeof parsed?.visible === 'boolean' ? parsed.visible : null,
      mode: sanitizeOskMode(parsed?.mode)
    };
  } catch {
    return { visible: null, mode: 'full' };
  }
}

function saveOskPrefs(prefs) {
  try {
    window.localStorage.setItem(
      OSK_STORAGE_KEY,
      JSON.stringify({
        visible: typeof prefs?.visible === 'boolean' ? prefs.visible : null,
        mode: sanitizeOskMode(prefs?.mode)
      })
    );
  } catch {
    // Ignore storage errors
  }
}

function shouldAutoShowOsk() {
  try {
    if (typeof window.matchMedia === 'function') {
      if (window.matchMedia('(pointer: coarse)').matches) return true;
      if (window.matchMedia('(hover: none)').matches) return true;
    }
  } catch {
    // Ignore matchMedia errors
  }
  return window.innerWidth <= 900;
}

function formatDipReadout(dips) {
  const byte = dips & 0xff;
  const hex = '0x' + byte.toString(16).toUpperCase().padStart(2, '0');
  const bin = byte.toString(2).padStart(8, '0');
  return `${hex} (${bin})`;
}

function formatByteCount(n) {
  const bytes = Math.max(0, Number(n) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatKindLabel(state) {
  if (!state || !state.loaded) return '';
  if (state.blank) return 'Blank';
  if (state.kind === 8) return '8"';
  if (state.kind === 5) return '5.25"';
  return 'IMD';
}

/* ---- DOM References ---- */

const dom = {
  powerBadge: document.getElementById('power-badge'),
  powerBadgeText: document.getElementById('power-badge-text'),
  btnPower: document.getElementById('btn-power'),
  btnPowerText: document.getElementById('btn-power-text'),
  btnRestart: document.getElementById('btn-restart'),
  btnFast: document.getElementById('btn-fast'),
  btnLibrary: document.getElementById('btn-library'),
  libraryCountBadge: document.getElementById('library-count-badge'),
  btnPaste: document.getElementById('btn-paste'),
  btnOsk: document.getElementById('btn-osk'),
  btnPrinter: document.getElementById('btn-printer'),
  printerCountBadge: document.getElementById('printer-count-badge'),
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

  oskDock: document.getElementById('osk-dock'),

  drivesStrip: document.getElementById('drives-strip'),
  drives: [0, 1, 2, 3].map((d) => ({
    card: document.getElementById(`drive-card-${d}`),
    led: document.getElementById(`drive-led-${d}`),
    kind: document.getElementById(`drive-kind-${d}`),
    three: document.getElementById(`drive-three-${d}`),
    mod: document.getElementById(`drive-mod-${d}`),
    name: document.getElementById(`drive-name-${d}`),
    btnInsert: document.getElementById(`drive-insert-${d}`),
    btnBlank: document.getElementById(`drive-blank-${d}`),
    btnSave: document.getElementById(`drive-save-${d}`),
    btnEject: document.getElementById(`drive-eject-${d}`),
    btnWp: document.getElementById(`drive-wp-${d}`),
    fileInput: document.getElementById(`drive-file-${d}`)
  })),

  modalLibrary: document.getElementById('modal-library'),
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
  settingsRestartBanner: document.getElementById('settings-restart-banner'),
  btnSettingsRestartNow: document.getElementById('btn-settings-restart-now'),
  settingsDipReadout: document.getElementById('settings-dip-readout'),
  settingsBootDevice: document.getElementById('settings-boot-device'),
  dipSwitches: [0, 1, 2, 3, 4, 5, 6, 7].map((bit) =>
    document.getElementById(`dip-sw-${bit}`)
  ),
  settingsMem128: document.getElementById('settings-mem-128'),
  settingsMem64: document.getElementById('settings-mem-64'),
  settingsMem64f: document.getElementById('settings-mem-64f'),
  settingsTimingAuth: document.getElementById('settings-timing-auth'),
  settingsTimingQuick: document.getElementById('settings-timing-quick'),
  settingsTimeSet: document.getElementById('settings-time-set'),
  settingsHdStatus: document.getElementById('settings-hd-status'),
  btnHdMount: document.getElementById('btn-hd-mount'),
  btnHdBlank: document.getElementById('btn-hd-blank'),
  btnHdSave: document.getElementById('btn-hd-save'),
  btnHdEject: document.getElementById('btn-hd-eject'),
  inputHdFile: document.getElementById('input-hd-file'),
  settingsThree: [0, 1, 2, 3].map((d) =>
    document.getElementById(`settings-three-${d}`)
  ),
  settingsWprot: [0, 1, 2, 3].map((d) =>
    document.getElementById(`settings-wprot-${d}`)
  ),
  settingsPhosphorWhite: document.getElementById('settings-phosphor-white'),
  settingsPhosphorGreen: document.getElementById('settings-phosphor-green'),
  settingsPhosphorAmber: document.getElementById('settings-phosphor-amber'),

  modalPrinter: document.getElementById('modal-printer'),
  printerSubtitle: document.getElementById('printer-subtitle'),
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

  modalDipMismatch: document.getElementById('modal-dip-mismatch'),
  modalDipDesc: document.getElementById('modal-dip-desc'),
  btnDipIgnore: document.getElementById('btn-dip-ignore'),
  btnDipApply: document.getElementById('btn-dip-apply')
};

/* ---- Application State ---- */

const initialSettings = loadStoredSettings();
const emu = new Max80Emulator(initialSettings);

let osk = null;
let oskPrefs = loadOskPrefs();
let pendingRestartNeeded = false;
let libraryDisks = [];
let libraryCategory = 'All';
let libraryQuery = '';
let libraryLoadingId = null;

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
  dom.modalDipMismatch,
  dom.modalLibrary,
  dom.modalSettings,
  dom.modalPaste,
  dom.modalPrinter,
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
  try {
    if (osk) {
      osk.releaseAll();
      osk.blurNativeInput();
    }
    emu.keyReleaseAll();
  } catch {
    // Ignore if emulator not initialized yet
  }
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

/* ---- Rendering UI State ---- */

function renderTopbar() {
  const powered = Boolean(emu.isPoweredOn());
  const fast = Boolean(emu.isFast());
  const muted = Boolean(emu.isMuted());

  dom.btnPowerText.textContent = 'Power';
  dom.btnPower.setAttribute('aria-pressed', String(powered));

  dom.powerBadge.classList.remove('status-off', 'status-on', 'status-fast');
  if (!powered) {
    dom.powerBadge.classList.add('status-off');
    dom.powerBadgeText.textContent = 'OFF';
    dom.btnPower.classList.remove('is-power-on');
  } else if (fast) {
    dom.powerBadge.classList.add('status-fast');
    dom.powerBadgeText.textContent = 'FAST';
    dom.btnPower.classList.add('is-power-on');
  } else {
    dom.powerBadge.classList.add('status-on');
    dom.powerBadgeText.textContent = 'ON';
    dom.btnPower.classList.add('is-power-on');
  }

  dom.btnRestart.disabled = !powered;

  dom.btnFast.classList.toggle('is-active', fast);
  dom.btnFast.setAttribute('aria-pressed', String(fast));

  if (dom.btnOsk) {
    const oskVisible = Boolean(osk && osk.isVisible());
    dom.btnOsk.classList.toggle('is-active', oskVisible);
    dom.btnOsk.setAttribute('aria-pressed', String(oskVisible));
  }

  if (dom.printerCountBadge) {
    const printerBytes = emu.getPrinterByteCount ? emu.getPrinterByteCount() : 0;
    dom.printerCountBadge.hidden = printerBytes <= 0;
    dom.printerCountBadge.textContent = formatByteCount(printerBytes);
  }

  dom.btnMute.classList.toggle('is-active', muted);
  dom.btnMute.setAttribute('aria-pressed', String(muted));
  dom.btnMuteIcon.textContent = muted ? '\u{1F507}' : '\u{1F50A}';
  dom.btnMuteText.textContent = muted ? 'Muted' : 'Sound';
}

function renderDrives() {
  const settings = sanitizeSettings(emu.getSettings());
  for (let d = 0; d < 4; d++) {
    const slot = dom.drives[d];
    const st = emu.getDriveState(d) || {
      drive: d,
      loaded: false,
      blank: false,
      name: '',
      kind: 0,
      changed: false,
      wprot: settings.wprot[d],
      three: settings.three[d]
    };

    const loaded = Boolean(st.loaded);
    const modified = Boolean(loaded && st.changed);
    const wprot = Boolean(st.wprot);
    const three = Boolean(st.three);

    slot.card.classList.toggle('is-loaded', loaded);
    slot.card.classList.toggle('is-modified', modified);

    slot.led.classList.toggle('is-loaded', loaded && !modified);
    slot.led.classList.toggle('is-modified', modified);

    const kindText = formatKindLabel(st);
    if (loaded && kindText) {
      slot.kind.hidden = false;
      slot.kind.textContent = kindText;
    } else {
      slot.kind.hidden = true;
      slot.kind.textContent = '';
    }

    slot.three.hidden = !three;
    slot.mod.hidden = !modified;

    const displayName = loaded ? st.name || (st.blank ? 'Blank Disk' : 'Disk') : 'Empty';
    slot.name.textContent = displayName;
    slot.name.title = displayName;
    slot.name.classList.toggle('is-empty', !loaded);

    slot.btnSave.disabled = !loaded;
    slot.btnEject.disabled = !loaded;

    slot.btnWp.classList.toggle('is-active', wprot);
    slot.btnWp.setAttribute('aria-pressed', String(wprot));
  }
}

function syncSettingsModalFromEmu() {
  const s = sanitizeSettings(emu.getSettings());

  const bootVal = s.dips & 7;
  dom.settingsBootDevice.value = String(bootVal);
  dom.settingsDipReadout.textContent = formatDipReadout(s.dips);

  for (let bit = 0; bit < 8; bit++) {
    if (dom.dipSwitches[bit]) {
      dom.dipSwitches[bit].checked = Boolean((s.dips >> bit) & 1);
    }
  }

  dom.settingsMem128.checked = s.memMode === '128';
  dom.settingsMem64.checked = s.memMode === '64';
  if (dom.settingsMem64f) {
    dom.settingsMem64f.checked = s.memMode === '64f';
  }

  dom.settingsTimingQuick.checked = Boolean(s.quick);
  dom.settingsTimingAuth.checked = !s.quick;
  if (dom.settingsTimeSet) {
    dom.settingsTimeSet.checked = Boolean(s.timeSet);
  }

  for (let d = 0; d < 4; d++) {
    if (dom.settingsThree[d]) dom.settingsThree[d].checked = Boolean(s.three[d]);
    if (dom.settingsWprot[d]) dom.settingsWprot[d].checked = Boolean(s.wprot[d]);
  }

  if (dom.settingsHdStatus) {
    const hd = emu.getHardDiskState ? emu.getHardDiskState() : { loaded: false, name: '', blocks: 0 };
    if (hd.loaded) {
      const mb = ((hd.blocks * 512) / (1024 * 1024)).toFixed(2);
      dom.settingsHdStatus.textContent = `${hd.name || 'SASI Hard Disk'} (${hd.blocks} blocks, ${mb} MB)`;
      dom.settingsHdStatus.classList.remove('is-empty');
    } else {
      dom.settingsHdStatus.textContent = 'No hard disk mounted';
      dom.settingsHdStatus.classList.add('is-empty');
    }
    if (dom.btnHdSave) dom.btnHdSave.disabled = !hd.loaded;
    if (dom.btnHdEject) dom.btnHdEject.disabled = !hd.loaded;
  }

  dom.settingsPhosphorWhite.checked = s.phosphor === 'white';
  dom.settingsPhosphorGreen.checked = s.phosphor === 'green';
  dom.settingsPhosphorAmber.checked = s.phosphor === 'amber';

  dom.settingsRestartBanner.hidden = !(emu.isPoweredOn() && pendingRestartNeeded);
}

function renderPrinterModal() {
  if (!dom.printerOutput || !dom.printerStatus) return;
  const byteCount = emu.getPrinterByteCount ? emu.getPrinterByteCount() : 0;
  const text = emu.getPrinterText ? emu.getPrinterText() : '';
  dom.printerOutput.textContent = text || '(No parallel printer output captured yet.)';
  dom.printerStatus.textContent =
    byteCount > 0 ? `${byteCount.toLocaleString()} bytes captured` : 'No output captured yet';
  if (dom.btnPrinterCopy) dom.btnPrinterCopy.disabled = byteCount <= 0;
  if (dom.btnPrinterDownload) dom.btnPrinterDownload.disabled = byteCount <= 0;
  if (dom.btnPrinterClear) dom.btnPrinterClear.disabled = byteCount <= 0;
}

function renderAll() {
  renderTopbar();
  renderDrives();
  if (!dom.modalSettings.hidden) {
    syncSettingsModalFromEmu();
  }
  if (dom.modalPrinter && !dom.modalPrinter.hidden) {
    renderPrinterModal();
  }
}

/* ---- Save Disk As (Browser Download) ---- */

function buildSaveFilename(drive, rawName) {
  const fallback = `max80-drive-${'abcd'[drive]}.imd`;
  if (!rawName || typeof rawName !== 'string') return fallback;
  const trimmed = rawName.trim();
  if (!trimmed) return fallback;
  if (/\.imd$/i.test(trimmed)) return trimmed;
  return `${trimmed}.imd`;
}

async function downloadDriveDisk(drive) {
  try {
    const saved = await emu.saveDiskBytes(drive);
    if (!saved || !saved.bytes) {
      showToast(`Drive ${DRIVE_LETTERS[drive]} has no disk to save.`, 'warn');
      return false;
    }
    const filename = buildSaveFilename(drive, saved.name);
    const bytes =
      saved.bytes instanceof Uint8Array
        ? saved.bytes
        : new Uint8Array(saved.bytes);
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);

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

  const diskTitle = st.name || (st.blank ? 'Blank Disk' : 'Disk');
  dom.modalUnsavedDesc.textContent =
    `The disk in Drive ${DRIVE_LETTERS[drive]} (${diskTitle}) has changes that are not saved. ` +
    `If you ${actionLabel} without saving, your changes will be lost.`;

  return new Promise((resolve) => {
    activeUnsavedResolver = resolve;

    dom.btnUnsavedSave.onclick = async () => {
      const ok = await downloadDriveDisk(drive);
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

/* ---- DIP-Switch Mismatch Prompt Dialog ---- */

let activeDipResolver = null;

function resolveDipModal(result) {
  closeModal(dom.modalDipMismatch);
  const resolver = activeDipResolver;
  activeDipResolver = null;
  if (resolver) resolver(result);
}

function promptDipMismatch(kind, currentBoot, targetBoot, isPoweredOn) {
  if (activeDipResolver) {
    resolveDipModal(false);
  }

  const kindLabel = kind === 8 ? '8-inch' : '5.25-inch';
  const curName = (BOOT_DEVICE_NAMES[currentBoot] || `device ${currentBoot}`).toLowerCase();
  const targetName = (BOOT_DEVICE_NAMES[targetBoot] || `device ${targetBoot}`).toLowerCase();

  dom.modalDipDesc.textContent =
    `This is a ${kindLabel} disk in Drive A:, but the DIP switches are set to boot from ${curName}. ` +
    (isPoweredOn
      ? `Set the boot device to ${targetName} and restart?`
      : `Set the boot device to ${targetName}?`);

  dom.btnDipApply.textContent = isPoweredOn ? 'Set & Restart' : 'Set Boot Device';

  return new Promise((resolve) => {
    activeDipResolver = resolve;
    dom.btnDipApply.onclick = () => resolveDipModal(true);
    dom.btnDipIgnore.onclick = () => resolveDipModal(false);
    openModal(dom.modalDipMismatch, dom.btnDipApply);
  });
}

async function checkDipMismatchForDriveA(kind) {
  const settings = sanitizeSettings(emu.getSettings());
  const currentBoot = settings.dips & 7;

  // Match Mac/Win parity: prompt when A: disk is 5.25" while DIP is 8" (2), or 8" while DIP is 5" (1)
  const isMismatch =
    (kind === 5 && currentBoot === 2) || (kind === 8 && currentBoot === 1);
  if (!isMismatch) return;

  const targetBoot = kind === 8 ? 2 : 1;
  const powered = Boolean(emu.isPoweredOn());
  const shouldSwitch = await promptDipMismatch(
    kind,
    currentBoot,
    targetBoot,
    powered
  );
  if (!shouldSwitch) return;

  const newDips = (settings.dips & ~7) | targetBoot;
  emu.setDips(newDips);
  emu.updateSettings({ dips: newDips });
  saveStoredSettings(emu.getSettings());
  renderAll();
  showToast(
    `Boot DIP set to ${BOOT_DEVICE_NAMES[targetBoot]} (${formatDipReadout(newDips)})`,
    'info'
  );

  if (powered) {
    await performRestart();
  }
}

/* ---- Disk Operations ---- */

async function insertBytesIntoDrive(
  drive,
  filename,
  uint8Array,
  { skipDipCheck = false, skipUnsavedCheck = false } = {}
) {
  if (!skipUnsavedCheck) {
    const ok = await confirmUnsavedDrive(drive, 'insert another disk');
    if (!ok) return false;
  }

  let res;
  try {
    res = await emu.insertDiskBytes(drive, filename, uint8Array);
  } catch (err) {
    showToast(
      `Could not insert ${filename} in Drive ${DRIVE_LETTERS[drive]}: ${err?.message || err}`,
      'error'
    );
    return false;
  }

  if (!res || !res.ok) {
    showToast(
      res?.error || `Failed to load ${filename} into Drive ${DRIVE_LETTERS[drive]}.`,
      'error'
    );
    renderAll();
    return false;
  }

  renderAll();
  if (res.pending) {
    showToast(
      `Queued ${filename} for Drive ${DRIVE_LETTERS[drive]} (FDC busy)`,
      'info'
    );
  } else {
    showToast(`Inserted ${filename} in Drive ${DRIVE_LETTERS[drive]}`, 'success');
  }

  if (drive === 0 && !skipDipCheck) {
    const detectedKind = res.kind || emu.getDriveState(0)?.kind || 0;
    await checkDipMismatchForDriveA(detectedKind);
  }
  return true;
}

async function handleLocalFileForDrive(drive, file) {
  if (!file) return;
  try {
    const buffer = await file.arrayBuffer();
    await insertBytesIntoDrive(drive, file.name, new Uint8Array(buffer));
  } catch (err) {
    showToast(`Error reading ${file.name}: ${err?.message || err}`, 'error');
  }
}

async function handleBlankDisk(drive) {
  const ok = await confirmUnsavedDrive(drive, 'insert a blank disk');
  if (!ok) return;
  try {
    await emu.insertBlankDisk(drive);
    renderAll();
    showToast(
      `Inserted unformatted blank disk in Drive ${DRIVE_LETTERS[drive]}`,
      'info'
    );
  } catch (err) {
    showToast(`Could not insert blank disk: ${err?.message || err}`, 'error');
  }
}

async function handleEjectDisk(drive) {
  const st = emu.getDriveState(drive);
  if (!st || !st.loaded) return;
  const ok = await confirmUnsavedDrive(drive, 'eject it');
  if (!ok) return;
  try {
    await emu.ejectDisk(drive);
    renderAll();
    showToast(`Ejected disk from Drive ${DRIVE_LETTERS[drive]}`, 'info');
  } catch (err) {
    showToast(`Could not eject Drive ${DRIVE_LETTERS[drive]}: ${err?.message || err}`, 'error');
  }
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
  try {
    await emu.powerOn();
    if (osk) osk.resetPowerHint();
    pendingRestartNeeded = false;
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
    if (osk) osk.releaseAll();
    await emu.powerOff();
    pendingRestartNeeded = false;
    renderAll();
    showToast('MAX-80 powered off', 'info');
  } catch (err) {
    showToast(`Power Off failed: ${err?.message || err}`, 'error');
  }
}

async function performRestart() {
  const ok = await confirmAllUnsavedDrives('restart the machine');
  if (!ok) return;
  try {
    if (osk) osk.releaseAll();
    if (emu.isPoweredOn()) {
      await emu.restart();
    } else {
      await emu.powerOn();
    }
    if (osk) osk.resetPowerHint();
    pendingRestartNeeded = false;
    renderAll();
    showToast('MAX-80 restarted', 'info');
    dom.screenContainer.focus();
  } catch (err) {
    showToast(`Restart failed: ${err?.message || err}`, 'error');
  }
}

function handleToggleFast() {
  const next = !emu.isFast();
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

/* ---- Built-In Disk & Application Library ---- */

async function loadLibraryManifest() {
  try {
    const resp = await fetch('./disks/manifest.json');
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = await resp.json();
    libraryDisks = Array.isArray(data?.disks) ? data.disks : [];
  } catch {
    libraryDisks = [];
  }

  if (libraryDisks.length > 0) {
    dom.libraryCountBadge.hidden = false;
    dom.libraryCountBadge.textContent = String(libraryDisks.length);
  } else {
    dom.libraryCountBadge.hidden = true;
  }

  renderLibraryCategories();
  renderLibraryList();
}

function getLibraryCategories() {
  const seen = new Set();
  const cats = ['All'];
  for (const disk of libraryDisks) {
    const cat = (disk.category || 'Other').trim();
    if (cat && !seen.has(cat)) {
      seen.add(cat);
      cats.push(cat);
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

function formatDiskKindBadge(disk) {
  if (disk.threeInch) return '3.5" / 720K';
  if (disk.kind === 8) return '8" Floppy';
  if (disk.kind === 5) return '5.25" Floppy';
  return 'IMD';
}

function formatDiskSizeBadge(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
    return '';
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
      'No built-in disk manifest found (./disks/manifest.json). You can still insert any local .imd disk image into Drives A: through D:.';
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
      disk.id
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

    const kindBadge = document.createElement('span');
    kindBadge.className = disk.threeInch ? 'badge badge-three' : 'badge badge-kind';
    kindBadge.textContent = formatDiskKindBadge(disk);
    badges.appendChild(kindBadge);

    const sizeText = formatDiskSizeBadge(disk.size);
    if (sizeText) {
      const sizeBadge = document.createElement('span');
      sizeBadge.className = 'badge badge-size';
      sizeBadge.textContent = sizeText;
      badges.appendChild(sizeBadge);
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
    btnBootA.disabled = isBusy;
    btnBootA.textContent = isBusy ? 'Loading...' : 'Boot in A:';
    btnBootA.title = 'Insert in A:, match DIP switches & 3.5" mode, and boot';
    btnBootA.addEventListener('click', () => handleLibraryBootInA(disk));

    const btnInsertA = document.createElement('button');
    btnInsertA.type = 'button';
    btnInsertA.className = 'btn btn-sm';
    btnInsertA.disabled = isBusy;
    btnInsertA.textContent = 'Insert in A:';
    btnInsertA.addEventListener('click', () => handleLibraryInsert(disk, 0));

    const btnInsertB = document.createElement('button');
    btnInsertB.type = 'button';
    btnInsertB.className = 'btn btn-sm';
    btnInsertB.disabled = isBusy;
    btnInsertB.textContent = 'Insert in B:';
    btnInsertB.addEventListener('click', () => handleLibraryInsert(disk, 1));

    actions.appendChild(btnBootA);
    actions.appendChild(btnInsertA);
    actions.appendChild(btnInsertB);

    card.appendChild(main);
    card.appendChild(actions);
    dom.libraryList.appendChild(card);
  }
}

async function fetchLibraryDiskBytes(disk) {
  const relPath = String(disk.file || '').replace(/^\.?\//, '');
  if (!relPath) {
    throw new Error('Disk entry has no file path');
  }
  const url = `./${relPath}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} fetching ${url}`);
  }
  const buf = await resp.arrayBuffer();
  const filename = relPath.split('/').pop() || `${disk.id || 'disk'}.imd`;
  return { filename, bytes: new Uint8Array(buf) };
}

async function handleLibraryBootInA(disk) {
  if (libraryLoadingId) return;

  // Check unsaved changes on A: (and all drives if restarting a running machine)
  const unsavedOk = emu.isPoweredOn()
    ? await confirmAllUnsavedDrives(`boot ${disk.title || 'selected disk'}`)
    : await confirmUnsavedDrive(0, `boot ${disk.title || 'selected disk'}`);
  if (!unsavedOk) return;

  libraryLoadingId = disk.id || 'loading';
  renderLibraryList();

  try {
    const { filename, bytes } = await fetchLibraryDiskBytes(disk);

    // Match boot DIP (low 3 bits) and Drive A: 3.5-inch flag
    const settings = sanitizeSettings(emu.getSettings());
    const bootDip =
      typeof disk.bootDip === 'number'
        ? disk.bootDip & 7
        : disk.kind === 8
          ? 2
          : 1;
    const newDips = ((settings.dips & ~7) | bootDip) & 0xff;
    const newThree = [...settings.three];
    newThree[0] = Boolean(disk.threeInch);

    emu.setDips(newDips);
    emu.updateSettings({ dips: newDips, three: newThree });
    saveStoredSettings(emu.getSettings());

    const inserted = await insertBytesIntoDrive(0, filename, bytes, {
      skipDipCheck: true,
      skipUnsavedCheck: true
    });
    if (!inserted) return;

    closeModal(dom.modalLibrary);

    if (emu.isPoweredOn()) {
      await emu.restart();
    } else {
      await emu.powerOn();
    }
    pendingRestartNeeded = false;
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

async function handleLibraryInsert(disk, drive) {
  if (libraryLoadingId) return;

  const ok = await confirmUnsavedDrive(drive, 'insert another disk');
  if (!ok) return;

  libraryLoadingId = disk.id || 'loading';
  renderLibraryList();

  try {
    const { filename, bytes } = await fetchLibraryDiskBytes(disk);
    closeModal(dom.modalLibrary);
    await insertBytesIntoDrive(drive, filename, bytes, {
      skipUnsavedCheck: true
    });
  } catch (err) {
    showToast(
      `Failed to load ${disk.title} into Drive ${DRIVE_LETTERS[drive]}: ${err?.message || err}`,
      'error'
    );
  } finally {
    libraryLoadingId = null;
    renderLibraryList();
  }
}

/* ---- Settings Modal Wiring ---- */

function populateBootDeviceSelect() {
  dom.settingsBootDevice.innerHTML = '';
  for (let i = 0; i < 8; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `${i} — ${BOOT_DEVICE_NAMES[i] || `Device ${i}`}`;
    dom.settingsBootDevice.appendChild(opt);
  }
}

function applyDipByteFromUI(newDips) {
  const byte = newDips & 0xff;
  emu.setDips(byte);
  const res = emu.updateSettings({ dips: byte });
  if (emu.isPoweredOn() && res?.needsRestart) {
    pendingRestartNeeded = true;
  }
  saveStoredSettings(emu.getSettings());
  syncSettingsModalFromEmu();
}

function wireSettingsEvents() {
  populateBootDeviceSelect();

  dom.settingsBootDevice.addEventListener('change', () => {
    const bootBits = Number.parseInt(dom.settingsBootDevice.value, 10) & 7;
    const cur = sanitizeSettings(emu.getSettings()).dips;
    const nextDips = (cur & ~7) | bootBits;
    if (emu.isPoweredOn()) {
      pendingRestartNeeded = true;
    }
    applyDipByteFromUI(nextDips);
  });

  for (let bit = 0; bit < 8; bit++) {
    const sw = dom.dipSwitches[bit];
    if (!sw) continue;
    sw.addEventListener('change', () => {
      let mask = 0;
      for (let b = 0; b < 8; b++) {
        if (dom.dipSwitches[b]?.checked) {
          mask |= 1 << b;
        }
      }
      if (emu.isPoweredOn()) {
        pendingRestartNeeded = true;
      }
      applyDipByteFromUI(mask);
    });
  }

  const onMemChange = () => {
    let memMode = '128';
    if (dom.settingsMem64f?.checked) memMode = '64f';
    else if (dom.settingsMem64?.checked) memMode = '64';
    const res = emu.updateSettings({ memMode, mem64: memMode !== '128' });
    if (emu.isPoweredOn() || res?.needsRestart) {
      pendingRestartNeeded = emu.isPoweredOn();
    }
    saveStoredSettings(emu.getSettings());
    syncSettingsModalFromEmu();
  };
  dom.settingsMem128.addEventListener('change', onMemChange);
  dom.settingsMem64.addEventListener('change', onMemChange);
  dom.settingsMem64f?.addEventListener('change', onMemChange);

  const onTimingChange = () => {
    const quick = Boolean(dom.settingsTimingQuick.checked);
    const res = emu.updateSettings({ quick });
    if (emu.isPoweredOn() || res?.needsRestart) {
      pendingRestartNeeded = emu.isPoweredOn();
    }
    saveStoredSettings(emu.getSettings());
    syncSettingsModalFromEmu();
  };
  dom.settingsTimingAuth.addEventListener('change', onTimingChange);
  dom.settingsTimingQuick.addEventListener('change', onTimingChange);

  dom.settingsTimeSet?.addEventListener('change', () => {
    const held = Boolean(dom.settingsTimeSet.checked);
    emu.setTimeSet(held);
    emu.updateSettings({ timeSet: held });
    saveStoredSettings(emu.getSettings());
    syncSettingsModalFromEmu();
  });

  // SASI Hard Disk controls
  dom.btnHdInsert?.addEventListener('click', () => {
    if (!dom.inputHdFile) return;
    dom.inputHdFile.value = '';
    dom.inputHdFile.click();
  });
  dom.inputHdFile?.addEventListener('change', async () => {
    const file = dom.inputHdFile.files?.[0];
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const res = await emu.insertHardDiskBytes(file.name, new Uint8Array(buf));
      if (!res?.ok) {
        showToast(res?.error || `Failed to mount ${file.name}.`, 'error');
      } else {
        showToast(`Mounted SASI hard disk ${file.name} (${res.blocks} blocks)`, 'success');
      }
      renderAll();
    } catch (err) {
      showToast(`Error loading hard disk ${file.name}: ${err?.message || err}`, 'error');
    }
  });
  dom.btnHdBlank?.addEventListener('click', async () => {
    try {
      const res = await emu.insertBlankHardDisk(10240);
      if (!res?.ok) {
        showToast(res?.error || 'Failed to create blank SASI hard disk.', 'error');
      } else {
        showToast(`Created blank 5 MB SASI hard disk (${res.blocks} blocks)`, 'success');
      }
      renderAll();
    } catch (err) {
      showToast(`Could not create blank hard disk: ${err?.message || err}`, 'error');
    }
  });
  dom.btnHdSave?.addEventListener('click', async () => {
    try {
      const saved = await emu.saveHardDiskBytes();
      if (!saved?.bytes) {
        showToast('No SASI hard disk mounted to save.', 'warn');
        return;
      }
      const filename = saved.name && /\.img$/i.test(saved.name)
        ? saved.name
        : `${saved.name || 'max80-sasi'}.img`;
      const blob = new Blob([saved.bytes], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
      showToast(`Saved SASI hard disk ${filename}`, 'success');
    } catch (err) {
      showToast(`Failed to save hard disk: ${err?.message || err}`, 'error');
    }
  });
  dom.btnHdEject?.addEventListener('click', async () => {
    try {
      await emu.ejectHardDisk();
      renderAll();
      showToast('Ejected SASI hard disk', 'info');
    } catch (err) {
      showToast(`Failed to eject hard disk: ${err?.message || err}`, 'error');
    }
  });

  for (let d = 0; d < 4; d++) {
    dom.settingsThree[d]?.addEventListener('change', (e) => {
      const s = sanitizeSettings(emu.getSettings());
      s.three[d] = Boolean(e.target.checked);
      const res = emu.updateSettings({ three: s.three });
      if (emu.isPoweredOn() || res?.needsRestart) {
        pendingRestartNeeded = emu.isPoweredOn();
      }
      saveStoredSettings(emu.getSettings());
      renderAll();
    });

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
    await performRestart();
  });

  dom.btnSettingsReset.addEventListener('click', () => {
    const def = sanitizeSettings(DEFAULT_SETTINGS);
    emu.setDips(def.dips);
    emu.setFast(def.fast);
    emu.setPhosphor(def.phosphor);
    emu.setTimeSet(def.timeSet);
    for (let d = 0; d < 4; d++) {
      emu.setWriteProtect(d, def.wprot[d]);
    }
    const res = emu.updateSettings(def);
    if (emu.isPoweredOn() && res?.needsRestart) {
      pendingRestartNeeded = true;
    }
    saveStoredSettings(emu.getSettings());
    renderAll();
    showToast('Settings reset to defaults', 'info');
  });
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
    showToast('Power on the MAX-80 before pasting text.', 'warn');
    return;
  }
  emu.pasteText(text);
  closeModal(dom.modalPaste);
  showToast(`Queued ${text.length} character${text.length === 1 ? '' : 's'} to MAX-80`, 'info');
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
    const file = e.dataTransfer?.files?.[0];
    if (file) {
      await handleLocalFileForDrive(0, file);
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
      const file = e.dataTransfer?.files?.[0];
      if (file) {
        await handleLocalFileForDrive(d, file);
      }
    });
  }
}

/* ---- Parallel Printer Modal ---- */

function openPrinterModal() {
  renderPrinterModal();
  openModal(dom.modalPrinter, dom.btnPrinterClose);
}

async function handlePrinterCopy() {
  const text = emu.getPrinterText ? emu.getPrinterText() : '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied printer output to clipboard', 'success');
  } catch {
    showToast('Could not copy to clipboard', 'warn');
  }
}

function handlePrinterDownload() {
  const bytes = emu.getPrinterBytes ? emu.getPrinterBytes() : null;
  if (!bytes || bytes.length === 0) return;
  const blob = new Blob([bytes], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'max80-printer.txt';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  showToast('Downloaded max80-printer.txt', 'success');
}

function handlePrinterClear() {
  emu.clearPrinter();
  renderAll();
  showToast('Cleared parallel printer buffer', 'info');
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

  dom.btnRestart.addEventListener('click', async () => {
    await performRestart();
  });

  dom.btnFast.addEventListener('click', () => {
    handleToggleFast();
  });

  dom.btnLibrary.addEventListener('click', () => {
    renderLibraryCategories();
    renderLibraryList();
    openModal(dom.modalLibrary, dom.librarySearch);
  });

  dom.btnPaste.addEventListener('click', () => {
    openPasteModal();
  });

  dom.btnPrinter?.addEventListener('click', () => {
    openPrinterModal();
  });

  if (dom.btnOsk) {
    dom.btnOsk.addEventListener('click', () => {
      if (osk) {
        const opening = !osk.isVisible();
        osk.setVisible(opening, { focusNative: opening });
      }
    });
  }

  dom.screenContainer?.addEventListener('click', () => {
    if (isAnyModalOpen()) return;
    if (osk && osk.isVisible() && osk.getMode() === 'native') {
      osk.focusNativeInput();
    } else {
      dom.screenContainer.focus();
    }
  });

  dom.btnMute.addEventListener('click', () => {
    handleToggleMute();
  });

  dom.btnFullscreen.addEventListener('click', () => {
    handleToggleFullscreen();
  });

  dom.btnSettings.addEventListener('click', () => {
    syncSettingsModalFromEmu();
    openModal(dom.modalSettings, dom.settingsBootDevice);
  });

  dom.btnAbout.addEventListener('click', () => {
    openModal(dom.modalAbout, dom.btnAboutClose);
  });

  // Drive cards A:..D:
  for (let d = 0; d < 4; d++) {
    const slot = dom.drives[d];
    slot.btnInsert.addEventListener('click', () => {
      slot.fileInput.value = '';
      slot.fileInput.click();
    });
    slot.fileInput.addEventListener('change', async () => {
      const file = slot.fileInput.files?.[0];
      if (file) {
        await handleLocalFileForDrive(d, file);
      }
    });
    slot.btnBlank.addEventListener('click', () => handleBlankDisk(d));
    slot.btnSave.addEventListener('click', () => downloadDriveDisk(d));
    slot.btnEject.addEventListener('click', () => handleEjectDisk(d));
    slot.btnWp.addEventListener('click', () => handleToggleWriteProtect(d));
  }

  // Library Modal events
  dom.btnCloseLibrary.addEventListener('click', () => closeModal(dom.modalLibrary));
  dom.btnLibraryDone.addEventListener('click', () => closeModal(dom.modalLibrary));
  dom.librarySearch.addEventListener('input', () => {
    libraryQuery = dom.librarySearch.value || '';
    renderLibraryList();
  });

  // Settings Modal close
  dom.btnCloseSettings.addEventListener('click', () => closeModal(dom.modalSettings));
  dom.btnSettingsClose.addEventListener('click', () => closeModal(dom.modalSettings));

  // Paste Modal events
  dom.btnClosePaste.addEventListener('click', () => closeModal(dom.modalPaste));
  dom.btnPasteCancel.addEventListener('click', () => closeModal(dom.modalPaste));
  dom.btnPasteSend.addEventListener('click', () => handleSendPaste());
  dom.btnPasteClipboard.addEventListener('click', () => handleReadClipboardIntoPaste());

  // Printer Modal events
  dom.btnClosePrinter?.addEventListener('click', () => closeModal(dom.modalPrinter));
  dom.btnPrinterClose?.addEventListener('click', () => closeModal(dom.modalPrinter));
  dom.btnPrinterCopy?.addEventListener('click', () => handlePrinterCopy());
  dom.btnPrinterDownload?.addEventListener('click', () => handlePrinterDownload());
  dom.btnPrinterClear?.addEventListener('click', () => handlePrinterClear());

  // About Modal close
  dom.btnCloseAbout.addEventListener('click', () => closeModal(dom.modalAbout));
  dom.btnAboutClose.addEventListener('click', () => closeModal(dom.modalAbout));

  // Click on backdrop outside modal panel to close
  for (const modal of [
    dom.modalLibrary,
    dom.modalSettings,
    dom.modalPaste,
    dom.modalPrinter,
    dom.modalAbout
  ]) {
    modal?.addEventListener('mousedown', (e) => {
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
  dom.modalDipMismatch.addEventListener('mousedown', (e) => {
    if (e.target === dom.modalDipMismatch) {
      resolveDipModal(false);
    }
  });

  // UI Keyboard Shortcuts (Alt+1..4, Alt+R, Alt+F, Alt+K, Alt+P, Alt+,, Escape for open modals)
  // NOTE: Never intercept Ctrl shortcuts; Ctrl belongs to the MAX-80!
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && isAnyModalOpen()) {
        e.preventDefault();
        e.stopPropagation();
        if (!dom.modalUnsaved.hidden) {
          resolveUnsavedModal(false);
        } else if (!dom.modalDipMismatch.hidden) {
          resolveDipModal(false);
        } else if (!dom.modalPaste.hidden) {
          closeModal(dom.modalPaste);
        } else if (dom.modalPrinter && !dom.modalPrinter.hidden) {
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

      const key = e.key.toLowerCase();
      if (key === '1' || key === '2' || key === '3' || key === '4') {
        e.preventDefault();
        const drive = Number.parseInt(key, 10) - 1;
        const input = dom.drives[drive]?.fileInput;
        if (input) {
          input.value = '';
          input.click();
        }
      } else if (key === 'r') {
        e.preventDefault();
        if (emu.isPoweredOn()) {
          performRestart();
        }
      } else if (key === 'f') {
        e.preventDefault();
        handleToggleFast();
      } else if (key === 'k') {
        e.preventDefault();
        if (osk) {
          const opening = !osk.isVisible();
          osk.setVisible(opening, { focusNative: opening });
        }
      } else if (key === 'p') {
        e.preventDefault();
        openPrinterModal();
      } else if (key === ',') {
        e.preventDefault();
        syncSettingsModalFromEmu();
        openModal(dom.modalSettings, dom.settingsBootDevice);
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
  wireSettingsEvents();
  wireControls();
  wireDragAndDrop();

  attachKeyboard(window, emu, {
    isBlocked: () => isKeyboardBlocked()
  });

  if (dom.oskDock) {
    let initializingOsk = true;
    osk = createOnScreenKeyboard(dom.oskDock, emu, {
      initialMode: oskPrefs.mode,
      onVisibilityChange: (isVisible) => {
        if (!initializingOsk) {
          oskPrefs = { ...oskPrefs, visible: isVisible };
          saveOskPrefs(oskPrefs);
        }
        renderTopbar();
      },
      onModeChange: (nextMode) => {
        oskPrefs = { ...oskPrefs, mode: nextMode };
        saveOskPrefs(oskPrefs);
      },
      onPowerNeeded: () => {
        showToast('Press Power (or boot a disk from Library) to type on the MAX-80.', 'info');
      }
    });

    const initialVisible =
      oskPrefs.visible !== null ? oskPrefs.visible : shouldAutoShowOsk();
    osk.setVisible(initialVisible);
    initializingOsk = false;
  }

  renderAll();

  // Load built-in disk library manifest in parallel with emulator initialization
  loadLibraryManifest();

  try {
    await emu.init({
      canvas: dom.canvas,
      romUrl: './max80.e12',
      logoUrl: './lobo_logo.svg',
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
      `Failed to initialize MAX-80 ROM/assets: ${err?.message || err}`,
      'error',
      6000
    );
  }
}

bootstrap();
