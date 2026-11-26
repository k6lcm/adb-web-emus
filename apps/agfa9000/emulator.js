/*
 * Browser runtime controller for the Agfa 9000PS WebAssembly emulator.
 * Manages Emscripten lifecycle (clean restart via fresh createAgfa9000()
 * instances), streaming disk.img.gz download + DecompressionStream gunzip,
 * IndexedDB copy-on-write SCSI sector overlay, 640x480 VERA Canvas rendering,
 * 48 kHz stereo Web Audio worklet streaming, and Z8530 SCC serial I/O.
 */

import createAgfa9000 from './agfa9000.js';
import {
	loadCowOverlay,
	saveCowBatch,
	clearCowOverlay,
	loadEepromBytes,
	saveEepromBytes,
	clearEepromBytes,
} from './storage.js';

export const BOOT_TARGETS = {
	minix: { id: 'minix', label: 'Minix 2.0.4', addr: 0x40000 },
	cpm: { id: 'cpm', label: 'CP/M-68K v1.6', addr: 0x20000 },
	mon: { id: 'mon', label: 'AGFA-MON + EhBASIC', addr: 0x00000 },
};

export const DEFAULT_SETTINGS = {
	bootTarget: 'minix',
	ramMb: 4,
	veraEnabled: true,
	fast: false,
	layout: 'split', // 'split' | 'vera' | 'terminal'
};

const CPU_HZ = 16000000;
const AUDIO_RATE = 48000;
const EXPECTED_GZ_BYTES = 48493845;

async function gunzipBytes(gzBytes, onProgress = null) {
	if (typeof DecompressionStream === 'undefined') {
		throw new Error('This browser does not support DecompressionStream("gzip").');
	}
	const ds = new DecompressionStream('gzip');
	const writer = ds.writable.getWriter();
	const writePromise = (async () => {
		const chunkSize = 1024 * 1024;
		for (let off = 0; off < gzBytes.length; off += chunkSize) {
			await writer.write(gzBytes.subarray(off, Math.min(off + chunkSize, gzBytes.length)));
		}
		await writer.close();
	})();

	const reader = ds.readable.getReader();
	const chunks = [];
	let totalLen = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		totalLen += value.byteLength;
		if (onProgress) onProgress(totalLen);
	}
	await writePromise;

	const out = new Uint8Array(totalLen);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.byteLength;
	}
	return out;
}

export class Agfa9000Emulator {
	constructor(initialSettings = {}) {
		this.settings = { ...DEFAULT_SETTINGS, ...initialSettings };

		this.canvas = null;
		this.ctx = null;
		this.offscreen = null;
		this.offCtx = null;
		this.imageData = null;

		this.romBytes = null;
		this.romName = 'Built-in 12-EPROM set (AGFA-MON + CP/M + Minix)';
		this.customRom = false;

		this.baseDiskBytes = null;
		this.diskName = 'disk.img.gz (171 MiB SCSI)';
		this.customDisk = false;
		this.blockSize = 512;

		this.cowMap = new Map();
		this.pendingCowWrites = new Map();
		this.cowFlushTimer = null;

		this.mod = null;
		this.poweredOn = false;
		this.loading = false;
		this.muted = false;

		this.rafId = null;
		this.lastRafTime = 0;
		this.cycleCarry = 0;

		this.audioCtx = null;
		this.audioNode = null;
		this.audioReady = false;
		this.audioInitPromise = null;

		this.pasteQueue = [];
		this.lastScsiReads = 0;
		this.lastScsiWrites = 0;
		this.lastEepromSnapshot = null;
		this.eepromSyncCounter = 0;

		this.onSerialTx = () => {};
		this.onStateChange = () => {};
		this.onLoadingProgress = () => {};
		this.onScsiActivity = () => {};
		this.onError = () => {};
	}

	init({
		canvas,
		onSerialTx = () => {},
		onStateChange = () => {},
		onLoadingProgress = () => {},
		onScsiActivity = () => {},
		onError = () => {},
	} = {}) {
		this.canvas = canvas || null;
		this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
		this.onSerialTx = onSerialTx;
		this.onStateChange = onStateChange;
		this.onLoadingProgress = onLoadingProgress;
		this.onScsiActivity = onScsiActivity;
		this.onError = onError;

		if (this.canvas) {
			this.offscreen = document.createElement('canvas');
			this.offscreen.width = 640;
			this.offscreen.height = 480;
			this.offCtx = this.offscreen.getContext('2d');
			this.imageData = this.offCtx.createImageData(640, 480);
			this._drawStandbyScreen('AGFA 9000PS', 'Powered Off');
		}
	}

	getSettings() {
		return { ...this.settings };
	}

	updateSettings(patch) {
		this.settings = { ...this.settings, ...patch };
		this._emitState();
	}

	setFast(enabled) {
		this.settings.fast = Boolean(enabled);
		this._emitState();
	}

	setMuted(muted) {
		this.muted = Boolean(muted);
		if (this.muted && this.audioNode) {
			this.audioNode.port.postMessage({ type: 'clear' });
		} else if (!this.muted && this.poweredOn) {
			this.ensureAudio();
		}
		this._emitState();
	}

	async ensureAudio() {
		if (this.muted) return;
		if (this.audioReady) {
			if (this.audioCtx && this.audioCtx.state === 'suspended') {
				this.audioCtx.resume().catch(() => {});
			}
			return;
		}
		if (this.audioInitPromise) return this.audioInitPromise;
		if (typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') {
			return;
		}
		this.audioInitPromise = (async () => {
			try {
				const Ctx = window.AudioContext || window.webkitAudioContext;
				const ctx = new Ctx({ sampleRate: AUDIO_RATE });
				await ctx.audioWorklet.addModule('./audio-worklet.js');
				const node = new AudioWorkletNode(ctx, 'agfa9000-audio', {
					numberOfInputs: 0,
					numberOfOutputs: 1,
					outputChannelCount: [2],
				});
				node.connect(ctx.destination);
				this.audioCtx = ctx;
				this.audioNode = node;
				this.audioReady = true;
				if (ctx.state === 'suspended') {
					await ctx.resume().catch(() => {});
				}
			} catch {
				// Audio may fail before user gesture; will retry on next interaction
			} finally {
				this.audioInitPromise = null;
			}
		})();
		return this.audioInitPromise;
	}

	async _ensureAssetsLoaded() {
		if (!this.romBytes) {
			this.onLoadingProgress({
				phase: 'rom',
				label: 'Loading 384 KiB EPROM bank image…',
				percent: 2,
			});
			const resp = await fetch('./agfa9000.rom');
			if (!resp.ok) throw new Error(`Failed to fetch agfa9000.rom (HTTP ${resp.status})`);
			this.romBytes = new Uint8Array(await resp.arrayBuffer());
		}

		if (!this.baseDiskBytes) {
			this.onLoadingProgress({
				phase: 'download',
				label: 'Downloading SCSI disk image (46.2 MiB)…',
				percent: 5,
			});
			const resp = await fetch('./disk.img.gz');
			if (!resp.ok) throw new Error(`Failed to fetch disk.img.gz (HTTP ${resp.status})`);

			const contentLength = Number(resp.headers.get('content-length')) || EXPECTED_GZ_BYTES;
			let gzBytes;
			if (resp.body && typeof resp.body.getReader === 'function') {
				const reader = resp.body.getReader();
				const chunks = [];
				let received = 0;
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					chunks.push(value);
					received += value.byteLength;
					const pct = Math.min(82, 5 + Math.round((received / contentLength) * 77));
					const mb = (received / 1048576).toFixed(1);
					const totalMb = (contentLength / 1048576).toFixed(1);
					this.onLoadingProgress({
						phase: 'download',
						label: `Downloading SCSI disk image… ${mb} / ${totalMb} MiB`,
						percent: pct,
					});
				}
				gzBytes = new Uint8Array(received);
				let off = 0;
				for (const c of chunks) {
					gzBytes.set(c, off);
					off += c.byteLength;
				}
			} else {
				gzBytes = new Uint8Array(await resp.arrayBuffer());
			}

			this.onLoadingProgress({
				phase: 'decompress',
				label: 'Decompressing SCSI disk image (171 MiB)…',
				percent: 86,
			});
			this.baseDiskBytes = await gunzipBytes(gzBytes, (bytesOut) => {
				const pct = Math.min(96, 86 + Math.round((bytesOut / 179487744) * 10));
				this.onLoadingProgress({
					phase: 'decompress',
					label: `Decompressing SCSI disk… ${(bytesOut / 1048576).toFixed(0)} / 171 MiB`,
					percent: pct,
				});
			});

			this.onLoadingProgress({
				phase: 'storage',
				label: 'Restoring saved disk changes…',
				percent: 98,
			});
			this.cowMap = await loadCowOverlay();
		}
	}

	async powerOn() {
		if (this.loading) return;
		this.powerOff();
		this.loading = true;
		this._emitState();

		try {
			await this._ensureAssetsLoaded();

			this.onLoadingProgress({
				phase: 'boot',
				label: 'Starting Motorola 68020 & VERA…',
				percent: 99,
			});

			const mod = await createAgfa9000({
				print: () => {},
				printErr: () => {},
			});

			const bootDef = BOOT_TARGETS[this.settings.bootTarget] || BOOT_TARGETS.minix;
			const romPtr = mod._malloc(this.romBytes.length);
			mod.HEAPU8.set(this.romBytes, romPtr);
			const rc = mod._web_init(
				romPtr,
				this.romBytes.length,
				this.settings.ramMb,
				bootDef.addr,
				this.settings.veraEnabled ? 1 : 0,
				AUDIO_RATE
			);
			mod._free(romPtr);
			if (rc !== 0) {
				throw new Error(`Emulator initialization failed (code ${rc})`);
			}

			// Restore persisted 512-byte EEPROM if present
			const savedEeprom = loadEepromBytes();
			if (savedEeprom) {
				const epPtr = mod._malloc(512);
				mod.HEAPU8.set(savedEeprom, epPtr);
				mod._web_load_eeprom(epPtr, 512);
				mod._free(epPtr);
				this.lastEepromSnapshot = savedEeprom.slice();
			} else {
				this.lastEepromSnapshot = new Uint8Array(512).fill(0xff);
			}

			// Wire zero-copy JS COW SCSI callbacks
			const baseDisk = this.baseDiskBytes;
			const cowMap = this.cowMap;
			const isCustom = this.customDisk;
			const blockSize = this.blockSize;
			const totalBlocks = Math.floor(baseDisk.length / blockSize);

			mod.onScsiRead = (lba, count, bs, bufPtr) => {
				for (let i = 0; i < count; i++) {
					const sec = lba + i;
					const dst = bufPtr + i * bs;
					const dirty = cowMap.get(sec);
					if (dirty) {
						mod.HEAPU8.set(dirty, dst);
					} else {
						const off = sec * bs;
						if (off + bs <= baseDisk.length) {
							mod.HEAPU8.set(baseDisk.subarray(off, off + bs), dst);
						} else {
							mod.HEAPU8.fill(0, dst, dst + bs);
						}
					}
				}
				return 0;
			};

			mod.onScsiWrite = (lba, count, bs, bufPtr) => {
				for (let i = 0; i < count; i++) {
					const sec = lba + i;
					const src = bufPtr + i * bs;
					const copy = mod.HEAPU8.slice(src, src + bs);
					cowMap.set(sec, copy);
					if (!isCustom) {
						this.pendingCowWrites.set(sec, copy);
					}
				}
				if (!isCustom) {
					this._scheduleCowFlush();
				}
				return 0;
			};

			mod._web_attach_scsi_disk(0, totalBlocks, blockSize);

			this.mod = mod;
			this.poweredOn = true;
			this.loading = false;
			this.lastRafTime = performance.now();
			this.cycleCarry = 0;
			this.lastScsiReads = 0;
			this.lastScsiWrites = 0;
			this.pasteQueue = [];

			if (!this.settings.veraEnabled) {
				this._drawStandbyScreen('VERA Disabled', 'VIA #2 active · Serial console only');
			} else {
				this._drawStandbyScreen('AGFA 9000PS', 'Initializing VERA video…');
			}

			this.onLoadingProgress({ phase: 'done', label: '', percent: 100 });
			this._emitState();
			this._startLoop();
		} catch (err) {
			this.loading = false;
			this.poweredOn = false;
			this.mod = null;
			this.onLoadingProgress({ phase: 'error', label: err.message || String(err), percent: 0 });
			this.onError(err.message || String(err));
			this._emitState();
		}
	}

	powerOff() {
		if (this.rafId !== null) {
			cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
		this.flushStorage();
		this.poweredOn = false;
		this.mod = null;
		this.pasteQueue = [];
		if (this.audioNode) {
			this.audioNode.port.postMessage({ type: 'clear' });
		}
		this._drawStandbyScreen('AGFA 9000PS', 'Powered Off');
		this.onScsiActivity({ read: false, write: false });
		this._emitState();
	}

	async restart() {
		await this.powerOn();
	}

	sendSerialBytes(bytes) {
		if (!this.poweredOn || !this.mod || !bytes || bytes.length === 0) return;
		const ptr = this.mod._malloc(bytes.length);
		this.mod.HEAPU8.set(bytes, ptr);
		this.mod._web_serial_rx_push(ptr, bytes.length);
		this.mod._free(ptr);
	}

	sendSerialText(text) {
		if (!text) return;
		const bytes = new Uint8Array(text.length);
		for (let i = 0; i < text.length; i++) {
			bytes[i] = text.charCodeAt(i) & 0xff;
		}
		this.sendSerialBytes(bytes);
	}

	pasteText(text) {
		if (!text || !this.poweredOn) return;
		// Convert LF -> CR for serial terminal compatibility
		const normalized = text.replace(/\r\n/g, '\r').replace(/\n/g, '\r');
		for (let i = 0; i < normalized.length; i++) {
			this.pasteQueue.push(normalized.charCodeAt(i) & 0xff);
		}
	}

	async resetDiskToPristine() {
		this.cowMap.clear();
		this.pendingCowWrites.clear();
		if (this.cowFlushTimer) {
			clearTimeout(this.cowFlushTimer);
			this.cowFlushTimer = null;
		}
		if (!this.customDisk) {
			await clearCowOverlay();
		}
		this._emitState();
		if (this.poweredOn) {
			await this.restart();
		}
	}

	async loadCustomDisk(file) {
		const raw = new Uint8Array(await file.arrayBuffer());
		let diskBytes = raw;
		if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
			diskBytes = await gunzipBytes(raw);
		}
		if (diskBytes.length < 512) {
			throw new Error('Disk image is too small (minimum 512 bytes).');
		}
		this.baseDiskBytes = diskBytes;
		this.diskName = `${file.name} (${(diskBytes.length / 1048576).toFixed(1)} MiB)`;
		this.customDisk = true;
		this.cowMap = new Map();
		this.pendingCowWrites.clear();
		this._emitState();
		if (this.poweredOn) {
			await this.restart();
		}
	}

	async loadCustomRom(file) {
		const raw = new Uint8Array(await file.arrayBuffer());
		if (raw.length === 0 || raw.length > 640 * 1024) {
			throw new Error('ROM image must be between 1 byte and 640 KiB.');
		}
		this.romBytes = raw;
		this.romName = `${file.name} (${Math.round(raw.length / 1024)} KiB)`;
		this.customRom = true;
		this._emitState();
		if (this.poweredOn) {
			await this.restart();
		}
	}

	resetEeprom() {
		clearEepromBytes();
		this.lastEepromSnapshot = new Uint8Array(512).fill(0xff);
		if (this.poweredOn && this.mod) {
			const ptr = this.mod._malloc(512);
			this.mod.HEAPU8.fill(0xff, ptr, ptr + 512);
			this.mod._web_load_eeprom(ptr, 512);
			this.mod._free(ptr);
		}
	}

	flushStorage() {
		if (this.cowFlushTimer) {
			clearTimeout(this.cowFlushTimer);
			this.cowFlushTimer = null;
		}
		if (!this.customDisk && this.pendingCowWrites.size > 0) {
			const batch = Array.from(this.pendingCowWrites.entries());
			this.pendingCowWrites.clear();
			saveCowBatch(batch);
		}
		this._syncEepromIfChanged();
	}

	_scheduleCowFlush() {
		if (this.cowFlushTimer !== null) return;
		this.cowFlushTimer = setTimeout(() => {
			this.cowFlushTimer = null;
			if (!this.customDisk && this.pendingCowWrites.size > 0) {
				const batch = Array.from(this.pendingCowWrites.entries());
				this.pendingCowWrites.clear();
				saveCowBatch(batch);
				this._emitState();
			}
		}, 450);
	}

	_syncEepromIfChanged() {
		if (!this.mod || !this.lastEepromSnapshot) return;
		const ptr = this.mod._web_eeprom_ptr();
		const cur = this.mod.HEAPU8.subarray(ptr, ptr + 512);
		let changed = false;
		for (let i = 0; i < 512; i++) {
			if (cur[i] !== this.lastEepromSnapshot[i]) {
				changed = true;
				break;
			}
		}
		if (changed) {
			const copy = cur.slice();
			this.lastEepromSnapshot = copy;
			saveEepromBytes(copy);
		}
	}

	_startLoop() {
		const step = (now) => {
			if (!this.poweredOn || !this.mod) return;
			this.rafId = requestAnimationFrame(step);

			const rawDt = (now - this.lastRafTime) / 1000;
			this.lastRafTime = now;
			const dt = Math.min(Math.max(rawDt, 0.001), 0.05);

			// Drain paced paste queue gently (up to 16 bytes per frame)
			if (this.pasteQueue.length > 0) {
				const count = Math.min(16, this.pasteQueue.length);
				const chunk = new Uint8Array(this.pasteQueue.splice(0, count));
				this.sendSerialBytes(chunk);
			}

			const mult = this.settings.fast ? 3 : 1;
			const targetCycles = dt * CPU_HZ * mult + this.cycleCarry;
			const maxBudget = this.settings.fast ? 1100000 : 420000;
			const budget = Math.min(Math.floor(targetCycles), maxBudget);
			this.cycleCarry = Math.max(0, targetCycles - budget);

			if (budget < 1000) return;

			const flags = this.mod._web_tick(budget);

			// Serial TX -> xterm.js
			if (flags & 2) {
				const txLen = this.mod._web_serial_tx_len();
				if (txLen > 0) {
					const txPtr = this.mod._web_serial_tx_ptr();
					const txBytes = this.mod.HEAPU8.slice(txPtr, txPtr + txLen);
					this.mod._web_serial_tx_clear();
					this.onSerialTx(txBytes);
				}
			}

			// VERA Frame -> Canvas
			if ((flags & 1) && this.ctx && this.imageData) {
				const fbPtr = this.mod._web_frame_ptr();
				const fbBytes = this.mod.HEAPU8.subarray(fbPtr, fbPtr + 640 * 480 * 4);
				this.imageData.data.set(fbBytes);
				this.offCtx.putImageData(this.imageData, 0, 0);
				this.ctx.imageSmoothingEnabled = false;
				this.ctx.drawImage(this.offscreen, 0, 0, this.canvas.width, this.canvas.height);
			}

			// VERA Audio -> AudioWorklet
			if (!this.muted && this.audioReady && this.audioNode) {
				const frames = this.mod._web_audio_samples();
				if (frames > 0) {
					const ptr = this.mod._web_audio_ptr();
					const start = ptr >> 1;
					const copy = this.mod.HEAP16.slice(start, start + frames * 2);
					this.audioNode.port.postMessage({ samples: copy }, [copy.buffer]);
				}
			}

			// SCSI activity LED update
			const r = this.mod._web_scsi_read_count();
			const w = this.mod._web_scsi_write_count();
			if (r !== this.lastScsiReads || w !== this.lastScsiWrites) {
				this.onScsiActivity({ read: r !== this.lastScsiReads, write: w !== this.lastScsiWrites });
				this.lastScsiReads = r;
				this.lastScsiWrites = w;
			} else {
				this.onScsiActivity({ read: false, write: false });
			}

			// Periodic EEPROM persistence check (~every 2 seconds)
			if (++this.eepromSyncCounter >= 120) {
				this.eepromSyncCounter = 0;
				this._syncEepromIfChanged();
			}
		};
		this.rafId = requestAnimationFrame(step);
	}

	_drawStandbyScreen(title, subtitle) {
		if (!this.ctx || !this.canvas) return;
		const w = this.canvas.width;
		const h = this.canvas.height;
		this.ctx.fillStyle = '#07090d';
		this.ctx.fillRect(0, 0, w, h);

		// Subtle scanline grid texture
		this.ctx.fillStyle = 'rgba(255,255,255,0.018)';
		for (let y = 0; y < h; y += 4) {
			this.ctx.fillRect(0, y, w, 1);
		}

		this.ctx.textAlign = 'center';
		this.ctx.textBaseline = 'middle';
		this.ctx.fillStyle = '#e8ecf2';
		this.ctx.font = '700 32px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
		this.ctx.fillText(title, w / 2, h / 2 - 18);

		this.ctx.fillStyle = '#7e8ca3';
		this.ctx.font = '500 15px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
		this.ctx.fillText(subtitle, w / 2, h / 2 + 20);
	}

	_emitState() {
		this.onStateChange({
			poweredOn: this.poweredOn,
			loading: this.loading,
			muted: this.muted,
			settings: this.getSettings(),
			romName: this.romName,
			diskName: this.diskName,
			customDisk: this.customDisk,
			dirtySectors: this.cowMap.size,
		});
	}
}
