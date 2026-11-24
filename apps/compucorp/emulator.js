/*
 * Browser runtime for the Compucorp 665 Web emulator.
 * Wraps the Emscripten-compiled cc665 WASM module (./cc665.js), manages
 * 4 floppy drives in MEMFS, CRT phosphor rendering, Web Audio worklet output,
 * Diablo 630 printer rendering, and RAF loop pacing.
 */

import createCc665 from './cc665.js';

export const DISK_SIZE = 315392;

export const PHOSPHOR_RGB = {
	cyan: [180, 236, 255],
	white: [232, 232, 232],
	green: [51, 255, 102],
	amber: [255, 176, 0],
};

const DEFAULT_SETTINGS = {
	boards: 2,
	mainsHz: 60,
	fast: false,
	romSwitch: false,
	lowerPage: false,
	wprot: [false, false, false, false],
	phosphor: 'cyan',
};

function cloneSettings(s) {
	return {
		boards: Math.max(0, Math.min(4, Number.isInteger(s.boards) ? s.boards : 2)),
		mainsHz: s.mainsHz === 50 ? 50 : 60,
		fast: Boolean(s.fast),
		romSwitch: Boolean(s.romSwitch),
		lowerPage: Boolean(s.lowerPage),
		wprot: Array.isArray(s.wprot) ? s.wprot.slice(0, 4).map(Boolean) : [false, false, false, false],
		phosphor: PHOSPHOR_RGB[s.phosphor] ? s.phosphor : 'cyan',
	};
}

function boolArrayToMask(arr) {
	let mask = 0;
	for (let d = 0; d < 4; d++) {
		if (arr[d]) mask |= 1 << d;
	}
	return mask;
}

function hex2(b) {
	return (b & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

function idBytesToHex(idBytes) {
	if (!idBytes || idBytes.length < 3) return '';
	return `${hex2(idBytes[0])}${hex2(idBytes[1])}${hex2(idBytes[2])}`;
}

/**
 * Faithful JS port of tools/cc665_diablo.py render(d):
 * Renders Diablo 630 daisy-wheel printer escape sequences (bidirectional printing,
 * horizontal/vertical motion index, absolute tabs, carriage returns, line feeds,
 * form feeds, backspaces) and standard printable ASCII into plain text.
 *
 * @param {Uint8Array|Array<number>} bytes
 * @returns {{ text: string, unknown: Record<string, number> }}
 */
export function renderDiabloText(bytes) {
	const d = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
	const lines = new Map();
	let maxRow = -1;
	let row = 0;
	let col = 0;
	let back = false;
	const unknown = {};

	let i = 0;
	const len = d.length;
	while (i < len) {
		const c = d[i++];
		if (c === 0x1b && i < len) {
			const e = d[i++];
			if ((e === 0x1f || e === 0x1e || e === 0x09) && i < len) {
				const n = d[i++];
				if (e === 0x09) {
					col = Math.max(n - 1, 0);
				} else if (e === 0x1e && n - 1 !== 8) {
					unknown[`VMI ${n - 1}/48 in`] = 1;
				}
			} else if (e === 0x35) {
				back = false;
			} else if (e === 0x36) {
				back = true;
			} else if (e === 0x5b && i < len) {
				// Cleanly consume ANSI/VT100 CSI sequences (ESC [ ... final) if a diagnostic outputs them
				let j = i;
				while (j < len && d[j] >= 0x20 && d[j] <= 0x3f) j++;
				if (j < len && d[j] >= 0x40 && d[j] <= 0x7e) {
					i = j + 1;
				} else {
					const key = `ESC ${hex2(e)}h`;
					unknown[key] = (unknown[key] || 0) + 1;
				}
			} else {
				const key = `ESC ${hex2(e)}h`;
				unknown[key] = (unknown[key] || 0) + 1;
			}
		} else if (c === 0x0a) {
			row += 1;
		} else if (c === 0x0d) {
			col = 0;
		} else if (c === 0x0c) {
			row = (Math.floor(row / 66) + 1) * 66;
		} else if (c === 0x08) {
			col += back ? 1 : -1;
		} else if (c === 0x09) {
			col = (Math.floor(col / 8) + 1) * 8;
		} else if (c === 0x00) {
			// padding, ignored
		} else if (c >= 0x20) {
			let ln = lines.get(row);
			if (!ln) {
				ln = { cols: new Map(), maxCol: -1 };
				lines.set(row, ln);
				if (row > maxRow) maxRow = row;
			}
			if (c !== 0x20) {
				ln.cols.set(col, c < 0x7f ? String.fromCharCode(c) : '?');
				if (col > ln.maxCol) ln.maxCol = col;
			}
			col += back ? -1 : 1;
			col = Math.max(col, 0);
		} else {
			const key = `${hex2(c)}h`;
			unknown[key] = (unknown[key] || 0) + 1;
		}
	}

	if (maxRow < 0) {
		return { text: len === 0 ? '' : '\n', unknown };
	}

	const out = [];
	for (let r = 0; r <= maxRow; r++) {
		const ln = lines.get(r);
		if (!ln || ln.maxCol < 0) {
			out.push('');
			continue;
		}
		const chars = [];
		for (let x = 0; x <= ln.maxCol; x++) {
			const ch = ln.cols.get(x);
			chars.push(ch !== undefined ? ch : ' ');
		}
		out.push(chars.join('').replace(/\s+$/, ''));
	}

	return {
		text: `${out.join('\n')}\n`,
		unknown,
	};
}

export class Cc665Emulator {
	constructor(initialSettings = {}) {
		this.settings = cloneSettings({
			...DEFAULT_SETTINGS,
			...initialSettings,
			wprot: initialSettings.wprot || DEFAULT_SETTINGS.wprot,
		});
		this.launchSettings = null;

		this.canvas = null;
		this.ctx = null;
		this.offscreenCanvas = null;
		this.offscreenCtx = null;
		this.imageData = null;
		this.lastFrame = null; // { bytes: Uint8Array, w: number, h: number, aspect: number }
		this.lastPhosphor = null;

		this.romBytes = null;
		this.promLBytes = null;
		this.promHBytes = null;
		this.logoImg = null;
		this.onStateChange = () => {};
		this.onError = () => {};

		this.mod = null;
		this.poweredOn = false;
		this.muted = false;

		this.rafId = null;
		this.lastRafTime = 0;
		this.tickAccum = 0;
		this.lastTelemetryNotify = 0;
		this.resizeObserver = null;
		this._boundResize = null;

		this.speedHost0 = 0;
		this.speedEmu0 = 0;
		this.speedRatio = -1;

		this.cachedPrinterBytes = new Uint8Array(0);
		this.lastPrinterLen = 0;

		this.audioCtx = null;
		this.audioNode = null;
		this.audioReady = false;
		this.audioInitPromise = null;

		this.pendingTextChunks = [];
		this.diskGen = 0;

		this.drives = [0, 1, 2, 3].map((d) => ({
			drive: d,
			loaded: false,
			unformatted: false,
			name: '',
			bytes: null,
			idBytes: null,
			headerId: '',
			changed: false,
			memfsPath: null,
			memfsIdPath: null,
		}));
	}

	async init({
		canvas,
		romUrl = './cc665_rom.bin',
		promLUrl = './cc665_prom_l.bin',
		promHUrl = './cc665_prom_h.bin',
		logoUrl = './cc665_logo.png',
		onStateChange = () => {},
		onError = () => {},
	} = {}) {
		this.canvas = canvas || null;
		this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
		this.onStateChange = typeof onStateChange === 'function' ? onStateChange : () => {};
		this.onError = typeof onError === 'function' ? onError : () => {};

		// Set up canvas sizing & ResizeObserver (+ window resize/orientationchange for iOS Safari)
		if (this.canvas) {
			this._syncCanvasSize();
			this._boundResize = () => {
				this._syncCanvasSize();
				this._redrawCurrentScreen();
			};
			if (typeof ResizeObserver !== 'undefined') {
				this.resizeObserver = new ResizeObserver(this._boundResize);
				this.resizeObserver.observe(this.canvas.parentElement || this.canvas);
			}
			if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
				window.addEventListener('resize', this._boundResize);
				window.addEventListener('orientationchange', this._boundResize);
			}
			if (typeof requestAnimationFrame === 'function') {
				requestAnimationFrame(() => {
					this._syncCanvasSize();
					this._redrawCurrentScreen();
				});
			}
		}

		// Load Compucorp logo image (non-fatal if missing)
		if (logoUrl && typeof Image !== 'undefined') {
			await new Promise((resolve) => {
				const img = new Image();
				img.onload = () => {
					this.logoImg = img;
					if (!this.poweredOn) this._drawOffScreen();
					resolve();
				};
				img.onerror = () => {
					resolve();
				};
				img.src = logoUrl;
			});
		}

		this._drawOffScreen();

		// Fetch 2048-byte boot ROM
		if (romUrl && typeof fetch === 'function') {
			let resp;
			try {
				resp = await fetch(romUrl);
			} catch (err) {
				const msg = `Failed to fetch boot ROM (${romUrl}): ${err.message || err}`;
				this.onError(msg);
				throw new Error(msg);
			}
			if (!resp.ok) {
				const msg = `Failed to load boot ROM (${romUrl}): HTTP ${resp.status}`;
				this.onError(msg);
				throw new Error(msg);
			}
			const buf = await resp.arrayBuffer();
			const bytes = new Uint8Array(buf);
			if (bytes.length !== 2048) {
				const msg = `Invalid boot ROM (${romUrl}): expected 2048 bytes, got ${bytes.length}`;
				this.onError(msg);
				throw new Error(msg);
			}
			this.romBytes = bytes;
		}

		// Fetch 1024-byte U21/U22 glyph PROMs (non-fatal warning if missing)
		if (promLUrl && typeof fetch === 'function') {
			try {
				const resp = await fetch(promLUrl);
				if (resp.ok) {
					const bytes = new Uint8Array(await resp.arrayBuffer());
					if (bytes.length === 1024) {
						this.promLBytes = bytes;
					} else {
						console.warn(`Unexpected PROM L size (${promLUrl}): expected 1024, got ${bytes.length}`);
					}
				} else {
					console.warn(`Could not fetch PROM L (${promLUrl}): HTTP ${resp.status}`);
				}
			} catch (err) {
				console.warn(`Could not fetch PROM L (${promLUrl}):`, err);
			}
		}

		if (promHUrl && typeof fetch === 'function') {
			try {
				const resp = await fetch(promHUrl);
				if (resp.ok) {
					const bytes = new Uint8Array(await resp.arrayBuffer());
					if (bytes.length === 1024) {
						this.promHBytes = bytes;
					} else {
						console.warn(`Unexpected PROM H size (${promHUrl}): expected 1024, got ${bytes.length}`);
					}
				} else {
					console.warn(`Could not fetch PROM H (${promHUrl}): HTTP ${resp.status}`);
				}
			} catch (err) {
				console.warn(`Could not fetch PROM H (${promHUrl}):`, err);
			}
		}
	}

	async powerOn() {
		this._stopLoop();
		this._flushAudio();

		if (!this.romBytes || this.romBytes.length !== 2048) {
			const msg = 'Cannot power on: 2048-byte boot ROM (cc665_rom.bin) is not loaded.';
			this.onError(msg);
			throw new Error(msg);
		}

		const mod = await createCc665();
		this.mod = mod;
		this.pendingTextChunks = [];
		this.lastFrame = null;
		this.speedHost0 = 0;
		this.speedEmu0 = 0;
		this.speedRatio = -1;
		this.cachedPrinterBytes = new Uint8Array(0);
		this.lastPrinterLen = 0;

		try {
			mod.FS.mkdir('/disks');
		} catch (_e) {
			// ignore EEXIST
		}
		try {
			mod.FS.mkdir('/save');
		} catch (_e) {
			// ignore EEXIST
		}

		const romPtr = mod._malloc(2048);
		let promLPtr = 0;
		let promLLen = 0;
		let promHPtr = 0;
		let promHLen = 0;
		let initRc = -1;

		try {
			mod.HEAPU8.set(this.romBytes, romPtr);
			if (this.promLBytes && this.promLBytes.length === 1024) {
				promLPtr = mod._malloc(1024);
				promLLen = 1024;
				mod.HEAPU8.set(this.promLBytes, promLPtr);
			}
			if (this.promHBytes && this.promHBytes.length === 1024) {
				promHPtr = mod._malloc(1024);
				promHLen = 1024;
				mod.HEAPU8.set(this.promHBytes, promHPtr);
			}

			initRc = mod._web_init(
				romPtr,
				2048,
				promLPtr,
				promLLen,
				promHPtr,
				promHLen,
				this.settings.boards,
				this.settings.mainsHz,
				boolArrayToMask(this.settings.wprot),
				this.settings.fast ? 1 : 0,
				this.settings.romSwitch ? 1 : 0,
				this.settings.lowerPage ? 1 : 0
			);
		} finally {
			mod._free(romPtr);
			if (promLPtr) mod._free(promLPtr);
			if (promHPtr) mod._free(promHPtr);
		}

		if (initRc !== 0) {
			this.mod = null;
			const msg = 'Failed to initialize Compucorp 665 WASM core (_web_init returned -1).';
			this.onError(msg);
			throw new Error(msg);
		}

		// Re-mount all 4 drives currently staged in this.drives
		for (let d = 0; d < 4; d++) {
			const slot = this.drives[d];
			slot.memfsPath = null;
			slot.memfsIdPath = null;
			if (slot.loaded && slot.unformatted) {
				mod._web_insert_unformatted(d);
				slot.changed = false;
				slot.headerId = '';
			} else if (slot.loaded && slot.bytes) {
				this._mountStagedDisk(d);
			}
			mod._web_set_wprot(d, this.settings.wprot[d] ? 1 : 0);
		}

		// Initialize or resume Web Audio worklet (graceful fallback if unavailable)
		await this._initOrResumeAudio();

		this.launchSettings = cloneSettings(this.settings);
		this.poweredOn = true;

		// Run initial tick
		this._stepSingleTick(true);
		if (!this.lastFrame) {
			this._clearCanvasBlack();
		} else {
			this._renderLastFrame(true);
		}

		this._startLoop();
		this._notifyState();
	}

	powerOff() {
		this._stopLoop();
		this._flushAudio();
		this.pendingTextChunks = [];
		this.mod = null;
		this.poweredOn = false;
		this.launchSettings = null;
		this.lastFrame = null;
		this.speedHost0 = 0;
		this.speedEmu0 = 0;
		this.speedRatio = -1;

		for (let d = 0; d < 4; d++) {
			this.drives[d].memfsPath = null;
			this.drives[d].memfsIdPath = null;
			this.drives[d].changed = false;
		}

		this._drawOffScreen();
		this._notifyState();
	}

	async restart() {
		this.powerOff();
		await this.powerOn();
	}

	softReset() {
		if (!this.poweredOn || !this.mod) return;
		this.mod._web_reset();
		this._flushAudio();
		this.pendingTextChunks = [];
		this._notifyState();
	}

	sendBreak() {
		if (!this.poweredOn || !this.mod) return;
		this.mod._web_break();
	}

	isPoweredOn() {
		return this.poweredOn;
	}

	getSettings() {
		return cloneSettings(this.settings);
	}

	getLaunchSettings() {
		return this.launchSettings ? cloneSettings(this.launchSettings) : null;
	}

	needsRestart() {
		if (!this.poweredOn || !this.launchSettings) return false;
		const ls = this.launchSettings;
		return (
			this.settings.boards !== ls.boards ||
			this.settings.mainsHz !== ls.mainsHz ||
			this.settings.romSwitch !== ls.romSwitch ||
			this.settings.lowerPage !== ls.lowerPage
		);
	}

	updateSettings(partial = {}) {
		if (!partial || typeof partial !== 'object') {
			return { needsRestart: this.needsRestart() };
		}

		if (partial.boards !== undefined) {
			const b = Number(partial.boards);
			if (Number.isInteger(b) && b >= 0 && b <= 4) {
				this.settings.boards = b;
			}
		}
		if (partial.mainsHz !== undefined) {
			this.settings.mainsHz = Number(partial.mainsHz) === 50 ? 50 : 60;
		}
		if (partial.romSwitch !== undefined) {
			this.settings.romSwitch = Boolean(partial.romSwitch);
		}
		if (partial.lowerPage !== undefined) {
			this.settings.lowerPage = Boolean(partial.lowerPage);
		}
		if (partial.fast !== undefined) {
			const flag = Boolean(partial.fast);
			this.settings.fast = flag;
			if (this.poweredOn && this.mod) {
				this.mod._web_set_fast(flag ? 1 : 0);
			}
		}
		if (Array.isArray(partial.wprot)) {
			for (let d = 0; d < 4; d++) {
				if (partial.wprot[d] !== undefined) {
					const on = Boolean(partial.wprot[d]);
					this.settings.wprot[d] = on;
					if (this.poweredOn && this.mod) {
						this.mod._web_set_wprot(d, on ? 1 : 0);
					}
				}
			}
		}
		if (partial.phosphor !== undefined && PHOSPHOR_RGB[partial.phosphor]) {
			if (this.settings.phosphor !== partial.phosphor) {
				this.settings.phosphor = partial.phosphor;
				this.lastPhosphor = null;
				if (this.poweredOn) {
					this._renderLastFrame(true);
				}
			}
		}

		this._notifyState();
		return { needsRestart: this.needsRestart() };
	}

	setFast(on) {
		const flag = Boolean(on);
		this.settings.fast = flag;
		if (this.poweredOn && this.mod) {
			this.mod._web_set_fast(flag ? 1 : 0);
		}
		this._notifyState();
	}

	setWriteProtect(drive, on) {
		if (drive < 0 || drive > 3) return;
		const flag = Boolean(on);
		this.settings.wprot[drive] = flag;
		if (this.poweredOn && this.mod) {
			this.mod._web_set_wprot(drive, flag ? 1 : 0);
		}
		this._notifyState();
	}

	setPhosphor(name) {
		if (!PHOSPHOR_RGB[name]) return;
		if (this.settings.phosphor !== name) {
			this.settings.phosphor = name;
			this.lastPhosphor = null;
			if (this.poweredOn) {
				this._renderLastFrame(true);
			}
			this._notifyState();
		}
	}

	setMuted(on) {
		this.muted = Boolean(on);
		if (this.muted) {
			this._flushAudio();
		}
		this._notifyState();
	}

	isMuted() {
		return this.muted;
	}

	insertDiskBytes(drive, name, imgBytes, idBytes = null) {
		if (drive < 0 || drive > 3) {
			this.onError(`Invalid drive index: ${drive}`);
			return false;
		}
		if (!(imgBytes instanceof Uint8Array) || imgBytes.length !== DISK_SIZE) {
			const len = imgBytes && typeof imgBytes.length === 'number' ? imgBytes.length : 0;
			this.onError(
				`Invalid disk image "${name || 'disk.img'}": expected ${DISK_SIZE} bytes, got ${len}.`
			);
			return false;
		}

		const slot = this.drives[drive];
		slot.bytes = new Uint8Array(imgBytes);
		slot.idBytes =
			idBytes instanceof Uint8Array && idBytes.length === 3
				? new Uint8Array(idBytes)
				: Array.isArray(idBytes) && idBytes.length === 3
					? new Uint8Array(idBytes)
					: null;
		slot.name = name || `disk_${String.fromCharCode(97 + drive)}.img`;
		slot.loaded = true;
		slot.unformatted = false;
		slot.changed = false;
		slot.headerId = slot.idBytes ? idBytesToHex(slot.idBytes) : '000000';

		if (this.poweredOn && this.mod) {
			if (!this._mountStagedDisk(drive)) {
				this._notifyState();
				return false;
			}
		}

		this._notifyState();
		return true;
	}

	insertUnformatted(drive) {
		if (drive < 0 || drive > 3) return false;
		const slot = this.drives[drive];
		this._unlinkSlotFiles(slot);
		slot.loaded = true;
		slot.unformatted = true;
		slot.name = 'Unformatted disk';
		slot.bytes = null;
		slot.idBytes = null;
		slot.headerId = '000000';
		slot.changed = false;

		if (this.poweredOn && this.mod) {
			this.mod._web_insert_unformatted(drive);
			this.mod._web_set_wprot(drive, this.settings.wprot[drive] ? 1 : 0);
		}

		this._notifyState();
		return true;
	}

	ejectDisk(drive) {
		if (drive < 0 || drive > 3) return false;
		const slot = this.drives[drive];
		if (this.poweredOn && this.mod) {
			this.mod._web_eject_disk(drive);
		}
		this._unlinkSlotFiles(slot);
		slot.loaded = false;
		slot.unformatted = false;
		slot.name = '';
		slot.bytes = null;
		slot.idBytes = null;
		slot.headerId = '';
		slot.changed = false;

		this._notifyState();
		return true;
	}

	saveDiskBytes(drive) {
		if (drive < 0 || drive > 3) return null;
		const slot = this.drives[drive];
		if (!slot.loaded) return null;

		const downloadName =
			slot.name && slot.name !== 'Unformatted disk'
				? slot.name.endsWith('.img') || slot.name.endsWith('.IMG')
					? slot.name
					: `${slot.name}.img`
				: `disk_${String.fromCharCode(97 + drive)}.img`;

		if (this.poweredOn && this.mod) {
			const saveImgPath = `/save/drive${drive}.img`;
			const saveIdPath = `/save/drive${drive}.id`;
			try {
				this.mod.FS.unlink(saveImgPath);
			} catch (_e) {
				// ignore
			}
			try {
				this.mod.FS.unlink(saveIdPath);
			} catch (_e) {
				// ignore
			}

			const rc = this._withCString(saveImgPath, (ptr) => this.mod._web_save_disk(drive, ptr));
			if (rc !== 0) {
				this.onError(`Could not save disk in drive ${String.fromCharCode(65 + drive)}:.`);
				return null;
			}

			let imgBytes;
			let idBytes = new Uint8Array(3);
			try {
				imgBytes = new Uint8Array(this.mod.FS.readFile(saveImgPath));
				try {
					const rawId = this.mod.FS.readFile(saveIdPath);
					if (rawId && rawId.length === 3) {
						idBytes = new Uint8Array(rawId);
					}
				} catch (_e) {
					// keep 000000
				}
			} finally {
				try {
					this.mod.FS.unlink(saveImgPath);
				} catch (_e) {
					// ignore
				}
				try {
					this.mod.FS.unlink(saveIdPath);
				} catch (_e) {
					// ignore
				}
			}

			slot.bytes = new Uint8Array(imgBytes);
			slot.idBytes = new Uint8Array(idBytes);
			slot.headerId = idBytesToHex(idBytes);
			slot.changed = false;
			slot.unformatted = false;
			if (!slot.name || slot.name === 'Unformatted disk') {
				slot.name = downloadName;
			}
			this._notifyState();
			return {
				name: downloadName,
				imgBytes: new Uint8Array(imgBytes),
				idBytes: new Uint8Array(idBytes),
			};
		}

		if (slot.bytes) {
			slot.changed = false;
			this._notifyState();
			return {
				name: downloadName,
				imgBytes: new Uint8Array(slot.bytes),
				idBytes: slot.idBytes ? new Uint8Array(slot.idBytes) : new Uint8Array(3),
			};
		}

		return null;
	}

	getDriveState(drive) {
		if (drive < 0 || drive > 3) return null;
		const slot = this.drives[drive];
		let loaded = slot.loaded;
		let unformatted = slot.unformatted;
		let changed = slot.changed;
		let wprot = Boolean(this.settings.wprot[drive]);
		let busy = false;
		let track = 0;
		let side = 0;
		let headerId = slot.headerId || (slot.idBytes ? idBytesToHex(slot.idBytes) : '');

		if (this.poweredOn && this.mod) {
			loaded = Boolean(this.mod._web_disk_loaded(drive));
			unformatted = Boolean(this.mod._web_disk_unformatted(drive));
			changed = Boolean(this.mod._web_disk_changed(drive));
			wprot = Boolean(this.mod._web_get_wprot(drive));
			busy = Boolean(this.mod._web_disk_busy(drive));
			track = this.mod._web_disk_track(drive) | 0;
			side = this.mod._web_disk_side(drive) | 0;
			if (loaded) {
				const idInt = this.mod._web_disk_id_hex(drive) >>> 0;
				headerId = (idInt & 0xffffff).toString(16).toUpperCase().padStart(6, '0');
			} else {
				headerId = '';
			}
		}

		return {
			drive,
			loaded,
			unformatted,
			name: slot.name,
			changed,
			wprot,
			busy,
			track,
			side,
			headerId,
		};
	}

	getAllDriveStates() {
		return [0, 1, 2, 3].map((d) => this.getDriveState(d));
	}

	hasUnsavedChanges() {
		for (let d = 0; d < 4; d++) {
			const st = this.getDriveState(d);
			if (st && st.loaded && st.changed) return true;
		}
		return false;
	}

	getTelemetry() {
		if (!this.poweredOn || !this.mod) {
			return {
				poweredOn: false,
				fast: Boolean(this.settings.fast),
				boards: this.settings.boards,
				mappedCard: -1,
				mappedBank: -1,
				mainsHz: this.settings.mainsHz,
				emuSeconds: 0,
				speedRatio: -1,
				serBusy: false,
				printerBytes: this.cachedPrinterBytes.length,
			};
		}

		const mapped = this.mod._web_mem_mapped();
		const mappedCard = mapped >= 0 ? (mapped >> 8) & 0xff : -1;
		const mappedBank = mapped >= 0 ? mapped & 0xff : -1;
		const emuSeconds = this.mod._web_emu_seconds();
		const hostNow = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;

		if (this.speedHost0 === 0) {
			this.speedHost0 = hostNow;
			this.speedEmu0 = emuSeconds;
		} else if (hostNow - this.speedHost0 >= 0.5) {
			this.speedRatio = (emuSeconds - this.speedEmu0) / (hostNow - this.speedHost0);
			this.speedHost0 = hostNow;
			this.speedEmu0 = emuSeconds;
		}

		const printerBytes = this.mod._web_printer_bytes() | 0;

		return {
			poweredOn: true,
			fast: Boolean(this.mod._web_get_fast()),
			boards: this.mod._web_mem_boards() | 0,
			mappedCard,
			mappedBank,
			mainsHz: this.mod._web_mains_hz() | 0,
			emuSeconds,
			speedRatio: this.speedRatio,
			serBusy: Boolean(this.mod._web_ser_busy()),
			printerBytes,
		};
	}

	getPrinterBytes() {
		if (this.poweredOn && this.mod) {
			this.mod._web_printer_bytes(); // flushes FILE* in C
			try {
				const raw = this.mod.FS.readFile('/printer.bin');
				this.cachedPrinterBytes = new Uint8Array(raw);
			} catch (_e) {
				this.cachedPrinterBytes = new Uint8Array(0);
			}
		}
		return new Uint8Array(this.cachedPrinterBytes);
	}

	getPrinterText() {
		return renderDiabloText(this.getPrinterBytes());
	}

	clearPrinter() {
		if (this.poweredOn && this.mod) {
			this.mod._web_printer_clear();
		}
		this.cachedPrinterBytes = new Uint8Array(0);
		this.lastPrinterLen = 0;
		this._notifyState();
	}

	keyQueue(ch) {
		if (!this.poweredOn || !this.mod) return;
		this.mod._web_key_queue(ch | 0);
	}

	pasteText(text) {
		if (!this.poweredOn || !this.mod || !text) return;
		const normalized = String(text).replace(/\r\n/g, '\r').replace(/\n/g, '\r');
		const CHUNK_SIZE = 128;
		for (let i = 0; i < normalized.length; i += CHUNK_SIZE) {
			this.pendingTextChunks.push(normalized.slice(i, i + CHUNK_SIZE));
		}
		this._drainTextChunks();
	}

	getKeyPending() {
		if (!this.poweredOn || !this.mod) return 0;
		return (this.mod._web_key_pending() | 0) + this.pendingTextChunks.length;
	}

	getScreenText() {
		if (!this.poweredOn || !this.mod) return '';
		const ptr = this.mod._web_screen_text();
		return ptr ? this.mod.UTF8ToString(ptr) : '';
	}

	// ---- Private helpers ----

	_withCString(str, fn) {
		if (!this.mod) return -1;
		const len = this.mod.lengthBytesUTF8(str) + 1;
		const ptr = this.mod._malloc(len);
		try {
			this.mod.stringToUTF8(str, ptr, len);
			return fn(ptr);
		} finally {
			this.mod._free(ptr);
		}
	}

	_unlinkSlotFiles(slot) {
		if (!this.mod) {
			slot.memfsPath = null;
			slot.memfsIdPath = null;
			return;
		}
		if (slot.memfsPath) {
			try {
				this.mod.FS.unlink(slot.memfsPath);
			} catch (_e) {
				// ignore
			}
			slot.memfsPath = null;
		}
		if (slot.memfsIdPath) {
			try {
				this.mod.FS.unlink(slot.memfsIdPath);
			} catch (_e) {
				// ignore
			}
			slot.memfsIdPath = null;
		}
	}

	_mountStagedDisk(drive) {
		const slot = this.drives[drive];
		if (!this.mod || !slot.bytes) return false;

		const gen = ++this.diskGen;
		const imgPath = `/disks/d${drive}_${gen}.img`;
		const idPath = `/disks/d${drive}_${gen}.id`;

		this.mod.FS.writeFile(imgPath, slot.bytes);
		if (slot.idBytes && slot.idBytes.length === 3) {
			this.mod.FS.writeFile(idPath, slot.idBytes);
		}

		const rc = this._withCString(imgPath, (ptr) => this.mod._web_insert_disk(drive, ptr));
		if (rc === 0) {
			this._unlinkSlotFiles(slot);
			slot.memfsPath = imgPath;
			slot.memfsIdPath = slot.idBytes && slot.idBytes.length === 3 ? idPath : null;
			slot.changed = Boolean(this.mod._web_disk_changed(drive));
			const idInt = this.mod._web_disk_id_hex(drive) >>> 0;
			slot.headerId = (idInt & 0xffffff).toString(16).toUpperCase().padStart(6, '0');
			this.mod._web_set_wprot(drive, this.settings.wprot[drive] ? 1 : 0);
			return true;
		}

		try {
			this.mod.FS.unlink(imgPath);
		} catch (_e) {
			// ignore
		}
		try {
			this.mod.FS.unlink(idPath);
		} catch (_e) {
			// ignore
		}
		slot.loaded = false;
		this.onError(`Failed to mount disk "${slot.name}" in drive ${String.fromCharCode(65 + drive)}:.`);
		return false;
	}

	_drainTextChunks() {
		if (!this.poweredOn || !this.mod || this.pendingTextChunks.length === 0) return;
		if (this.mod._web_key_pending() > 256) return;
		const chunk = this.pendingTextChunks.shift();
		this._withCString(chunk, (ptr) => {
			this.mod._web_key_queue_str(ptr, this.mod.lengthBytesUTF8(chunk));
		});
	}

	async _initOrResumeAudio() {
		if (typeof window === 'undefined') return;
		const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
		if (!AudioContextCtor) return;

		try {
			if (!this.audioCtx) {
				this.audioCtx = new AudioContextCtor({ sampleRate: 48000 });
			}
			if (this.audioCtx.state === 'suspended') {
				this.audioCtx.resume().catch(() => {});
			}
			if (!this.audioNode && this.audioCtx.audioWorklet) {
				if (!this.audioInitPromise) {
					this.audioInitPromise = (async () => {
						await this.audioCtx.audioWorklet.addModule('./audio-worklet.js');
						const node = new AudioWorkletNode(this.audioCtx, 'cc665-audio', {
							numberOfInputs: 0,
							numberOfOutputs: 1,
							outputChannelCount: [1],
						});
						node.connect(this.audioCtx.destination);
						this.audioNode = node;
						this.audioReady = true;
					})().catch(() => {
						this.audioReady = false;
					});
				}
				await this.audioInitPromise;
			}
		} catch (_err) {
			// Graceful fallback if AudioWorklet is blocked or unsupported
			this.audioReady = false;
		}
	}

	_flushAudio() {
		if (this.audioNode && this.audioNode.port) {
			try {
				this.audioNode.port.postMessage({ type: 'clear' });
			} catch (_e) {
				// ignore
			}
		}
	}

	_startLoop() {
		this._stopLoop();
		if (typeof requestAnimationFrame !== 'function') return;

		const FRAME_MS = 1000 / 60;
		const MAX_CATCHUP_TICKS = 4;
		const FAST_BUDGET_MS = 12;
		const TELEMETRY_INTERVAL_MS = 66; // ~15 Hz

		const now0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
		this.lastRafTime = now0;
		this.lastTelemetryNotify = now0;
		this.tickAccum = 0;

		const loop = (now) => {
			if (!this.poweredOn || !this.mod) return;

			const dt = Math.max(0, now - this.lastRafTime);
			this.lastRafTime = now;

			let discreteChanged = false;
			let hasNewFrame = false;
			let ticksRun = 0;

			if (this.settings.fast) {
				const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
				let audioSentThisFrame = false;
				do {
					const res = this._stepSingleTick(!audioSentThisFrame);
					audioSentThisFrame = true;
					if (res.frameReady) hasNewFrame = true;
					if (res.discreteChanged) discreteChanged = true;
					ticksRun++;
				} while (
					ticksRun < 64 &&
					(typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0 < FAST_BUDGET_MS
				);
				this.tickAccum = 0;
			} else {
				this.tickAccum += dt;
				if (this.tickAccum > FRAME_MS * MAX_CATCHUP_TICKS) {
					this.tickAccum = FRAME_MS * MAX_CATCHUP_TICKS;
				}
				while (this.tickAccum >= FRAME_MS && ticksRun < MAX_CATCHUP_TICKS) {
					const res = this._stepSingleTick(true);
					if (res.frameReady) hasNewFrame = true;
					if (res.discreteChanged) discreteChanged = true;
					this.tickAccum -= FRAME_MS;
					ticksRun++;
				}
			}

			if (hasNewFrame) {
				this._renderLastFrame(false);
			}

			if (discreteChanged || (ticksRun > 0 && now - this.lastTelemetryNotify >= TELEMETRY_INTERVAL_MS)) {
				this.lastTelemetryNotify = now;
				this._notifyState();
			}

			this.rafId = requestAnimationFrame(loop);
		};

		this.rafId = requestAnimationFrame(loop);
	}

	_stopLoop() {
		if (this.rafId !== null && typeof cancelAnimationFrame === 'function') {
			cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
	}

	_stepSingleTick(postAudio) {
		if (!this.poweredOn || !this.mod) {
			return { frameReady: false, discreteChanged: false };
		}

		if (this.pendingTextChunks.length > 0) {
			this._drainTextChunks();
		}

		const frameReady = this.mod._web_tick() === 1;
		let discreteChanged = false;

		for (let d = 0; d < 4; d++) {
			const slot = this.drives[d];
			const loadedNow = Boolean(this.mod._web_disk_loaded(d));
			const changedNow = loadedNow ? Boolean(this.mod._web_disk_changed(d)) : false;
			const unformattedNow = loadedNow ? Boolean(this.mod._web_disk_unformatted(d)) : false;
			if (
				loadedNow !== slot.loaded ||
				changedNow !== slot.changed ||
				unformattedNow !== slot.unformatted
			) {
				slot.loaded = loadedNow;
				slot.changed = changedNow;
				slot.unformatted = unformattedNow;
				discreteChanged = true;
			}
		}

		const prnLen = this.mod._web_printer_bytes() | 0;
		if (prnLen !== this.lastPrinterLen) {
			this.lastPrinterLen = prnLen;
			discreteChanged = true;
		}

		if (postAudio && !this.muted && this.audioReady && this.audioNode) {
			if (this.audioCtx && this.audioCtx.state === 'suspended') {
				this.audioCtx.resume().catch(() => {});
			}
			const audioPtr = this.mod._web_audio_ptr();
			const numSamples = this.mod._web_audio_samples();
			if (audioPtr && numSamples > 0) {
				const baseIdx = audioPtr >> 1;
				// Always read fresh this.mod.HEAP16 in case WASM memory grew during _web_tick()
				const chunk = this.mod.HEAP16.slice(baseIdx, baseIdx + numSamples);
				this.audioNode.port.postMessage(chunk, [chunk.buffer]);
			}
		}

		if (frameReady) {
			const w = this.mod._web_frame_w();
			const h = this.mod._web_frame_h();
			const aspect = this.mod._web_frame_aspect();
			const framePtr = this.mod._web_frame_ptr();
			const byteLen = w * h;
			if (w > 0 && h > 0 && framePtr) {
				// Always read fresh this.mod.HEAPU8 after _web_tick()
				const src = this.mod.HEAPU8.subarray(framePtr, framePtr + byteLen);
				if (!this.lastFrame || this.lastFrame.w !== w || this.lastFrame.h !== h) {
					this.lastFrame = {
						bytes: new Uint8Array(src),
						w,
						h,
						aspect: aspect > 0 ? aspect : 4 / 3,
					};
				} else {
					this.lastFrame.bytes.set(src);
					this.lastFrame.aspect = aspect > 0 ? aspect : 4 / 3;
				}
			}
		}

		return { frameReady, discreteChanged };
	}

	_syncCanvasSize() {
		if (!this.canvas) return;
		const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
		const rect = this.canvas.getBoundingClientRect();
		const cssW = rect.width > 0 ? rect.width : 800;
		const cssH = rect.height > 0 ? rect.height : 600;
		const targetW = Math.max(1, Math.round(cssW * dpr));
		const targetH = Math.max(1, Math.round(cssH * dpr));
		if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
			this.canvas.width = targetW;
			this.canvas.height = targetH;
		}
	}

	_clearCanvasBlack() {
		if (!this.ctx || !this.canvas) return;
		this.ctx.fillStyle = '#000000';
		this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
	}

	_drawOffScreen() {
		if (!this.ctx || !this.canvas) return;
		this._syncCanvasSize();
		const ww = this.canvas.width;
		const wh = this.canvas.height;

		this.ctx.fillStyle = '#000000';
		this.ctx.fillRect(0, 0, ww, wh);

		if (this.logoImg && this.logoImg.naturalWidth > 0 && this.logoImg.naturalHeight > 0) {
			const logoAspect = this.logoImg.naturalWidth / this.logoImg.naturalHeight;
			const maxW = Math.round(ww * (ww < wh * 1.2 ? 0.6 : 0.4));
			const maxH = Math.round(wh * 0.55);
			let lw = maxW;
			let lh = Math.round(lw / logoAspect);
			if (lh > maxH) {
				lh = maxH;
				lw = Math.round(lh * logoAspect);
			}
			const lx = Math.round((ww - lw) / 2);
			const ly = Math.round((wh - lh) / 2);
			this.ctx.imageSmoothingEnabled = true;
			this.ctx.drawImage(this.logoImg, lx, ly, lw, lh);
		}
	}

	_renderLastFrame(_forceUpload = false) {
		if (!this.ctx || !this.canvas) return;
		this._syncCanvasSize();
		if (!this.lastFrame) {
			this._clearCanvasBlack();
			return;
		}

		const { bytes, w, h, aspect } = this.lastFrame;
		if (!this.offscreenCanvas || this.offscreenCanvas.width !== w || this.offscreenCanvas.height !== h) {
			if (typeof document !== 'undefined') {
				this.offscreenCanvas = document.createElement('canvas');
				this.offscreenCanvas.width = w;
				this.offscreenCanvas.height = h;
				this.offscreenCtx = this.offscreenCanvas.getContext('2d');
				this.imageData = this.offscreenCtx.createImageData(w, h);
			}
		}

		if (this.offscreenCtx && this.imageData) {
			const rgb = PHOSPHOR_RGB[this.settings.phosphor] || PHOSPHOR_RGB.cyan;
			const rLit = rgb[0];
			const gLit = rgb[1];
			const bLit = rgb[2];
			const data = this.imageData.data;
			const n = w * h;

			for (let i = 0; i < n; i++) {
				const p = i << 2;
				if (bytes[i]) {
					data[p] = rLit;
					data[p + 1] = gLit;
					data[p + 2] = bLit;
					data[p + 3] = 255;
				} else {
					data[p] = 0;
					data[p + 1] = 0;
					data[p + 2] = 0;
					data[p + 3] = 255;
				}
			}
			this.offscreenCtx.putImageData(this.imageData, 0, 0);
			this.lastPhosphor = this.settings.phosphor;
		}

		const ww = this.canvas.width;
		const wh = this.canvas.height;
		this.ctx.fillStyle = '#000000';
		this.ctx.fillRect(0, 0, ww, wh);

		if (this.offscreenCanvas) {
			let dstW = ww;
			let dstH = Math.round(ww / aspect);
			if (dstH > wh) {
				dstH = wh;
				dstW = Math.round(wh * aspect);
			}
			const dstX = Math.round((ww - dstW) / 2);
			const dstY = Math.round((wh - dstH) / 2);
			this.ctx.imageSmoothingEnabled = true;
			this.ctx.drawImage(this.offscreenCanvas, 0, 0, w, h, dstX, dstY, dstW, dstH);
		}
	}

	_redrawCurrentScreen() {
		if (!this.poweredOn) {
			this._drawOffScreen();
		} else {
			this._renderLastFrame(true);
		}
	}

	_notifyState() {
		try {
			this.onStateChange();
		} catch (_e) {
			// ignore observer callback exceptions
		}
	}
}
