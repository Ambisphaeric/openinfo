/**
 * The mic-capture IPC protocol — the narrow contract between the hidden capture renderer and the main
 * process, kept in one pure module so the channel names and payload shapes are a single source of
 * truth (asserted in tests) and neither side drifts. getUserMedia needs a renderer, so the actual
 * microphone lives in a hidden BrowserWindow; it hands finished audio segments up to the main process
 * over these channels, and the main process wraps them as CaptureChunks (see chunk.ts) onto EngineLink.
 *
 * Coordinate/electron-free: this file imports nothing from electron and holds only data, so the pure
 * controller (mic-controller.ts) and its tests use it without a display or a real BrowserWindow.
 */

/** The IPC channels. `mic:*` mirrors the drag bridge's `hud:*` naming (see preload.cts). */
export const MIC_CHANNELS = {
  /** main → renderer: begin capturing (a session went live). */
  start: 'mic:start',
  /** main → renderer: stop capturing and flush the final in-flight segment (the session ended). */
  stop: 'mic:stop',
  /** renderer → main: one completed, independently-decodable audio segment. */
  segment: 'mic:segment',
  /** renderer → main: capture has fully stopped (the final segment was already sent). */
  stopped: 'mic:stopped',
  /** renderer → main: a permission/lifecycle status change. */
  status: 'mic:status',
} as const

/**
 * A finished audio segment as the renderer produces it — the raw container bytes plus the MIME the
 * MediaRecorder emitted and the wall-clock the segment started. The main process turns this into a
 * base64 CaptureChunk; the renderer never sees session/workspace ids (the main process owns those).
 * `bytes` is transferred structured-clone over IPC as an ArrayBuffer.
 */
export interface RawSegment {
  bytes: ArrayBuffer
  mimeType: string
  /** ISO-8601 wall-clock at which this segment's recording began. */
  capturedAt: string
  /** Nominal segment length in ms (the last, flushed segment may be shorter). */
  durationMs?: number
}

/** Renderer → main lifecycle signal. `ready` = getUserMedia succeeded; the rest are terminal-ish. */
export type MicStatus =
  | { state: 'ready' }
  | { state: 'permission-denied' }
  | { state: 'error'; detail: string }

/**
 * The surface the mic preload exposes on `window.openinfoMic` (contextBridge). The renderer script
 * reads it off `globalThis`; the preload wires each method to the channels above. Declared here so
 * the renderer and the preload agree without importing each other.
 */
export interface MicBridge {
  /** Subscribe to the main process's "start capturing" command. */
  onStart(handler: () => void): void
  /** Subscribe to the main process's "stop capturing" command. */
  onStop(handler: () => void): void
  /** Send a finished segment up to the main process. */
  sendSegment(segment: RawSegment): void
  /** Signal that capture has fully stopped (final segment already sent). */
  sendStopped(): void
  /** Report a permission/lifecycle status change. */
  sendStatus(status: MicStatus): void
}
