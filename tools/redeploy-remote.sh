#!/usr/bin/env bash
# Wipe + fresh-install + run openinfo on a remote test machine.
# Run this FROM the machine with the source checkout; it drives everything
# over ssh on the remote end. Override target/version via env vars, e.g.:
#   REMOTE_HOST=10.0.0.5 REMOTE_USER=someone tools/redeploy-remote.sh
set -euo pipefail

REMOTE_USER="${REMOTE_USER:-someone}"
REMOTE_HOST="${REMOTE_HOST:-192.168.1.106}"
REMOTE_PATH="${REMOTE_PATH:-openinfo}"          # relative to remote $HOME
NODE_VERSION="${NODE_VERSION:-24.18.0}"
LOCAL_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="${REMOTE_USER}@${REMOTE_HOST}"

# Guard against a misconfigured REMOTE_PATH nuking something unintended.
case "$REMOTE_PATH" in
  ""|"/"|".."|*..*) echo "refusing to use REMOTE_PATH=${REMOTE_PATH}" >&2; exit 1 ;;
esac

echo "==> [1/5] killing running openinfo processes on ${REMOTE}"
ssh "$REMOTE" '
  pkill -f "'"${REMOTE_PATH}"'/apps/engine/dist/main.js" 2>/dev/null || true
  pkill -f "'"${REMOTE_PATH}"'/apps/client/node_modules/electron" 2>/dev/null || true
  lsof -ti:8787 2>/dev/null | xargs -r kill -9 || true
  sleep 1
  echo "   remaining openinfo processes:"
  ps aux | grep -i "'"${REMOTE_PATH}"'" | grep -v grep | sed "s/^/   /" || echo "   (none)"
'

echo "==> [2/5] wiping ~/${REMOTE_PATH} on ${REMOTE}"
ssh "$REMOTE" "rm -rf ~/${REMOTE_PATH} && mkdir -p ~/${REMOTE_PATH}"

echo "==> [3/5] copying fresh source from ${LOCAL_PATH}"
rsync -az --delete \
  --exclude='node_modules' --exclude='dist' \
  --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' --exclude='spool/' \
  -e ssh "${LOCAL_PATH}/" "${REMOTE}:~/${REMOTE_PATH}/"

echo "==> [4/5] install + build on ${REMOTE} (node ${NODE_VERSION} via nvm)"
ssh "$REMOTE" "
  set -e
  cd ~/${REMOTE_PATH}
  export NVM_DIR=\"\$HOME/.nvm\"
  . \"\$NVM_DIR/nvm.sh\"
  nvm use ${NODE_VERSION} >/dev/null
  pnpm install
  pnpm -r build
"

echo "==> [5/5] starting engine + electron client on ${REMOTE}"
ssh "$REMOTE" "
  cd ~/${REMOTE_PATH}
  export NVM_DIR=\"\$HOME/.nvm\"
  . \"\$NVM_DIR/nvm.sh\"
  nvm use ${NODE_VERSION} >/dev/null
  nohup node apps/engine/dist/main.js > /tmp/openinfo-engine.log 2>&1 &
  disown
  sleep 1
  nohup pnpm --filter @openinfo/client start > /tmp/openinfo-client.log 2>&1 &
  disown
"

echo "==> waiting for engine to come up"
sleep 6
ssh "$REMOTE" 'curl -s localhost:8787/health || echo "engine not responding"'
echo
ssh "$REMOTE" 'echo -n "electron processes: "; ps aux | grep -i electron | grep -v grep | wc -l | tr -d " "'
echo "==> done. logs: /tmp/openinfo-engine.log and /tmp/openinfo-client.log on ${REMOTE}"
