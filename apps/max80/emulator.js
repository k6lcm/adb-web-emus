/*
 * Browser runtime controller for the MAX-80 WebAssembly emulator.
 * Manages Emscripten module lifecycle (clean restart via fresh createMax80()
 * instances), Canvas 2D aspect-accurate CRT rendering, Web Audio worklet
 * streaming, in-memory floppy drives A:..D: with FDC-busy retry queueing,
 * and keyboard input forwarding.
 */

import createMax80 from './max80.js';

export const BOOT_DEVICES = [
	'None',
	'5-inch floppy',
	'8-inch floppy',
	'5-inch winchester',
	'8-inch winchester',
	'5-inch backup floppy',
	'8-inch backup floppy',
	'SASI hard disk',
];

const PHOSPHOR_RGB = {
	white: [232, 232, 232],
	green: [51, 255, 102],
	amber: [255, 176, 0],
};

const DEFAULT_SETTINGS = {
	dips: 2,
	memMode: '128', // '128' | '64' | '64f'
	mem64: false,
	quick: false,
	fast: false,
	timeSet: false,
	three: [false, false, false, false],
	wprot: [false, false, false, false],
	phosphor: 'white',
};

/**
 * Pure-JS IMD disk kind sniffer matching load_imd() in emu/max80.c.
 * Scans past the 0x1a ASCII comment terminator and inspects tracks until the
 * first non-empty track's mode byte (0..2 = 500/300/250 kbps FM, 3..5 = MFM).
 * Mode 0 or 3 (mode % 3 === 0) is 500 kbps -> 8-inch (8); modes 1,2,4,5 -> 5-inch (5).
 */
export function sniffImdKind(bytes) {
	if (!bytes || !(bytes instanceof Uint8Array) || bytes.length < 6) {
		return 0;
	}
	const n = bytes.length;
	let i = 0;
	while (i < n && bytes[i] !== 0x1a) {
		i++;
	}
	i++;
	while (i + 5 <= n) {
		const mode = bytes[i];
		const cyl = bytes[i + 1];
		const head = bytes[i + 2];
		const ns = bytes[i + 3];
		const sizeCode = bytes[i + 4];
		if (mode > 5 || sizeCode > 6 || (head & 0x3e) !== 0 || cyl >= 84) {
			return 0;
		}
		if (ns > 0) {
			return mode % 3 === 0 ? 8 : 5;
		}
		i += 5 + ns;
		if (head & 0x80) i += ns;
		if (head & 0x40) i += ns;
	}
	return 0;
}

function normalizeMemMode(s) {
	if (s && (s.memMode === '64' || s.memMode === '64f' || s.memMode === '128')) {
		return s.memMode;
	}
	return s && s.mem64 ? '64' : '128';
}

function memModeToInt(mode) {
	if (mode === '64') return 1;
	if (mode === '64f') return 2;
	return 0;
}

function cloneSettings(s) {
	const memMode = normalizeMemMode(s);
	return {
		dips: s.dips & 0xff,
		memMode,
		mem64: memMode !== '128',
		quick: Boolean(s.quick),
		fast: Boolean(s.fast),
		timeSet: Boolean(s.timeSet),
		three: Array.isArray(s.three) ? s.three.slice(0, 4).map(Boolean) : [false, false, false, false],
		wprot: Array.isArray(s.wprot) ? s.wprot.slice(0, 4).map(Boolean) : [false, false, false, false],
		phosphor: PHOSPHOR_RGB[s.phosphor] ? s.phosphor : 'white',
	};
}

function boolArrayToMask(arr) {
	let mask = 0;
	for (let d = 0; d < 4; d++) {
		if (arr[d]) mask |= 1 << d;
	}
	return mask;
}

export class Max80Emulator {
	constructor(initialSettings = {}) {
		this.settings = cloneSettings({
			...DEFAULT_SETTINGS,
			...initialSettings,
			three: initialSettings.three || DEFAULT_SETTINGS.three,
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
		this.logoImg = null;
		this.onStateChange = () => {};
		this.onError = () => {};

		this.mod = null;
		this.poweredOn = false;
		this.muted = false;

		this.rafId = null;
		this.lastRafTime = 0;
		this.tickAccum = 0;
		this.resizeObserver = null;
		this._boundResize = null;

		this.audioCtx = null;
		this.audioNode = null;
		this.audioReady = false;
		this.audioInitPromise = null;

		this.pendingTextChunks = [];
		this.diskGen = 0;
		this.cachedPrinterBytes = new Uint8Array(0);
		this.lastPrinterLen = 0;

		this.hardDisk = {
			loaded: false,
			blank: false,
			name: '',
			bytes: null,
			blocks: 0,
		};

		this.drives = [0, 1, 2, 3].map((d) => ({
			drive: d,
			loaded: false,
			blank: false,
			name: '',
			bytes: null,
			kind: 0,
			changed: false,
			memfsPath: null,
			pendingOp: null, // { type: 'insert' | 'blank' | 'eject' }
		}));
	}

	async init({
		canvas,
		romUrl = './max80.e12',
		logoUrl = './lobo_logo.svg',
		onStateChange = () => {},
		onError = () => {},
	} = {}) {
		this.canvas = canvas || null;
		this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
		this.onStateChange = typeof onStateChange === 'function' ? onStateChange : () => {};
		this.onError = typeof onError === 'function' ? onError : () => {};

		// Set up canvas sizing & ResizeObserver
		if (this.canvas) {
			this._syncCanvasSize();
			this._boundResize = () => {
				this._syncCanvasSize();
				this._redrawCurrentScreen();
			};
			if (typeof ResizeObserver !== 'undefined') {
				this.resizeObserver = new ResizeObserver(this._boundResize);
				this.resizeObserver.observe(this.canvas.parentElement || this.canvas);
			} else if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
				window.addEventListener('resize', this._boundResize);
			}
		}

		// Load Lobo logo image (non-fatal if missing)
		if (logoUrl && typeof Image !== 'undefined') {
			await new Promise((resolve) => {
				const img = new Image();
				img.onload = () => {
					this.logoImg = img;
					if (!this.poweredOn) this._drawOffScreen();
					resolve();
				};
				img.onerror = () => {
					this.logoImg = null;
					resolve();
				};
				img.src = logoUrl;
			});
		}

		this._drawOffScreen();

		// Fetch 512-byte boot ROM
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
			if (bytes.length !== 512) {
				const msg = `Invalid boot ROM (${romUrl}): expected 512 bytes, got ${bytes.length}`;
				this.onError(msg);
				throw new Error(msg);
			}
			this.romBytes = bytes;
		}
	}

	getSettings() {
		return cloneSettings(this.settings);
	}

	updateSettings(partial = {}) {
		if (!partial || typeof partial !== 'object') {
			return { needsRestart: false };
		}

		let dipsChanged = false;
		if (partial.dips !== undefined) {
			const nextDips = partial.dips & 0xff;
			if (nextDips !== this.settings.dips) {
				this.settings.dips = nextDips;
				dipsChanged = true;
				if (this.poweredOn && this.mod) {
					this.mod._web_set_dips(nextDips);
				}
			}
		}

		if (partial.memMode !== undefined && ['128', '64', '64f'].includes(partial.memMode)) {
			this.settings.memMode = partial.memMode;
			this.settings.mem64 = partial.memMode !== '128';
		} else if (partial.mem64 !== undefined) {
			this.settings.mem64 = Boolean(partial.mem64);
			this.settings.memMode = this.settings.mem64 ? '64' : '128';
		}
		if (partial.quick !== undefined) {
			this.settings.quick = Boolean(partial.quick);
		}
		if (partial.fast !== undefined) {
			this.settings.fast = Boolean(partial.fast);
			if (this.poweredOn && this.mod) {
				this.mod._web_set_fast(this.settings.fast ? 1 : 0);
			}
		}
		if (partial.timeSet !== undefined) {
			this.settings.timeSet = Boolean(partial.timeSet);
			if (this.poweredOn && this.mod) {
				this.mod._web_set_time_set(this.settings.timeSet ? 1 : 0);
			}
		}
		if (Array.isArray(partial.three)) {
			for (let d = 0; d < 4; d++) {
				if (partial.three[d] !== undefined) {
					this.settings.three[d] = Boolean(partial.three[d]);
				}
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

		let needsRestart = false;
		if (this.poweredOn && this.launchSettings) {
			const ls = this.launchSettings;
			const threeDiff = this.settings.three.some((v, i) => v !== ls.three[i]);
			if (
				dipsChanged ||
				this.settings.dips !== ls.dips ||
				this.settings.memMode !== ls.memMode ||
				this.settings.quick !== ls.quick ||
				threeDiff
			) {
				needsRestart = true;
			}
		}

		this._notifyState();
		return { needsRestart };
	}

	async powerOn() {
		this._stopLoop();
		this._flushAudio();

		if (!this.romBytes || this.romBytes.length !== 512) {
			const msg = 'Cannot power on: 512-byte boot ROM (max80.e12) is not loaded.';
			this.onError(msg);
			throw new Error(msg);
		}

		const mod = await createMax80();
		this.mod = mod;
		this.pendingTextChunks = [];
		this.lastFrame = null;
		this.cachedPrinterBytes = new Uint8Array(0);
		this.lastPrinterLen = 0;

		try {
			mod.FS.mkdir('/disks');
		} catch (_e) {
			// ignore EEXIST
		}
		try {
			mod.FS.mkdir('/tmp');
		} catch (_e) {
			// ignore EEXIST
		}

		const romPtr = mod._malloc(512);
		let initRc = -1;
		try {
			mod.HEAPU8.set(this.romBytes, romPtr);
			initRc = mod._web_init(
				romPtr,
				512,
				this.settings.dips & 0xff,
				memModeToInt(this.settings.memMode),
				this.settings.quick ? 1 : 0,
				boolArrayToMask(this.settings.three),
				boolArrayToMask(this.settings.wprot),
				this.settings.fast ? 1 : 0
			);
		} finally {
			mod._free(romPtr);
		}

		if (initRc !== 0) {
			this.mod = null;
			const msg = 'Failed to initialize MAX-80 WASM core (_web_init returned -1).';
			this.onError(msg);
			throw new Error(msg);
		}

		mod._web_set_time_set(this.settings.timeSet ? 1 : 0);

		// Mount staged SASI hard disk if attached
		if (this.hardDisk.loaded) {
			if (this.hardDisk.blank && this.hardDisk.blocks > 0) {
				mod._web_hd_insert_blank(this.hardDisk.blocks);
			} else if (this.hardDisk.bytes) {
				this._mountStagedHardDisk();
			}
		}

		// Load all active drive slots into the fresh WASM instance
		for (let d = 0; d < 4; d++) {
			const slot = this.drives[d];
			slot.pendingOp = null;
			slot.memfsPath = null;
			if (slot.blank) {
				mod._web_insert_blank(d);
				slot.loaded = true;
				slot.kind = 0;
				slot.changed = false;
			} else if (slot.loaded && slot.bytes) {
				const path = `/disks/d${d}_${++this.diskGen}.imd`;
				mod.FS.writeFile(path, slot.bytes);
				const rc = this._withCString(path, (ptr) => mod._web_insert_disk(d, ptr));
				if (rc === 0) {
					slot.memfsPath = path;
					slot.kind = mod._web_disk_kind(d);
					slot.changed = Boolean(mod._web_disk_changed(d));
				} else {
					try {
						mod.FS.unlink(path);
					} catch (_e) {
						// ignore
					}
					slot.loaded = false;
					slot.kind = 0;
					this.onError(`Failed to mount disk "${slot.name}" in drive ${String.fromCharCode(65 + d)}:.`);
				}
			}
			mod._web_set_wprot(d, this.settings.wprot[d] ? 1 : 0);
		}

		// Initialize or resume Web Audio worklet (graceful fallback if unavailable)
		await this._initOrResumeAudio();

		this.launchSettings = cloneSettings(this.settings);
		this.poweredOn = true;

		// Run initial tick so we render immediately if a frame is ready
		this._stepSingleTick(true);
		if (!this.lastFrame) {
			this._clearCanvasBlack();
		}

		this._startLoop();
		this._notifyState();
	}

	async powerOff() {
		this._stopLoop();
		this._flushAudio();
		this.pendingTextChunks = [];
		this.mod = null;
		this.poweredOn = false;
		this.launchSettings = null;
		this.lastFrame = null;

		for (let d = 0; d < 4; d++) {
			this.drives[d].pendingOp = null;
			this.drives[d].memfsPath = null;
			this.drives[d].changed = false;
		}

		this._drawOffScreen();
		this._notifyState();
	}

	async restart() {
		await this.powerOn();
	}

	insertDiskBytes(drive, name, uint8Array) {
		if (drive < 0 || drive > 3) {
			return { ok: false, error: 'Invalid drive index' };
		}
		if (!uint8Array || !(uint8Array instanceof Uint8Array) || uint8Array.length === 0) {
			return { ok: false, error: 'Empty or invalid disk image' };
		}

		const sniffedKind = sniffImdKind(uint8Array);
		if (sniffedKind === 0) {
			const err = `"${name || 'disk.imd'}" is not a valid ImageDisk (.imd) file.`;
			this.onError(err);
			return { ok: false, error: err };
		}

		const slot = this.drives[drive];
		const copy = new Uint8Array(uint8Array);

		if (!this.poweredOn || !this.mod) {
			slot.loaded = true;
			slot.blank = false;
			slot.name = name || `disk_${drive}.imd`;
			slot.bytes = copy;
			slot.kind = sniffedKind;
			slot.changed = false;
			slot.pendingOp = null;
			this._notifyState();
			return { ok: true, kind: slot.kind, pending: false };
		}

		slot.name = name || `disk_${drive}.imd`;
		slot.bytes = copy;
		slot.blank = false;
		slot.loaded = true;
		slot.kind = sniffedKind;

		const res = this._applyMountedDiskInsert(drive);
		if (!res.ok) {
			this.onError(res.error);
			this._notifyState();
			return res;
		}

		this._notifyState();
		return { ok: true, kind: slot.kind, pending: res.pending };
	}

	insertBlankDisk(drive) {
		if (drive < 0 || drive > 3) return { ok: false, error: 'Invalid drive index' };
		const slot = this.drives[drive];
		slot.loaded = true;
		slot.blank = true;
		slot.name = 'Blank disk';
		slot.bytes = null;
		slot.kind = 0;
		slot.changed = false;
		slot.pendingOp = null;

		let pending = false;
		if (this.poweredOn && this.mod) {
			const rc = this.mod._web_insert_blank(drive);
			if (rc === 1) {
				slot.pendingOp = { type: 'blank' };
				pending = true;
			} else if (rc === 0) {
				this._unlinkSlotFile(slot);
				this.mod._web_set_wprot(drive, this.settings.wprot[drive] ? 1 : 0);
			}
		}

		this._notifyState();
		return { ok: true, kind: 0, pending };
	}

	ejectDisk(drive) {
		if (drive < 0 || drive > 3) return { ok: false, error: 'Invalid drive index' };
		const slot = this.drives[drive];
		slot.loaded = false;
		slot.blank = false;
		slot.name = '';
		slot.bytes = null;
		slot.kind = 0;
		slot.changed = false;
		slot.pendingOp = null;

		let pending = false;
		if (this.poweredOn && this.mod) {
			const rc = this.mod._web_eject_disk(drive);
			if (rc === 1) {
				slot.pendingOp = { type: 'eject' };
				pending = true;
			} else {
				this._unlinkSlotFile(slot);
			}
		}

		this._notifyState();
		return { ok: true, pending };
	}

	saveDiskBytes(drive) {
		if (drive < 0 || drive > 3) return null;
		const slot = this.drives[drive];
		if (!slot.loaded) return null;

		const downloadName =
			slot.name && slot.name !== 'Blank disk'
				? slot.name.endsWith('.imd') || slot.name.endsWith('.IMD')
					? slot.name
					: `${slot.name}.imd`
				: `disk_${String.fromCharCode(97 + drive)}.imd`;

		if (this.poweredOn && this.mod) {
			const tmpPath = `/tmp/save_d${drive}.imd`;
			const rc = this._withCString(tmpPath, (ptr) => this.mod._web_save_disk(drive, ptr));
			if (rc !== 0) {
				this.onError(`Could not save disk in drive ${String.fromCharCode(65 + drive)}:.`);
				return null;
			}
			let saved;
			try {
				const raw = this.mod.FS.readFile(tmpPath);
				saved = new Uint8Array(raw);
			} finally {
				try {
					this.mod.FS.unlink(tmpPath);
				} catch (_e) {
					// ignore
				}
			}
			slot.bytes = saved;
			slot.blank = false;
			if (!slot.name || slot.name === 'Blank disk') {
				slot.name = downloadName;
			}
			slot.changed = false;
			slot.kind = this.mod._web_disk_kind(drive) || sniffImdKind(saved);
			this._notifyState();
			return { name: downloadName, bytes: new Uint8Array(saved) };
		}

		if (slot.bytes) {
			slot.changed = false;
			this._notifyState();
			return { name: downloadName, bytes: new Uint8Array(slot.bytes) };
		}

		return null;
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

	setFast(on) {
		const flag = Boolean(on);
		this.settings.fast = flag;
		if (this.poweredOn && this.mod) {
			this.mod._web_set_fast(flag ? 1 : 0);
		}
		this._notifyState();
	}

	setDips(byte) {
		const val = byte & 0xff;
		this.settings.dips = val;
		if (this.poweredOn && this.mod) {
			this.mod._web_set_dips(val);
		}
		this._notifyState();
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

	setPhosphor(mode) {
		if (!PHOSPHOR_RGB[mode]) return;
		if (this.settings.phosphor !== mode) {
			this.settings.phosphor = mode;
			this.lastPhosphor = null;
			if (this.poweredOn) {
				this._renderLastFrame(true);
			}
			this._notifyState();
		}
	}

	getDriveState(drive) {
		if (drive < 0 || drive > 3) return null;
		const slot = this.drives[drive];
		return {
			drive,
			loaded: slot.loaded,
			blank: slot.blank,
			name: slot.name,
			kind: slot.kind,
			changed: slot.changed,
			wprot: Boolean(this.settings.wprot[drive]),
			three: Boolean(this.settings.three[drive]),
		};
	}

	hasUnsavedChanges() {
		return this.drives.some((d) => d.loaded && d.changed);
	}

	getUnsavedDrives() {
		return this.drives.filter((d) => d.loaded && d.changed).map((d) => this.getDriveState(d.drive));
	}

	isPoweredOn() {
		return this.poweredOn;
	}

	isFast() {
		return Boolean(this.settings.fast);
	}

	keyHold(slot, ch) {
		if (!this.poweredOn || !this.mod) return 0;
		return this.mod._web_key_hold(slot | 0, ch | 0);
	}

	keyUnhold(slot) {
		if (!this.poweredOn || !this.mod) return;
		this.mod._web_key_unhold(slot | 0);
	}

	keyReleaseAll() {
		if (!this.poweredOn || !this.mod) return;
		this.mod._web_key_release_all();
	}

	keyQueue(ch) {
		if (!this.poweredOn || !this.mod) return;
		this.mod._web_key_queue_char(ch | 0);
	}

	pasteText(str) {
		if (!this.poweredOn || !this.mod || !str) return;
		const normalized = String(str).replace(/\r\n/g, '\r').replace(/\n/g, '\r');
		const CHUNK_SIZE = 128;
		for (let i = 0; i < normalized.length; i += CHUNK_SIZE) {
			this.pendingTextChunks.push(normalized.slice(i, i + CHUNK_SIZE));
		}
		this._drainTextChunks();
	}

	readScreenText() {
		if (!this.poweredOn || !this.mod) return '';
		const ptr = this.mod._web_screen_text();
		return ptr ? this.mod.UTF8ToString(ptr) : '';
	}

	// ---- SASI Hard Disk (-h) ----

	getHardDiskState() {
		return {
			loaded: Boolean(this.hardDisk.loaded),
			blank: Boolean(this.hardDisk.blank),
			name: this.hardDisk.name || '',
			blocks: this.hardDisk.blocks | 0,
		};
	}

	insertHardDiskBytes(name, uint8Array) {
		if (!uint8Array || !(uint8Array instanceof Uint8Array) || uint8Array.length === 0) {
			return { ok: false, error: 'Empty or invalid hard disk image.' };
		}
		if (uint8Array.length % 512 !== 0) {
			return {
				ok: false,
				error: `"${name || 'hard.img'}" size (${uint8Array.length} bytes) must be a multiple of 512 bytes.`,
			};
		}
		const copy = new Uint8Array(uint8Array);
		this.hardDisk = {
			loaded: true,
			blank: false,
			name: name || 'hard.img',
			bytes: copy,
			blocks: copy.length / 512,
		};
		if (this.poweredOn && this.mod) {
			if (!this._mountStagedHardDisk()) {
				this.hardDisk = { loaded: false, blank: false, name: '', bytes: null, blocks: 0 };
				this._notifyState();
				return { ok: false, error: `Failed to mount SASI image "${name}".` };
			}
		}
		this._notifyState();
		return { ok: true, blocks: this.hardDisk.blocks };
	}

	insertBlankHardDisk(blocks = 10240) {
		const n = Math.max(1, blocks | 0);
		this.hardDisk = {
			loaded: true,
			blank: true,
			name: `Blank ${(n * 512 / (1024 * 1024)).toFixed(1)} MB SASI`,
			bytes: null,
			blocks: n,
		};
		if (this.poweredOn && this.mod) {
			const rc = this.mod._web_hd_insert_blank(n);
			if (rc !== 0) {
				this.hardDisk = { loaded: false, blank: false, name: '', bytes: null, blocks: 0 };
				this._notifyState();
				return { ok: false, error: 'Failed to allocate blank SASI hard disk.' };
			}
		}
		this._notifyState();
		return { ok: true, blocks: n };
	}

	ejectHardDisk() {
		if (this.poweredOn && this.mod) {
			this.mod._web_hd_eject();
		}
		this.hardDisk = { loaded: false, blank: false, name: '', bytes: null, blocks: 0 };
		this._notifyState();
		return { ok: true };
	}

	saveHardDiskBytes() {
		if (!this.hardDisk.loaded) return null;
		const downloadName =
			this.hardDisk.name && !this.hardDisk.blank
				? /\.(img|hd|raw)$/i.test(this.hardDisk.name)
					? this.hardDisk.name
					: `${this.hardDisk.name}.img`
				: 'max80-sasi.img';

		if (this.poweredOn && this.mod && this.mod._web_hd_loaded()) {
			const tmpPath = '/tmp/save_hd.img';
			const rc = this._withCString(tmpPath, (ptr) => this.mod._web_hd_save(ptr));
			if (rc !== 0) {
				this.onError('Could not save SASI hard disk image.');
				return null;
			}
			let saved;
			try {
				saved = new Uint8Array(this.mod.FS.readFile(tmpPath));
			} finally {
				try {
					this.mod.FS.unlink(tmpPath);
				} catch (_e) {
					// ignore
				}
			}
			this.hardDisk.bytes = saved;
			this.hardDisk.blank = false;
			this.hardDisk.blocks = saved.length / 512;
			if (!this.hardDisk.name || this.hardDisk.name.startsWith('Blank ')) {
				this.hardDisk.name = downloadName;
			}
			this._notifyState();
			return { name: downloadName, bytes: new Uint8Array(saved) };
		}

		if (this.hardDisk.bytes) {
			return { name: downloadName, bytes: new Uint8Array(this.hardDisk.bytes) };
		}
		if (this.hardDisk.blank && this.hardDisk.blocks > 0) {
			return { name: downloadName, bytes: new Uint8Array(this.hardDisk.blocks * 512) };
		}
		return null;
	}

	_mountStagedHardDisk() {
		if (!this.mod || !this.hardDisk.bytes) return false;
		const path = `/tmp/hd_${++this.diskGen}.img`;
		this.mod.FS.writeFile(path, this.hardDisk.bytes);
		const rc = this._withCString(path, (ptr) => this.mod._web_hd_insert(ptr));
		try {
			this.mod.FS.unlink(path);
		} catch (_e) {
			// ignore
		}
		return rc === 0;
	}

	// ---- Parallel Printer Capture (-l) ----

	getPrinterByteCount() {
		if (this.poweredOn && this.mod) {
			return this.mod._web_printer_bytes() | 0;
		}
		return this.cachedPrinterBytes.length;
	}

	getPrinterBytes() {
		if (this.poweredOn && this.mod) {
			this.mod._web_printer_bytes();
			try {
				this.cachedPrinterBytes = new Uint8Array(this.mod.FS.readFile('/printer.bin'));
			} catch (_e) {
				this.cachedPrinterBytes = new Uint8Array(0);
			}
		}
		return new Uint8Array(this.cachedPrinterBytes);
	}

	getPrinterText() {
		const bytes = this.getPrinterBytes();
		if (bytes.length === 0) return '';
		let out = '';
		for (let i = 0; i < bytes.length; i++) {
			const c = bytes[i];
			if (c === 0x0d) {
				if (i + 1 < bytes.length && bytes[i + 1] === 0x0a) continue;
				out += '\n';
			} else if (c === 0x0a || c === 0x09 || (c >= 0x20 && c < 0x7f)) {
				out += String.fromCharCode(c);
			} else if (c === 0x0c) {
				out += '\n--- PAGE BREAK ---\n';
			}
		}
		return out;
	}

	clearPrinter() {
		if (this.poweredOn && this.mod) {
			this.mod._web_printer_clear();
		}
		this.cachedPrinterBytes = new Uint8Array(0);
		this.lastPrinterLen = 0;
		this._notifyState();
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

	_unlinkSlotFile(slot) {
		if (slot.memfsPath && this.mod) {
			try {
				this.mod.FS.unlink(slot.memfsPath);
			} catch (_e) {
				// ignore
			}
			slot.memfsPath = null;
		}
	}

	_applyMountedDiskInsert(drive) {
		const slot = this.drives[drive];
		if (!this.mod || !slot.bytes) {
			return { ok: false, error: 'No WASM instance or disk bytes' };
		}

		const path = `/disks/d${drive}_${++this.diskGen}.imd`;
		this.mod.FS.writeFile(path, slot.bytes);
		const rc = this._withCString(path, (ptr) => this.mod._web_insert_disk(drive, ptr));
		if (rc === 0) {
			this._unlinkSlotFile(slot);
			slot.memfsPath = path;
			slot.pendingOp = null;
			slot.changed = false;
			slot.kind = this.mod._web_disk_kind(drive) || slot.kind;
			this.mod._web_set_wprot(drive, this.settings.wprot[drive] ? 1 : 0);
			return { ok: true, pending: false };
		}
		if (rc === 1) {
			try {
				this.mod.FS.unlink(path);
			} catch (_e) {
				// ignore
			}
			slot.pendingOp = { type: 'insert' };
			return { ok: true, pending: true };
		}

		try {
			this.mod.FS.unlink(path);
		} catch (_e) {
			// ignore
		}
		return {
			ok: false,
			error: `Invalid or corrupted .imd image for drive ${String.fromCharCode(65 + drive)}:.`,
		};
	}

	_retryPendingDiskOps() {
		if (!this.poweredOn || !this.mod) return false;
		let anyTransition = false;
		for (let d = 0; d < 4; d++) {
			const slot = this.drives[d];
			const op = slot.pendingOp;
			if (!op) continue;

			if (op.type === 'insert') {
				const res = this._applyMountedDiskInsert(d);
				if (!res.pending) {
					slot.pendingOp = null;
					anyTransition = true;
				}
			} else if (op.type === 'blank') {
				const rc = this.mod._web_insert_blank(d);
				if (rc === 0) {
					this._unlinkSlotFile(slot);
					slot.pendingOp = null;
					slot.kind = 0;
					slot.changed = false;
					this.mod._web_set_wprot(d, this.settings.wprot[d] ? 1 : 0);
					anyTransition = true;
				} else if (rc < 0) {
					slot.pendingOp = null;
				}
			} else if (op.type === 'eject') {
				const rc = this.mod._web_eject_disk(d);
				if (rc === 0) {
					this._unlinkSlotFile(slot);
					slot.pendingOp = null;
					anyTransition = true;
				} else if (rc < 0) {
					slot.pendingOp = null;
				}
			}
		}
		return anyTransition;
	}

	_drainTextChunks() {
		if (!this.poweredOn || !this.mod || this.pendingTextChunks.length === 0) return;
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
						const node = new AudioWorkletNode(this.audioCtx, 'max80-audio', {
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

		this.lastRafTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
		this.tickAccum = 0;

		const loop = (now) => {
			if (!this.poweredOn || !this.mod) return;

			const dt = Math.max(0, now - this.lastRafTime);
			this.lastRafTime = now;

			let stateChanged = false;
			let hasNewFrame = false;

			if (this.settings.fast) {
				const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
				let ticksRun = 0;
				let audioSentThisFrame = false;
				do {
					const res = this._stepSingleTick(!audioSentThisFrame);
					audioSentThisFrame = true;
					if (res.frameReady) hasNewFrame = true;
					if (res.stateChanged) stateChanged = true;
					ticksRun++;
				} while (
					ticksRun < 64 &&
					((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0) < FAST_BUDGET_MS
				);
				this.tickAccum = 0;
			} else {
				this.tickAccum += dt;
				if (this.tickAccum > FRAME_MS * MAX_CATCHUP_TICKS) {
					this.tickAccum = FRAME_MS * MAX_CATCHUP_TICKS;
				}
				let ticksRun = 0;
				while (this.tickAccum >= FRAME_MS && ticksRun < MAX_CATCHUP_TICKS) {
					const res = this._stepSingleTick(true);
					if (res.frameReady) hasNewFrame = true;
					if (res.stateChanged) stateChanged = true;
					this.tickAccum -= FRAME_MS;
					ticksRun++;
				}
			}

			if (hasNewFrame) {
				this._renderLastFrame(false);
			}
			if (stateChanged) {
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
			return { frameReady: false, stateChanged: false };
		}

		if (this.pendingTextChunks.length > 0) {
			this._drainTextChunks();
		}

		const frameReady = this.mod._web_tick() === 1;
		let stateChanged = this._retryPendingDiskOps();

		for (let d = 0; d < 4; d++) {
			const slot = this.drives[d];
			if (!slot.loaded) continue;
			const changedNow = Boolean(this.mod._web_disk_changed(d));
			const kindNow = this.mod._web_disk_kind(d) || slot.kind;
			if (changedNow !== slot.changed || kindNow !== slot.kind) {
				slot.changed = changedNow;
				slot.kind = kindNow;
				stateChanged = true;
			}
		}

		const prnLen = this.mod._web_printer_bytes() | 0;
		if (prnLen !== this.lastPrinterLen) {
			this.lastPrinterLen = prnLen;
			stateChanged = true;
		}

		if (postAudio && !this.muted && this.audioReady && this.audioNode) {
			if (this.audioCtx && this.audioCtx.state === 'suspended') {
				this.audioCtx.resume().catch(() => {});
			}
			const audioPtr = this.mod._web_audio_ptr();
			const numSamples = this.mod._web_audio_samples();
			const baseIdx = audioPtr >> 1;
			// Always read fresh this.mod.HEAP16 in case WASM memory grew during _web_tick()
			const chunk = this.mod.HEAP16.slice(baseIdx, baseIdx + numSamples);
			this.audioNode.port.postMessage(chunk, [chunk.buffer]);
		}

		if (frameReady) {
			const w = this.mod._web_frame_w();
			const h = this.mod._web_frame_h();
			const aspect = this.mod._web_frame_aspect();
			const framePtr = this.mod._web_frame_ptr();
			const byteLen = w * h;
			if (w > 0 && h > 0) {
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

		return { frameReady, stateChanged };
	}

	_syncCanvasSize() {
		if (!this.canvas) return;
		const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
		const rect = this.canvas.getBoundingClientRect();
		const targetW = Math.max(1, Math.round((rect.width || this.canvas.width || 800) * dpr));
		const targetH = Math.max(1, Math.round((rect.height || this.canvas.height || 600) * dpr));
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

	_renderLastFrame(forceUpload = false) {
		if (!this.ctx || !this.canvas) return;
		this._syncCanvasSize();
		if (!this.lastFrame) {
			this._clearCanvasBlack();
			return;
		}

		const { bytes, w, h, aspect } = this.lastFrame;
		this.canvas.parentElement?.style.setProperty('--screen-aspect', String(aspect));
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
			const rgb = PHOSPHOR_RGB[this.settings.phosphor] || PHOSPHOR_RGB.white;
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
