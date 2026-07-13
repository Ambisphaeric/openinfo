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

test('buildTranscriptUpdates preserves interleaved lane chronology and true provenance', () => {
  const at = (sec: number): string => new Date(Date.UTC(2026, 6, 9, 12, 0, sec)).toISOString()
  const updates = buildTranscriptUpdates([
    { sourceChunkId: 'mic-1', sessionId: 's1', source: 'mic' as CaptureSource, sequence: 1, text: 'same words', capturedAt: at(0), processedAt: at(4) },
    { sourceChunkId: 'sys-2', sessionId: 's1', source: 'system-audio' as CaptureSource, sequence: 2, text: 'same words', capturedAt: at(1), processedAt: at(5) },
    { sourceChunkId: 'mic-3', sessionId: 's1', source: 'mic' as CaptureSource, sequence: 3, text: 'same words', capturedAt: at(3), processedAt: at(6) },
  ])
  assert.deepEqual(updates.map((update) => update.source), ['mic', 'system-audio', 'mic'])
  assert.deepEqual(updates.map((update) => update.sourceChunkIds), [['mic-1'], ['sys-2'], ['mic-3']])
  assert.deepEqual(updates.map((update) => update.sourceSequenceRange), [{ start: 1, end: 1 }, { start: 2, end: 2 }, { start: 3, end: 3 }])
  assert.deepEqual(updates.map((update) => update.processedAt), [at(4), at(5), at(6)])
  assert.deepEqual(updates.map((update) => update.capturedAtRange.start), [at(0), at(1), at(3)])
})

test('buildTranscriptUpdates compacts only adjacent same-lane chunks and uses deterministic timestamp ties', () => {
  const capturedAt = '2026-07-09T12:00:00.000Z'
  const updates = buildTranscriptUpdates([
    // Deliberately reversed input. Cross-lane order at the same instant is unknown; source gives a stable
    // presentation tie-break, while sequence orders the two chunks inside the microphone lane only. The
    // system lane's 1 must NOT claim it happened before microphone 99; those counters are independent.
    { sourceChunkId: 'sys-1', sessionId: 's1', source: 'system-audio', sequence: 1, text: 'system', capturedAt, processedAt: '2026-07-09T12:00:03.000Z' },
    { sourceChunkId: 'mic-100', sessionId: 's1', source: 'mic', sequence: 100, text: 'second', capturedAt, processedAt: '2026-07-09T12:00:02.000Z' },
    { sourceChunkId: 'mic-99', sessionId: 's1', source: 'mic', sequence: 99, text: 'first', capturedAt, processedAt: '2026-07-09T12:00:01.000Z' },
  ])
  assert.equal(updates.length, 2)
  assert.deepEqual(updates[0], {
    sessionId: 's1', source: 'mic', text: 'first second', sourceChunkIds: ['mic-99', 'mic-100'],
    sourceSequenceRange: { start: 99, end: 100 },
    capturedAtRange: { start: capturedAt, end: capturedAt }, processedAt: '2026-07-09T12:00:02.000Z',
  })
  assert.equal(updates[1]?.source, 'system-audio')
})

test('buildTranscriptUpdates on no transcribed segments yields no events', () => {
  assert.deepEqual(buildTranscriptUpdates([]), [])
})
