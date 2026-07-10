import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureBridge, CaptureSourceKind, CaptureStartOptions, CaptureStatus, RawSegment } from './protocol.js'

/**
 * capture-renderer honours the configured segment cadence (issue #57). The renderer drives browser
 * globals (MediaRecorder/getUserMedia/AudioContext) and is not part of the normal CI unit set (see its
 * header), so this harness fakes just enough of those globals to prove the ONE decision #57 adds: the
 * segment length sent with `capture:start` (CaptureStartOptions.segmentMs) drives BOTH the stop-timer
 * cadence and the chunk's `durationMs`, and a missing/garbage value clamps to the ~1s default — WITHOUT
 * the hardcoded 8s that used to be the latency floor.
 *
 * How it drives the load-time module: the renderer wires `window.openinfoCapture` on import, so we set a
 * fake bridge (capturing its onStart handler) + fake navigator/MediaRecorder on globalThis BEFORE a
 * cache-busted dynamic import, then invoke the captured handler. `setTimeout` is replaced with a spy that
 * RECORDS the scheduled delay instead of waiting, so the cadence is asserted instantly and the segment is
 * fired deterministically rather than on a wall-clock timer. Blob is Node-native (has size + arrayBuffer).
 */

interface Timer {
  fn: () => void
  ms: number
}

interface Harness {
  timers: Timer[]
  intervals: Timer[]
  emitted: RawSegment[]
  statuses: CaptureStatus[]
  /** How the current run opened its stream — for asserting the #142 loopback vs device branch. */
  calls: { getUserMedia: number; getDisplayMedia: number; enumerateDevices: number }
  /** Video tracks the last getDisplayMedia stream handed out — to prove they are stopped + removed (audio-only). */
  lastDisplayVideoTracks: FakeTrack[]
  /** Test-controlled current amplitude the fake AnalyserNode reports (drives vad pause detection). */
  peak: { value: number }
  onStart?: (source: CaptureSourceKind, options?: CaptureStartOptions) => void
  restore: () => void
}

/** Per-run control over what the fake getDisplayMedia produces (#142 loopback path). */
interface DisplayMediaConfig {
  /** How many audio tracks the loopback stream yields (0 ⇒ the "dead stream" / no-track case → no-device). */
  audioTracks: number
  /** How many video tracks it yields (getDisplayMedia always includes one; the renderer must drop it). */
  videoTracks: number
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((res) => setImmediate(res))
}

interface FakeTrack {
  kind: string
  stopped: boolean
  stop(): void
}
const makeTrack = (kind: string): FakeTrack => ({ kind, stopped: false, stop() { this.stopped = true } })

/** A fake MediaStream with removable/stoppable tracks (mirrors the renderer's MediaStreamLike, #142). */
const makeStream = (audio: number, video: number) => {
  const tracks: FakeTrack[] = [
    ...Array.from({ length: audio }, () => makeTrack('audio')),
    ...Array.from({ length: video }, () => makeTrack('video')),
  ]
  return {
    _tracks: tracks,
    getTracks: () => tracks.slice(),
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    removeTrack: (t: FakeTrack) => {
      const i = tracks.indexOf(t)
      if (i >= 0) tracks.splice(i, 1)
    },
  }
}

class FakeMediaRecorder {
  static isTypeSupported(): boolean {
    return true
  }
  state = 'inactive'
  mimeType: string
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: ((event: { error?: { message?: string } }) => void) | null = null
  constructor(_stream: unknown, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? 'audio/webm'
  }
  start(): void {
    this.state = 'recording'
    // Emit one non-empty data blob so the assembled segment has size > 0 and is shipped.
    this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3, 4])], { type: this.mimeType }) })
  }
  stop(): void {
    if (this.state === 'inactive') return
    this.state = 'inactive'
    this.onstop?.()
  }
}

/** Install the fake browser globals + bridge, then import a FRESH copy of the renderer (cache-busted). */
const installAndLoad = async (bust: number, display: DisplayMediaConfig = { audioTracks: 1, videoTracks: 1 }): Promise<Harness> => {
  const timers: Timer[] = []
  const intervals: Timer[] = []
  const emitted: RawSegment[] = []
  const statuses: CaptureStatus[] = []
  const peak = { value: 0 }
  const h: Harness = {
    timers,
    intervals,
    emitted,
    statuses,
    calls: { getUserMedia: 0, getDisplayMedia: 0, enumerateDevices: 0 },
    lastDisplayVideoTracks: [],
    peak,
    restore: () => undefined,
  }

  const originalSetTimeout = globalThis.setTimeout
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const g = globalThis as unknown as Record<string, unknown>
  const originalMediaRecorder = g['MediaRecorder']
  const originalAudioContext = g['AudioContext']
  const originalCapture = g['openinfoCapture']

  // Record the scheduled delay instead of waiting — the segment is fired manually via h.timers.
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    timers.push({ fn, ms: ms ?? 0 })
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout

  // The vad poll runs on setInterval — record it so the test ticks it deterministically. Handles are the
  // interval's index+1 so clearInterval can splice it out (a cleared poll stops firing).
  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    intervals.push({ fn, ms: ms ?? 0 })
    return intervals.length as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval
  globalThis.clearInterval = ((handle?: ReturnType<typeof setInterval>) => {
    const i = (handle as unknown as number) - 1
    if (i >= 0 && i < intervals.length) intervals[i] = { fn: () => undefined, ms: 0 }
  }) as typeof clearInterval

  Object.defineProperty(globalThis, 'navigator', {
    value: {
      mediaDevices: {
        getUserMedia: async () => {
          h.calls.getUserMedia += 1
          return makeStream(1, 0)
        },
        // #142: loopback stream — the renderer must keep audio, stop+remove video. `audioTracks:0` models
        // the "dead stream" (no CoreAudio-Tap grant) case, which must degrade to a benign no-device.
        getDisplayMedia: async () => {
          h.calls.getDisplayMedia += 1
          const s = makeStream(display.audioTracks, display.videoTracks)
          h.lastDisplayVideoTracks = s.getVideoTracks()
          return s
        },
        enumerateDevices: async () => {
          h.calls.enumerateDevices += 1
          return []
        },
      },
    },
    configurable: true,
    writable: true,
  })
  g['MediaRecorder'] = FakeMediaRecorder
  // Minimal AudioContext: the analyser fills the time-domain buffer with the test-controlled peak so
  // readPeak (capture-renderer) sees it; the gain/destination nodes are inert no-ops.
  const inertNode = { connect: () => undefined, disconnect: () => undefined }
  g['AudioContext'] = class {
    destination = inertNode
    createMediaStreamSource(): typeof inertNode {
      return inertNode
    }
    createAnalyser(): { fftSize: number; getFloatTimeDomainData: (a: Float32Array) => void; connect: () => void; disconnect: () => void } {
      return {
        fftSize: 8,
        getFloatTimeDomainData: (a: Float32Array) => a.fill(peak.value),
        connect: () => undefined,
        disconnect: () => undefined,
      }
    }
    createGain(): typeof inertNode & { gain: { value: number } } {
      return { ...inertNode, gain: { value: 0 } }
    }
    async close(): Promise<void> {
      return undefined
    }
  }

  const bridge: CaptureBridge = {
    onStart: (handler) => {
      h.onStart = handler
    },
    onStop: () => undefined,
    sendSegment: (segment) => emitted.push(segment),
    sendStopped: () => undefined,
    sendStatus: (status) => statuses.push(status),
    sendLoaded: () => undefined,
    sendStartAck: () => undefined,
  }
  g['openinfoCapture'] = bridge

  h.restore = (): void => {
    globalThis.setTimeout = originalSetTimeout
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
    g['MediaRecorder'] = originalMediaRecorder
    g['AudioContext'] = originalAudioContext
    g['openinfoCapture'] = originalCapture
  }

  await import(`./capture-renderer.js?seg57=${bust}`)
  return h
}

let bust = 0
const drive = async (options?: CaptureStartOptions): Promise<Harness> => {
  const h = await installAndLoad(++bust)
  assert.ok(h.onStart, 'renderer registered an onStart handler on load')
  h.onStart('mic', options)
  await flush() // getUserMedia resolves → cycle() runs → the segment stop-timer is recorded
  return h
}

/** Drive a specific source (#142 loopback needs `system-audio`), with a configurable loopback stream. */
const driveSource = async (
  source: CaptureSourceKind,
  options?: CaptureStartOptions,
  display?: DisplayMediaConfig,
): Promise<Harness> => {
  const h = await installAndLoad(++bust, display)
  assert.ok(h.onStart, 'renderer registered an onStart handler on load')
  h.onStart(source, options)
  await flush()
  return h
}

test('honours a passed segmentMs for BOTH the stop-timer cadence and the chunk durationMs (#57)', async () => {
  const h = await drive({ segmentMs: 250 })
  try {
    assert.equal(h.timers.length >= 1, true, 'a segment stop-timer was scheduled')
    assert.equal(h.timers[0]?.ms, 250, 'stop-timer fires at the configured cadence, not the old 8000ms')
    h.timers[0]?.fn() // fire the segment boundary → recorder stops → segment is shipped
    await flush()
    assert.equal(h.emitted.length >= 1, true, 'a segment was shipped')
    const seg = h.emitted[0]!
    assert.equal(seg.source, 'mic')
    assert.equal(seg.durationMs, 250, 'chunk durationMs reflects the configured value, not a hardcode')
    assert.match(seg.mimeType, /audio\/webm/)
    assert.equal(seg.bytes.byteLength, 4)
  } finally {
    h.restore()
  }
})

test('falls back to the ~1s default when a start arrives without options (#57)', async () => {
  const h = await drive(undefined)
  try {
    assert.equal(h.timers[0]?.ms, 1000, 'no options ⇒ the 1000ms default, never the removed 8s floor')
    h.timers[0]?.fn()
    await flush()
    assert.equal(h.emitted[0]?.durationMs, 1000)
  } finally {
    h.restore()
  }
})

test('clamps a non-positive/garbage segmentMs to the default (#57)', async () => {
  for (const bad of [0, -5, Number.NaN]) {
    const h = await drive({ segmentMs: bad as number })
    try {
      assert.equal(h.timers[0]?.ms, 1000, `segmentMs=${bad} clamps to the default`)
    } finally {
      h.restore()
    }
  }
})

/** Fire the currently-active vad poll one tick, at the given amplitude (peak). */
const tickAt = (h: Harness, amplitude: number): void => {
  h.peak.value = amplitude
  h.intervals[h.intervals.length - 1]?.fn()
}

const VAD_OPTS: CaptureStartOptions = {
  segmentMs: 1000,
  chunkStrategy: 'vad',
  vadMinSegmentMs: 100,
  vadSilenceHoldMs: 100,
  vadMaxSegmentMs: 1000,
  vadSilencePeak: 0.02,
}

test('vad rotates the segment at a detected pause, not on the wall clock (#95)', async () => {
  const h = await drive(VAD_OPTS)
  try {
    assert.equal(h.timers.length, 0, 'vad uses no fixed stop-timer')
    assert.equal(h.intervals.length >= 1, true, 'vad armed an amplitude poll')
    // Speech for a while: elapsed grows past the minimum but the silence run keeps resetting ⇒ no cut.
    tickAt(h, 0.4) // elapsed 50
    tickAt(h, 0.4) // elapsed 100 (past min) but no pause yet
    tickAt(h, 0.4) // elapsed 150
    await flush()
    assert.equal(h.emitted.length, 0, 'no cut while the speaker is still talking')
    // Now a pause: two quiet ticks reach the 100ms hold ⇒ cut lands in the silence.
    tickAt(h, 0.0) // silenceRun 50
    tickAt(h, 0.0) // silenceRun 100, elapsed 250 ⇒ rotate
    await flush()
    assert.equal(h.emitted.length, 1, 'the pause closed the segment')
    assert.equal(h.emitted[0]?.source, 'mic')
    assert.equal(h.emitted[0]?.durationMs, 250, 'chunk durationMs is the segment’s ACTUAL (variable) length')
  } finally {
    h.restore()
  }
})

test('vad still cuts by the max cap when speech never pauses (#95 latency bound)', async () => {
  const h = await drive(VAD_OPTS)
  try {
    // Loud forever: silence never accumulates, so only the 1000ms max cap can trigger a cut (20 ticks).
    for (let i = 0; i < 19; i++) tickAt(h, 0.5)
    await flush()
    assert.equal(h.emitted.length, 0, 'under the cap with no pause ⇒ keep recording')
    tickAt(h, 0.5) // elapsed 1000 ⇒ hit the cap
    await flush()
    assert.equal(h.emitted.length, 1, 'the max cap bounds latency for pauseless speech')
    assert.equal(h.emitted[0]?.durationMs, 1000)
  } finally {
    h.restore()
  }
})

test('system-audio LOOPBACK opens via getDisplayMedia — not a device match — and drops the video track (#142)', async () => {
  const h = await driveSource('system-audio', { segmentMs: 500, systemAudioMethod: 'loopback' })
  try {
    assert.equal(h.calls.getDisplayMedia, 1, 'loopback uses getDisplayMedia (the CoreAudio-Tap path)')
    assert.equal(h.calls.getUserMedia, 0, 'loopback never opens a getUserMedia input')
    assert.equal(h.calls.enumerateDevices, 0, 'loopback never enumerates for a BlackHole device')
    assert.equal(h.lastDisplayVideoTracks.length, 1, 'getDisplayMedia handed out a video track')
    assert.equal(h.lastDisplayVideoTracks[0]?.stopped, true, 'the unwanted video track is stopped (audio-only capture)')
    assert.deepEqual(h.statuses.map((s) => s.state), ['ready'], 'loopback reached the capturing-ready state')
    h.timers[0]?.fn() // close the segment
    await flush()
    assert.equal(h.emitted[0]?.source, 'system-audio', 'loopback audio flows into the SAME chunk pipeline as "them"')
    // system-audio segments carry the silence honesty flag (a dead loopback stream reads as silent, not faked).
    assert.equal(typeof h.emitted[0]?.silent, 'boolean', 'the silence probe still tags system-audio segments under loopback')
  } finally {
    h.restore()
  }
})

test('system-audio LOOPBACK with no audio track degrades to a benign no-device (dead-stream honesty, #142)', async () => {
  const h = await driveSource('system-audio', { segmentMs: 500, systemAudioMethod: 'loopback' }, { audioTracks: 0, videoTracks: 1 })
  try {
    assert.deepEqual(h.statuses.map((s) => s.state), ['no-device'], 'a loopback stream with no audio track reports no-device (→ unavailable), never a fake capture')
    assert.equal(h.emitted.length, 0, 'nothing is shipped when the tap produced no audio')
  } finally {
    h.restore()
  }
})

test('system-audio DEVICE method still enumerates + matches a BlackHole input, never getDisplayMedia (#142)', async () => {
  const h = await driveSource('system-audio', { segmentMs: 500, systemAudioMethod: 'device' })
  try {
    assert.equal(h.calls.getDisplayMedia, 0, 'device method never touches the loopback path')
    assert.equal(h.calls.enumerateDevices, 1, 'device method enumerates to match a virtual input')
    // No BlackHole-class device in the fake enumeration ⇒ benign no-device (the shipped floor behaviour).
    assert.deepEqual(h.statuses.map((s) => s.state), ['no-device'], 'no matching device ⇒ no-device (unchanged floor)')
  } finally {
    h.restore()
  }
})
