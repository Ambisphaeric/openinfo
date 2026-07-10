import type { ScreenFrameMeta } from '@openinfo/contracts'
import type { ChunkStrategy } from './vad.js'

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

/**
 * HOW the system-audio ("them") stream is opened (#142) — the two live capture paths, both feeding the
 * identical MediaRecorder/VAD/chunk pipeline downstream (only *how the second stream opens* differs, exactly
 * the source-agnostic seam ARCHITECTURE §8 set up):
 *   - `loopback` — the NO-ROUTING path: Chromium's macOS CoreAudio-Tap (`getDisplayMedia({audio:'loopback'})`,
 *     macOS 13+/Electron; rides the Screen-&-System-Audio-Recording TCC grant + an `NSAudioCaptureUsageDescription`
 *     Info.plist key). Zero virtual-device install, zero Multi-Output routing — the far side is captured
 *     out of the box once the one-time recording grant is given. A missing grant/plist yields a DEAD
 *     (digital-silence) stream, which the existing silence probe already flags honestly rather than faking.
 *   - `device` — the BlackHole-class virtual-input path (the shipped floor): a 2nd `getUserMedia` on a matched
 *     loopback INPUT device (device-match.ts). Needs the user to install + route output through it, but needs
 *     no OS recording grant. The honest fallback for pre-13 macOS or when loopback capture is refused.
 * `auto` (config-level, resolved in main/config.ts) picks `loopback` on macOS, `device` elsewhere; the
 * RESOLVED value is what travels here, so the renderer never re-derives platform.
 */
export type SystemAudioMethod = 'loopback' | 'device'

/** The IPC channels. `capture:*` generalizes the drag bridge's `hud:*` naming (see preload.cts). */
export const CAPTURE_CHANNELS = {
  /**
   * main → renderer: begin capturing a source (a session went live). The message carries the source AND
   * a CaptureStartOptions payload — the config-resolved segment length (#57) — so the renderer records at
   * the configured cadence rather than a hardcoded default. Extends the existing start message rather than
   * adding a channel; the preload forwards the extra arg untouched (its channel strings stay inlined).
   */
  start: 'capture:start',
  /** main → renderer: stop a source and flush its final in-flight segment (the session ended). */
  stop: 'capture:stop',
  /** renderer → main: one completed, independently-decodable audio segment for a source. */
  segment: 'capture:segment',
  /** renderer → main: a source has fully stopped (its final segment was already sent). */
  stopped: 'capture:stopped',
  /** renderer → main: a permission/lifecycle/device status change for a source. */
  status: 'capture:status',
  /**
   * renderer → main: the capture module loaded and registered its start/stop listeners (issue #41). Sent
   * ONCE on module load, BEFORE any getUserMedia. The main process gates every `start` on having heard
   * this, so a start can never again race the renderer's listener registration and be silently dropped.
   */
  loaded: 'capture:loaded',
  /**
   * renderer → main: acknowledgement that a `start` command was RECEIVED for a source (issue #41). The
   * main process retries the send until this arrives (or times out into a visible fault), so a dropped
   * start is detected instead of leaving the controller wedged in `starting` forever.
   */
  startAck: 'capture:start-ack',
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
 * Options the main process sends WITH a `capture:start` (issue #57). Today it carries only the segment
 * cadence; it exists as its own shape so future per-start knobs extend it without touching the channel.
 * OPTIONAL end-to-end: a start with no options (e.g. an older/partial message) leaves the renderer on its
 * built-in default, so the handshake never depends on the payload arriving.
 */
export interface CaptureStartOptions {
  /**
   * Nominal segment length in ms — how long the renderer records before stopping/restarting to cut one
   * complete webm file. Resolved client-side (ShellConfig.segmentMs, env > file > 1000) and echoed into
   * each chunk's `durationMs`. The renderer clamps a non-positive/garbage value to its own default. Used
   * by the `fixed` chunk strategy; ignored (except as the durationMs echo) under `vad`.
   */
  segmentMs: number
  /**
   * How the renderer decides WHERE to cut a segment (#95). `vad` cuts at detected pauses (the measured
   * default — a cut in silence never splits a word); `fixed` keeps the old wall-clock `segmentMs` cadence.
   * OPTIONAL + append-only: a start with no strategy leaves the renderer on its built-in fallback, so the
   * handshake never depends on the field arriving. Resolved client-side (ShellConfig.chunkStrategy).
   */
  chunkStrategy?: ChunkStrategy
  /**
   * VAD knobs (#95), forwarded only when `chunkStrategy` is `vad`. All optional — each falls back to the
   * renderer's measured default (capture/vad.ts DEFAULT_VAD_PARAMS) via resolveVadParams. See config.ts
   * for the env/file resolution. Held flat (not a sub-object) to mirror how segmentMs already travels.
   */
  vadSilenceHoldMs?: number
  vadMinSegmentMs?: number
  vadMaxSegmentMs?: number
  vadSilencePeak?: number
  /**
   * HOW to open the system-audio stream (#142) — `loopback` (Chromium CoreAudio-Tap, no routing) or
   * `device` (a matched BlackHole-class virtual input). RESOLVED client-side from config (auto → loopback
   * on macOS, else device). OPTIONAL + append-only: a start with no method leaves the renderer on its
   * built-in fallback (`device` — the historical behaviour), so the handshake never depends on it arriving.
   * IGNORED for the mic source (mic is always the default `getUserMedia` input).
   */
  systemAudioMethod?: SystemAudioMethod
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
  /**
   * Subscribe to the main process's "start capturing <source>" command. The handler also receives the
   * CaptureStartOptions the main process sent (the configured segment cadence, #57); it is optional so a
   * start that arrives without a payload still drives capture on the renderer's built-in default.
   */
  onStart(handler: (source: CaptureSourceKind, options?: CaptureStartOptions) => void): void
  /** Subscribe to the main process's "stop capturing <source>" command. */
  onStop(handler: (source: CaptureSourceKind) => void): void
  /** Send a finished segment up to the main process. */
  sendSegment(segment: RawSegment): void
  /** Signal that a source's capture has fully stopped (final segment already sent). */
  sendStopped(source: CaptureSourceKind): void
  /** Report a permission/lifecycle/device status change for a source. */
  sendStatus(status: CaptureStatus): void
  /** Ping that the module loaded and registered its listeners — the readiness handshake (issue #41). */
  sendLoaded(): void
  /** Acknowledge that a `start` command was received for a source — the start-ack (issue #41). */
  sendStartAck(source: CaptureSourceKind): void
}
