import { contextBridge, ipcRenderer } from 'electron'

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
