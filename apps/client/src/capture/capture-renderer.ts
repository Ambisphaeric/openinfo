import { matchSystemAudioDevice, type AudioDevice } from './device-match.js'
import type { CaptureBridge, CaptureSourceKind, CaptureStartOptions } from './protocol.js'
import {
  asChunkStrategy,
  DEFAULT_CHUNK_STRATEGY,
  nextSilenceRunMs,
  resolveVadParams,
  shouldRotate,
  type ChunkStrategy,
  type VadParams,
} from './vad.js'

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
 *
 * WHEN to rotate is CONFIGURABLE (issues #57, #95). Two strategies, selected by CaptureStartOptions:
 *   - `fixed` — stop/restart on a wall-clock timer every `segmentMs` (env > file > 1000). Simple, but a
 *     clock cut lands mid-word ~once a second at speaking pace and the model fabricates a phantom word
 *     from the fragment (measured ~0.20 WER at 1s — the 0.0.8 corruption, issue #95).
 *   - `vad` — the measured default: an AnalyserNode tap watches amplitude and we rotate only at a detected
 *     PAUSE (past a minimum, with a max cap for pauseless speech). A cut in silence never splits a word, so
 *     accuracy matches whole-file (~0.00 WER, tools/stt-accuracy). The DECISION is pure in vad.ts; this
 *     file just feeds it amplitude telemetry each poll tick. `segmentMs` then only sets the chunk's
 *     durationMs echo for fixed; under vad the chunk's durationMs is the segment's ACTUAL length.
 * Either way the rotation is stop/restart (synchronous: stop the old recorder, immediately `new
 * MediaRecorder`), so no audio is dropped beyond the sub-frame gap of closing one webm and opening the next.
 */

/** Fallback segment length when a `capture:start` arrives without options (older/partial message). The */
/** real value comes from ShellConfig.segmentMs (config.ts); this mirrors its default so the renderer is */
/** never left recording an 8s segment. A non-positive/garbage passed value clamps to this too. */
const DEFAULT_SEGMENT_MS = 1_000

/** Fallback chunk strategy when a `capture:start` arrives WITHOUT one — kept `fixed` (the historical */
/** behaviour) so a legacy/partial message is conservative; the real product default is `vad`, resolved in */
/** config.ts (ShellConfig.chunkStrategy) and sent with every start by the main process. */
const DEFAULT_STRATEGY: ChunkStrategy = 'fixed'

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
  /** Segment length (ms) for this source's current run — set from CaptureStartOptions on start (#57). */
  segmentMs: number
  /** Silence probe (system-audio only): the AudioContext tap + the peak seen since the current segment began. */
  audioContext?: AudioContextLike | undefined
  analyser?: AnalyserLike | undefined
  levelBuf?: Float32Array | undefined
  levelTimer?: ReturnType<typeof setInterval> | undefined
  peakThisSegment: number
  /** Chunk strategy for this run — how the current segment is rotated (fixed cadence vs vad pause). */
  strategy: ChunkStrategy
  /** Resolved VAD knobs for this run (only meaningful when `strategy === 'vad'`). */
  vad: VadParams
  /** VAD poll interval handle (vad only) — samples amplitude + re-asks shouldRotate; cleared on rotate/stop. */
  vadTimer?: ReturnType<typeof setInterval> | undefined
  /** Actual length (ms) of the segment just closed — set by the vad poll so the chunk's durationMs is real. */
  segmentDurationMs?: number | undefined
}

const capturers = new Map<CaptureSourceKind, Capturer>()
const capturerFor = (source: CaptureSourceKind): Capturer => {
  let c = capturers.get(source)
  if (!c) {
    c = { source, running: false, peakThisSegment: 0, segmentMs: DEFAULT_SEGMENT_MS, strategy: DEFAULT_STRATEGY, vad: resolveVadParams() }
    capturers.set(source, c)
  }
  return c
}

/** Clamp a passed segment length to a sane positive number, mirroring config.ts's resolveIntervalMs. */
const resolveSegmentMs = (segmentMs: number | undefined): number =>
  typeof segmentMs === 'number' && Number.isFinite(segmentMs) && segmentMs > 0 ? segmentMs : DEFAULT_SEGMENT_MS

/** Tear down a capturer's stream + amplitude probe + vad poll (idempotent). */
const stopStream = (c: Capturer): void => {
  if (c.levelTimer) clearInterval(c.levelTimer)
  c.levelTimer = undefined
  if (c.vadTimer) clearInterval(c.vadTimer)
  c.vadTimer = undefined
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

/** Read the analyser's current peak time-domain amplitude (0..1); 0 when no probe is wired. */
const readPeak = (c: Capturer): number => {
  if (!c.analyser || !c.levelBuf) return 0
  c.analyser.getFloatTimeDomainData(c.levelBuf)
  let peak = 0
  for (let i = 0; i < c.levelBuf.length; i++) {
    const v = Math.abs(c.levelBuf[i] ?? 0)
    if (v > peak) peak = v
  }
  return peak
}

/**
 * Wire an AudioContext tap (source → analyser → zero-gain → destination) so we can measure peak level
 * without playing anything. Needed by BOTH the system-audio silence flag (peak-per-segment) AND the `vad`
 * strategy (peak-per-poll drives pause detection), so it is attached whenever either is in play. The
 * per-segment silence peak (system-audio only) is maintained by its own 100ms levelTimer; the vad poll
 * (cycle) reads the same analyser at its own cadence via readPeak.
 */
const attachAmplitudeProbe = (c: Capturer): void => {
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
    c.audioContext = ctx
    c.analyser = analyser
    c.levelBuf = new Float32Array(analyser.fftSize)
    // The silent-flag peak tracker is a system-audio concern; the vad poll reads peaks itself, so a
    // vad-only mic run does not need this extra 100ms interval.
    if (c.source === 'system-audio') {
      c.levelTimer = setInterval(() => {
        const peak = readPeak(c)
        if (peak > c.peakThisSegment) c.peakThisSegment = peak
      }, 100)
    }
  } catch {
    // No probe ⇒ system-audio segments carry no `silent` flag and vad falls back to the max cap only;
    // capture still works. Not fatal.
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
  c.segmentDurationMs = undefined // set by the vad poll on rotate; fixed uses the nominal segmentMs
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
          // vad cuts at a pause, so the real segment length varies — report it; fixed reports its cadence.
          durationMs: c.segmentDurationMs ?? c.segmentMs,
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
  armRotation(c, rec)
}

/**
 * Arm the rotation that ends the current segment. `fixed`: a single stop-timer at the wall-clock cadence
 * (the #57 behaviour). `vad`: a poll that samples amplitude every `pollMs`, extends the silence run, and
 * stops the moment shouldRotate says we are past the minimum in a real pause (or hit the max cap) — the
 * cut then lands in silence, never mid-word (#95). Elapsed is accumulated from ticks (no wall clock), so
 * the decision is deterministic and the shipped chunk's durationMs is the segment's true length. Falls
 * back to a fixed stop-timer if the vad probe never attached (no AudioContext), so capture never wedges.
 */
const armRotation = (c: Capturer, rec: MediaRecorderLike): void => {
  const stopIfActive = (): void => {
    if (rec.state !== 'inactive') rec.stop()
  }
  if (c.strategy !== 'vad' || !c.analyser) {
    setTimeout(stopIfActive, c.segmentMs)
    return
  }
  const { pollMs, silencePeak } = c.vad
  let elapsedMs = 0
  let silenceRunMs = 0
  c.vadTimer = setInterval(() => {
    if (c.recorder !== rec || rec.state === 'inactive') {
      if (c.vadTimer) clearInterval(c.vadTimer)
      c.vadTimer = undefined
      return
    }
    elapsedMs += pollMs
    silenceRunMs = nextSilenceRunMs(silenceRunMs, pollMs, readPeak(c), silencePeak)
    if (shouldRotate(elapsedMs, silenceRunMs, c.vad)) {
      if (c.vadTimer) clearInterval(c.vadTimer)
      c.vadTimer = undefined
      c.segmentDurationMs = elapsedMs // the real segment length → the chunk's durationMs
      stopIfActive()
    }
  }, pollMs)
}

/** Resolve the input deviceId for a source: mic uses the default (undefined); system-audio matches by name. */
const resolveDeviceId = async (source: CaptureSourceKind): Promise<{ ok: true; deviceId?: string } | { ok: false }> => {
  if (source === 'mic') return { ok: true }
  const devices = (await g.navigator.mediaDevices.enumerateDevices()) as AudioDevice[]
  const match = matchSystemAudioDevice(devices)
  return match ? { ok: true, deviceId: match.deviceId } : { ok: false }
}

const start = (source: CaptureSourceKind, bridge: CaptureBridge, options?: CaptureStartOptions): void => {
  const c = capturerFor(source)
  if (c.running) return
  c.segmentMs = resolveSegmentMs(options?.segmentMs) // config-resolved cadence for this run (#57)
  c.strategy = asChunkStrategy(options?.chunkStrategy) ?? DEFAULT_STRATEGY // config-resolved strategy (#95)
  c.vad = resolveVadParams({
    ...(options?.vadSilenceHoldMs !== undefined ? { silenceHoldMs: options.vadSilenceHoldMs } : {}),
    ...(options?.vadMinSegmentMs !== undefined ? { minSegmentMs: options.vadMinSegmentMs } : {}),
    ...(options?.vadMaxSegmentMs !== undefined ? { maxSegmentMs: options.vadMaxSegmentMs } : {}),
    ...(options?.vadSilencePeak !== undefined ? { silencePeak: options.vadSilencePeak } : {}),
  })
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
        // Attach the amplitude probe when EITHER the system-audio silent flag OR the vad strategy needs it.
        if (source === 'system-audio' || c.strategy === 'vad') attachAmplitudeProbe(c)
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
  bridge.onStart((source, options) => {
    bridge.sendStartAck(source)
    start(source, bridge, options)
  })
  bridge.onStop((source) => stop(source, bridge))
  // Readiness ping: listeners are now registered, so it is safe for the main process to send `start`.
  // This fires on module load, BEFORE getUserMedia — the fix for the boot-time start/load race (#41).
  bridge.sendLoaded()
} else {
  console.error('[capture-renderer] window.openinfoCapture bridge missing — capture preload did not load')
}
