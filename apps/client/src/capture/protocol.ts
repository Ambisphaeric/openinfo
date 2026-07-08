/**
 * The capture IPC protocol — the narrow contract between the ONE hidden capture renderer and the main
 * process, kept in one pure module so the channel names and payload shapes are a single source of truth
 * (asserted in tests) and neither side drifts. getUserMedia needs a renderer, so the actual audio lives
 * in a hidden BrowserWindow; it hands finished audio segments up to the main process over these
 * channels, and the main process wraps them as CaptureChunks (see chunk.ts) onto EngineLink.
 *
 * TWO sources share this ONE window/renderer/preload: `mic` (the user — "me") and `system-audio` (the
 * far side of a call captured off a BlackHole-like virtual input — "them"). Every message therefore
 * carries a `source` discriminator; the main process runs one source-agnostic controller per source
 * (capture-controller.ts) and the renderer holds one recorder per source. The `capture:*` channel names
 * generalize the old `mic:*` set now that the module is no longer mic-only.
 *
 * Coordinate/electron-free: this file imports nothing from electron and holds only data, so the pure
 * controller (capture-controller.ts) and its tests use it without a display or a real BrowserWindow.
 */

/** The two audio sources that ride this one window. Matches the engine's `CaptureSource` literals. */
export type CaptureSourceKind = 'mic' | 'system-audio'

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
 * A finished audio segment as the renderer produces it — the raw container bytes plus the MIME the
 * MediaRecorder emitted and the wall-clock the segment started. The main process turns this into a
 * base64 CaptureChunk; the renderer never sees session/workspace ids (the main process owns those).
 * `bytes` is transferred structured-clone over IPC as an ArrayBuffer.
 */
export interface RawSegment {
  /** Which stream produced this segment — mic ("me") or system-audio ("them"). */
  source: CaptureSourceKind
  bytes: ArrayBuffer
  mimeType: string
  /** ISO-8601 wall-clock at which this segment's recording began. */
  capturedAt: string
  /** Nominal segment length in ms (the last, flushed segment may be shorter). */
  durationMs?: number
  /**
   * Whether the renderer measured this segment as pure silence (peak amplitude below a small floor).
   * Set only for `system-audio` (a BlackHole input with no output routed through it emits digital
   * silence — the common not-yet-set-up state); the controller uses it to be honest instead of
   * claiming to record the room. Undefined for `mic` (no silence gating — the mic path is unchanged).
   */
  silent?: boolean
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
