# ADB Web Emulators

[Open the emulator desktop](https://k6lcm.github.io/adb-web-emus/).

Compucorp 665, Lobo MAX-80, Plexus P/20 and Agfa 9000PS run locally in your
browser, each in its own window. GitHub serves the static files.

This repository hosts the emulator desktop. It contains the browser app, compiled emulators, public
ROM/disk libraries, licenses and the GitHub Pages deployment workflow.
Build metadata identifies emulator components without exposing private development locations.

Plexus downloads about 73 MiB on first launch. Wait for self-test (or type
`!`), then press Enter at the primary boot prompt. Its About and help dialogs
credit Sprite_tm and contributors and explain how to use the machine.

Agfa 9000PS downloads a 46 MiB compressed SCSI disk image (171 MiB uncompressed)
on first launch and boots directly into Minix 2.0.4, CP/M-68K v1.6, or AGFA-MON
with VERA 640x480 video and stereo PSG+PCM audio. Disk changes persist in your
browser via IndexedDB copy-on-write sectors.

## Rule for changes

Every change to this site is time-stamped. Each push to `main` runs the Pages
workflow, which records the date and time of the update, to the second and in
UTC, in `last-updated.json`. The desktop's About dialog shows it in each
visitor's local time zone, in 24-hour time. Publish only through that workflow, keep its
"Record the date and time" step, and do not commit `last-updated.json` by hand.
