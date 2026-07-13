# client/main — the Electron shell (Phase-1 home, landed post-Phase-2)

The Mac menu-bar app that hosts the document-driven HUD. Logic is pure + node-tested (CI has no
display); `shell.ts` is the only file that imports `electron`, and tests never import it.

| File | Concern |
|---|---|
| `config.ts` | Resolve engine URL + workspace/mode/surface from env (client-local config, **not** a flag). |
| `engine-auth.ts` | Validate owner-only per-port discovery, attach Bearer only to loopback HTTP / HTTPS, reload once on `401`, and encode WS auth without URL credentials. |
| `renderer-engine-auth.ts` | One exact-origin Electron-session listener; strips renderer Authorization and injects the real credential only for explicitly trusted built-in `webContents`. Also exchanges one-use Settings browser tickets. |
| `window-options.ts` | The HUD `BrowserWindow` options + method-only hardening (content-protection, always-on-top, all-workspaces). |
| `window-position.ts` | Pure drag geometry (cursor-follow) + saved-position (de)serialize + on-screen validation against displays. |
| `window-store.ts` | The thin IO edge — read/write the remembered position as a tiny JSON under `userData` (client-local, not a flag). |
| `preload.cts` | The renderer's only bridge (`contextBridge`): a coordinate-free drag start/end channel. `.cts` → CommonJS preload. |
| `tray-menu.ts` | The tray (menu-bar) state machine: Show/Hide, Start/End Session, Quit, and the live-session indicator. |
| `shortcuts.ts` | Global shortcut → command map. ⌘\ toggles HUD visibility (the inherited Glass bind). |
| `engine-session.ts` | `EngineSessionClient` (session start/end/list over the API, injected `fetch`) + `SessionLiveState` (live from WS events). |
| `tray-icon.ts` | The menu-bar template PNG, embedded as base64 (no binary asset). |
| `shell.ts` | The `electron`-importing entry — wires the pure modules into a real window + tray + shortcuts. |

Run it: `pnpm --filter @openinfo/client start` (builds, then `electron .`) against a local running engine.
`OPENINFO_ENGINE_URL` / `OPENINFO_PORT` select the daemon origin; the supported product path loads its
per-launch credential from the matching owner-only `~/.openinfo/run/engine-<port>.json`. The window opens hidden; ⌘\ or the
tray's Show HUD reveals it. Drag it by its header strip (the `.hudtop` context line) to reposition; the
spot is remembered across restarts (restored only if still on a connected display, else re-centered). The renderer loads `apps/client/hud.html`, which hosts the same compiled
HUD dev entry the browser harness uses — it talks to the engine over the browser `HudTransport`
(fetch + WebSocket), never `EngineLink` (which is node-bound). Electron main injects auth after requests
leave trusted renderer JavaScript and opens Settings through a one-use browser ticket. The client NEVER
opens a database.

Engine tunnel mode requires HTTPS and an explicit `OPENINFO_CONTROL_TOKEN` or owner-only
`OPENINFO_CONTROL_TOKEN_FILE`. Keychain-backed setup UI is not built yet. The standalone browser HUD
likewise cannot read discovery or inject WS auth without an explicit browser-session bootstrap.
