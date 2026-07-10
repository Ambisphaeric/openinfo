import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk, CaptureSource } from '@openinfo/contracts'
import { DistillCadence, DEFAULT_DISTILL_CADENCE_MS } from './cadence.js'
import { buildTranscriptUpdates } from './transcribe.js'

const chunk = (sec: number, over: Partial<CaptureChunk> = {}): CaptureChunk => ({
  id: `c-${sec}-${over.sessionId ?? 's1'}`,
  sessionId: 's1',
  workspaceId: 'w1',
  source: 'mic',
  sequence: sec,
  capturedAt: new Date(Date.UTC(2026, 6, 9, 12, 0, sec)).toISOString(),
  contentType: 'text/plain',
  encoding: 'utf8',
  data: `line ${sec}`,
  ...over,
})

test('the default cadence threshold is 15s', () => {
  assert.equal(DEFAULT_DISTILL_CADENCE_MS, 15_000)
})

test('DistillCadence holds material until the buffered span crosses the threshold, then releases it once', () => {
  const cadence = new DistillCadence(15_000)

  // three sub-threshold drains (spans 0s, then up to 4s, then up to 10s) release NOTHING
  assert.deepEqual(cadence.offer([chunk(0)]), [])
  assert.deepEqual(cadence.offer([chunk(4)]), [])
  assert.deepEqual(cadence.offer([chunk(10)]), [])
  assert.equal(cadence.pending(), 3)

  // the drain that pushes the span to >=15s releases the WHOLE accumulated batch, in arrival order
  const due = cadence.offer([chunk(15)])
  assert.deepEqual(due.map((c) => c.data), ['line 0', 'line 4', 'line 10', 'line 15'])
  assert.equal(cadence.pending(), 0) // buffer cleared on release

  // fresh accumulation starts again after a release
  assert.deepEqual(cadence.offer([chunk(16)]), [])
  assert.equal(cadence.pending(), 1)
})

test('DistillCadence tracks span per session and flush() drains every buffer', () => {
  const cadence = new DistillCadence(15_000)
  cadence.offer([chunk(0, { sessionId: 's1' }), chunk(0, { sessionId: 's2' })])
  cadence.offer([chunk(5, { sessionId: 's1' })])
  // s1 spans 5s (<15s), s2 spans 0s — neither is due
  assert.equal(cadence.pending(), 3)

  const flushed = cadence.flush()
  assert.equal(flushed.length, 3) // session-end flush drains BOTH sessions' tails
  assert.equal(cadence.pending(), 0)
  assert.deepEqual(cadence.flush(), []) // idempotent
})

test('a single session crossing the threshold does not drag another sub-threshold session out early', () => {
  const cadence = new DistillCadence(15_000)
  cadence.offer([chunk(0, { sessionId: 's1' }), chunk(0, { sessionId: 's2' })])
  const due = cadence.offer([chunk(20, { sessionId: 's1' })]) // s1 span 20s -> due; s2 still 0s
  assert.deepEqual(due.map((c) => c.sessionId), ['s1', 's1'])
  assert.equal(cadence.pending(), 1) // s2's tail stays buffered
})

test('buildTranscriptUpdates aggregates per (session, source) in first-seen order with the capturedAt span', () => {
  const at = (sec: number): string => new Date(Date.UTC(2026, 6, 9, 12, 0, sec)).toISOString()
  const updates = buildTranscriptUpdates([
    { sessionId: 's1', source: 'mic' as CaptureSource, text: 'hello', capturedAt: at(0) },
    { sessionId: 's1', source: 'system-audio' as CaptureSource, text: 'hi there', capturedAt: at(1) },
    { sessionId: 's1', source: 'mic' as CaptureSource, text: 'how are you', capturedAt: at(3) },
  ])
  assert.equal(updates.length, 2) // mic + system-audio, not one-per-chunk
  assert.deepEqual(updates[0], { sessionId: 's1', source: 'mic', text: 'hello how are you', capturedAtRange: { start: at(0), end: at(3) } })
  assert.deepEqual(updates[1], { sessionId: 's1', source: 'system-audio', text: 'hi there', capturedAtRange: { start: at(1), end: at(1) } })
})

test('buildTranscriptUpdates on no transcribed segments yields no events', () => {
  assert.deepEqual(buildTranscriptUpdates([]), [])
})
