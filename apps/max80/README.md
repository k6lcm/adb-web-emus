# Lobo MAX-80 Web Emulator

A platform-agnostic WebAssembly emulator of the 1982 **Lobo Systems MAX-80** (Z80 @ 5.067 MHz, 128K/64K RAM, HD46505R beam-accurate CRT video, MB8866 floppy controller, 48 kHz beeper), running entirely in your browser.

**Live site:** https://k6lcm.github.io/max80-web/

## Features

- Compiled directly from the hardware-accurate C emulator core ([`lobo_max80`](https://github.com/fletto2/lobo_max80), MIT) to WebAssembly — no backend server required.
- Built-in Library with 19 redistributable MAX-80 homebrew disks (xcpmz80 Desktop, xcpmz80, HI-TECH C 3.09, 80-Force, MAX-80 Hardware Demo, CRTC Tricks, Diagnostics, Boot Monitor, Game Template), loaded on demand.
- Drag-and-drop or insert any local `.imd` (ImageDisk) floppy image into Drives `A:` through `D:`, create blank disks for `FORMAT`, toggle write-protect, and download modified disks via **Save As** (never overwriting original files).
- Full DIP switch bank (`SW8`–`SW1`) and boot device selector, 128K/64K memory, authentic vs. quick/fast timing, and White / Green / Amber CRT phosphor presets.

## Keyboard Shortcuts

- `Ctrl` belongs to the MAX-80 (for example, `Ctrl+C` is `BREAK`).
- `Alt+1`–`Alt+4`: Insert `.imd` disk in Drives `A:`–`D:`
- `Alt+R`: Restart
- `Alt+F`: Toggle Fast mode
- `Alt+,`: Open Settings
- `Esc`: Close open modal

## License

MIT — see [`LICENSE`](LICENSE).
