import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CaptureChunk } from '@openinfo/contracts'
import { EngineLink } from '../engine-link/index.js'
import { CaptureController, type CaptureControllerDeps, type CaptureState } from './capture-controller.js'
import { CAPTURE_CHANNELS, type RawSegment } from './protocol.js'

const seg = (over: Partial<RawSegment> = {}): RawSegment => ({
  source: 'mic',
  bytes: new Uint8Array([1, 2, 3]).buffer,
  mimeType: 'audio/webm;codecs=opus',
  capturedAt: '2026-07-07T10:00:00.000Z',
  ...over,
})

/** A controller wired to spies, with sensible test defaults (mic source, enabled, permission granted). */
/** A controllable timer so the stop-ack un-wedge timeout is fired on demand (no real clock in tests). */
const timerHarness = () => {
  const pending = new Map<unknown, () => void>()
  let next = 0
  return {
    setTimer: (fn: () => void): unknown => {
      const h = ++next
      pending.set(h, fn)
      return h
    },
    clearTimer: (h: unknown) => void pending.delete(h),
    fireAll: () => {
      const snapshot = [...pending.values()]
      pending.clear()
      for (const fn of snapshot) fn()
    },
    get size() {
      return pending.size
    },
  }
}

const harness = (over: Partial<CaptureControllerDeps> = {}) => {
  const captured: CaptureChunk[] = []
  const control: string[] = []
  const states: CaptureState[] = []
  const silences: boolean[] = []
  const timers = timerHarness()
  const deps: CaptureControllerDeps = {
    source: 'mic',
    enabled: true,
    capture: async (chunk) => void captured.push(chunk),
    control: { start: () => control.push('start'), stop: () => control.push('stop') },
    requestPermission: async () => true,
    onStateChange: (s) => states.push(s),
    onSilence: (silent) => silences.push(silent),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...over,
  }
  return { controller: new CaptureController(deps), captured, control, states, silences, timers }
}

test('happy path: start → capture segments → end flushes the final in-flight segment → idle', async () => {
  const h = harness()
  await h.controller.onSessionStarted({ sessionId: 'A', workspaceId: 'ws' })
  // Start intent only: the renderer is told to start, but no audio has flowed → `starting`, NOT rec.
  assert.equal(h.controller.currentState, 'starting')
  assert.deepEqual(h.control, ['start'])

  await h.controller.onSegment(seg())
  assert.equal(h.controller.currentState, 'capturing') // first real segment → ● rec lights up
  await h.controller.onSegment(seg())
  assert.deepEqual(h.captured.map((c) => c.sequence), [1, 2]) // monotonic within the run
  assert.ok(h.captured.every((c) => c.sessionId === 'A' && c.source === 'mic'))

  h.controller.onSessionEnded()
  assert.deepEqual(h.control, ['start', 'stop']) // renderer told to stop + flush

  // The renderer's final segment arrives AFTER stop but BEFORE `stopped` — still tagged the ended session.
  await h.controller.onSegment(seg())
  assert.equal(h.captured.length, 3)
  assert.equal(h.captured[2]?.sessionId, 'A')

  await h.controller.onCaptureStopped()
  assert.equal(h.controller.currentState, 'idle')

  // A stray segment after full stop is ignored (no active run).
  await h.controller.onSegment(seg())
  assert.equal(h.captured.length, 3)
})

test('rec-indicator: transitions requesting → starting → capturing, ● rec only on real audio', async () => {
  const h = harness()
  await h.controller.onSessionStarted({ sessionId: 'A', workspaceId: 'ws' })
  // The state-change trail proves rec (capturing) is NOT asserted on the start intent.
  assert.deepEqual(h.states, ['requesting', 'starting'])
  await h.controller.onSegment(seg())
  assert.deepEqual(h.states, ['requesting', 'starting', 'capturing'])
  // A second segment does not re-fire the transition (idempotent once capturing).
  await h.controller.onSegment(seg())
  assert.deepEqual(h.states, ['requesting', 'starting', 'capturing'])
})

test('rec-indicator: a session that ends before the first segment still stops the renderer', async () => {
  const h = harness()
  await h.controller.onSessionStarted({ sessionId: 'A', workspaceId: 'ws' })
  assert.equal(h.controller.currentState, 'starting') // no segment ever arrived
  h.controller.onSessionEnded()
  assert.deepEqual(h.control, ['start', 'stop']) // renderer still told to stop (it held a stream)
  await h.controller.onCaptureStopped()
  assert.equal(h.controller.currentState, 'idle')
})

test('privacy default: no session ⇒ nothing captured (segments before a start are dropped)', async () => {
  const h = harness()
  await h.controller.onSegment(seg())
  assert.equal(h.captured.length, 0)
  assert.deepEqual(h.control, [])
})

test('denial path: permission refused ⇒ capture disabled, no renderer start, session unaffected', async () => {
  const h = harness({ requestPermission: async () => false })
  await h.controller.onSessionStarted({ sessionId: 'A', workspaceId: 'ws' })
  assert.equal(h.controller.currentState, 'denied')
  assert.deepEqual(h.control, []) // renderer never started
  await h.controller.onSegment(seg()) // no context ⇒ ignored, does not throw
  assert.equal(h.captured.length, 0)
  // Ending the session from the denied state just resolves to idle (text path was never blocked).
  h.controller.onSessionEnded()
  assert.equal(h.controller.currentState, 'idle')
})

test('renderer-reported permission-denied flips to denied even if the OS pre-check passed', async () => {
  const h = harness()
  await h.controller.onSessionStarted({ sessionId: 'A', workspaceId: 'ws' })
  h.controller.onStatus({ source: 'mic', state: 'permission-denied' })
  assert.equal(h.controller.currentState, 'denied')
  await h.controller.onSegment(seg())
  assert.equal(h.captured.length, 0) // context cleared by the denial
})

test('config disabled: onSessionStarted is a no-op (nothing requested, nothing started)', async () => {
  let asked = false
  const h = harness({ enabled: false, requestPermission: async () => ((asked = true), true) })
  await h.controller.onSessionStarted({ sessionId: 'A', workspaceId: 'ws' })
  assert.equal(asked, false)
  assert.equal(h.controller.currentState, 'idle')
  assert.deepEqual(h.control, [])
})

test('auto-end → immediate restart serializes runs: the old final segment keeps the old ids', async () => {
  const h = harness()
  await h.controller.onSessionStarted({ sessionId: 'A', workspaceId: 'ws' })
  await h.controller.onSegment(seg())

  // Auto-end (start-while-live): the engine emits ended(A) then started(B). The started(B) arrives
  // while A is still flushing, so it is queued — not applied over A's context.
  h.controller.onSessionEnded()
  await h.controller.onSessionStarted({ sessionId: 'B', workspaceId: 'ws' })
  assert.deepEqual(h.control, ['start', 'stop']) // B not started yet — A still flushing

  await h.controller.onSegment(seg()) // A's final segment — must still be tagged A
  await h.controller.onCaptureStopped() // A done → queued B begins
  assert.deepEqual(h.control, ['start', 'stop', 'start'])
  assert.equal(h.controller.currentState, 'starting') // B started, no B audio yet → not rec

  await h.controller.onSegment(seg()) // now under B, sequence reset to 1
  assert.equal(h.controller.currentState, 'capturing') // B's first segment → rec
  const tags = h.captured.map((c) => `${c.sessionId}#${c.sequence}`)
  assert.deepEqual(tags, ['A#1', 'A#2', 'B#1'])
})

test('shutdown mid-capture stops the renderer cleanly', async () => {
  const h = harness()
  await h.controller.onSessionStarted({ sessionId: 'A', workspaceId: 'ws' })
  h.controller.shutdown()
  assert.deepEqual(h.control, ['start', 'stop'])
  assert.equal(h.controller.currentState, 'idle')
})

test('IPC protocol shape is stable (the renderer/preload/main contract)', () => {
  assert.deepEqual(CAPTURE_CHANNELS, {
    start: 'capture:start',
    stop: 'capture:stop',
    segment: 'capture:segment',
    stopped: 'capture:stopped',
    status: 'capture:status',
    loaded: 'capture:loaded',
    startAck: 'capture:start-ack',
  })
})

test('capture preload is self-contained: it inlines every channel and requires NO app module (sandbox-safe, #41)', async () => {
  // The preload runs under Electron's default sandbox, where require reaches only electron + builtins.
  // Requiring the ESM sibling ./protocol.js there fails to load the WHOLE preload — the bridge never
  // exposes and every chunk is silently unsent. So the compiled preload must import nothing but electron
  // and carry the channel strings inline; assert both, and that they still match CAPTURE_CHANNELS.
  const preloadPath = join(dirname(fileURLToPath(import.meta.url)), 'capture-preload.cjs')
  const cjs = await readFile(preloadPath, 'utf8')
  assert.doesNotMatch(cjs, /require\(["']\.\/protocol\.js["']\)/, 'the preload must NOT require the ESM protocol sibling (sandbox would drop it)')
  assert.doesNotMatch(cjs, /require\(["']\.\/device-match/, 'no app-module require at all')
  for (const value of Object.values(CAPTURE_CHANNELS)) {
    assert.ok(cjs.includes(`'${value}'`) || cjs.includes(`"${value}"`), `preload inlines the ${value} channel literal`)
  }
})

test('spool integration: with the engine unreachable, capture spools instead of losing chunks', async () => {
  // A real EngineLink pointed at a dead port → capture() POST fails → the chunk is spooled to disk.
  const spoolDir = await mkdtemp(join(tmpdir(), 'capture-spool-'))
  const link = new EngineLink({ baseUrl: 'http://127.0.0.1:1', spoolDir })
  const h = harness({ capture: (chunk) => link.capture(chunk) })

  await h.controller.onSessionStarted({ sessionId: 'A', workspaceId: 'ws' })
  await h.controller.onSegment(seg())
  await h.controller.onSegment(seg())

  const files = (await readdir(spoolDir)).filter((f) => f.endsWith('.json'))
  assert.equal(files.length, 2) // both segments durably spooled, nothing thrown, nothing lost
})

// --- un-wedge guard (issue #41): the controller can never get stuck in `stopping`/`starting` ---------

test('un-wedge: a stop the renderer never acks force-clears `stopping` on timeout and returns to idle', async () => {
  const h = harness()
  await h.controller.onSessionStarted({ sessionId: 'A', workspaceId: 'ws' })
  await h.controller.onSegment(seg())
  h.controller.onSessionEnded() // stopping = true; renderer told to stop
  assert.deepEqual(h.control, ['start', 'stop'])
  assert.equal(h.timers.size, 1) // the un-wedge timer is armed
  // The renderer never sends `stopped` (it was not listening / died). Firing the timeout un-wedges us.
  h.timers.fireAll()
  assert.equal(h.controller.currentState, 'idle')
  // And a brand-new start now runs — proving `stopping` no longer swallows it into pendingStart forever.
  await h.controller.onSessionStarted({ sessionId: 'B', workspaceId: 'ws' })
  assert.equal(h.controller.currentState, 'starting')
  assert.deepEqual(h.control, ['start', 'stop', 'start'])
})

test('un-wedge: a start queued while stopping STILL drains when the stop times out (pendingStart never stuck)', async () => {
  const h = harness()
  await h.controller.onSessionStarted({ sessionId: 'A', workspaceId: 'ws' })
  await h.controller.onSegment(seg())
  h.controller.onSessionEnded() // stopping = true
  await h.controller.onSessionStarted({ sessionId: 'B', workspaceId: 'ws' }) // queued (A still "flushing")
  assert.deepEqual(h.control, ['start', 'stop']) // B not begun yet
  h.timers.fireAll() // A's stop never acked → timeout drains the queued B
  await Promise.resolve() // let the queued beginRun's async permission resolve
  assert.deepEqual(h.control, ['start', 'stop', 'start'])
  await h.controller.onSegment(seg({})) // now under B
  assert.equal(h.controller.currentState, 'capturing')
})

test('un-wedge: the real `stopped` ack clears the timer so the timeout is a no-op afterward', async () => {
  const h = harness()
  await h.controller.onSessionStarted({ sessionId: 'A', workspaceId: 'ws' })
  await h.controller.onSegment(seg())
  h.controller.onSessionEnded()
  assert.equal(h.timers.size, 1)
  await h.controller.onCaptureStopped() // renderer acked promptly
  assert.equal(h.timers.size, 0) // timer cleared — no dangling un-wedge
  assert.equal(h.controller.currentState, 'idle')
  h.timers.fireAll() // firing nothing is harmless
  assert.equal(h.controller.currentState, 'idle')
})

test('un-wedge: onStartFailed (dispatcher exhausted retries) drops a stuck `starting` back to idle', async () => {
  const h = harness()
  await h.controller.onSessionStarted({ sessionId: 'A', workspaceId: 'ws' })
  assert.equal(h.controller.currentState, 'starting') // told to start, dispatcher never got an ack
  h.controller.onStartFailed('capture renderer did not acknowledge start')
  assert.equal(h.controller.currentState, 'idle') // no longer claims a warming-up capture
  // A later session starts cleanly.
  await h.controller.onSessionStarted({ sessionId: 'B', workspaceId: 'ws' })
  assert.equal(h.controller.currentState, 'starting')
})

test('un-wedge: rapid start/stop/start/stop cycles always converge to idle (no accumulated wedge)', async () => {
  const h = harness()
  for (let i = 0; i < 5; i += 1) {
    await h.controller.onSessionStarted({ sessionId: `S${i}`, workspaceId: 'ws' })
    await h.controller.onSegment(seg())
    h.controller.onSessionEnded()
    await h.controller.onCaptureStopped()
    assert.equal(h.controller.currentState, 'idle')
  }
  // Even a cycle whose stop is dropped converges via the timeout.
  await h.controller.onSessionStarted({ sessionId: 'last', workspaceId: 'ws' })
  h.controller.onSessionEnded()
  h.timers.fireAll()
  assert.equal(h.controller.currentState, 'idle')
})

// --- system-audio ("them") source — rhymes with mic, plus its two source-scoped behaviours ------------

test('system-audio: no BlackHole-like device ⇒ unavailable (benign), never captures, session unaffected', async () => {
  const h = harness({ source: 'system-audio' })
  await h.controller.onSessionStarted({ sessionId: 'A', workspaceId: 'ws' })
  assert.equal(h.controller.currentState, 'starting') // told renderer to start; it will enumerate + match
  h.controller.onStatus({ source: 'system-audio', state: 'no-device' }) // renderer found no virtual input
  assert.equal(h.controller.currentState, 'unavailable')
  await h.controller.onSegment(seg({ source: 'system-audio' })) // context cleared ⇒ ignored, no throw
  assert.equal(h.captured.length, 0)
  h.controller.onSessionEnded() // ending from unavailable just resolves to idle
  assert.equal(h.controller.currentState, 'idle')
})

test('system-audio: captures chunks tagged system-audio through the same path when a device is present', async () => {
  const h = harness({ source: 'system-audio' })
  await h.controller.onSessionStarted({ sessionId: 'A', workspaceId: 'ws' })
  await h.controller.onSegment(seg({ source: 'system-audio', silent: false }))
  assert.equal(h.controller.currentState, 'capturing')
  assert.equal(h.captured[0]?.source, 'system-audio')
  assert.equal(h.captured[0]?.id, 'sys-A-000001') // the sys- prefix — never collides with a mic chunk
})

test('system-audio silence honesty: first silent signals silent, first real audio signals heard — once each', async () => {
  const h = harness({ source: 'system-audio' })
  await h.controller.onSessionStarted({ sessionId: 'A', workspaceId: 'ws' })
  await h.controller.onSegment(seg({ source: 'system-audio', silent: true }))
  await h.controller.onSegment(seg({ source: 'system-audio', silent: true }))
  assert.deepEqual(h.silences, [true]) // fired ONCE on the first silent segment, not per segment
  await h.controller.onSegment(seg({ source: 'system-audio', silent: false }))
  assert.deepEqual(h.silences, [true, false]) // real audio → heard, fired once
  await h.controller.onSegment(seg({ source: 'system-audio', silent: true }))
  assert.deepEqual(h.silences, [true, false]) // once heard in a run, never reverts to "silent"
  // Chunks flow regardless — we still spool silence (the engine transcribes it to empty, a normal outcome).
  assert.equal(h.captured.length, 4)
})

test('mic segments carry no silent flag ⇒ the silence path is a strict no-op (mic behaviour unchanged)', async () => {
  const h = harness({ source: 'mic' })
  await h.controller.onSessionStarted({ sessionId: 'A', workspaceId: 'ws' })
  await h.controller.onSegment(seg()) // no `silent` field on mic segments
  await h.controller.onSegment(seg())
  assert.deepEqual(h.silences, []) // onSilence never fires for mic
})

// --- screen source — a still-frame IMAGE plus its companion ScreenFrameMeta chunk --------------------

const screenSeg = (over: Partial<RawSegment> = {}): RawSegment => ({
  source: 'screen',
  bytes: new Uint8Array([0xff, 0xd8, 0xff]).buffer,
  mimeType: 'image/jpeg',
  capturedAt: '2026-07-07T10:00:00.000Z',
  screenMeta: { displayId: 'display-1', width: 1920, height: 1080, scale: 2 },
  ...over,
})

test('screen: each frame emits TWO adjacent chunks — the image then its companion ScreenFrameMeta', async () => {
  const h = harness({ source: 'screen' })
  await h.controller.onSessionStarted({ sessionId: 'A', workspaceId: 'ws' })
  assert.equal(h.controller.currentState, 'starting') // frame loop told to start, no frame yet

  await h.controller.onSegment(screenSeg())
  assert.equal(h.controller.currentState, 'capturing') // first frame → honestly capturing
  assert.equal(h.captured.length, 2) // image + meta

  const [image, meta] = h.captured
  assert.equal(image?.source, 'screen')
  assert.equal(image?.contentType, 'image/jpeg')
  assert.equal(image?.encoding, 'base64')
  assert.equal(image?.id, 'scr-A-000001')
  assert.equal(meta?.source, 'screen')
  assert.equal(meta?.contentType, 'application/json')
  assert.equal(meta?.encoding, 'utf8')
  assert.equal(meta?.id, 'scr-A-000002') // NEXT sequence → adjacency
  assert.equal((image?.sequence ?? 0) + 1, meta?.sequence)
  assert.deepEqual(JSON.parse(meta?.data ?? '{}'), { displayId: 'display-1', width: 1920, height: 1080, scale: 2 })
})

test('screen: consecutive frames keep advancing the shared sequence (image/meta/image/meta…)', async () => {
  const h = harness({ source: 'screen' })
  await h.controller.onSessionStarted({ sessionId: 'A', workspaceId: 'ws' })
  await h.controller.onSegment(screenSeg())
  await h.controller.onSegment(screenSeg())
  assert.deepEqual(
    h.captured.map((c) => c.id),
    ['scr-A-000001', 'scr-A-000002', 'scr-A-000003', 'scr-A-000004'],
  )
  // Every screen chunk is image/* or application/json — never an audio type.
  assert.deepEqual(
    h.captured.map((c) => c.contentType),
    ['image/jpeg', 'application/json', 'image/jpeg', 'application/json'],
  )
})

test('screen: session end flushes the final frame then resets to idle (same lifecycle as audio)', async () => {
  const h = harness({ source: 'screen' })
  await h.controller.onSessionStarted({ sessionId: 'A', workspaceId: 'ws' })
  await h.controller.onSegment(screenSeg())
  h.controller.onSessionEnded()
  assert.deepEqual(h.control, ['start', 'stop']) // frame loop told to stop
  await h.controller.onSegment(screenSeg()) // a final in-flight frame still tagged the ended session
  assert.equal(h.captured.length, 4) // 2 frames × (image + meta)
  assert.ok(h.captured.every((c) => c.sessionId === 'A'))
  await h.controller.onCaptureStopped()
  assert.equal(h.controller.currentState, 'idle')
})

test('screen: config disabled ⇒ opt-out no-op (nothing requested, no frame loop started)', async () => {
  let asked = false
  const h = harness({ source: 'screen', enabled: false, requestPermission: async () => ((asked = true), true) })
  await h.controller.onSessionStarted({ sessionId: 'A', workspaceId: 'ws' })
  assert.equal(asked, false)
  assert.equal(h.controller.currentState, 'idle')
  assert.deepEqual(h.control, [])
})

test('screen: Screen-Recording denied ⇒ denied state, no frame loop, session unaffected', async () => {
  const h = harness({ source: 'screen', requestPermission: async () => false })
  await h.controller.onSessionStarted({ sessionId: 'A', workspaceId: 'ws' })
  assert.equal(h.controller.currentState, 'denied')
  assert.deepEqual(h.control, []) // never started grabbing
})

test('a segment WITHOUT screenMeta emits exactly one chunk (audio path unchanged, no phantom meta)', async () => {
  const h = harness({ source: 'mic' })
  await h.controller.onSessionStarted({ sessionId: 'A', workspaceId: 'ws' })
  await h.controller.onSegment(seg()) // mic segment, no screenMeta
  assert.equal(h.captured.length, 1) // one chunk only — the companion-meta path is a strict no-op
})
