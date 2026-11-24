#!/usr/bin/env bash
# Copy a built static web emulator into apps/<id>/.
#
# Usage: tools/sync-app.sh <app-id> <source>
#
#   <source> is either
#     - a local directory holding a built emulator (it must contain index.html), or
#     - a git URL of a repo holding one, optionally with "#<branch>".
#
# Examples:
#   tools/sync-app.sh max80 https://github.com/k6lcm/max80-web.git#main
#   tools/sync-app.sh compucorp ~/code/compucorp/emu/build/web
#
# Environment overrides for apps/<id>/sync-info.json (useful for local builds):
#   SYNC_SOURCE    where the build came from (default: the <source> argument)
#   SYNC_REVISION  commit the build was made from (default: detected via git)
#
# After syncing, make sure apps/manifest.json has an entry for <app-id>.
set -euo pipefail

if [ $# -ne 2 ]; then
  sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi

id=$1
src=$2
case $id in
  *[!a-z0-9-]* | "") echo "error: app id must be lowercase letters, digits and dashes" >&2; exit 2 ;;
esac

root=$(cd "$(dirname "$0")/.." && pwd)
dest=$root/apps/$id
tmp=""
trap '[ -n "$tmp" ] && rm -rf "$tmp"' EXIT

if [ -d "$src" ]; then
  dir=$(cd "$src" && pwd)
  revision=$(git -C "$dir" rev-parse --short HEAD 2>/dev/null || echo unknown)
  if [ "$revision" != unknown ] && [ -n "$(git -C "$dir" status --porcelain 2>/dev/null)" ]; then
    revision="$revision-dirty"
  fi
else
  url=${src%%#*}
  branch=""
  [[ $src == *#* ]] && branch=${src#*#}
  tmp=$(mktemp -d)
  git clone --quiet --depth 1 ${branch:+--branch "$branch"} "$url" "$tmp/repo"
  dir=$tmp/repo
  revision=$(git -C "$dir" rev-parse --short HEAD)
fi

if [ ! -f "$dir/index.html" ]; then
  echo "error: $dir has no index.html; point at the built web directory" >&2
  exit 1
fi

mkdir -p "$dest"
rsync -a --delete \
  --exclude '.git' --exclude '.github' --exclude '.nojekyll' --exclude '.DS_Store' \
  "$dir/" "$dest/"

cat > "$dest/sync-info.json" <<EOF
{
  "source": "${SYNC_SOURCE:-$src}",
  "revision": "${SYNC_REVISION:-$revision}"
}
EOF

echo "Synced $id from ${SYNC_SOURCE:-$src} (${SYNC_REVISION:-$revision}) -> apps/$id/"
if ! grep -q "\"id\": *\"$id\"" "$root/apps/manifest.json"; then
  echo "note: add an entry for \"$id\" to apps/manifest.json" >&2
fi
