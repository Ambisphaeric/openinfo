import { contextBridge, ipcRenderer, webUtils } from 'electron'

/**
 * The HUD renderer's ONLY bridge to the main process — a two-verb drag channel, nothing more. The
 * shell slice deliberately shipped no preload (the HUD reads the engine over HTTP+WS like any browser,
 * needing no node APIs — see PHASE2-NOTES). Dragging is the one thing the renderer cannot do itself: a
 * `focusable: false`, frameless window can't use CSS `-webkit-app-region: drag` on macOS, so moving it
 * must happen in the main process. This exposes a coordinate-free start/end — the main process reads
 * the live cursor and moves the window (see shell.ts + window-position.ts) — keeping `contextIsolation`
 * on and `nodeIntegration` off (only these channels cross, no node surface reaches the page).
 *
 * `resize` rides the same bridge: the frameless, transparent HUD is CONTENT-sized (see auto-resize.ts +
 * shell.ts), and like dragging, only the main process can change the window's bounds — the renderer just
 * reports the measured content height and main applies it (top-anchored). Same one-way, coordinate-light
 * shape as the drag verbs.
 *
 * `panel` (#134) rides it too: an attached-expansion-panel surface reports the collapsed/expanded content
 * size along its edge ({height} for a below-panel, {width} for a right-sidebar) and the main process sets
 * exactly that axis, keeping the other — the same one-way shape. Only panel surfaces send it.
 *
 * `openinfoFiles.getPathForFile` (basics wave B / S2) is the ONE thing the renderer genuinely cannot do
 * itself post-Electron-32: `File.path` was removed, so a picked/dropped file no longer carries its local
 * filesystem path, and the input block's attach flow (input-submit.ts → the engine's pins/ingest) went
 * silently inert. Electron's replacement, `webUtils.getPathForFile(file)`, is a renderer-process API that
 * must run behind the context-isolation boundary — so we expose it here (the pattern the Electron docs
 * prescribe) and the attach module reads it off `window.openinfoFiles`. It returns '' for a File with no
 * backing file on disk (one built in JS), which the attach module treats as "no path" → honest failure.
 *
 * Authored as `.cts` (→ compiled `preload.cjs`): the client package is `type: module`, but Electron
 * loads a `.js` preload as CommonJS, so an ESM preload would fail to parse. `.cts` makes tsc emit real
 * CommonJS, which loads under the default sandbox with `contextBridge`/`ipcRenderer` available.
 */
contextBridge.exposeInMainWorld('openinfoDrag', {
  start: () => ipcRenderer.send('hud:drag-start'),
  end: () => ipcRenderer.send('hud:drag-end'),
  resize: (height: number) => ipcRenderer.send('hud:resize', height),
  panel: (size: { width?: number; height?: number }) => ipcRenderer.send('hud:panel-size', size),
})

contextBridge.exposeInMainWorld('openinfoFiles', {
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
})

/**
 * The Ask face capture bridge (screenshot-on-every-send). `captureFrame` asks the MAIN process for ONE
 * still frame of the primary display — desktopCapturer is main-only, exactly like dragging/resizing, so
 * this is the third thing the renderer genuinely cannot do itself. The main handler enforces the consent
 * gate (screen sense granted AND enabled) and answers an honest discriminated outcome:
 *   { ok: true, frame: { contentType, data } }   — one base64 frame, captured for THIS send.
 *   { ok: false, reason: '…' }                    — no frame, with the human WHY (sense off / not granted /
 *                                                   no frame available) the send path discloses.
 * One invoke per explicit user send — the renderer never polls this (no ambient capture on this channel).
 */
contextBridge.exposeInMainWorld('openinfoScreen', {
  captureFrame: (): Promise<unknown> => ipcRenderer.invoke('hud:capture-frame'),
})

/**
 * The pill's SHELL bridge (the-pill) — the renderer's one-way ask to open the EXISTING settings surface.
 * The pill's settings-on-hover affordance must reach the SAME path the tray's "Settings…" opens (main
 * process → `shell.openExternal(${engineUrl}/settings)`); a `contextIsolation` renderer cannot open an
 * external URL itself, so — like drag/resize/capture — it sends a coordinate-free signal main honors. It
 * is NOT a new settings UI: it opens the one the tray already opens. Fire-and-forget; a build without the
 * main handler is an honest no-op.
 */
contextBridge.exposeInMainWorld('openinfoShell', {
  openSettings: (): void => ipcRenderer.send('hud:open-settings'),
})

/**
 * The #136 SESSION bridge — the on-surface session control's reach to the shell. Starting/ending a session
 * grants/revokes capture CONSENT and drives capture, both main-only (the #41 boundary), so — like
 * drag/capture/settings — the renderer sends a coordinate-free signal main honors on the SAME command path
 * the tray's Start/End Session item uses (shell.ts `dispatch('start-session')` / `end-session`): one session
 * lifecycle, one consent gate. `state()` returns the latest READINESS main pushed over `hud:session-state`
 * (engine reachable? skew-refused? capture health?), which the control renders as its honest live/disabled
 * state. Cached here so the renderer reads it synchronously each paint; before the first push it is the
 * honest "not ready yet" default. A build without the main handlers leaves start/stop inert (honest no-op).
 */
let sessionState: { ready: boolean; reason?: string; capture?: { tone: 'rec' | 'warn'; note: string } } = {
  ready: false,
  reason: 'Connecting to the engine…',
}
ipcRenderer.on('hud:session-state', (_event, snapshot: typeof sessionState) => {
  if (snapshot && typeof snapshot.ready === 'boolean') sessionState = snapshot
})
contextBridge.exposeInMainWorld('openinfoSession', {
  start: (): void => ipcRenderer.send('hud:session-start'),
  stop: (): void => ipcRenderer.send('hud:session-stop'),
  state: (): typeof sessionState => sessionState,
})
