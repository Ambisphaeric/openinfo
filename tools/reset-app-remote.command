#!/usr/bin/env bash
# One-click reset + reinstall of the PACKAGED openinfo app on a remote test machine.
# Double-clickable on macOS (.command opens in Terminal). What it does, in order:
#   [1/5] kill running openinfo processes on the remote (engine launchd agent, Electron
#         shell, anything on :8787) — the exact incantations proven in redeploy-remote.sh
#   [2/5] wipe ~/.openinfo entirely (client.json, data/ sqlite dbs, secrets/) plus any
#         Electron userData dirs — a factory-fresh app state. TCC (mic/screen) is left
#         STRICTLY alone: revoke that by hand in System Settings when you want a fresh
#         permission prompt; there is no reliable CLI for it.
#   [3/5] reinstall the app bundle from the newest openinfo-*-arm64.dmg in the remote's
#         ~/Downloads (ship one first with tools/ship-dmg-remote.sh)
#   [4/5] launch the app and wait for the engine on :8787
#   [5/5] re-seed the fabric: store the llm api key as secret `api_d`, then PUT the
#         llm (omlx, :8000) + stt (parakeet via mlx-audio, :8002) endpoints pointing at
#         THIS machine's live LAN IP — read at runtime, never hardcoded (it's DHCP).
#
# Config: sources .private/redeploy.env for REMOTE_USER/REMOTE_HOST (see .private/README.md);
# explicit env vars win. Other overrides:
#   FABRIC_IP    LAN IP the endpoints should point at (default: ipconfig getifaddr en0 here)
#   LLM_PORT / STT_PORT      default 8000 / 8002
#   LLM_MODEL / STT_MODEL    default the current dev combo (see below)
#   OMLX_SETTINGS            path to omlx settings.json holding auth.api_key
#                            (default ~/.omlx/settings.json on this machine)
#   DRY_RUN=1    print every remote step instead of executing (nothing is touched)
set -euo pipefail

LOCAL_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "${LOCAL_PATH}/.private/redeploy.env" ] && source "${LOCAL_PATH}/.private/redeploy.env"

REMOTE_USER="${REMOTE_USER:-someone}"
REMOTE_HOST="${REMOTE_HOST:-192.168.1.100}"
REMOTE="${REMOTE_USER}@${REMOTE_HOST}"
LLM_PORT="${LLM_PORT:-8000}"
STT_PORT="${STT_PORT:-8002}"
LLM_MODEL="${LLM_MODEL:-LFM2.5-8B-A1B-MLX-8bit}"
STT_MODEL="${STT_MODEL:-mlx-community/parakeet-tdt_ctc-110m}"
OMLX_SETTINGS="${OMLX_SETTINGS:-$HOME/.omlx/settings.json}"
DRY_RUN="${DRY_RUN:-}"

run_remote() {  # run_remote <label> <script-via-stdin>
  local label="$1"; shift
  if [ -n "$DRY_RUN" ]; then
    echo "-- DRY RUN [$label] would run on ${REMOTE}:"; sed 's/^/   | /'
  else
    ssh "$REMOTE" 'bash -s'
  fi
}

# The LAN IP the freshly-seeded endpoints must point at — read live, never hardcoded
# (this machine's IP is DHCP-assigned and does change).
FABRIC_IP="${FABRIC_IP:-$(ipconfig getifaddr en0 2>/dev/null || true)}"
if [ -z "$FABRIC_IP" ]; then
  read -r -p "Could not detect this machine's LAN IP (en0). Enter the IP omlx/parakeet are served on: " FABRIC_IP
fi

# The omlx api key, read from the local omlx install so no credential lives in this script.
API_KEY=""
if [ -f "$OMLX_SETTINGS" ]; then
  API_KEY="$(python3 -c "import json;print(json.load(open('$OMLX_SETTINGS'))['auth']['api_key'])" 2>/dev/null || true)"
fi
if [ -z "$API_KEY" ]; then
  read -r -s -p "omlx api key (auth.api_key not found in ${OMLX_SETTINGS}): " API_KEY; echo
fi

echo "openinfo remote reset+reinstall"
echo "  target   : ${REMOTE}"
echo "  endpoints: llm http://${FABRIC_IP}:${LLM_PORT} (${LLM_MODEL})"
echo "             stt http://${FABRIC_IP}:${STT_PORT} (${STT_MODEL})"
echo "  wipes    : ~/.openinfo (dbs, secrets, config) + app userData; TCC untouched"
[ -n "$DRY_RUN" ] && echo "  mode     : DRY RUN — nothing will be touched"
echo
read -r -p "This DELETES all openinfo data on ${REMOTE}. Continue? [y/N] " yn
case "$yn" in [Yy]*) ;; *) echo "aborted."; exit 1 ;; esac

echo "==> [1/5] killing running openinfo processes on ${REMOTE}"
run_remote "kill" <<'EOS'
  launchctl bootout gui/$(id -u)/io.openinfo.engine 2>/dev/null || true
  launchctl bootout gui/$(id -u)/io.openinfo.omlx 2>/dev/null || true
  osascript -e 'quit app "openinfo"' 2>/dev/null || true
  sleep 2
  pkill -f "apps/engine/dist/main.js" 2>/dev/null || true
  # -i: the Electron binary inside the app bundle is capitalized
  pkill -if "electron ." 2>/dev/null || true
  pkill -if "openinfo.app/Contents/MacOS" 2>/dev/null || true
  lsof -ti:8787 2>/dev/null | xargs -r kill -9 || true
  sleep 1
  echo "   remaining openinfo processes:"
  ps aux | grep -i "openinfo\|apps/engine" | grep -v grep | sed "s/^/   /" || echo "   (none)"
EOS

echo "==> [2/5] wiping app state on ${REMOTE} (TCC left alone)"
run_remote "wipe" <<'EOS'
  rm -rf ~/.openinfo
  rm -rf "$HOME/Library/Application Support/openinfo" 2>/dev/null || true
  rm -rf "$HOME/Library/Application Support/ai.openinfo.client" 2>/dev/null || true
  echo "   wiped: ~/.openinfo + app userData"
EOS

echo "==> [3/5] reinstalling the app bundle from the newest DMG in ~/Downloads"
run_remote "reinstall" <<'EOS'
  set -e
  # highest VERSION wins (sort -V), not newest mtime — a re-shipped old DMG must never win
  DMG=$(ls ~/Downloads/openinfo-*-arm64.dmg 2>/dev/null | sort -V | tail -1)
  if [ -z "$DMG" ]; then echo "   NO openinfo-*-arm64.dmg in ~/Downloads — ship one with tools/ship-dmg-remote.sh" >&2; exit 1; fi
  echo "   installing from: $DMG"
  for V in /Volumes/openinfo*; do hdiutil detach -quiet "$V" 2>/dev/null || true; done
  MNT=$(hdiutil attach -nobrowse "$DMG" | grep -o "/Volumes/.*" | tail -1)
  rm -rf /Applications/openinfo.app
  ditto "$MNT/openinfo.app" /Applications/openinfo.app
  hdiutil detach -quiet "$MNT" || true
  defaults read /Applications/openinfo.app/Contents/Info.plist CFBundleShortVersionString | sed "s/^/   installed version: /"
EOS

echo "==> [4/5] launching the app and waiting for the engine on :8787"
run_remote "launch" <<'EOS'
  open -a openinfo
  for i in $(seq 1 30); do
    if curl -s -m 2 http://127.0.0.1:8787/health | grep -q '"ok"'; then
      curl -s -m 2 http://127.0.0.1:8787/health | python3 -c "import json,sys;h=json.load(sys.stdin);print('   engine up: version',h['version'])"
      exit 0
    fi
    sleep 2
  done
  echo "   engine did not come up on :8787 within 60s" >&2; exit 1
EOS

echo "==> [5/5] re-seeding secret + fabric endpoints"
if [ -n "$DRY_RUN" ]; then
  echo "-- DRY RUN [seed]: would PUT /fabric/secrets/api_d and PUT /fabric on ${REMOTE} (llm ${FABRIC_IP}:${LLM_PORT}, stt ${FABRIC_IP}:${STT_PORT})"
else
  ssh "$REMOTE" 'python3 -' <<PYEOF
import json, urllib.request

def call(method, path, body):
    req = urllib.request.Request("http://127.0.0.1:8787" + path,
        data=json.dumps(body).encode(), method=method,
        headers={"Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=10).status

print("   secret api_d:", call("PUT", "/fabric/secrets/api_d", {"value": "${API_KEY}"}))

fabric = json.load(urllib.request.urlopen("http://127.0.0.1:8787/fabric", timeout=10))
fabric["slots"]["llm"] = [{"kind": "http", "name": "host",
    "url": "http://${FABRIC_IP}:${LLM_PORT}", "api": "openai-compat",
    "model": "${LLM_MODEL}", "auth": {"keyRef": "api_d"}}]
fabric["slots"]["stt"] = [{"kind": "http", "name": "parakeet-mlx-audio",
    "url": "http://${FABRIC_IP}:${STT_PORT}", "api": "openai-compat",
    "model": "${STT_MODEL}"}]
print("   fabric PUT:", call("PUT", "/fabric", fabric))
cur = json.load(urllib.request.urlopen("http://127.0.0.1:8787/fabric", timeout=10))
print("   fabric now:", [(k, [e["name"] for e in v]) for k, v in cur["slots"].items() if v])
PYEOF
fi

echo
echo "done. Fresh install is running STOPPED (consent boundary) with endpoints seeded."
echo "Remaining by-hand steps: re-grant mic (System Settings > Privacy) if you revoked it,"
echo "then tray > Start Session. Features/flags reset to defaults — flip them in Settings"
echo "or run the Try-it card once."
