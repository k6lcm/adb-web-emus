/*
 * IndexedDB copy-on-write (COW) sector persistence and localStorage EEPROM /
 * settings storage for the Agfa 9000PS web emulator.
 */

const DB_NAME = 'agfa9000-storage-v1';
const DB_VERSION = 1;
const STORE_COW = 'cow-sectors';
const EEPROM_KEY = 'agfa9000:eeprom:v1';
const SETTINGS_KEY = 'agfa9000:settings:v1';

let dbPromise = null;

function openDb() {
	if (typeof indexedDB === 'undefined') {
		return Promise.resolve(null);
	}
	if (!dbPromise) {
		dbPromise = new Promise((resolve) => {
			try {
				const req = indexedDB.open(DB_NAME, DB_VERSION);
				req.onupgradeneeded = () => {
					const db = req.result;
					if (!db.objectStoreNames.contains(STORE_COW)) {
						db.createObjectStore(STORE_COW);
					}
				};
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => resolve(null);
			} catch {
				resolve(null);
			}
		});
	}
	return dbPromise;
}

export async function loadCowOverlay() {
	const map = new Map();
	const db = await openDb();
	if (!db) return map;
	return new Promise((resolve) => {
		try {
			const tx = db.transaction(STORE_COW, 'readonly');
			const store = tx.objectStore(STORE_COW);
			const req = store.openCursor();
			req.onsuccess = (ev) => {
				const cursor = ev.target.result;
				if (cursor) {
					const key = Number(cursor.key);
					const val = cursor.value;
					if (val instanceof Uint8Array) {
						map.set(key, val);
					} else if (val && val.buffer) {
						map.set(key, new Uint8Array(val.buffer));
					}
					cursor.continue();
				} else {
					resolve(map);
				}
			};
			req.onerror = () => resolve(map);
		} catch {
			resolve(map);
		}
	});
}

export async function saveCowBatch(entries) {
	if (!entries || entries.length === 0) return;
	const db = await openDb();
	if (!db) return;
	return new Promise((resolve) => {
		try {
			const tx = db.transaction(STORE_COW, 'readwrite');
			const store = tx.objectStore(STORE_COW);
			for (const [lba, bytes] of entries) {
				store.put(bytes, lba);
			}
			tx.oncomplete = () => resolve();
			tx.onerror = () => resolve();
		} catch {
			resolve();
		}
	});
}

export async function clearCowOverlay() {
	const db = await openDb();
	if (!db) return;
	return new Promise((resolve) => {
		try {
			const tx = db.transaction(STORE_COW, 'readwrite');
			tx.objectStore(STORE_COW).clear();
			tx.oncomplete = () => resolve();
			tx.onerror = () => resolve();
		} catch {
			resolve();
		}
	});
}

export function loadEepromBytes() {
	try {
		const raw = localStorage.getItem(EEPROM_KEY);
		if (!raw) return null;
		const bin = atob(raw);
		if (bin.length !== 512) return null;
		const out = new Uint8Array(512);
		for (let i = 0; i < 512; i++) out[i] = bin.charCodeAt(i);
		return out;
	} catch {
		return null;
	}
}

export function saveEepromBytes(bytes) {
	if (!bytes || bytes.length !== 512) return;
	try {
		let s = '';
		for (let i = 0; i < 512; i++) s += String.fromCharCode(bytes[i]);
		localStorage.setItem(EEPROM_KEY, btoa(s));
	} catch {
		// Ignore quota/storage errors
	}
}

export function clearEepromBytes() {
	try {
		localStorage.removeItem(EEPROM_KEY);
	} catch {
		// Ignore
	}
}

export function loadSavedSettings(defaults) {
	try {
		const raw = localStorage.getItem(SETTINGS_KEY);
		if (!raw) return { ...defaults };
		const parsed = JSON.parse(raw);
		return { ...defaults, ...parsed };
	} catch {
		return { ...defaults };
	}
}

export function saveSettings(settings) {
	try {
		localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
	} catch {
		// Ignore
	}
}
