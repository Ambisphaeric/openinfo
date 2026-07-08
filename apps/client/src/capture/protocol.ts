import type { ScreenFrameMeta } from '@openinfo/contracts'

/**
 * The capture IPC protocol — the narrow contract between the ONE hidden capture renderer and the main
 * process, kept in one pure module so the channel names and payload shapes are a single source of truth
 * (asserted in tests) and neither side drifts. getUserMedia needs a renderer, so the actual audio lives
 * in a hidden BrowserWindow; it hands finished audio segments up to the main process over these
 * channels, and the main process wraps them as CaptureChunks (see chunk.ts) onto EngineLink.
 *
 * TWO AUDIO sources share this ONE window/renderer/preload: `mic` (the user — "me") and `system-audio`
 * (the far side of a call captured off a BlackHole-like virtual input — "them"). Every IPC message
 * carries a `source` discriminator; the main process runs one source-agnostic controller per source
 * (capture-controller.ts) and the renderer holds one recorder per source. The `capture:*` channel names
 * generalize the old `mic:*` set now that the module is no longer mic-only.
 *
 * `screen` is the THIRD source (P4B) and the odd one out: it does NOT ride this hidden renderer or these
 * IPC channels. A screen frame is an IMAGE, and the cheapest, dependency-free way to grab still frames on
 * a cadence is the MAIN process (`desktopCapturer` → `NativeImage.toJPEG`), so screen frames never touch
 * getUserMedia/getDisplayMedia. It still flows through the SAME source-parametric machinery downstream —
 * it is a `CaptureSourceKind`, its frames are `RawSegment`s (bytes = JPEG), and it drives its own
 * `CaptureController` — so the only thing it doesn't share is this renderer/IPC edge. That is why the
 * `capture:*` channels below carry only the two audio sources in practice even though the type admits
 * `screen`.
 *
 * Coordinate/electron-free: this file imports nothing from electron and holds only data (a type-only
 * import of the ScreenFrameMeta contract aside), so the pure controller (capture-controller.ts) and its
 * tests use it without a display or a real BrowserWindow.
 */

/**
 * The capture sources. `mic`/`system-audio` are AUDIO and ride the hidden renderer (above); `screen` is
 * an IMAGE source captured in the main process (see header). All three match the engine's `CaptureSource`
 * literals and share the RawSegment→chunk→controller machinery.
 */
export type CaptureSourceKind = 'mic' | 'system-audio' | 'screen'

/** The IPC channels. `capture:*` generalizes the drag bridge's `hud:*` naming (see preload.cts). */
export const CAPTURE_CHANNELS = {
  /** main → renderer: begin capturing a source (a session went live). */
  start: 'capture:start',
  /** main → renderer: stop a source and flush its final in-flight segment (the session ended). */
  stop: 'capture:stop',
  /** renderer → main: one completed, independently-decodable audio segment for a source. */
  segment: 'capture:segment',
  /** renderer → main: a source has fully stopped (its final segment was already sent). */
  stopped: 'capture:stopped',
  /** renderer → main: a permission/lifecycle/device status change for a source. */
  status: 'capture:status',
} as const

/**
 * One finished capture segment as its producer hands it up. For AUDIO (`mic`/`system-audio`) it is the
 * raw container bytes the renderer's MediaRecorder emitted plus its MIME and start wall-clock. For
 * `screen` it is ONE still frame the main process grabbed (`bytes` = the JPEG, `mimeType` = 'image/jpeg')
 * plus its `screenMeta`. Either way the main process turns it into a CaptureChunk (chunk.ts); the
 * producer never sees session/workspace ids (the main process owns those). `bytes` is transferred
 * structured-clone over IPC as an ArrayBuffer (audio) or handed directly in-process (screen).
 */
export interface RawSegment {
  /** Which stream produced this segment — mic ("me"), system-audio ("them"), or screen (a still frame). */
  source: CaptureSourceKind
  bytes: ArrayBuffer
  mimeType: string
  /** ISO-8601 wall-clock at which this segment's recording began (audio) / the frame was grabbed (screen). */
  capturedAt: string
  /** Nominal segment length in ms (the last, flushed segment may be shorter). Unused for screen frames. */
  durationMs?: number
  /**
   * Whether the renderer measured this segment as pure silence (peak amplitude below a small floor).
   * Set only for `system-audio` (a BlackHole input with no output routed through it emits digital
   * silence — the common not-yet-set-up state); the controller uses it to be honest instead of
   * claiming to record the room. Undefined for `mic`/`screen` (no silence gating).
   */
  silent?: boolean
  /**
   * Screen-only: the frame's typed descriptor (which display, pixel dimensions, backing scale). Present
   * ONLY for `source: 'screen'`; when present, the controller emits it as the companion `source:'screen'`
   * utf8/json ScreenFrameMeta CaptureChunk alongside the image chunk (records/screen.ts). Undefined for
   * audio, so the companion-chunk emission is a strict no-op on the mic/system-audio paths. `deltaScore`
   * is left unset — the Δ-gate that would populate it is future (records/screen.ts).
   */
  screenMeta?: ScreenFrameMeta
}

/**
 * Renderer → main lifecycle signal, per source. `ready` = getUserMedia succeeded; `no-device` = the
 * source has no capturable input on this machine (system-audio found no BlackHole-like device — a
 * benign absence, NOT an error); the rest are terminal-ish. This is the "expose presence/absence to
 * the main process over the existing status IPC shape" path from the design note.
 */
export type CaptureStatus =
  | { source: CaptureSourceKind; state: 'ready' }
  | { source: CaptureSourceKind; state: 'no-device' }
  | { source: CaptureSourceKind; state: 'permission-denied' }
  | { source: CaptureSourceKind; state: 'error'; detail: string }

/**
 * The surface the capture preload exposes on `window.openinfoCapture` (contextBridge). The renderer
 * script reads it off `globalThis`; the preload wires each method to the channels above, tagging every
 * message with its source. Declared here so the renderer and the preload agree without importing each
 * other.
 */
export interface CaptureBridge {
  /** Subscribe to the main process's "start capturing <source>" command. */
  onStart(handler: (source: CaptureSourceKind) => void): void
  /** Subscribe to the main process's "stop capturing <source>" command. */
  onStop(handler: (source: CaptureSourceKind) => void): void
  /** Send a finished segment up to the main process. */
  sendSegment(segment: RawSegment): void
  /** Signal that a source's capture has fully stopped (final segment already sent). */
  sendStopped(source: CaptureSourceKind): void
  /** Report a permission/lifecycle/device status change for a source. */
  sendStatus(status: CaptureStatus): void
}
