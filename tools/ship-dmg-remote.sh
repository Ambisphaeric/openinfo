#!/usr/bin/env bash
# rsync a built openinfo .dmg (apps/client/release/) to ~/Downloads on a remote test
# machine — for trying the packaged installer itself, as opposed to
# redeploy-remote.sh which wipes and rebuilds from source on the remote.
# Build the dmg first with `pnpm --filter @openinfo/client dmg`.
# Override target/version via env vars, e.g.:
#   REMOTE_HOST=10.0.0.5 REMOTE_USER=someone VERSION=0.0.1 tools/ship-dmg-remote.sh
set -euo pipefail

LOCAL_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Local override (gitignored) with your real deploy target — see .private/README.md.
# Explicit env vars passed to this script still win over the file.
[ -f "${LOCAL_PATH}/.private/redeploy.env" ] && source "${LOCAL_PATH}/.private/redeploy.env"

REMOTE_USER="${REMOTE_USER:-someone}"
REMOTE_HOST="${REMOTE_HOST:-192.168.1.100}"
VERSION="${VERSION:-$(node -p "require('${LOCAL_PATH}/apps/client/package.json').version")}"
REMOTE="${REMOTE_USER}@${REMOTE_HOST}"

DMG_PATH="${LOCAL_PATH}/apps/client/release/openinfo-${VERSION}-arm64.dmg"

if [ ! -f "$DMG_PATH" ]; then
  echo "no dmg at ${DMG_PATH} — build it first: pnpm --filter @openinfo/client dmg" >&2
  exit 1
fi

echo "==> rsyncing $(basename "$DMG_PATH") to ${REMOTE}:~/Downloads/"
ssh "$REMOTE" "mkdir -p ~/Downloads"
rsync -avP --progress "$DMG_PATH" "${REMOTE}:~/Downloads/"
echo "==> done."
