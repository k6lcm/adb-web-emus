/*
 * UI controller for the Agfa 9000PS web emulator.
 * Connects xterm.js serial console, VERA canvas keyboard focus, topbar controls,
 * layout switcher, Software quick-launch modal, Settings modal, and toasts.
 */

import { Agfa9000Emulator, BOOT_TARGETS, DEFAULT_SETTINGS } from './emulator.js';
import { loadSavedSettings, saveSettings } from './storage.js';

const $ = (id) => document.getElementById(id);

const els = {
	workspace: $('workspace'),
	powerBadge: $('power-badge'),
	powerBadgeText: $('power-badge-text'),
	scsiBadge: $('scsi-badge'),
	bootSelect: $('boot-select'),
	btnPower: $('btn-power'),
	btnPowerText: $('btn-power-text'),
	btnRestart: $('btn-restart'),
	btnFast: $('btn-fast'),
	btnSoftware: $('btn-software'),
	btnPaste: $('btn-paste'),
	btnMute: $('btn-mute'),
	btnMuteText: $('btn-mute-text'),
	btnFullscreen: $('btn-fullscreen'),
	btnSettings: $('btn-settings'),
	btnAbout: $('btn-about'),
	paneVera: $('pane-vera'),
	veraStage: $('vera-stage'),
	veraCanvas: $('vera-canvas'),
	veraFocusPill: $('vera-focus-pill'),
	btnVeraFs: $('btn-vera-fs'),
	termContainer: $('terminal-container'),
	btnQuickRoot: $('btn-quick-root'),
	btnQuickCtrlC: $('btn-quick-ctrlc'),
	btnTermClear: $('btn-term-clear'),
	loadingOverlay: $('loading-overlay'),
	loadingLabel: $('loading-label'),
	loadingBar: $('loading-bar'),
	toastContainer: $('toast-container'),
	// Modals
	modalSoftware: $('modal-software'),
	modalPaste: $('modal-paste'),
	pasteTextarea: $('paste-textarea'),
	modalSettings: $('modal-settings'),
	settingRam: $('setting-ram'),
	settingVera: $('setting-vera'),
	settingsDiskName: $('settings-disk-name'),
	settingsDiskDirty: $('settings-disk-dirty'),
	settingsRomName: $('settings-rom-name'),
	inputCustomDisk: $('input-custom-disk'),
	inputCustomRom: $('input-custom-rom'),
	modalAbout: $('modal-about'),
};

const savedSettings = loadSavedSettings(DEFAULT_SETTINGS);
const emu = new Agfa9000Emulator(savedSettings);

// ---- Toast notifications ----

function showToast(message, isError = false) {
	const el = document.createElement('div');
	el.className = 'toast' + (isError ? ' toast-error' : '');
	el.textContent = message;
	els.toastContainer.appendChild(el);
	setTimeout(() => {
		el.classList.add('is-fading');
		setTimeout(() => el.remove(), 220);
	}, isError ? 4200 : 2400);
}

// ---- xterm.js Serial Console ----

const term = new window.Terminal({
	cols: 80,
	rows: 25,
	cursorBlink: true,
	scrollback: 2000,
	fontSize: 13,
	fontFamily: '"SFMono-Regular", ui-monospace, "Cascadia Mono", "Consolas", "Liberation Mono", Menlo, monospace',
	theme: {
		background: '#090c10',
		foreground: '#dce6f2',
		cursor: '#38bdf8',
		cursorAccent: '#090c10',
		selection: 'rgba(59, 130, 246, 0.35)',
		black: '#11161f',
		red: '#f87171',
		green: '#4ade80',
		yellow: '#fbbf24',
		blue: '#60a5fa',
		magenta: '#c084fc',
		cyan: '#38bdf8',
		white: '#e2e8f0',
	},
});

term.open(els.termContainer);

function fitTerminal() {
	if (!els.termContainer || els.termContainer.clientWidth < 40 || els.termContainer.clientHeight < 40) {
		return;
	}
	let cellW = 7.8;
	let cellH = 16.5;
	try {
		const dims = term._core && term._core._renderService && term._core._renderService.dimensions;
		if (dims && dims.actualCellWidth > 2 && dims.actualCellHeight > 4) {
			cellW = dims.actualCellWidth;
			cellH = dims.actualCellHeight;
		}
	} catch {
		// Use fallback metrics
	}
	const availW = Math.max(80, els.termContainer.clientWidth - 18);
	const availH = Math.max(60, els.termContainer.clientHeight - 8);
	const cols = Math.max(40, Math.min(160, Math.floor(availW / cellW)));
	const rows = Math.max(12, Math.min(60, Math.floor(availH / cellH)));
	if (cols !== term.cols || rows !== term.rows) {
		term.resize(cols, rows);
	}
}

const termResizeObserver = new ResizeObserver(() => fitTerminal());
termResizeObserver.observe(els.termContainer);

term.onData((data) => {
	emu.ensureAudio();
	emu.sendSerialText(data);
});

// ---- Layout Management ----

function applyLayout(layout) {
	const valid = layout === 'vera' || layout === 'terminal' ? layout : 'split';
	els.workspace.dataset.layout = valid;
	document.querySelectorAll('.seg-btn[data-layout]').forEach((btn) => {
		btn.setAttribute('aria-pressed', btn.dataset.layout === valid ? 'true' : 'false');
	});
	emu.updateSettings({ layout: valid });
	saveSettings(emu.getSettings());
	requestAnimationFrame(() => fitTerminal());
}

// ---- VERA Canvas Keyboard Forwarding ----

function keyEventToSerialBytes(ev) {
	if (ev.altKey || ev.metaKey) return null;

	// Ctrl+A .. Ctrl+Z
	if (ev.ctrlKey) {
		const k = ev.key.toLowerCase();
		if (k.length === 1 && k >= 'a' && k <= 'z') {
			return new Uint8Array([k.charCodeAt(0) - 96]);
		}
		if (ev.key === '[' || ev.key === 'Escape') return new Uint8Array([0x1b]);
		return null;
	}

	switch (ev.key) {
		case 'Enter': return new Uint8Array([0x0d]);
		case 'Escape': return new Uint8Array([0x1b]);
		case 'Tab': return new Uint8Array([0x09]);
		case 'Backspace': return new Uint8Array([0x7f]);
		case 'ArrowUp': return new Uint8Array([0x1b, 0x5b, 0x41]);
		case 'ArrowDown': return new Uint8Array([0x1b, 0x5b, 0x42]);
		case 'ArrowRight': return new Uint8Array([0x1b, 0x5b, 0x43]);
		case 'ArrowLeft': return new Uint8Array([0x1b, 0x5b, 0x44]);
		default:
			if (ev.key.length === 1) {
				const code = ev.key.charCodeAt(0);
				if (code >= 0x20 && code < 0x7f) {
					return new Uint8Array([code]);
				}
			}
			return null;
	}
}

els.veraStage.addEventListener('click', () => {
	emu.ensureAudio();
	els.veraStage.focus();
});

els.veraStage.addEventListener('focus', () => {
	els.paneVera.classList.add('is-focused');
	els.veraFocusPill.textContent = 'Keyboard active';
});

els.veraStage.addEventListener('blur', () => {
	els.paneVera.classList.remove('is-focused');
	els.veraFocusPill.textContent = 'Click to send keys';
});

els.veraStage.addEventListener('keydown', (ev) => {
	if (ev.altKey && (ev.key === 'r' || ev.key === 'R' || ev.key === 'f' || ev.key === 'F')) {
		return;
	}
	const bytes = keyEventToSerialBytes(ev);
	if (bytes) {
		ev.preventDefault();
		ev.stopPropagation();
		emu.ensureAudio();
		emu.sendSerialBytes(bytes);
	}
});

// ---- Global Keyboard Shortcuts ----

window.addEventListener('keydown', (ev) => {
	if (ev.key === 'Escape') {
		closeAllModals();
		return;
	}
	if (ev.altKey && !ev.ctrlKey && !ev.metaKey) {
		if (ev.key === 'r' || ev.key === 'R') {
			ev.preventDefault();
			if (emu.poweredOn) restartEmulator();
		} else if (ev.key === 'f' || ev.key === 'F') {
			ev.preventDefault();
			const next = !emu.getSettings().fast;
			emu.setFast(next);
			saveSettings(emu.getSettings());
			showToast(next ? 'Fast mode (3×) enabled' : 'Normal 16 MHz speed');
		}
	}
});

window.addEventListener('pointerdown', () => {
	if (emu.poweredOn && !emu.muted) {
		emu.ensureAudio();
	}
}, { passive: true });

// ---- Modals ----

const allModals = [els.modalSoftware, els.modalPaste, els.modalSettings, els.modalAbout];

function openModal(modal) {
	closeAllModals();
	modal.hidden = false;
}

function closeAllModals() {
	for (const m of allModals) {
		m.hidden = true;
	}
}

for (const m of allModals) {
	m.addEventListener('click', (ev) => {
		if (ev.target === m) closeAllModals();
	});
}

// ---- Emulator Lifecycle & UI Sync ----

let scsiClearTimer = null;

emu.init({
	canvas: els.veraCanvas,
	onSerialTx: (bytes) => {
		term.write(bytes);
	},
	onLoadingProgress: ({ phase, label, percent }) => {
		if (phase === 'done' || phase === 'error') {
			els.loadingOverlay.hidden = true;
		} else {
			els.loadingOverlay.hidden = false;
			els.loadingLabel.textContent = label || 'Loading…';
			els.loadingBar.style.width = `${Math.max(2, Math.min(100, percent || 0))}%`;
		}
	},
	onScsiActivity: ({ read, write }) => {
		if (read || write) {
			els.scsiBadge.classList.toggle('is-write', Boolean(write));
			els.scsiBadge.classList.toggle('is-read', Boolean(read) && !write);
			if (scsiClearTimer) clearTimeout(scsiClearTimer);
			scsiClearTimer = setTimeout(() => {
				els.scsiBadge.classList.remove('is-read', 'is-write');
			}, 90);
		}
	},
	onStateChange: (st) => {
		els.powerBadge.classList.remove('status-on', 'status-loading');
		if (st.loading) {
			els.powerBadge.classList.add('status-loading');
			els.powerBadgeText.textContent = 'LOADING';
			els.btnPower.disabled = true;
			els.btnRestart.disabled = true;
		} else if (st.poweredOn) {
			els.powerBadge.classList.add('status-on');
			els.powerBadgeText.textContent = 'ON';
			els.btnPower.disabled = false;
			els.btnPowerText.textContent = 'Power Off';
			els.btnPower.classList.remove('btn-primary');
			els.btnRestart.disabled = false;
		} else {
			els.powerBadgeText.textContent = 'OFF';
			els.btnPower.disabled = false;
			els.btnPowerText.textContent = 'Power On';
			els.btnPower.classList.add('btn-primary');
			els.btnRestart.disabled = true;
		}

		els.bootSelect.value = st.settings.bootTarget;
		els.btnFast.setAttribute('aria-pressed', st.settings.fast ? 'true' : 'false');
		els.btnMute.setAttribute('aria-pressed', st.muted ? 'true' : 'false');
		els.btnMuteText.textContent = st.muted ? 'Muted' : 'Sound';

		els.settingRam.value = String(st.settings.ramMb);
		els.settingVera.checked = Boolean(st.settings.veraEnabled);
		els.settingsDiskName.textContent = st.diskName;
		els.settingsDiskDirty.textContent = st.customDisk
			? `${st.dirtySectors} modified sectors in session memory`
			: `${st.dirtySectors} modified sectors saved in browser storage`;
		els.settingsRomName.textContent = st.romName;
	},
	onError: (msg) => {
		showToast(msg, true);
	},
});

async function startEmulator() {
	term.reset();
	const target = BOOT_TARGETS[emu.getSettings().bootTarget] || BOOT_TARGETS.minix;
	term.writeln(`\x1b[1;36mAgfa Compugraphic 9000PS\x1b[0m — booting \x1b[1m${target.label}\x1b[0m…`);
	await emu.powerOn();
	fitTerminal();
	if (emu.poweredOn) {
		term.focus();
	}
}

async function restartEmulator() {
	await startEmulator();
}

// ---- Wire Controls ----

els.bootSelect.addEventListener('change', async () => {
	const bootTarget = els.bootSelect.value;
	emu.updateSettings({ bootTarget });
	saveSettings(emu.getSettings());
	if (emu.poweredOn) {
		await restartEmulator();
	}
});

els.btnPower.addEventListener('click', async () => {
	emu.ensureAudio();
	if (emu.poweredOn) {
		emu.powerOff();
	} else {
		await startEmulator();
	}
});

els.btnRestart.addEventListener('click', async () => {
	emu.ensureAudio();
	await restartEmulator();
});

els.btnFast.addEventListener('click', () => {
	const next = !emu.getSettings().fast;
	emu.setFast(next);
	saveSettings(emu.getSettings());
});

document.querySelectorAll('.seg-btn[data-layout]').forEach((btn) => {
	btn.addEventListener('click', () => applyLayout(btn.dataset.layout));
});

els.btnSoftware.addEventListener('click', () => openModal(els.modalSoftware));
$('btn-close-software').addEventListener('click', closeAllModals);
$('btn-software-done').addEventListener('click', closeAllModals);

document.querySelectorAll('[data-send-cmd]').forEach((btn) => {
	btn.addEventListener('click', () => {
		if (!emu.poweredOn) {
			showToast('Power on the Agfa 9000PS first.', true);
			return;
		}
		emu.ensureAudio();
		const cmd = btn.getAttribute('data-send-cmd');
		const focusVera = btn.getAttribute('data-focus-vera') === '1';
		closeAllModals();
		emu.pasteText(cmd);
		if (focusVera) {
			if (emu.getSettings().layout === 'terminal') {
				applyLayout('split');
			}
			els.veraStage.focus();
			showToast('Sent command — VERA display focused for keyboard input');
		} else {
			term.focus();
		}
	});
});

els.btnPaste.addEventListener('click', () => {
	els.pasteTextarea.value = '';
	openModal(els.modalPaste);
	els.pasteTextarea.focus();
});
$('btn-close-paste').addEventListener('click', closeAllModals);
$('btn-paste-cancel').addEventListener('click', closeAllModals);
$('btn-paste-send').addEventListener('click', () => {
	const txt = els.pasteTextarea.value;
	closeAllModals();
	if (txt && emu.poweredOn) {
		emu.ensureAudio();
		emu.pasteText(txt);
		term.focus();
	}
});

els.btnMute.addEventListener('click', () => {
	emu.setMuted(!emu.muted);
});

function toggleVeraFullscreen() {
	if (document.fullscreenElement) {
		document.exitFullscreen().catch(() => {});
	} else {
		const target = emu.getSettings().layout === 'terminal' ? els.workspace : els.veraStage;
		target.requestFullscreen().catch(() => {});
	}
}

els.btnFullscreen.addEventListener('click', toggleVeraFullscreen);
els.btnVeraFs.addEventListener('click', () => {
	if (document.fullscreenElement) {
		document.exitFullscreen().catch(() => {});
	} else {
		els.veraStage.requestFullscreen().catch(() => {});
	}
});

els.btnQuickRoot.addEventListener('click', () => {
	if (!emu.poweredOn) return;
	emu.ensureAudio();
	emu.sendSerialText('root\r');
	term.focus();
});

els.btnQuickCtrlC.addEventListener('click', () => {
	if (!emu.poweredOn) return;
	emu.ensureAudio();
	emu.sendSerialBytes(new Uint8Array([0x03]));
	term.focus();
});

els.btnTermClear.addEventListener('click', () => {
	term.clear();
	term.focus();
});

// Settings modal
els.btnSettings.addEventListener('click', () => openModal(els.modalSettings));
$('btn-close-settings').addEventListener('click', closeAllModals);
$('btn-settings-close').addEventListener('click', closeAllModals);

$('btn-settings-restart').addEventListener('click', async () => {
	emu.updateSettings({
		ramMb: Number(els.settingRam.value) || 4,
		veraEnabled: Boolean(els.settingVera.checked),
	});
	saveSettings(emu.getSettings());
	closeAllModals();
	if (emu.poweredOn) {
		await restartEmulator();
	}
});

$('btn-reset-disk').addEventListener('click', async () => {
	if (!confirm('Reset the SCSI disk image to its pristine state? Any saved files in Minix or CP/M will be cleared.')) {
		return;
	}
	closeAllModals();
	await emu.resetDiskToPristine();
	showToast('SCSI disk reset to pristine state');
});

$('btn-load-disk').addEventListener('click', () => els.inputCustomDisk.click());
els.inputCustomDisk.addEventListener('change', async () => {
	const file = els.inputCustomDisk.files && els.inputCustomDisk.files[0];
	els.inputCustomDisk.value = '';
	if (!file) return;
	try {
		closeAllModals();
		showToast(`Loading ${file.name}…`);
		await emu.loadCustomDisk(file);
		showToast(`Mounted ${file.name}`);
	} catch (err) {
		showToast(err.message || String(err), true);
	}
});

$('btn-load-rom').addEventListener('click', () => els.inputCustomRom.click());
els.inputCustomRom.addEventListener('change', async () => {
	const file = els.inputCustomRom.files && els.inputCustomRom.files[0];
	els.inputCustomRom.value = '';
	if (!file) return;
	try {
		closeAllModals();
		await emu.loadCustomRom(file);
		showToast(`Loaded ROM ${file.name}`);
	} catch (err) {
		showToast(err.message || String(err), true);
	}
});

$('btn-reset-eeprom').addEventListener('click', () => {
	emu.resetEeprom();
	showToast('EEPROM erased (512 bytes set to 0xFF)');
});

// About modal
els.btnAbout.addEventListener('click', () => openModal(els.modalAbout));
$('btn-close-about').addEventListener('click', closeAllModals);
$('btn-about-close').addEventListener('click', closeAllModals);

// Persist pending COW writes & EEPROM on page unload
window.addEventListener('pagehide', () => emu.flushStorage());
window.addEventListener('beforeunload', () => emu.flushStorage());

// Apply saved layout and auto-boot immediately
applyLayout(savedSettings.layout);
startEmulator();
