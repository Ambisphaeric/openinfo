import { contextBridge, ipcRenderer } from 'electron'
import { MIC_CHANNELS, type MicStatus, type RawSegment } from './protocol.js'

/**
 * The hidden capture window's preload — the mic renderer's ONLY bridge to the main process. It
 * exposes `window.openinfoMic` (the MicBridge in protocol.ts): the main process pushes start/stop
 * commands down, the renderer pushes finished segments / status up. `contextIsolation` stays on and
 * `nodeIntegration` off (only these IPC channels cross — no node surface reaches the capture page),
 * exactly the pattern the HUD drag preload established (see preload.cts, incl. the `.cts` gotcha:
 * the package is `type: module` but Electron loads a `.js` preload as CommonJS, so `.cts` makes tsc
 * emit a real `.cjs` that loads under the default sandbox with contextBridge/ipcRenderer available).
 */
contextBridge.exposeInMainWorld('openinfoMic', {
  onStart: (handler: () => void) => ipcRenderer.on(MIC_CHANNELS.start, () => handler()),
  onStop: (handler: () => void) => ipcRenderer.on(MIC_CHANNELS.stop, () => handler()),
  sendSegment: (segment: RawSegment) => ipcRenderer.send(MIC_CHANNELS.segment, segment),
  sendStopped: () => ipcRenderer.send(MIC_CHANNELS.stopped),
  sendStatus: (status: MicStatus) => ipcRenderer.send(MIC_CHANNELS.status, status),
})
