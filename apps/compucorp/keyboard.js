/*
 * Keyboard mapper and Omega function-key strip descriptors for the
 * Compucorp 665 Web emulator.
 * Mirrors win_events() and key_tick() in emu/cc665.c and the F-key chart
 * in emu/mac/README.md.
 */

export const K_RESET = 0x100;
export const K_BREAK = 0x101;
export const K_PAUSE = 0x102;
export const K_DOWN = 0x103;
export const K_HOLD = 0x104;

export const OMEGA_KEYS = [
	// 0..9: F1..F10 (left half of keystrip, alt: false)
	{ index: 0, fKey: 'F1', keyLabel: 'F1', alt: false, plain: 'INDEX', ctrl: '', codePlain: 0xe0, codeCtrl: 0x80, codeShift: 0xc0 },
	{ index: 1, fKey: 'F2', keyLabel: 'F2', alt: false, plain: 'COMMAND', ctrl: 'MATH', codePlain: 0xe1, codeCtrl: 0x81, codeShift: 0xc1 },
	{ index: 2, fKey: 'F3', keyLabel: 'F3', alt: false, plain: 'STATUS', ctrl: 'TRACE', codePlain: 0xe2, codeCtrl: 0x82, codeShift: 0xc2 },
	{ index: 3, fKey: 'F4', keyLabel: 'F4', alt: false, plain: 'PRINT', ctrl: 'STOP PRINT', codePlain: 0xe3, codeCtrl: 0x83, codeShift: 0xc3 },
	{ index: 4, fKey: 'F5', keyLabel: 'F5', alt: false, plain: 'BLOCK', ctrl: 'COPY', codePlain: 0xe4, codeCtrl: 0x84, codeShift: 0xc4 },
	{ index: 5, fKey: 'F6', keyLabel: 'F6', alt: false, plain: 'SAVE', ctrl: 'MOVE', codePlain: 0xe5, codeCtrl: 0x85, codeShift: 0xc5 },
	{ index: 6, fKey: 'F7', keyLabel: 'F7', alt: false, plain: 'RECALL', ctrl: 'SPELL', codePlain: 0xe6, codeCtrl: 0x86, codeShift: 0xc6 },
	{ index: 7, fKey: 'F8', keyLabel: 'F8', alt: false, plain: 'GLOSSARY', ctrl: 'MERGE', codePlain: 0xe7, codeCtrl: 0x87, codeShift: 0xc7 },
	{ index: 8, fKey: 'F9', keyLabel: 'F9', alt: false, plain: 'DEL LINE', ctrl: 'DELETE', codePlain: 0xe8, codeCtrl: 0x88, codeShift: 0xc8 },
	{ index: 9, fKey: 'F10', keyLabel: 'F10', alt: false, plain: 'DEL WORD', ctrl: '', codePlain: 0xe9, codeCtrl: 0x89, codeShift: 0xc9 },

	// 10..19: Alt+F1..Alt+F10 (right half of keystrip, alt: true)
	{ index: 10, fKey: 'F1', keyLabel: 'Alt+F1', alt: true, plain: 'DEL CHAR', ctrl: 'CLEAR', codePlain: 0xea, codeCtrl: 0x8a, codeShift: 0xca },
	{ index: 11, fKey: 'F2', keyLabel: 'Alt+F2', alt: true, plain: 'INDENT', ctrl: 'MARGIN', codePlain: 0xeb, codeCtrl: 0x8b, codeShift: 0xcb },
	{ index: 12, fKey: 'F3', keyLabel: 'Alt+F3', alt: true, plain: 'CENTER', ctrl: 'HARD SPACE', codePlain: 0xec, codeCtrl: 0x8c, codeShift: 0xcc },
	{ index: 13, fKey: 'F4', keyLabel: 'Alt+F4', alt: true, plain: 'UNDERLINE', ctrl: 'SOFT HYPHEN', codePlain: 0xed, codeCtrl: 0x8d, codeShift: 0xcd },
	{ index: 14, fKey: 'F5', keyLabel: 'Alt+F5', alt: true, plain: 'BOLD', ctrl: '', codePlain: 0xee, codeCtrl: 0x8e, codeShift: 0xce },
	{ index: 15, fKey: 'F6', keyLabel: 'Alt+F6', alt: true, plain: 'PAGINATE', ctrl: '', codePlain: 0xef, codeCtrl: 0x8f, codeShift: 0xcf },
	{ index: 16, fKey: 'F7', keyLabel: 'Alt+F7', alt: true, plain: 'WORD', ctrl: 'FIND', codePlain: 0xf0, codeCtrl: 0x90, codeShift: 0xd0 },
	{ index: 17, fKey: 'F8', keyLabel: 'Alt+F8', alt: true, plain: 'PAGE DOWN', ctrl: 'PAGE UP', codePlain: 0xf1, codeCtrl: 0x91, codeShift: 0xd1 },
	{ index: 18, fKey: 'F9', keyLabel: 'Alt+F9', alt: true, plain: 'DOCUMENT', ctrl: 'SEARCH', codePlain: 0xf2, codeCtrl: 0x92, codeShift: 0xd2 },
	{ index: 19, fKey: 'F10', keyLabel: 'Alt+F10', alt: true, plain: 'FORMAT', ctrl: 'REPLACE', codePlain: 0xf3, codeCtrl: 0x93, codeShift: 0xd3 },
];

const FKEY_RE = /^F([1-9]|10)$/;

function matchFKeyNumber(e) {
	if (typeof e.key === 'string') {
		const m = FKEY_RE.exec(e.key);
		if (m) return parseInt(m[1], 10);
	}
	if (typeof e.code === 'string') {
		const m = FKEY_RE.exec(e.code);
		if (m) return parseInt(m[1], 10);
	}
	return 0;
}

export function attachKeyboard(target, emulator, opts = {}) {
	const isBlocked = typeof opts.isBlocked === 'function' ? opts.isBlocked : () => false;
	const onToggleFast = typeof opts.onToggleFast === 'function' ? opts.onToggleFast : null;

	let contextMenuHeld = false;

	function shouldIgnore(e) {
		if (!emulator || typeof emulator.isPoweredOn !== 'function' || !emulator.isPoweredOn()) {
			return true;
		}
		if (isBlocked()) {
			return true;
		}
		if (e.metaKey) {
			return true;
		}
		return false;
	}

	function onKeyDown(e) {
		if (e.key === 'ContextMenu' || e.code === 'ContextMenu') {
			contextMenuHeld = true;
			return;
		}

		if (shouldIgnore(e)) return;

		// The 665 takes 15 keys a second, slower than the host's repeat:
		// drop a repeat while keys are still waiting in the queue.
		const pending =
			typeof emulator.getKeyPending === 'function' ? emulator.getKeyPending() : 0;
		if (e.repeat && pending > 0) {
			e.preventDefault();
			return;
		}

		if (e.key === 'ScrollLock' || e.code === 'ScrollLock') {
			e.preventDefault();
			if (onToggleFast) {
				onToggleFast();
			} else if (typeof emulator.setFast === 'function' && typeof emulator.getSettings === 'function') {
				emulator.setFast(!emulator.getSettings().fast);
			}
			return;
		}

		// F1..F10: always handled (including with Alt, Ctrl, Shift, or ContextMenu held)
		const fNum = matchFKeyNumber(e);
		if (fNum >= 1 && fNum <= 10) {
			const right = Boolean(contextMenuHeld || e.altKey);
			const n = fNum - 1 + (right ? 10 : 0);
			const base = e.ctrlKey ? 0x80 : e.shiftKey ? 0xc0 : 0xe0;
			e.preventDefault();
			emulator.keyQueue(base + n);
			return;
		}

		// For all OTHER keys, leave Alt combinations for UI shortcuts (Alt+1..4, Alt+R, Alt+B, Alt+F, Alt+K, Alt+P, Alt+,)
		if (e.altKey) {
			return;
		}

		if (e.key === 'F12' || e.code === 'F12') {
			e.preventDefault();
			emulator.keyQueue(K_BREAK);
			return;
		}

		if (e.key === 'Pause' || e.code === 'Pause') {
			e.preventDefault();
			emulator.keyQueue(e.shiftKey ? K_BREAK : K_RESET);
			return;
		}

		if (e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter') {
			e.preventDefault();
			emulator.keyQueue(0x0d);
			return;
		}
		if (e.key === 'Escape' || e.code === 'Escape') {
			e.preventDefault();
			emulator.keyQueue(0x1b);
			return;
		}
		if (e.key === 'Backspace' || e.code === 'Backspace') {
			e.preventDefault();
			emulator.keyQueue(0x7f);
			return;
		}
		if (e.key === 'Tab' || e.code === 'Tab') {
			e.preventDefault();
			emulator.keyQueue(0x09);
			return;
		}
		if (e.key === 'ArrowUp' || e.code === 'ArrowUp') {
			e.preventDefault();
			emulator.keyQueue(0x18);
			return;
		}
		if (e.key === 'ArrowDown' || e.code === 'ArrowDown') {
			e.preventDefault();
			emulator.keyQueue(K_DOWN);
			return;
		}
		if (e.key === 'ArrowLeft' || e.code === 'ArrowLeft') {
			e.preventDefault();
			emulator.keyQueue(0x08);
			return;
		}
		if (e.key === 'ArrowRight' || e.code === 'ArrowRight') {
			e.preventDefault();
			emulator.keyQueue(0x1a);
			return;
		}

		if (e.ctrlKey) {
			const k = e.key;
			if (k && k.length === 1) {
				const lower = k.toLowerCase();
				const code = lower.charCodeAt(0);
				if (code >= 97 && code <= 122) {
					e.preventDefault();
					emulator.keyQueue(code - 96); // 1..26
					return;
				}
				if (k === '[') {
					e.preventDefault();
					emulator.keyQueue(0x1b);
					return;
				}
			}
			return;
		}

		if (typeof e.key === 'string' && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
			const code = e.key.charCodeAt(0);
			if (code >= 0x20 && code <= 0x7e) {
				e.preventDefault();
				emulator.keyQueue(code);
			}
		}
	}

	function onKeyUp(e) {
		if (e.key === 'ContextMenu' || e.code === 'ContextMenu') {
			contextMenuHeld = false;
		}
	}

	function onBlur() {
		contextMenuHeld = false;
	}

	function onVisibilityChange() {
		if (typeof document !== 'undefined' && document.hidden) {
			contextMenuHeld = false;
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
