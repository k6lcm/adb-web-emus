#!/usr/bin/env python3
"""Mirror the published Plexus build, then vendor it with sync-app.sh."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
SITE = "https://spritetm.github.io/plexus_20_emu/"
REPO = "https://github.com/Spritetm/plexus_20_emu"
ASSETS = (
    "index.html", "plexem.css", "plexem.mjs", "plexem.wasm",
    "plexem.data", "plexem.wasm.map", "xterm/css/xterm.css",
    "xterm/lib/xterm.js", "xterm/lib/xterm.js.map", "xterm/LICENSE",
    "xterm/package.json", "xterm-pty/index.js", "xterm-pty/index.js.map",
    "xterm-pty/LICENSE.txt", "xterm-pty/package.json",
)


def download(url, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {dest.name}", flush=True)
    request = Request(url, headers={"User-Agent": "adb-web-emus Plexus sync"})
    with urlopen(request, timeout=120) as response, dest.open("wb") as output:
        shutil.copyfileobj(response, output)


def main():
    with tempfile.TemporaryDirectory(prefix="plexus-build-") as temporary:
        stage = Path(temporary)
        # This is source HEAD at download time, not a claim about the Pages
        # build's exact source revision. Hashes below identify the actual build.
        download("https://api.github.com/repos/Spritetm/plexus_20_emu/commits/main",
                 stage / "commit.json")
        source_head = json.loads((stage / "commit.json").read_text())["sha"]
        (stage / "commit.json").unlink()
        for asset in ASSETS:
            download(SITE + asset, stage / asset)
        for source, target in (
            ("LICENSE.txt", "LICENSE.txt"),
            ("README.md", "UPSTREAM-README.md"),
            ("Musashi/readme.txt", "licenses/Musashi-readme.txt"),
            ("Musashi/softfloat/softfloat.c", "licenses/softfloat.c"),
        ):
            download(f"https://raw.githubusercontent.com/Spritetm/plexus_20_emu/{source_head}/{source}",
                     stage / target)

        hashes = {str(path.relative_to(stage)): hashlib.sha256(path.read_bytes()).hexdigest()
                  for path in sorted(stage.rglob("*")) if path.is_file()}
        snapshot = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()
        (stage / "build-info.json").write_text(json.dumps({
            "upstream_site": SITE,
            "source_repository": REPO,
            "source_head_at_sync": source_head,
            "snapshot_sha256": snapshot,
            "rom_and_disk_source": "https://github.com/misterblack1/plexus-p20",
            "data_bundle": "plexem.data contains U15-MERGED.BIN, U17-MERGED.BIN and plexus-sanitized.img",
            "sha256": hashes,
        }, indent=2) + "\n")
        subprocess.run([str(ROOT / "tools/sync-app.sh"), "plexus", str(stage)],
                       env={**os.environ, "SYNC_SOURCE": SITE,
                            "SYNC_REVISION": "snapshot-" + snapshot[:12]}, check=True)


if __name__ == "__main__":
    main()
