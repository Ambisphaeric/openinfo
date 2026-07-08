import type { MicBridge } from './protocol.js'

/**
 * The hidden capture window's renderer — the one place getUserMedia can run (it needs a Chromium
 * renderer). It listens for start/stop over the preload bridge (window.openinfoMic), records the mic
 * in fixed-length segments, and hands each finished segment up to the main process, which wraps it as
 * a CaptureChunk (chunk.ts) and sends it via EngineLink. This window is never shown and has no
 * content to protect; it exists purely to host the microphone.
 *
 * NOT unit-tested by CI (it drives browser globals — MediaRecorder/getUserMedia — with no DOM in the
 * node test env), mirroring shell.ts/mount.ts. Its behaviour is verified live (see PHASE2-NOTES). The
 * decision-bearing logic that CAN be pure — segment→chunk assembly and the lifecycle state machine —
 * lives in chunk.ts / mic-controller.ts, which ARE tested. Typed against a minimal structural subset
 * of the browser globals via one globalThis cast, so the file stays in the node-typed package (the
 * same trick mount.ts uses) rather than pulling in lib.dom (which collides with @types/node globals).
 *
 * Segmenting = stop/restart, not timeslice. MediaRecorder's `timeslice` emits fragments of ONE webm
 * stream; only the first fragment carries the container header, so later fragments are not
 * independently decodable — an STT server can't transcribe them alone. Stopping and immediately
 * restarting the recorder yields a COMPLETE, self-contained webm file per segment (a header + its
 * data), which is exactly what `/v1/audio/transcriptions` needs. The sub-frame gap at each boundary
 * is negligible for speech (the engine re-merges chunks into 30s–2m distill windows anyway).
 */

/** Segment length: 8s — within the 5–10s band. Long enough to amortize per-request + stop/restart */
/** overhead and keep boundaries rare; short enough that audio reaches the engine promptly and the */
/** flushed final segment on session-end is small. The engine merges chunks into larger windows. */
const SEGMENT_MS = 8_000

interface BlobLike {
  size: number
  type: string
  arrayBuffer(): Promise<ArrayBuffer>
}
interface BlobCtor {
  new (parts: BlobLike[], options?: { type?: string }): BlobLike
}
interface MediaStreamLike {
  getTracks(): Array<{ stop(): void }>
}
interface MediaRecorderLike {
  state: string
  mimeType: string
  ondataavailable: ((event: { data: BlobLike }) => void) | null
  onstop: (() => void) | null
  onerror: ((event: { error?: { message?: string } }) => void) | null
  start(timeslice?: number): void
  stop(): void
}
interface MediaRecorderCtor {
  new (stream: MediaStreamLike, options?: { mimeType?: string }): MediaRecorderLike
  isTypeSupported(type: string): boolean
}
interface CaptureGlobals {
  navigator: { mediaDevices: { getUserMedia(constraints: unknown): Promise<MediaStreamLike> } }
  MediaRecorder: MediaRecorderCtor
  Blob: BlobCtor
  openinfoMic?: MicBridge
}

const g = globalThis as unknown as CaptureGlobals

/** Prefer opus in webm; fall back to whatever this Chromium supports for audio. */
const pickMimeType = (): string => {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
  for (const type of candidates) {
    try {
      if (g.MediaRecorder.isTypeSupported(type)) return type
    } catch {
      /* isTypeSupported can throw on odd inputs — try the next */
    }
  }
  return 'audio/webm'
}

let stream: MediaStreamLike | undefined
let recorder: MediaRecorderLike | undefined
let running = false

const stopStream = (): void => {
  for (const track of stream?.getTracks() ?? []) track.stop()
  stream = undefined
  recorder = undefined
}

/** Record one segment; on stop, ship it and (if still running) begin the next — else confirm stopped. */
const cycle = (bridge: MicBridge): void => {
  if (!running || !stream) return
  const parts: BlobLike[] = []
  const rec = new g.MediaRecorder(stream, { mimeType: pickMimeType() })
  recorder = rec
  const capturedAt = new Date().toISOString()
  rec.ondataavailable = (event): void => {
    if (event.data.size > 0) parts.push(event.data)
  }
  rec.onstop = (): void => {
    void (async (): Promise<void> => {
      const blob = new g.Blob(parts, { type: rec.mimeType })
      if (blob.size > 0) {
        const bytes = await blob.arrayBuffer()
        bridge.sendSegment({ bytes, mimeType: rec.mimeType, capturedAt, durationMs: SEGMENT_MS })
      }
      if (running) cycle(bridge)
      else {
        stopStream()
        bridge.sendStopped()
      }
    })()
  }
  rec.onerror = (event): void => {
    bridge.sendStatus({ state: 'error', detail: event.error?.message ?? 'MediaRecorder error' })
  }
  rec.start()
  setTimeout(() => {
    if (rec.state !== 'inactive') rec.stop()
  }, SEGMENT_MS)
}

const start = (bridge: MicBridge): void => {
  if (running) return
  g.navigator.mediaDevices
    .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } })
    .then((granted) => {
      stream = granted
      running = true
      bridge.sendStatus({ state: 'ready' })
      cycle(bridge)
    })
    .catch((err: { name?: string; message?: string }) => {
      // NotAllowedError / SecurityError = the user or the OS refused; anything else is an error.
      if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
        bridge.sendStatus({ state: 'permission-denied' })
      } else {
        bridge.sendStatus({ state: 'error', detail: err?.message ?? err?.name ?? 'getUserMedia failed' })
      }
    })
}

const stop = (bridge: MicBridge): void => {
  if (!running) {
    bridge.sendStopped()
    return
  }
  running = false
  if (recorder && recorder.state !== 'inactive') recorder.stop() // onstop flushes the final segment + confirms
  else {
    stopStream()
    bridge.sendStopped()
  }
}

const bridge = g.openinfoMic
if (bridge) {
  bridge.onStart(() => start(bridge))
  bridge.onStop(() => stop(bridge))
} else {
  console.error('[mic-renderer] window.openinfoMic bridge missing — capture preload did not load')
}
