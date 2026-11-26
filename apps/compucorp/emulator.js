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

export const VIDEO_PROMS = new Set(['us', 'metric85', 'metric85g']);
export const MAPPER_PORTS = new Set([0, 0xf5, 0xf4, 0x77]);

const DEFAULT_SETTINGS = {
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
	phosphor: 'cyan',
};

function sanitizeRamFill(v) {
	const n = Number(v);
	if (!Number.isFinite(n) || n < 0) return -1;
	return Math.max(0, Math.min(255, Math.round(n)));
}

function cloneSettings(s) {
	const rawMapper = Number(s.mapperPort);
	const rawDrivePct = Number(s.drivePct);
	const rawPrnBusy = Number(s.prnBusyMs);
	return {
		boards: Math.max(0, Math.min(4, Number.isInteger(s.boards) ? s.boards : 2)),
		mexBoards: Math.max(0, Math.min(3, Number.isInteger(s.mexBoards) ? s.mexBoards : 0)),
		mainsHz: s.mainsHz === 50 ? 50 : 60,
		fast: Boolean(s.fast),
		romSwitch: Boolean(s.romSwitch),
		lowerPage: Boolean(s.lowerPage),
		pmReadback: Boolean(s.pmReadback),
		mapperPort: MAPPER_PORTS.has(rawMapper) ? rawMapper : 0,
		mapperCoversRom: Boolean(s.mapperCoversRom),
		pb5: Boolean(s.pb5),
		jt1: Boolean(s.jt1),
		ctc3: Boolean(s.ctc3),
		c60: Boolean(s.c60),
		videoProm: VIDEO_PROMS.has(s.videoProm) ? s.videoProm : 'us',
		xcpmKeys: Boolean(s.xcpmKeys),
		drivePct: Number.isFinite(rawDrivePct) ? Math.max(-10, Math.min(10, Math.round(rawDrivePct))) : 0,
		ramFill: sanitizeRamFill(s.ramFill),
		prnBusyMs: Number.isFinite(rawPrnBusy) ? Math.max(0, Math.min(500, Math.round(rawPrnBusy))) : 0,
		centronics: Boolean(s.centronics),
		jPort: Number(s.jPort) === 0x14 ? 0x14 : 0x10,
		jWprot: Boolean(s.jWprot),
		wprot: Array.isArray(s.wprot) ? s.wprot.slice(0, 4).map(Boolean) : [false, false, false, false],
		phosphor: PHOSPHOR_RGB[s.phosphor] ? s.phosphor : 'cyan',
	};
}

function diskExtensionFromName(name) {
	const m = String(name || '').match(/\.(cc665|hfe|scp|img)$/i);
	return m ? m[0].toLowerCase() : '.img';
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
		this.metricPromLBytes = null;
		this.metricPromHBytes = null;
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
		this.cachedCenBytes = new Uint8Array(0);
		this.lastCenLen = 0;

		this.audioCtx = null;
		this.audioNode = null;
		this.audioReady = false;
		this.audioInitPromise = null;

		this.pendingTextChunks = [];
		this.diskGen = 0;

		this.winchester = {
			loaded: false,
			blank: false,
			name: '',
			bytes: null,
			sectors: 0,
		};

		this.cartridges = []; // Array of { name, bytes, blank }

		this.drives = [0, 1, 2, 3].map((d) => ({
			drive: d,
			loaded: false,
			unformatted: false,
			name: '',
			bytes: null,
			idBytes: null,
			headerId: '',
			changed: false,
			cyls: 0,
			sides: 0,
			memfsPath: null,
			memfsIdPath: null,
		}));
	}

	async init({
		canvas,
		romUrl = './cc665_rom.bin',
		promLUrl = './cc665_prom_l.bin',
		promHUrl = './cc665_prom_h.bin',
		metricPromLUrl = './metric85_prom_l.bin',
		metricPromHUrl = './metric85_prom_h.bin',
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

		// Fetch 1024-byte U21/U22 glyph PROMs (US and optional Metric 85)
		const fetchProm = async (url, label) => {
			if (!url || typeof fetch !== 'function') return null;
			try {
				const resp = await fetch(url);
				if (resp.ok) {
					const bytes = new Uint8Array(await resp.arrayBuffer());
					if (bytes.length === 1024) return bytes;
					console.warn(`Unexpected ${label} size (${url}): expected 1024, got ${bytes.length}`);
				}
			} catch (err) {
				console.warn(`Could not fetch ${label} (${url}):`, err);
			}
			return null;
		};

		const [usL, usH, mL, mH] = await Promise.all([
			fetchProm(promLUrl, 'US PROM L'),
			fetchProm(promHUrl, 'US PROM H'),
			fetchProm(metricPromLUrl, 'Metric 85 PROM L'),
			fetchProm(metricPromHUrl, 'Metric 85 PROM H'),
		]);
		this.promLBytes = usL;
		this.promHBytes = usH;
		this.metricPromLBytes = mL;
		this.metricPromHBytes = mH;
	}

	_getPromPair(name) {
		const isMetric = name === 'metric85' || name === 'metric85g';
		const l = isMetric && this.metricPromLBytes ? this.metricPromLBytes : this.promLBytes;
		const h = isMetric && this.metricPromHBytes ? this.metricPromHBytes : this.promHBytes;
		return {
			l,
			h,
			semigfx: name === 'metric85g' ? 1 : 0,
		};
	}

	_applyVideoPromToWasm() {
		if (!this.mod) return;
		const { l, h, semigfx } = this._getPromPair(this.settings.videoProm);
		let lp = 0;
		let hp = 0;
		try {
			if (l && l.length === 1024) {
				lp = this.mod._malloc(1024);
				this.mod.HEAPU8.set(l, lp);
			}
			if (h && h.length === 1024) {
				hp = this.mod._malloc(1024);
				this.mod.HEAPU8.set(h, hp);
			}
			this.mod._web_set_video_prom_bytes(lp, lp ? 1024 : 0, hp, hp ? 1024 : 0, semigfx);
		} finally {
			if (lp) this.mod._free(lp);
			if (hp) this.mod._free(hp);
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
		this.cachedCenBytes = new Uint8Array(0);
		this.lastCenLen = 0;

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

		const prom = this._getPromPair(this.settings.videoProm);
		const romPtr = mod._malloc(2048);
		let promLPtr = 0;
		let promLLen = 0;
		let promHPtr = 0;
		let promHLen = 0;
		let initRc = -1;

		try {
			mod.HEAPU8.set(this.romBytes, romPtr);
			if (prom.l && prom.l.length === 1024) {
				promLPtr = mod._malloc(1024);
				promLLen = 1024;
				mod.HEAPU8.set(prom.l, promLPtr);
			}
			if (prom.h && prom.h.length === 1024) {
				promHPtr = mod._malloc(1024);
				promHLen = 1024;
				mod.HEAPU8.set(prom.h, promHPtr);
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

		// Apply extended hardware options (-e, -5, -u, -3, -E, -q/-Q, -X, -Z, -v, -z, -U, -n, -j, -R j, semigfx)
		mod._web_configure(
			this.settings.mexBoards,
			this.settings.pb5 ? 1 : 0,
			this.settings.jt1 ? 1 : 0,
			this.settings.ctc3 ? 1 : 0,
			this.settings.pmReadback ? 1 : 0,
			this.settings.mapperPort || -1,
			this.settings.mapperCoversRom ? 1 : 0,
			this.settings.c60 ? 1 : 0,
			this.settings.xcpmKeys ? 1 : 0,
			this.settings.drivePct | 0,
			this.settings.ramFill | 0,
			this.settings.prnBusyMs | 0,
			this.settings.centronics ? 1 : 0,
			this.settings.jPort || 0x10,
			this.settings.jWprot ? 1 : 0,
			prom.semigfx
		);

		// Re-mount all 4 floppy drives currently staged in this.drives
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

		// Re-mount Winchester HD if staged
		if (this.winchester.loaded) {
			if (this.winchester.blank && !this.winchester.bytes) {
				mod._web_hd_load_blank(this.winchester.sectors || 4896);
			} else if (this.winchester.bytes) {
				this._mountStagedWinchester();
			}
		}

		// Re-mount 691 Cartridge HD units if staged
		for (let u = 0; u < this.cartridges.length && u < 4; u++) {
			const c = this.cartridges[u];
			if (c.blank && !c.bytes) {
				mod._web_j_load_blank();
			} else if (c.bytes) {
				this._mountStagedCartridge(u);
			}
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
			this.settings.mexBoards !== ls.mexBoards ||
			this.settings.mainsHz !== ls.mainsHz ||
			this.settings.romSwitch !== ls.romSwitch ||
			this.settings.lowerPage !== ls.lowerPage ||
			this.settings.pmReadback !== ls.pmReadback ||
			this.settings.mapperPort !== ls.mapperPort ||
			this.settings.mapperCoversRom !== ls.mapperCoversRom ||
			this.settings.pb5 !== ls.pb5 ||
			this.settings.ctc3 !== ls.ctc3 ||
			this.settings.c60 !== ls.c60 ||
			this.settings.drivePct !== ls.drivePct ||
			this.settings.ramFill !== ls.ramFill ||
			this.settings.prnBusyMs !== ls.prnBusyMs ||
			this.settings.centronics !== ls.centronics ||
			this.settings.jPort !== ls.jPort
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
		if (partial.mexBoards !== undefined) {
			const m = Number(partial.mexBoards);
			if (Number.isInteger(m) && m >= 0 && m <= 3) {
				this.settings.mexBoards = m;
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
		if (partial.pmReadback !== undefined) {
			this.settings.pmReadback = Boolean(partial.pmReadback);
		}
		if (partial.mapperPort !== undefined) {
			const mp = Number(partial.mapperPort);
			if (MAPPER_PORTS.has(mp)) {
				this.settings.mapperPort = mp;
			}
		}
		if (partial.mapperCoversRom !== undefined) {
			this.settings.mapperCoversRom = Boolean(partial.mapperCoversRom);
		}
		if (partial.pb5 !== undefined) {
			this.settings.pb5 = Boolean(partial.pb5);
		}
		if (partial.jt1 !== undefined) {
			const flag = Boolean(partial.jt1);
			this.settings.jt1 = flag;
			if (this.poweredOn && this.mod) {
				this.mod._web_set_jt1(flag ? 1 : 0);
			}
		}
		if (partial.ctc3 !== undefined) {
			this.settings.ctc3 = Boolean(partial.ctc3);
		}
		if (partial.c60 !== undefined) {
			this.settings.c60 = Boolean(partial.c60);
		}
		if (partial.videoProm !== undefined && VIDEO_PROMS.has(partial.videoProm)) {
			this.settings.videoProm = partial.videoProm;
			if (this.poweredOn && this.mod) {
				this._applyVideoPromToWasm();
			}
		}
		if (partial.xcpmKeys !== undefined) {
			const flag = Boolean(partial.xcpmKeys);
			this.settings.xcpmKeys = flag;
			if (this.poweredOn && this.mod) {
				this.mod._web_set_xcpm_keys(flag ? 1 : 0);
			}
		}
		if (partial.drivePct !== undefined) {
			const v = Number(partial.drivePct);
			if (Number.isFinite(v)) {
				this.settings.drivePct = Math.max(-10, Math.min(10, Math.round(v)));
			}
		}
		if (partial.ramFill !== undefined) {
			this.settings.ramFill = sanitizeRamFill(partial.ramFill);
		}
		if (partial.prnBusyMs !== undefined) {
			const v = Number(partial.prnBusyMs);
			if (Number.isFinite(v)) {
				this.settings.prnBusyMs = Math.max(0, Math.min(500, Math.round(v)));
			}
		}
		if (partial.centronics !== undefined) {
			this.settings.centronics = Boolean(partial.centronics);
		}
		if (partial.jPort !== undefined) {
			this.settings.jPort = Number(partial.jPort) === 0x14 ? 0x14 : 0x10;
		}
		if (partial.jWprot !== undefined) {
			const flag = Boolean(partial.jWprot);
			this.settings.jWprot = flag;
			if (this.poweredOn && this.mod) {
				this.mod._web_j_set_wprot(flag ? 1 : 0);
			}
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

	setJt1(on) {
		const flag = Boolean(on);
		this.settings.jt1 = flag;
		if (this.poweredOn && this.mod) {
			this.mod._web_set_jt1(flag ? 1 : 0);
		}
		this._notifyState();
	}

	setXcpmKeys(on) {
		const flag = Boolean(on);
		this.settings.xcpmKeys = flag;
		if (this.poweredOn && this.mod) {
			this.mod._web_set_xcpm_keys(flag ? 1 : 0);
		}
		this._notifyState();
	}

	setVideoProm(name) {
		if (!VIDEO_PROMS.has(name)) return;
		this.settings.videoProm = name;
		if (this.poweredOn && this.mod) {
			this._applyVideoPromToWasm();
		}
		this._notifyState();
	}

	setJWprot(on) {
		const flag = Boolean(on);
		this.settings.jWprot = flag;
		if (this.poweredOn && this.mod) {
			this.mod._web_j_set_wprot(flag ? 1 : 0);
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
		if (!(imgBytes instanceof Uint8Array) || imgBytes.length === 0) {
			this.onError(`Invalid or empty disk image "${name || 'disk.img'}".`);
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
		slot.cyls = 0;
		slot.sides = 0;
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
		slot.cyls = 0;
		slot.sides = 0;

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
		slot.cyls = 0;
		slot.sides = 0;

		this._notifyState();
		return true;
	}

	saveDiskBytes(drive, format = 'img') {
		if (drive < 0 || drive > 3) return null;
		const slot = this.drives[drive];
		if (!slot.loaded) return null;

		const asCc665 = format === 'cc665';
		const ext = asCc665 ? '.cc665' : '.img';
		const baseRaw =
			slot.name && slot.name !== 'Unformatted disk'
				? slot.name.replace(/\.(img|cc665|hfe|scp)$/i, '')
				: `disk_${String.fromCharCode(97 + drive)}`;
		const downloadName = `${baseRaw}${ext}`;

		if (this.poweredOn && this.mod) {
			const savePath = `/save/drive${drive}${ext}`;
			const saveIdPath = `/save/drive${drive}.id`;
			try {
				this.mod.FS.unlink(savePath);
			} catch (_e) {
				// ignore
			}
			try {
				this.mod.FS.unlink(saveIdPath);
			} catch (_e) {
				// ignore
			}

			const rc = this._withCString(savePath, (ptr) => this.mod._web_save_disk(drive, ptr));
			if (rc !== 0) {
				this.onError(`Could not save disk in drive ${String.fromCharCode(65 + drive)}:.`);
				return null;
			}

			let imgBytes;
			let idBytes = new Uint8Array(3);
			try {
				imgBytes = new Uint8Array(this.mod.FS.readFile(savePath));
				if (!asCc665) {
					try {
						const rawId = this.mod.FS.readFile(saveIdPath);
						if (rawId && rawId.length === 3) {
							idBytes = new Uint8Array(rawId);
						}
					} catch (_e) {
						// keep 000000
					}
				} else if (imgBytes.length >= 16) {
					idBytes = new Uint8Array([imgBytes[12], imgBytes[13], imgBytes[14]]);
				}
			} finally {
				try {
					this.mod.FS.unlink(savePath);
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
			slot.idBytes = asCc665 ? null : new Uint8Array(idBytes);
			slot.headerId = idBytesToHex(idBytes);
			slot.changed = false;
			slot.unformatted = false;
			if (!slot.name || slot.name === 'Unformatted disk') {
				slot.name = downloadName;
			}
			this._notifyState();
			return {
				name: downloadName,
				format: asCc665 ? 'cc665' : 'img',
				imgBytes: new Uint8Array(imgBytes),
				idBytes: asCc665 ? null : new Uint8Array(idBytes),
			};
		}

		if (slot.bytes) {
			slot.changed = false;
			this._notifyState();
			return {
				name: slot.name || downloadName,
				format: diskExtensionFromName(slot.name).slice(1),
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
		let cyls = slot.cyls || 0;
		let sides = slot.sides || 0;
		let headerId = slot.headerId || (slot.idBytes ? idBytesToHex(slot.idBytes) : '');

		if (this.poweredOn && this.mod) {
			loaded = Boolean(this.mod._web_disk_loaded(drive));
			unformatted = Boolean(this.mod._web_disk_unformatted(drive));
			changed = Boolean(this.mod._web_disk_changed(drive));
			wprot = Boolean(this.mod._web_get_wprot(drive));
			busy = Boolean(this.mod._web_disk_busy(drive));
			track = this.mod._web_disk_track(drive) | 0;
			side = this.mod._web_disk_side(drive) | 0;
			cyls = this.mod._web_disk_cyls(drive) | 0;
			sides = this.mod._web_disk_sides(drive) | 0;
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
			cyls,
			sides,
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
				mexBoards: this.settings.mexBoards,
				mexE: null,
				mexC: null,
				mappedCard: -1,
				mappedBank: -1,
				mainsHz: this.settings.mainsHz,
				emuSeconds: 0,
				speedRatio: -1,
				serBusy: false,
				printerBytes: this.cachedPrinterBytes.length,
				cenEnabled: Boolean(this.settings.centronics),
				cenBytes: this.cachedCenBytes.length,
				c60Active: false,
				pb5: Boolean(this.settings.pb5),
				jt1: Boolean(this.settings.jt1),
				xcpmKeys: Boolean(this.settings.xcpmKeys),
				hdLoaded: Boolean(this.winchester.loaded),
				jUnits: this.cartridges.length,
			};
		}

		const mapped = this.mod._web_mem_mapped();
		const mappedCard = mapped >= 0 ? (mapped >> 8) & 0xff : -1;
		const mappedBank = mapped >= 0 ? mapped & 0xff : -1;
		const mexBoards = this.mod._web_mex_boards() | 0;
		const decodeMex = (v) => (v >= 0 ? { card: (v >> 8) & 0xff, bank: v & 0x1f } : null);
		const mexE = mexBoards > 0 ? decodeMex(this.mod._web_mex_window(7)) : null;
		const mexC = mexBoards > 0 ? decodeMex(this.mod._web_mex_window(6)) : null;

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
		const cenEnabled = Boolean(this.mod._web_cen_enabled());
		const cenBytes = cenEnabled ? this.mod._web_cen_bytes() | 0 : 0;

		return {
			poweredOn: true,
			fast: Boolean(this.mod._web_get_fast()),
			boards: this.mod._web_mem_boards() | 0,
			mexBoards,
			mexE,
			mexC,
			mappedCard,
			mappedBank,
			mainsHz: this.mod._web_mains_hz() | 0,
			emuSeconds,
			speedRatio: this.speedRatio,
			serBusy: Boolean(this.mod._web_ser_busy()),
			printerBytes,
			cenEnabled,
			cenBytes,
			c60Active: Boolean(this.mod._web_c60_active()),
			pb5: Boolean(this.settings.pb5),
			jt1: Boolean(this.mod._web_get_jt1()),
			xcpmKeys: Boolean(this.mod._web_get_xcpm_keys()),
			hdLoaded: Boolean(this.mod._web_hd_loaded()),
			jUnits: this.mod._web_j_units() | 0,
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

	// ---- Centronics Parallel Printer Card (-n) ----

	getCentronicsBytes() {
		if (this.poweredOn && this.mod && this.mod._web_cen_enabled()) {
			this.mod._web_cen_bytes();
			try {
				const raw = this.mod.FS.readFile('/centronics.bin');
				this.cachedCenBytes = new Uint8Array(raw);
			} catch (_e) {
				this.cachedCenBytes = new Uint8Array(0);
			}
		}
		return new Uint8Array(this.cachedCenBytes);
	}

	getCentronicsText() {
		const bytes = this.getCentronicsBytes();
		let out = '';
		for (let i = 0; i < bytes.length; i++) {
			const c = bytes[i] & 0x7f;
			if (c === 0x0d) continue;
			if (c === 0x0a || c === 0x09 || (c >= 0x20 && c < 0x7f)) {
				out += String.fromCharCode(c);
			} else if (c === 0x0c) {
				out += '\n--- PAGE BREAK ---\n';
			}
		}
		return out;
	}

	clearCentronics() {
		if (this.poweredOn && this.mod) {
			this.mod._web_cen_clear();
		}
		this.cachedCenBytes = new Uint8Array(0);
		this.lastCenLen = 0;
		this._notifyState();
	}

	// ---- Winchester Hard Disk (-W) ----

	getWinchesterState() {
		const size =
			this.poweredOn && this.mod && this.mod._web_hd_loaded()
				? this.mod._web_hd_size() | 0
				: this.winchester.bytes
					? this.winchester.bytes.length
					: (this.winchester.sectors || 0) * 1024;
		return {
			loaded: Boolean(this.winchester.loaded),
			blank: Boolean(this.winchester.blank),
			name: this.winchester.name || '',
			size,
		};
	}

	insertWinchesterBytes(name, uint8Array) {
		if (!(uint8Array instanceof Uint8Array) || uint8Array.length === 0) {
			return { ok: false, error: 'Empty or invalid Winchester hard disk image.' };
		}
		const copy = new Uint8Array(uint8Array);
		this.winchester = {
			loaded: true,
			blank: false,
			name: name || 'winchester.img',
			bytes: copy,
			sectors: Math.ceil(copy.length / 1024),
		};
		if (this.poweredOn && this.mod) {
			if (!this._mountStagedWinchester()) {
				this.winchester = { loaded: false, blank: false, name: '', bytes: null, sectors: 0 };
				this._notifyState();
				return { ok: false, error: `Failed to mount Winchester image "${name}".` };
			}
		}
		this._notifyState();
		return { ok: true, size: copy.length };
	}

	insertBlankWinchester(sectors = 4896) {
		const n = Math.max(1, Math.min(65536, sectors | 0));
		this.winchester = {
			loaded: true,
			blank: true,
			name: `Blank ${(n * 1024 / (1024 * 1024)).toFixed(1)} MB Winchester`,
			bytes: null,
			sectors: n,
		};
		if (this.poweredOn && this.mod) {
			const rc = this.mod._web_hd_load_blank(n);
			if (rc !== 0) {
				this.winchester = { loaded: false, blank: false, name: '', bytes: null, sectors: 0 };
				this._notifyState();
				return { ok: false, error: 'Failed to create blank Winchester image.' };
			}
		}
		this._notifyState();
		return { ok: true, size: n * 1024 };
	}

	saveWinchesterBytes() {
		if (!this.winchester.loaded) return null;
		const downloadName =
			this.winchester.name && !this.winchester.blank
				? this.winchester.name
				: 'cc665-winchester.img';
		if (this.poweredOn && this.mod && this.mod._web_hd_loaded()) {
			const tmpPath = '/save/winchester.img';
			const rc = this._withCString(tmpPath, (ptr) => this.mod._web_hd_save(ptr));
			if (rc !== 0) return null;
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
			this.winchester.bytes = saved;
			this.winchester.blank = false;
			this.winchester.sectors = Math.ceil(saved.length / 1024);
			this._notifyState();
			return { name: downloadName, bytes: new Uint8Array(saved) };
		}
		if (this.winchester.bytes) {
			return { name: downloadName, bytes: new Uint8Array(this.winchester.bytes) };
		}
		if (this.winchester.blank && this.winchester.sectors > 0) {
			return { name: downloadName, bytes: new Uint8Array(this.winchester.sectors * 1024) };
		}
		return null;
	}

	ejectWinchester() {
		if (this.poweredOn && this.mod) {
			this.mod._web_hd_eject();
		}
		this.winchester = { loaded: false, blank: false, name: '', bytes: null, sectors: 0 };
		this._notifyState();
		return { ok: true };
	}

	_mountStagedWinchester() {
		if (!this.mod || !this.winchester.bytes) return false;
		const path = `/disks/hd_${++this.diskGen}.img`;
		this.mod.FS.writeFile(path, this.winchester.bytes);
		const rc = this._withCString(path, (ptr) => this.mod._web_hd_load(ptr));
		try {
			this.mod.FS.unlink(path);
		} catch (_e) {
			// ignore
		}
		return rc === 0;
	}

	// ---- 691 Cartridge Hard Disk (-J) ----

	getCartridgeState() {
		return this.cartridges.map((c, idx) => ({
			unit: idx,
			name: c.name,
			blank: Boolean(c.blank),
		}));
	}

	insertCartridgeBytes(name, uint8Array) {
		if (this.cartridges.length >= 4) {
			return { ok: false, error: 'Maximum of 4 691 cartridge units already attached.' };
		}
		if (!(uint8Array instanceof Uint8Array) || uint8Array.length === 0) {
			return { ok: false, error: 'Empty or invalid 691 cartridge image.' };
		}
		const idx = this.cartridges.length;
		const entry = {
			name: name || `cart691_${idx}.img`,
			bytes: new Uint8Array(uint8Array),
			blank: false,
		};
		this.cartridges.push(entry);
		if (this.poweredOn && this.mod) {
			if (!this._mountStagedCartridge(idx)) {
				this.cartridges.pop();
				this._notifyState();
				return { ok: false, error: `Failed to mount 691 cartridge "${name}".` };
			}
		}
		this._notifyState();
		return { ok: true, unit: idx };
	}

	insertBlankCartridge() {
		if (this.cartridges.length >= 4) {
			return { ok: false, error: 'Maximum of 4 691 cartridge units already attached.' };
		}
		const idx = this.cartridges.length;
		this.cartridges.push({
			name: `Blank 691 Unit ${idx}`,
			bytes: null,
			blank: true,
		});
		if (this.poweredOn && this.mod) {
			const rc = this.mod._web_j_load_blank();
			if (rc !== 0) {
				this.cartridges.pop();
				this._notifyState();
				return { ok: false, error: 'Failed to allocate blank 691 cartridge.' };
			}
		}
		this._notifyState();
		return { ok: true, unit: idx };
	}

	saveCartridgeBytes(unit = 0) {
		if (unit < 0 || unit >= this.cartridges.length) return null;
		const entry = this.cartridges[unit];
		const downloadName = entry.blank ? `cc665-691-u${unit}.img` : entry.name;
		if (this.poweredOn && this.mod && unit < this.mod._web_j_units()) {
			const tmpPath = `/save/j_${unit}.img`;
			const rc = this._withCString(tmpPath, (ptr) => this.mod._web_j_save(unit, ptr));
			if (rc !== 0) return null;
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
			entry.bytes = saved;
			entry.blank = false;
			this._notifyState();
			return { name: downloadName, bytes: new Uint8Array(saved) };
		}
		if (entry.bytes) {
			return { name: downloadName, bytes: new Uint8Array(entry.bytes) };
		}
		return null;
	}

	ejectAllCartridges() {
		if (this.poweredOn && this.mod) {
			this.mod._web_j_eject_all();
		}
		this.cartridges = [];
		this._notifyState();
		return { ok: true };
	}

	_mountStagedCartridge(unit) {
		const entry = this.cartridges[unit];
		if (!this.mod || !entry || !entry.bytes) return false;
		const path = `/disks/j${unit}_${++this.diskGen}.img`;
		this.mod.FS.writeFile(path, entry.bytes);
		const rc = this._withCString(path, (ptr) => this.mod._web_j_load(ptr));
		try {
			this.mod.FS.unlink(path);
		} catch (_e) {
			// ignore
		}
		return rc === 0;
	}

	// ---- Live Memory Dump & Screenshot ----

	dumpMemoryBytes() {
		if (!this.poweredOn || !this.mod) return null;
		const base = '/save/cc665_mem.bin';
		const rc = this._withCString(base, (ptr) => this.mod._web_mem_dump(ptr));
		if (rc !== 0) return null;
		let ramBytes = null;
		try {
			ramBytes = new Uint8Array(this.mod.FS.readFile(base));
		} finally {
			for (const p of [base, `${base}.vram`, `${base}.c60`]) {
				try {
					this.mod.FS.unlink(p);
				} catch (_e) {
					// ignore
				}
			}
		}
		return ramBytes;
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
		const ext = diskExtensionFromName(slot.name);
		const imgPath = `/disks/d${drive}_${gen}${ext}`;
		const idPath = `/disks/d${drive}_${gen}.id`;

		this.mod.FS.writeFile(imgPath, slot.bytes);
		if (ext === '.img' && slot.idBytes && slot.idBytes.length === 3) {
			this.mod.FS.writeFile(idPath, slot.idBytes);
		}

		const rc = this._withCString(imgPath, (ptr) => this.mod._web_insert_disk(drive, ptr));
		if (rc === 0) {
			this._unlinkSlotFiles(slot);
			slot.memfsPath = imgPath;
			slot.memfsIdPath = ext === '.img' && slot.idBytes && slot.idBytes.length === 3 ? idPath : null;
			slot.changed = Boolean(this.mod._web_disk_changed(drive));
			slot.cyls = this.mod._web_disk_cyls(drive) | 0;
			slot.sides = this.mod._web_disk_sides(drive) | 0;
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
		if (this.mod._web_cen_enabled()) {
			const cenLen = this.mod._web_cen_bytes() | 0;
			if (cenLen !== this.lastCenLen) {
				this.lastCenLen = cenLen;
				discreteChanged = true;
			}
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
