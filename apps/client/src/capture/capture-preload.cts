import { contextBridge, ipcRenderer } from 'electron'
import type { CaptureSourceKind, CaptureStartOptions, CaptureStatus, RawSegment } from './protocol.js'

/**
 * The hidden capture window's preload — the capture renderer's ONLY bridge to the main process. It
 * exposes `window.openinfoCapture` (the CaptureBridge in protocol.ts): the main process pushes
 * start/stop commands down (each tagged with its source — mic or system-audio), the renderer pushes
 * finished segments / status / stopped / loaded / start-ack up. `contextIsolation` stays on and
 * `nodeIntegration` off (only these IPC channels cross — no node surface reaches the capture page).
 *
 * Authored as `.cts` (→ compiled `capture-preload.cjs`): the client package is `type: module`, but
 * Electron loads a `.js` preload as CommonJS, so an ESM preload would fail to parse. `.cts` makes tsc
 * emit real CommonJS, which loads under the default sandbox with `contextBridge`/`ipcRenderer` available.
 *
 * SELF-CONTAINED CHANNEL STRINGS (issue #41): a preload runs under Electron's DEFAULT sandbox, where
 * `require` reaches only `electron` + a few builtins — NOT sibling app modules. Importing the channel
 * constants from `./protocol.js` (an ESM sibling) therefore FAILS to load the whole preload, leaving
 * `window.openinfoCapture` undefined and every capture chunk silently unsent (no bridge, no log). So the
 * channel strings are inlined here as literals — exactly the pattern the HUD drag preload uses — with
 * `protocol.ts` (CAPTURE_CHANNELS) staying the typed source of truth these MUST match (asserted in
 * capture-controller.test.ts). Only `import type` crosses to protocol.ts, and types are fully erased at
 * compile time, so the emitted `.cjs` imports nothing but `electron`.
 */
const CHANNELS = {
  start: 'capture:start',
  stop: 'capture:stop',
  segment: 'capture:segment',
  stopped: 'capture:stopped',
  status: 'capture:status',
  loaded: 'capture:loaded',
  startAck: 'capture:start-ack',
} as const

contextBridge.exposeInMainWorld('openinfoCapture', {
  onStart: (handler: (source: CaptureSourceKind, options?: CaptureStartOptions) => void) =>
    ipcRenderer.on(CHANNELS.start, (_event, source: CaptureSourceKind, options?: CaptureStartOptions) => handler(source, options)),
  onStop: (handler: (source: CaptureSourceKind) => void) =>
    ipcRenderer.on(CHANNELS.stop, (_event, source: CaptureSourceKind) => handler(source)),
  sendSegment: (segment: RawSegment) => ipcRenderer.send(CHANNELS.segment, segment),
  sendStopped: (source: CaptureSourceKind) => ipcRenderer.send(CHANNELS.stopped, source),
  sendStatus: (status: CaptureStatus) => ipcRenderer.send(CHANNELS.status, status),
  sendLoaded: () => ipcRenderer.send(CHANNELS.loaded),
  sendStartAck: (source: CaptureSourceKind) => ipcRenderer.send(CHANNELS.startAck, source),
})
