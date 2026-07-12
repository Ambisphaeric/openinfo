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
