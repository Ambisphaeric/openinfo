import { contextBridge, ipcRenderer } from 'electron'
import { CAPTURE_CHANNELS, type CaptureSourceKind, type CaptureStatus, type RawSegment } from './protocol.js'

/**
 * The hidden capture window's preload — the capture renderer's ONLY bridge to the main process. It
 * exposes `window.openinfoCapture` (the CaptureBridge in protocol.ts): the main process pushes
 * start/stop commands down (each tagged with its source — mic or system-audio), the renderer pushes
 * finished segments / status / stopped up. `contextIsolation` stays on and `nodeIntegration` off (only
 * these IPC channels cross — no node surface reaches the capture page), exactly the pattern the HUD drag
 * preload established (see preload.cts, incl. the `.cts` gotcha: the package is `type: module` but
 * Electron loads a `.js` preload as CommonJS, so `.cts` makes tsc emit a real `.cjs` that loads under
 * the default sandbox with contextBridge/ipcRenderer available).
 */
contextBridge.exposeInMainWorld('openinfoCapture', {
  onStart: (handler: (source: CaptureSourceKind) => void) =>
    ipcRenderer.on(CAPTURE_CHANNELS.start, (_event, source: CaptureSourceKind) => handler(source)),
  onStop: (handler: (source: CaptureSourceKind) => void) =>
    ipcRenderer.on(CAPTURE_CHANNELS.stop, (_event, source: CaptureSourceKind) => handler(source)),
  sendSegment: (segment: RawSegment) => ipcRenderer.send(CAPTURE_CHANNELS.segment, segment),
  sendStopped: (source: CaptureSourceKind) => ipcRenderer.send(CAPTURE_CHANNELS.stopped, source),
  sendStatus: (status: CaptureStatus) => ipcRenderer.send(CAPTURE_CHANNELS.status, status),
})
