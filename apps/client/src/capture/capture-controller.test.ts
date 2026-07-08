import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
const harness = (over: Partial<CaptureControllerDeps> = {}) => {
  const captured: CaptureChunk[] = []
  const control: string[] = []
  const states: CaptureState[] = []
  const silences: boolean[] = []
  const deps: CaptureControllerDeps = {
    source: 'mic',
    enabled: true,
    capture: async (chunk) => void captured.push(chunk),
    control: { start: () => control.push('start'), stop: () => control.push('stop') },
    requestPermission: async () => true,
    onStateChange: (s) => states.push(s),
    onSilence: (silent) => silences.push(silent),
    ...over,
  }
  return { controller: new CaptureController(deps), captured, control, states, silences }
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
  })
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
