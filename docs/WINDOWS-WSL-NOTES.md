# Windows / WSL backend notes

Exploration record for issue #1 ("Build compatibility for Windows / WSL backend").
Environment used: native Windows 11, Node v24, pnpm 9.15.4 (via corepack), run from source.

## Scope of THIS change: build + test only (the minimum deliverable)

This slice makes the backend BUILD and the full test suite PASS on native Windows, and proves the
engine binds its port and is adopted by the client. That is the minimum deliverable, and it is
deliberately the ceiling of this change. **Actually running the app as a usable product on Windows
requires further work**, including (but not limited to) the gaps catalogued under "What degrades" and
"What is blocked" below: a real STT/LLM local server run, native capture-permission prompts, the
foreground-window / calendar readers, owner-only file protection (no `0o600` on Windows), and
packaging. Nothing here should be read as "openinfo runs on Windows"; it reads as "openinfo builds,
tests green, and the engine serves on Windows, with the remaining product gaps documented."

## Status: explored, engine builds/tests/serves on Windows

The engine builds, serves the authenticated HTTP/WS API, and is adopted by the client on native
Windows. The full workspace test suite passes on Windows (contracts 99, fixtures 15, client 554,
engine 855). The one hard blocker (the engine never started off a POSIX path) is fixed; the rest of
the darwin couplings degrade honestly and are catalogued below.

## Definition-of-explored checklist

- Engine builds and serves the HTTP/WS API on Windows, reachable from the client. **DONE** (verified:
  `GET /health` returns 200; `apps/client/src/engine-link/seam.test.ts` spawns the real engine, adopts
  it over the authenticated control plane, streams capture over WS, and flushes the spool, all green on
  Windows).
- Client boots and adopts the running engine or spawns the bundled one. **DONE** (the seam test proves
  adopt + credential discovery + WS; the supervisor's adopt-or-spawn logic is OS-neutral).
- Mic capture works or the gap is documented. **DOCUMENTED** (capture ingest is HTTP and OS-neutral; the
  Electron `desktopCapturer`/mic path is cross-platform, but native Windows capture-permission prompts
  and a real device run are not yet exercised here; see "What degrades").
- Screen capture works or the gap is documented. **DOCUMENTED** (same: `desktopCapturer` is cross-platform;
  macOS Screen-Recording TCC gating has no Windows equivalent wired).
- At least one STT endpoint transcribes end-to-end. **SEAM VERIFIED, real endpoint pending** (the stt
  interop seam and the whisper `/inference` + OpenAI-compatible adapters transcribe end-to-end against a
  fake runtime and a fake stt HTTP server in the suite, on Windows; a real `whisper-server` /
  OpenAI-compatible transcription of an audio clip needs that server installed on the box, which was not
  available here).
- Findings documented. **THIS FILE.**

## The one real blocker (fixed): the engine never started off a POSIX path

`apps/engine/src/main.ts` gated its entire startup on
`process.argv[1]?.endsWith('/main.js')`. On Windows `process.argv[1]` is backslash-separated
(`...\dist\main.js`), so the suffix check was always false and the daemon exited 0 without ever
binding a port. Fixed to compare the entry basename (`basename(process.argv[1]) === 'main.js'`), which
is separator-correct on every OS.

## Production fixes (affect the shipped daemon, not just tests)

- **Engine entry detection** (`apps/engine/src/main.ts`): the `isEntry` bug above.
- **Local-runtime binary discovery** (`apps/engine/src/fabric/endpoints/local.ts`): `findRuntimeBinary`
  searched PATH for bare names (`llama-server`, `whisper-server`, `omlx`). Windows executables carry an
  extension, so discovery found nothing even when a runtime was installed. It now probes each `PATHEXT`
  extension (`.exe`/`.cmd`/...) for a bare name on Windows, and the extra-search-dir list is
  OS-aware (Homebrew/`~/.local/bin` off Windows via `os.homedir()`, none on Windows where installers use
  PATH). The engine's `spawn(binary, args)` is already cross-platform for a real `.exe`.

## Build / test-infrastructure fixes (cross-platform, not Windows-only hacks)

- **Test-runner glob quoting** (`package.json` in engine, client, contracts, fixtures): `node --test
  'dist/**/*.test.js'` used single quotes. pnpm runs scripts through `cmd.exe` on Windows, where single
  quotes are literal, so node received the quotes and matched zero files (the suite silently "passed"
  with 0 tests). Switched to double quotes, which both `cmd.exe` and POSIX shells strip.
- **ESM dynamic import of an absolute path** (`tools/schema-gen/gen.mjs`): `await import(join(...))` fed a
  Windows path (`C:\...`) to the loader, which rejects it as an unsupported URL scheme `c:`. Wrapped in
  `pathToFileURL(...).href` (a no-op-shaped change on POSIX).
- **Line endings** (`.gitattributes`, new): the repo had none, so `core.autocrlf=true` checked text files
  out as CRLF on Windows. The schema-drift guard regenerates `schemas/*.json` (LF) and diffs byte-for-byte
  against the committed copies, so CRLF made it fail spuriously. `* text=auto eol=lf` forces LF checkout
  on every OS; binary types are pinned.

## Test-fixture portability fixes (POSIX assumptions in tests, production was fine)

- **Hardcoded POSIX path literals** vs `path.join`/`resolve` output (backslashes on Windows):
  `api/control-plane.test.ts` (discovery path), `main/engine-auth.test.ts` (discovery path),
  `main/engine-supervisor.test.ts` (`bundledEngineEntry`, `buildStampPath`). Expected values now built
  with `join`/`resolve`.
- **SQLite temp-DB teardown** (`EBUSY`): several tests `rm`'d a temp dir while a `WorkspaceRegistry`
  handle was still open (POSIX unlinks open files; Windows does not). Tests now `store.close()` before
  `rm`, in `finally`, with `maxRetries` to absorb the handle-release lag
  (`distill/guard.test.ts`, `distill/preset-injection.test.ts`, `api/context-assembly.test.ts`,
  `index/ingest/ingest.test.ts`). The ingest teardown had also masked a real assertion (see below).
- **`file://` URL without a drive letter** (`index/ingest/ingest.test.ts`): `fileURLToPath('file:///doc.txt')`
  throws on Windows (no drive), so the fixture now builds a host-valid URL via `pathToFileURL`. In
  production a real Windows file pin carries a drive-lettered URL and ingests; a POSIX-shaped `file://`
  URL on a Windows engine degrades honestly to `ingest.status: 'failed'`.
- **Spawned fake runtimes** (`ENOENT`): tests wrote a POSIX shebang script and spawned it directly, which
  Windows cannot exec. They now spawn it as `node <script> ...` (findBinary -> `process.execPath`), which
  exercises the same real spawn/ready/kill machinery on every OS
  (`fabric/endpoints/local.test.ts`, `fabric/local-invoke.test.ts`, `api/http.test.ts`). The PATH-discovery
  test writes a `.cmd` on Windows so `findRuntimeBinary` can discover it.
- **Concurrent-load timeout**: the seam integration test's 3s engine-startup poll was too tight when
  `pnpm -r test` spawns every package's suite at once (process spawn is slower under load on Windows).
  Bumped to 20s.

## What degrades (honest off-Windows/off-darwin behavior, not fixed here)

- **POSIX file permissions have no Windows equivalent.** The engine writes the control-plane discovery
  record and the secrets file as `0o600`, and the client refuses group/world-readable records
  (`assertOwnedPrivate`). On Windows `stat().mode` reads `0o666` and the owner-only checks are a
  deliberate no-op (`if (platform === 'win32') return`). Consequence: the discovery record, secrets file,
  and provisioned token file are NOT mode-restricted on Windows. Mitigation today: `~/.openinfo` lives
  under the per-user profile, which is ACL-protected by default. A first-class fix would set an owner-only
  NTFS ACL. Tests for these guards are now `process.platform`-gated.
- **Symlink hardening is weakened on Windows.** The client opens the record with `O_NOFOLLOW`, which is
  `undefined` on Windows, and symlink creation needs privilege there. The symlink-rejection guarantee is
  POSIX-only.
- **Foreground-window (context) read** (`apps/client/src/main/shell.ts` `readFrontmostWindow`) uses
  `osascript`; returns undefined off darwin. No Windows reader (`GetForegroundWindow` + `GetWindowText`
  via a native addon, or PowerShell) is wired.
- **Calendar routing signal** (`apps/engine/src/route/calendar-collector.ts`) is macOS JXA against
  Calendar.app; degrades to nothing on Windows (the collector logs it is watching but yields no events).
- **Media permissions** (`shell.ts`) use macOS TCC (`askForMediaAccess`); off darwin these fail open. No
  Windows capture-permission equivalent is implemented.
- **MLX / omlx** is Apple-Silicon-only by nature. Windows/WSL deployments must use `whisper.cpp`
  (`whisper-server`) or any OpenAI-compatible transcription server for stt, and `llama.cpp`
  (`llama-server.exe`) or an OpenAI-compatible chat server for llm.
- **Install hints** in `RUNTIME_SPECS` still say `brew install ...`. Discovery now works on Windows, but
  the honest "how to get it" line is macOS-worded. A per-OS hint (`winget`/`scoop`/direct download) is a
  small follow-up (left out here to avoid changing the macOS-pinned test assertion in the same pass).

## What is blocked

- **Real STT/LLM against a local model server**: needs `whisper-server` / `llama-server.exe` (or any
  OpenAI-compatible server) installed on the box. The seam, adapters, discovery, spawn, and end-to-end
  distill->moment flow are all proven with fakes on Windows; only a real-binary run is outstanding, and
  with the discovery fix it should now find `llama-server.exe` on PATH.
- **Packaging**: `apps/client/scripts/dmg.mjs` / `package.mjs` are macOS-only (`hdiutil`/`ditto`/
  `codesign`, `platform: 'darwin', arch: 'arm64'`). Windows needs its own packaging; "run from source" is
  the exploration baseline (below). Not attempted here.

## Recommended split

Two viable topologies:

1. **Native Windows client + engine in WSL2.** The engine is portable Node + HTTP with a POSIX-friendly
   data dir; it runs cleanly under WSL2/Ubuntu and keeps real `0o600`/symlink protections and PATH-based
   `whisper.cpp`/`llama.cpp` discovery. A native Windows Electron client points at it via
   `OPENINFO_ENGINE_URL` (or adopts it over the control plane). This keeps the security model intact and
   uses each OS for what it is good at.
2. **Full stack native on Windows.** Now unblocked for "run from source" (engine builds, serves, is
   adopted). The tradeoff is the permission-model gap above (no `0o600`) and the missing
   foreground-window / calendar / media-permission readers, all of which degrade honestly rather than
   crash.

Recommendation: treat **native client + WSL2 engine** as the primary self-hosting path (strongest
security parity, least surprising), and keep **native-Windows run-from-source** as the developer-friendly
secondary path with the documented degradations. WSLg (full stack inside Linux with the Electron client)
was not exercised and remains open.

## Run from source on Windows (baseline)

```powershell
corepack enable ; corepack prepare pnpm@9.15.4 --activate
pnpm install
pnpm -r build
pnpm -r test            # full suite, green on Windows
# start the engine (the user starts long-running processes):
$env:OPENINFO_PORT = '8787'
node apps/engine/dist/main.js
# then the client adopts it, or point a remote client at OPENINFO_ENGINE_URL
```
