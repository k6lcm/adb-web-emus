/*
 * Keyboard mapper for the MAX-80 Web emulator.
 * Accurately mirrors win_events(), key_hold(), and key_unhold() in emu/max80.c:
 * - Unmodified keys (no Shift/Ctrl/Alt/Meta and no CapsLock on a-z) are held
 *   directly in the MAX-80 key matrix via emulator.keyHold(slot, ch) and ignore
 *   host auto-repeat (so games reading the raw matrix see a steady hold and the
 *   BIOS handles key repeat itself).
 * - Shifted printable characters and Ctrl+A..Z go through emulator.keyQueue(ch).
 * - Alt/Meta combinations are ignored so UI and browser shortcuts remain intact.
 */

export const K_UP = 0x80;
export const K_DOWN = 0x81;
export const K_LEFT = 0x82;
export const K_RIGHT = 0x83;
export const K_F1 = 0x84;
export const K_F2 = 0x85;
export const K_F3 = 0x86;
export const K_F4 = 0x87;
export const K_BREAK = 0x88;
export const K_ENTER = 0x89;
export const K_PAUSE = 0x8a;

const SPECIAL_KEY_MAP = {
	Enter: 0x0d,
	NumpadEnter: 0x0d,
	Backspace: 0x08,
	Escape: 0x1b,
	ArrowUp: K_UP,
	ArrowDown: K_DOWN,
	ArrowLeft: K_LEFT,
	ArrowRight: K_RIGHT,
	F1: K_F1,
	F2: K_F2,
	F3: K_F3,
	F4: K_F4,
	Pause: K_BREAK,
	Tab: 0x09,
};

function specialCharForEvent(e) {
	if (SPECIAL_KEY_MAP[e.key] !== undefined) {
		return SPECIAL_KEY_MAP[e.key];
	}
	if (SPECIAL_KEY_MAP[e.code] !== undefined) {
		return SPECIAL_KEY_MAP[e.code];
	}
	return 0;
}

export function attachKeyboard(target, emulator, opts = {}) {
	const isBlocked = typeof opts.isBlocked === 'function' ? opts.isBlocked : () => false;
	const codeToSlot = new Map();
	let nextSlot = 0;

	function slotForCode(code) {
		const key = code || 'Unknown';
		let slot = codeToSlot.get(key);
		if (slot === undefined) {
			slot = nextSlot < 256 ? nextSlot++ : 255;
			codeToSlot.set(key, slot);
		}
		return slot;
	}

	function shouldIgnore() {
		if (!emulator || typeof emulator.isPoweredOn !== 'function' || !emulator.isPoweredOn()) {
			return true;
		}
		return Boolean(isBlocked());
	}

	function onKeyDown(e) {
		if (shouldIgnore()) return;

		// Leave Alt and Meta combinations for UI/browser shortcuts (Alt+R, Alt+F, Alt+1..4, Alt+,)
		if (e.altKey || e.metaKey) return;

		// Ctrl belongs to the MAX-80
		if (e.ctrlKey) {
			const k = e.key;
			if (k && k.length === 1) {
				const lower = k.toLowerCase();
				const code = lower.charCodeAt(0);
				if (code >= 97 && code <= 122) {
					e.preventDefault();
					emulator.keyQueue(code - 96); // 1..26 (Ctrl+C = 3 = BREAK)
					return;
				}
				if (k === '[') {
					e.preventDefault();
					emulator.keyQueue(0x1b);
					return;
				}
				if (k === '\\' || k === ']') {
					e.preventDefault();
					return;
				}
			}
			const special = specialCharForEvent(e);
			if (special) {
				e.preventDefault();
				emulator.keyQueue(special);
			}
			return;
		}

		const special = specialCharForEvent(e);
		const isPrintable = e.key && e.key.length === 1 && e.key.charCodeAt(0) >= 0x20 && e.key.charCodeAt(0) <= 0x7e;
		const isLetter = isPrintable && ((e.key >= 'a' && e.key <= 'z') || (e.key >= 'A' && e.key <= 'Z'));
		const capsLock = typeof e.getModifierState === 'function' && e.getModifierState('CapsLock');

		// Unmodified hold path (matching key_hold in emu/max80.c)
		if (!e.shiftKey && !(capsLock && isLetter)) {
			const ch = special || (isPrintable ? e.key.charCodeAt(0) : 0);
			if (ch) {
				e.preventDefault();
				if (e.repeat) {
					// Ignore host key repeat while held in the matrix; the BIOS repeats held keys itself
					return;
				}
				const slot = slotForCode(e.code);
				const held = emulator.keyHold(slot, ch);
				if (!held) {
					emulator.keyQueue(ch);
				}
				return;
			}
		}

		// Shifted or CapsLock special keys
		if (special) {
			e.preventDefault();
			emulator.keyQueue(special);
			return;
		}

		// Shifted / CapsLock / other printable ASCII single-char keys
		if (isPrintable) {
			e.preventDefault();
			emulator.keyQueue(e.key.charCodeAt(0));
		}
	}

	function onKeyUp(e) {
		if (!emulator || typeof emulator.isPoweredOn !== 'function' || !emulator.isPoweredOn()) {
			return;
		}
		const slot = codeToSlot.get(e.code || 'Unknown');
		if (slot !== undefined) {
			emulator.keyUnhold(slot);
		}
	}

	function onBlur() {
		if (emulator && typeof emulator.keyReleaseAll === 'function') {
			emulator.keyReleaseAll();
		}
	}

	function onVisibilityChange() {
		if (typeof document !== 'undefined' && document.hidden) {
			onBlur();
		}
	}

	const eventTarget = target || (typeof window !== 'undefined' ? window : null);
	if (eventTarget && typeof eventTarget.addEventListener === 'function') {
		eventTarget.addEventListener('keydown', onKeyDown);
		eventTarget.addEventListener('keyup', onKeyUp);
	}
	if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
		window.addEventListener('blur', onBlur);
	}
	if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
		document.addEventListener('visibilitychange', onVisibilityChange);
	}

	return function detach() {
		if (eventTarget && typeof eventTarget.removeEventListener === 'function') {
			eventTarget.removeEventListener('keydown', onKeyDown);
			eventTarget.removeEventListener('keyup', onKeyUp);
		}
		if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
			window.removeEventListener('blur', onBlur);
		}
		if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
			document.removeEventListener('visibilitychange', onVisibilityChange);
		}
	};
}
