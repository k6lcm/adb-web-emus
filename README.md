# ADB Web Emulators

A GNOME-style desktop in the browser that hosts vintage computer emulators.
Each emulator gets a desktop icon and a dock entry, and runs in its own window.

**Live:** https://k6lcm.github.io/adb-web-emus/

| Emulator | Source | Window link |
| --- | --- | --- |
| Compucorp 665 | `private-development/Compucorp` (`emu/web`) | [#/compucorp](https://k6lcm.github.io/adb-web-emus/#/compucorp) |
| Lobo MAX-80 | [k6lcm/max80-web](https://github.com/k6lcm/max80-web) | [#/max80](https://k6lcm.github.io/adb-web-emus/#/max80) |

## How it works

- The desktop is plain HTML, CSS and JavaScript with no build step
  (`index.html`, `css/desktop.css`, `js/desktop.js`).
- `apps/manifest.json` lists the emulators. Icons, the dock and the
  Activities grid are all generated from it.
- Each emulator is a self-contained static web app in `apps/<id>/`. It runs in
  an iframe, so emulators never share globals, audio or keyboard handlers.
  Closing a window destroys that emulator instance.
- `#/<id>` in the URL opens that emulator directly.
- On phones, every window opens full-screen.
- Every push to `main` deploys to GitHub Pages (`.github/workflows/deploy.yml`).
  The deploy fails if an app or icon listed in the manifest is missing.

## Updating an emulator

The built files are copied ("vendored") into `apps/<id>/` with
`tools/sync-app.sh`, which also writes `apps/<id>/sync-info.json` recording the
source and commit. The About dialog shows that commit.

**MAX-80:** run the **Sync MAX-80** workflow in the Actions tab. It pulls
`k6lcm/max80-web@main`, commits, and redeploys. To sync automatically
whenever max80-web changes, trigger it from that repo with
`gh api repos/k6lcm/adb-web-emus/dispatches -f event_type=sync-max80`.
Locally:

```sh
tools/sync-app.sh max80 https://github.com/k6lcm/max80-web.git#main
```

**Compucorp 665:** the source is private and needs Emscripten, so build it
locally with only the redistributable disks, then sync:

```sh
make -C ~/code/compucorp/emu web WEB_PACK_FLAGS=--public
SYNC_SOURCE=private-development/Compucorp tools/sync-app.sh compucorp ~/code/compucorp/emu/build/web
git add apps/compucorp && git commit -m "Sync Compucorp 665" && git push
```

> Everything in this repo is public, including ROMs and disk images in
> `apps/`. Only sync builds that are cleared for redistribution.

## Adding an emulator

1. Build the emulator as a static site whose `index.html` uses **relative**
   paths (it is served from `apps/<id>/`).
2. `tools/sync-app.sh <id> <built-dir-or-git-url>`
3. Add a 128×128 SVG icon to `icons/<id>.svg`.
4. Add an entry to `apps/manifest.json`:

   ```json
   {
     "id": "myemu",
     "name": "My Emulator",
     "description": "One line shown in tooltips and About",
     "icon": "icons/myemu.svg",
     "path": "apps/myemu/",
     "window": { "width": 1024, "height": 768 }
   }
   ```

5. Commit and push. The site redeploys automatically.

### Optional: pause when minimized

When a window is minimized or restored, the desktop posts a message into the
emulator's iframe:

```js
window.addEventListener('message', (e) => {
  if (e.data?.type === 'adb-web-emus:visibility') {
    e.data.visible ? resume() : pause();
  }
});
```

## Local preview

```sh
python3 -m http.server 8080
```

Then open http://localhost:8080/.
