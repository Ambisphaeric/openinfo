import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureBridge, CaptureSourceKind, CaptureStartOptions, RawSegment } from './protocol.js'

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
  emitted: RawSegment[]
  onStart?: (source: CaptureSourceKind, options?: CaptureStartOptions) => void
  restore: () => void
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((res) => setImmediate(res))
}

const fakeStream = {
  getTracks: () => [{ stop: () => undefined }],
  getAudioTracks: () => [{ stop: () => undefined }],
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
const installAndLoad = async (bust: number): Promise<Harness> => {
  const timers: Timer[] = []
  const emitted: RawSegment[] = []
  const h: Harness = { timers, emitted, restore: () => undefined }

  const originalSetTimeout = globalThis.setTimeout
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const g = globalThis as unknown as Record<string, unknown>
  const originalMediaRecorder = g['MediaRecorder']
  const originalCapture = g['openinfoCapture']

  // Record the scheduled delay instead of waiting — the segment is fired manually via h.timers.
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    timers.push({ fn, ms: ms ?? 0 })
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout

  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: { getUserMedia: async () => fakeStream, enumerateDevices: async () => [] } },
    configurable: true,
    writable: true,
  })
  g['MediaRecorder'] = FakeMediaRecorder

  const bridge: CaptureBridge = {
    onStart: (handler) => {
      h.onStart = handler
    },
    onStop: () => undefined,
    sendSegment: (segment) => emitted.push(segment),
    sendStopped: () => undefined,
    sendStatus: () => undefined,
    sendLoaded: () => undefined,
    sendStartAck: () => undefined,
  }
  g['openinfoCapture'] = bridge

  h.restore = (): void => {
    globalThis.setTimeout = originalSetTimeout
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
    g['MediaRecorder'] = originalMediaRecorder
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
