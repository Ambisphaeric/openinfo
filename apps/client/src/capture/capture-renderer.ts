import { matchSystemAudioDevice, type AudioDevice } from './device-match.js'
import type { CaptureBridge, CaptureSourceKind } from './protocol.js'

/**
 * The hidden capture window's renderer — the one place getUserMedia can run (it needs a Chromium
 * renderer). It listens for start/stop over the preload bridge (window.openinfoCapture), records audio
 * in fixed-length segments, and hands each finished segment up to the main process, which wraps it as a
 * CaptureChunk (chunk.ts) and sends it via EngineLink. This window is never shown and has no content to
 * protect; it exists purely to host the audio capture.
 *
 * TWO sources share this ONE renderer, keyed by `source` (protocol.ts): `mic` (the user — "me", the
 * default input, EC on) and `system-audio` (the far side of a call — "them", captured off a BlackHole-
 * like virtual input, EC off so the far end is faithful). Each has its own independent MediaRecorder
 * loop; the mic path is unchanged from the mic-only slice.
 *
 * System-audio detection + honesty (design note): on a system-audio start we enumerate audio inputs and
 * a pure matcher (device-match.ts) finds the virtual device by NAME — the user never types one. No device
 * ⇒ we report `no-device` (a benign absence) and capture nothing for that source. When a device IS found
 * but its output isn't routed (the common not-yet-set-up state), it emits DIGITAL SILENCE; an AnalyserNode
 * measures each segment's peak amplitude and flags `silent`, so the controller can be honest rather than
 * pretend to record the room.
 *
 * NOT unit-tested by CI (it drives browser globals — MediaRecorder/getUserMedia/AudioContext — with no
 * DOM in the node test env), mirroring shell.ts/mount.ts. The decision-bearing logic that CAN be pure —
 * segment→chunk assembly, the lifecycle state machine, and the device matcher — lives in chunk.ts /
 * capture-controller.ts / device-match.ts, which ARE tested. Typed against a minimal structural subset of
 * the browser globals via one globalThis cast, so the file stays in the node-typed package (the mount.ts
 * trick) rather than pulling in lib.dom (which collides with @types/node globals).
 *
 * Segmenting = stop/restart, not timeslice. MediaRecorder's `timeslice` emits fragments of ONE webm
 * stream; only the first fragment carries the container header, so later fragments are not independently
 * decodable. Stopping and immediately restarting the recorder yields a COMPLETE, self-contained webm file
 * per segment (a header + its data), which is exactly what `/v1/audio/transcriptions` needs.
 */

/** Segment length: 8s — within the 5–10s band. Long enough to amortize per-request + stop/restart */
/** overhead and keep boundaries rare; short enough that audio reaches the engine promptly and the */
/** flushed final segment on session-end is small. The engine merges chunks into larger windows. */
const SEGMENT_MS = 8_000

/** Peak-amplitude floor below which a system-audio segment counts as silence (digital silence = 0). */
const SILENCE_PEAK = 1e-3

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
  getAudioTracks(): Array<{ stop(): void }>
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
interface AnalyserLike {
  fftSize: number
  getFloatTimeDomainData(array: Float32Array): void
  connect(node: unknown): void
  disconnect(): void
}
interface AudioNodeLike {
  connect(node: unknown): void
  disconnect(): void
}
interface GainLike extends AudioNodeLike {
  gain: { value: number }
}
interface AudioContextLike {
  destination: unknown
  createMediaStreamSource(stream: MediaStreamLike): AudioNodeLike
  createAnalyser(): AnalyserLike
  createGain(): GainLike
  close(): Promise<void>
}
interface AudioContextCtor {
  new (): AudioContextLike
}
interface MediaDeviceInfoLike {
  kind: string
  label: string
  deviceId: string
}
interface CaptureGlobals {
  navigator: {
    mediaDevices: {
      getUserMedia(constraints: unknown): Promise<MediaStreamLike>
      enumerateDevices(): Promise<MediaDeviceInfoLike[]>
    }
  }
  MediaRecorder: MediaRecorderCtor
  Blob: BlobCtor
  AudioContext: AudioContextCtor
  openinfoCapture?: CaptureBridge
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

/** getUserMedia constraints per source. Mic = default input, EC/NS on (unchanged). System-audio = the */
/** matched virtual input by exact deviceId, EC/NS/AGC OFF so the far end is captured faithfully. */
const constraintsFor = (source: CaptureSourceKind, deviceId?: string): unknown =>
  source === 'mic'
    ? { audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } }
    : { audio: { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } }

/** One source's live capture state: its stream, current recorder, run flag, and (system-audio) silence probe. */
interface Capturer {
  source: CaptureSourceKind
  stream?: MediaStreamLike | undefined
  recorder?: MediaRecorderLike | undefined
  running: boolean
  /** Silence probe (system-audio only): the AudioContext tap + the peak seen since the current segment began. */
  audioContext?: AudioContextLike | undefined
  analyser?: AnalyserLike | undefined
  levelBuf?: Float32Array | undefined
  levelTimer?: ReturnType<typeof setInterval> | undefined
  peakThisSegment: number
}

const capturers = new Map<CaptureSourceKind, Capturer>()
const capturerFor = (source: CaptureSourceKind): Capturer => {
  let c = capturers.get(source)
  if (!c) {
    c = { source, running: false, peakThisSegment: 0 }
    capturers.set(source, c)
  }
  return c
}

/** Tear down a capturer's stream + silence probe (idempotent). */
const stopStream = (c: Capturer): void => {
  if (c.levelTimer) clearInterval(c.levelTimer)
  c.levelTimer = undefined
  try {
    c.analyser?.disconnect()
  } catch {
    /* graph already torn down */
  }
  void c.audioContext?.close().catch(() => undefined)
  c.audioContext = undefined
  c.analyser = undefined
  c.levelBuf = undefined
  for (const track of c.stream?.getTracks() ?? []) track.stop()
  c.stream = undefined
  c.recorder = undefined
  c.peakThisSegment = 0
}

/** Wire an AudioContext tap (source → analyser → zero-gain → destination) so we can measure peak level */
/** per segment without playing anything. System-audio only — the mic path never measures silence. */
const attachSilenceProbe = (c: Capturer): void => {
  try {
    if (!c.stream) return
    const ctx = new g.AudioContext()
    const src = ctx.createMediaStreamSource(c.stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    const sink = ctx.createGain()
    sink.gain.value = 0 // silent sink: pulls the graph so the analyser updates, without audible output
    src.connect(analyser)
    analyser.connect(sink)
    sink.connect(ctx.destination)
    const buf = new Float32Array(analyser.fftSize)
    c.audioContext = ctx
    c.analyser = analyser
    c.levelBuf = buf
    c.levelTimer = setInterval(() => {
      if (!c.analyser || !c.levelBuf) return
      c.analyser.getFloatTimeDomainData(c.levelBuf)
      let peak = 0
      for (let i = 0; i < c.levelBuf.length; i++) {
        const v = Math.abs(c.levelBuf[i] ?? 0)
        if (v > peak) peak = v
      }
      if (peak > c.peakThisSegment) c.peakThisSegment = peak
    }, 100)
  } catch {
    // No silence probe ⇒ segments simply carry no `silent` flag; capture still works. Not fatal.
    c.audioContext = undefined
    c.analyser = undefined
  }
}

/** Record one segment; on stop, ship it and (if still running) begin the next — else confirm stopped. */
const cycle = (c: Capturer, bridge: CaptureBridge): void => {
  if (!c.running || !c.stream) return
  const parts: BlobLike[] = []
  const rec = new g.MediaRecorder(c.stream, { mimeType: pickMimeType() })
  c.recorder = rec
  c.peakThisSegment = 0 // reset the silence probe's window for this segment
  const capturedAt = new Date().toISOString()
  const measuresSilence = c.source === 'system-audio' && !!c.analyser
  rec.ondataavailable = (event): void => {
    if (event.data.size > 0) parts.push(event.data)
  }
  rec.onstop = (): void => {
    void (async (): Promise<void> => {
      const blob = new g.Blob(parts, { type: rec.mimeType })
      if (blob.size > 0) {
        const bytes = await blob.arrayBuffer()
        bridge.sendSegment({
          source: c.source,
          bytes,
          mimeType: rec.mimeType,
          capturedAt,
          durationMs: SEGMENT_MS,
          ...(measuresSilence ? { silent: c.peakThisSegment < SILENCE_PEAK } : {}),
        })
      }
      if (c.running) cycle(c, bridge)
      else {
        stopStream(c)
        bridge.sendStopped(c.source)
      }
    })()
  }
  rec.onerror = (event): void => {
    bridge.sendStatus({ source: c.source, state: 'error', detail: event.error?.message ?? 'MediaRecorder error' })
  }
  rec.start()
  setTimeout(() => {
    if (rec.state !== 'inactive') rec.stop()
  }, SEGMENT_MS)
}

/** Resolve the input deviceId for a source: mic uses the default (undefined); system-audio matches by name. */
const resolveDeviceId = async (source: CaptureSourceKind): Promise<{ ok: true; deviceId?: string } | { ok: false }> => {
  if (source === 'mic') return { ok: true }
  const devices = (await g.navigator.mediaDevices.enumerateDevices()) as AudioDevice[]
  const match = matchSystemAudioDevice(devices)
  return match ? { ok: true, deviceId: match.deviceId } : { ok: false }
}

const start = (source: CaptureSourceKind, bridge: CaptureBridge): void => {
  const c = capturerFor(source)
  if (c.running) return
  void (async (): Promise<void> => {
    const resolved = await resolveDeviceId(source)
    if (!resolved.ok) {
      // system-audio: no BlackHole-like input on this machine — a benign absence, not an error.
      bridge.sendStatus({ source, state: 'no-device' })
      return
    }
    g.navigator.mediaDevices
      .getUserMedia(constraintsFor(source, resolved.deviceId))
      .then((granted) => {
        c.stream = granted
        c.running = true
        if (source === 'system-audio') attachSilenceProbe(c)
        bridge.sendStatus({ source, state: 'ready' })
        cycle(c, bridge)
      })
      .catch((err: { name?: string; message?: string }) => {
        // NotAllowedError / SecurityError = the user or the OS refused; anything else is an error.
        if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
          bridge.sendStatus({ source, state: 'permission-denied' })
        } else {
          bridge.sendStatus({ source, state: 'error', detail: err?.message ?? err?.name ?? 'getUserMedia failed' })
        }
      })
  })()
}

const stop = (source: CaptureSourceKind, bridge: CaptureBridge): void => {
  const c = capturerFor(source)
  if (!c.running) {
    bridge.sendStopped(source)
    return
  }
  c.running = false
  if (c.recorder && c.recorder.state !== 'inactive') c.recorder.stop() // onstop flushes the final segment + confirms
  else {
    stopStream(c)
    bridge.sendStopped(source)
  }
}

const bridge = g.openinfoCapture
if (bridge) {
  // Ack a start the MOMENT the command is received (before getUserMedia), so the main process knows the
  // send landed and stops retrying — a dropped start is detected instead of wedging the controller. Then
  // run the real start. The old `state: 'ready'` (post-getUserMedia) stays as the capturing signal.
  bridge.onStart((source) => {
    bridge.sendStartAck(source)
    start(source, bridge)
  })
  bridge.onStop((source) => stop(source, bridge))
  // Readiness ping: listeners are now registered, so it is safe for the main process to send `start`.
  // This fires on module load, BEFORE getUserMedia — the fix for the boot-time start/load race (#41).
  bridge.sendLoaded()
} else {
  console.error('[capture-renderer] window.openinfoCapture bridge missing — capture preload did not load')
}
