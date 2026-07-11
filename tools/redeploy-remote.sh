#!/usr/bin/env bash
# Wipe + fresh-install + run openinfo on a remote test machine, from the pushed
# GitHub main branch — NOT the local checkout. This deliberately skips whatever
# unpushed/in-progress work is sitting in your local tree: the remote only ever
# gets what has actually landed on origin/main. Push first if you want a change
# reflected on the remote.
# Run this FROM the machine with the source checkout; it drives everything
# over ssh on the remote end. Override target/version/source via env vars, e.g.:
#   REMOTE_HOST=10.0.0.5 REMOTE_USER=someone BRANCH=some-branch tools/redeploy-remote.sh
set -euo pipefail

LOCAL_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Local override (gitignored) with your real deploy target — see .private/README.md.
# Explicit env vars passed to this script still win over the file.
[ -f "${LOCAL_PATH}/.private/redeploy.env" ] && source "${LOCAL_PATH}/.private/redeploy.env"

REMOTE_USER="${REMOTE_USER:-someone}"
REMOTE_HOST="${REMOTE_HOST:-192.168.1.100}"
REMOTE_PATH="${REMOTE_PATH:-openinfo}"          # relative to remote $HOME
NODE_VERSION="${NODE_VERSION:-24.18.0}"
BRANCH="${BRANCH:-main}"
REPO_URL="${REPO_URL:-$(git -C "$LOCAL_PATH" remote get-url origin 2>/dev/null || true)}"
REMOTE="${REMOTE_USER}@${REMOTE_HOST}"

if [ -z "$REPO_URL" ]; then
  echo "no REPO_URL set and no 'origin' remote found locally — set REPO_URL explicitly" >&2
  exit 1
fi

# Guard against a misconfigured REMOTE_PATH nuking something unintended.
case "$REMOTE_PATH" in
  ""|"/"|".."|*..*) echo "refusing to use REMOTE_PATH=${REMOTE_PATH}" >&2; exit 1 ;;
esac

echo "==> [1/5] killing running openinfo processes on ${REMOTE}"
ssh "$REMOTE" '
  # engine runs as a launchd GUI-domain agent (macOS 26 Local Network TCC denies LAN
  # fetches to orphaned ssh-spawned processes — nohup engines could never reach other hosts)
  launchctl bootout gui/$(id -u)/io.openinfo.engine 2>/dev/null || true
  pkill -f "apps/engine/dist/main.js" 2>/dev/null || true
  # -i: macOS packages Electron as an app bundle whose actual binary is capitalized
  # (.../Electron.app/Contents/MacOS/Electron), so a case-sensitive "electron ." never matches it.
  pkill -if "electron ." 2>/dev/null || true
  lsof -ti:8787 2>/dev/null | xargs -r kill -9 || true
  sleep 1
  echo "   remaining openinfo processes:"
  ps aux | grep -i "openinfo\|apps/engine" | grep -v grep | sed "s/^/   /" || echo "   (none)"
'

echo "==> [2/5] wiping ~/${REMOTE_PATH} on ${REMOTE}"
ssh "$REMOTE" "rm -rf ~/${REMOTE_PATH} && mkdir -p ~/${REMOTE_PATH}"

echo "==> [3/5] cloning ${BRANCH} from ${REPO_URL} onto ${REMOTE}"
ssh "$REMOTE" "git clone --branch '${BRANCH}' --depth 1 '${REPO_URL}' ~/${REMOTE_PATH}"
ssh "$REMOTE" "cd ~/${REMOTE_PATH} && echo '   deployed commit:' \$(git log -1 --oneline)"

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

echo "==> [5/5] starting engine (launchd GUI agent) + electron client on ${REMOTE}"
ssh "$REMOTE" "
  cd ~/${REMOTE_PATH}
  export NVM_DIR=\"\$HOME/.nvm\"
  . \"\$NVM_DIR/nvm.sh\"
  nvm use ${NODE_VERSION} >/dev/null
  NODE_BIN=\"\$(command -v node)\"
  DEPLOY_SHA=\"\$(cd ~/${REMOTE_PATH} && git rev-parse --short HEAD)\"
  mkdir -p ~/Library/LaunchAgents
  cat > ~/Library/LaunchAgents/io.openinfo.engine.plist <<PLIST
<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\"><dict>
  <key>Label</key><string>io.openinfo.engine</string>
  <key>ProgramArguments</key><array>
    <string>\${NODE_BIN}</string>
    <string>\${HOME}/${REMOTE_PATH}/apps/engine/dist/main.js</string>
  </array>
  <key>WorkingDirectory</key><string>\${HOME}/${REMOTE_PATH}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:\${HOME}/.local/bin</string>
    <key>OPENINFO_BUILD</key><string>\${DEPLOY_SHA}</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/openinfo-engine.log</string>
  <key>StandardErrorPath</key><string>/tmp/openinfo-engine.log</string>
</dict></plist>
PLIST
  launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/io.openinfo.engine.plist 2>/dev/null \
    || launchctl kickstart -k gui/\$(id -u)/io.openinfo.engine
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
