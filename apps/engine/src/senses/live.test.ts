import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk, OcrResult, Session, TranscriptUpdate } from '@openinfo/contracts'
import { SenseLaneTracker } from './live.js'

const session = (
  id = 's1',
  workspaceId = 'w1',
  startedAt = '2026-07-13T10:00:00.000Z',
): Session => ({
  id, workspaceId, modeId: 'mode', startedAt,
  attribution: { evidence: [], confidence: 1 },
})

const capture = (over: Partial<CaptureChunk> = {}): CaptureChunk => ({
  id: 'mic-1', sessionId: 's1', workspaceId: 'w1', source: 'mic', sequence: 1,
  capturedAt: '2026-07-13T10:00:01.000Z', contentType: 'audio/webm', encoding: 'base64', data: 'PRIVATE',
  ...over,
})

const transcript = (over: Partial<TranscriptUpdate> = {}): TranscriptUpdate => ({
  sessionId: 's1', source: 'mic', text: 'PRIVATE TRANSCRIPT',
  sourceChunkIds: ['mic-1'],
  sourceSequenceRange: { start: 1, end: 1 },
  capturedAtRange: { start: '2026-07-13T10:00:01.000Z', end: '2026-07-13T10:00:01.000Z' },
  processedAt: '2026-07-13T10:00:01.250Z',
  ...over,
})

const ocr = (over: Partial<OcrResult> = {}): OcrResult => ({
  id: 'ocr-1', sessionId: 's1', workspaceId: 'w1', sourceChunks: ['screen-1'],
  text: 'PRIVATE OCR', provenance: { slot: 'ocr', endpoint: 'local-test' }, schemaVersion: 1,
  createdAt: '2026-07-13T10:00:03.000Z', capturedAt: '2026-07-13T10:00:02.000Z',
  ...over,
})

const clock = (start = Date.parse('2026-07-13T12:00:00.000Z')): { now: () => Date; tick: (ms?: number) => void } => {
  let value = start
  return {
    now: () => new Date(value),
    tick: (ms = 1) => { value += ms },
  }
}

test('cold boot is stopped in canonical order; lifecycle is explicit, idempotent, stale-safe, and immutable', () => {
  const time = clock()
  const tracker = new SenseLaneTracker({ now: time.now })
  const cold = tracker.snapshotSet('w1')
  assert.deepEqual(cold.lanes.map((lane) => lane.source), ['mic', 'system-audio', 'screen'])
  assert.ok(cold.lanes.every((lane) => lane.disposition === 'stopped' && lane.health === 'unknown' && lane.reason === 'no-session'))

  const explicitUnknown = tracker.snapshotSet('w1', 'not-observed-this-launch')
  assert.equal(explicitUnknown.sessionId, 'not-observed-this-launch')
  assert.ok(explicitUnknown.lanes.every((lane) => lane.sessionId === explicitUnknown.sessionId && lane.disposition === 'stopped'))

  time.tick()
  const started = tracker.startSession(session())
  assert.equal(started.length, 3)
  assert.ok(started.every((lane) => lane.disposition === 'waiting' && lane.reason === 'awaiting-capture'))
  const beforeDuplicate = tracker.snapshotSet('w1')
  assert.deepEqual(tracker.startSession(session()), []) // session.started then session.switched for the same id
  assert.deepEqual(tracker.snapshotSet('w1'), beforeDuplicate)

  // Returned values are copies, including nested evidence.
  ;(beforeDuplicate.lanes[0] as { reason: string }).reason = 'mutated'
  assert.equal(tracker.snapshotSet('w1').lanes[0].reason, 'awaiting-capture')

  time.tick()
  const ended = tracker.endSession({ ...session(), endedAt: '2026-07-13T10:01:00.000Z' })
  assert.ok(ended.every((lane) => lane.disposition === 'stopped' && lane.reason === 'session-ended'))
  assert.deepEqual(tracker.endSession({ ...session(), endedAt: '2026-07-13T10:01:00.000Z' }), [])
  assert.ok(tracker.snapshotSet('w1').lanes.every((lane) => lane.reason === 'no-session'), 'ending clears the current session')

  // The lifecycle watermark survives stop: a delayed older session cannot become current.
  assert.deepEqual(tracker.startSession(session('stale', 'w1', '2026-07-13T09:59:59.000Z')), [])
  assert.equal(tracker.snapshotSet('w1').sessionId, undefined)
})

test('physical capture filtering requires base64 plus the right case-normalized MIME on all three lanes', () => {
  const tracker = new SenseLaneTracker({ now: () => new Date('2026-07-13T12:00:00.000Z') })
  tracker.startSession(session())

  assert.equal(tracker.recordCapture(capture({ encoding: 'utf8' })), undefined)
  assert.equal(tracker.recordCapture(capture({ contentType: 'text/plain' })), undefined)
  assert.equal(tracker.recordCapture(capture({ source: 'repo', contentType: 'audio/webm' })), undefined)
  const mic = tracker.recordCapture(capture({ contentType: 'AuDiO/WebM' }))
  assert.equal(mic?.source, 'mic')
  assert.equal(mic?.health, 'unknown', 'receipt alone does not prove the processor is healthy')

  assert.equal(tracker.recordCapture(capture({ id: 'sys-bad', source: 'system-audio', encoding: 'utf8' })), undefined)
  assert.equal(tracker.recordCapture(capture({ id: 'sys-bad-2', source: 'system-audio', contentType: 'application/json' })), undefined)
  assert.equal(tracker.recordCapture(capture({ id: 'sys-1', source: 'system-audio', contentType: 'AUDIO/WAV' }))?.source, 'system-audio')

  assert.equal(tracker.recordCapture(capture({ id: 'meta-1', source: 'screen', contentType: 'application/json', encoding: 'utf8' })), undefined)
  assert.equal(tracker.recordCapture(capture({ id: 'screen-utf8', source: 'screen', contentType: 'image/jpeg', encoding: 'utf8' })), undefined)
  assert.equal(tracker.recordCapture(capture({ id: 'screen-json64', source: 'screen', contentType: 'application/json' })), undefined)
  assert.equal(tracker.recordCapture(capture({ id: 'screen-1', source: 'screen', capturedAt: '2026-07-13T10:00:02.000Z', contentType: 'IMAGE/JPEG' }))?.source, 'screen')
})

test('source-local sequence, not a wall-clock timestamp, selects the latest capture within one lane', () => {
  const tracker = new SenseLaneTracker({ now: () => new Date('2026-07-13T12:00:00.000Z') })
  tracker.startSession(session())
  tracker.recordCapture(capture({ id: 'clock-before', sequence: 1, capturedAt: '2026-07-13T10:00:10.000Z' }))
  const afterClockJump = tracker.recordCapture(capture({ id: 'clock-after', sequence: 2, capturedAt: '2026-07-13T09:59:00.000Z' }))
  assert.equal(afterClockJump?.latestCapture?.id, 'clock-after')

  const processed = tracker.recordTranscript(transcript({
    sourceChunkIds: ['clock-before', 'clock-after'],
    sourceSequenceRange: { start: 1, end: 2 },
    capturedAtRange: { start: '2026-07-13T09:59:00.000Z', end: '2026-07-13T10:00:10.000Z' },
    processedAt: '2026-07-13T10:00:11.000Z',
  }))
  assert.equal(processed?.disposition, 'processed')
  assert.equal(processed?.latestProcessing?.captureId, 'clock-after')
})

test('workspace/session isolation rejects stale, ended, cross-scope, and ambiguous transcript work', () => {
  const tracker = new SenseLaneTracker({ now: () => new Date('2026-07-13T12:00:00.000Z') })
  tracker.startSession(session('same', 'w1'))
  tracker.startSession(session('same', 'w2'))
  assert.equal(tracker.recordCapture(capture({ id: 'cross', sessionId: 'same', workspaceId: 'w3' })), undefined)
  assert.ok(tracker.recordCapture(capture({ id: 'w1-mic', sessionId: 'same', workspaceId: 'w1' })))
  assert.ok(tracker.recordCapture(capture({ id: 'w2-mic', sessionId: 'same', workspaceId: 'w2' })))
  assert.equal(tracker.recordTranscript(transcript({ sessionId: 'same', sourceChunkIds: ['w1-mic'] })), undefined, 'ambiguous session id never guesses a workspace')

  tracker.endSession({ ...session('same', 'w1'), endedAt: '2026-07-13T10:01:00.000Z' })
  assert.equal(tracker.recordCapture(capture({ id: 'after-end', sessionId: 'same', workspaceId: 'w1' })), undefined)
  assert.equal(tracker.recordOcr(ocr({ sessionId: 'same', workspaceId: 'w1' })), undefined)

  tracker.startSession(session('new', 'w1', '2026-07-13T10:02:00.000Z'))
  tracker.endSession({ ...session('same', 'w1'), endedAt: '2026-07-13T10:03:00.000Z' }) // stale prior end
  assert.equal(tracker.snapshotSet('w1').sessionId, 'new')
  assert.ok(tracker.recordCapture(capture({ id: 'new-mic', sessionId: 'new', workspaceId: 'w1', capturedAt: '2026-07-13T10:02:01.000Z' })))
})

test('transcript completion requires exact canonical source ids/ranges and clamps negative lag', () => {
  const tracker = new SenseLaneTracker({ now: () => new Date('2026-07-13T12:00:00.000Z') })
  tracker.startSession(session())
  tracker.recordCapture(capture())
  tracker.recordCapture(capture({ id: 'mic-2', sequence: 2, capturedAt: '2026-07-13T10:00:02.000Z' }))

  const exact = transcript({
    sourceChunkIds: ['mic-1', 'mic-2'],
    sourceSequenceRange: { start: 1, end: 2 },
    capturedAtRange: { start: '2026-07-13T10:00:01.000Z', end: '2026-07-13T10:00:02.000Z' },
    processedAt: '2026-07-13T10:00:01.500Z',
  })
  assert.equal(tracker.recordTranscript({ ...exact, sourceChunkIds: ['mic-2', 'mic-1'] }), undefined)
  assert.equal(tracker.recordTranscript({ ...exact, sourceChunkIds: ['mic-1', 'mic-1'] }), undefined)
  assert.equal(tracker.recordTranscript({ ...exact, sourceSequenceRange: { start: 0, end: 2 } }), undefined)
  const processed = tracker.recordTranscript(exact)
  assert.equal(processed?.disposition, 'processed')
  assert.deepEqual(processed?.latestProcessing, {
    captureId: 'mic-2', capturedAt: '2026-07-13T10:00:02.000Z',
    completedAt: '2026-07-13T10:00:01.500Z', lagMs: 0, basis: 'capture-to-processing-completion',
  })
  assert.equal(tracker.recordTranscript(exact), undefined, 'same completion retry is idempotent')

  const serialized = JSON.stringify(tracker.snapshotSet('w1'))
  for (const forbidden of ['PRIVATE', 'TRANSCRIPT', 'text', 'data', 'preview', 'hash', 'error']) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} never enters the read model`)
  }
})

test('aggregate transcript and OCR completions make every correlated capture idempotent across regrouped retries', () => {
  const tracker = new SenseLaneTracker({ now: () => new Date('2026-07-13T12:00:00.000Z') })
  tracker.startSession(session())
  tracker.recordCapture(capture({ id: 'mic-a', sequence: 1, capturedAt: '2026-07-13T10:00:01.000Z' }))
  tracker.recordCapture(capture({ id: 'mic-b', sequence: 2, capturedAt: '2026-07-13T10:00:02.000Z' }))

  const aggregateTranscript = tracker.recordTranscript(transcript({
    sourceChunkIds: ['mic-a', 'mic-b'],
    sourceSequenceRange: { start: 1, end: 2 },
    capturedAtRange: { start: '2026-07-13T10:00:01.000Z', end: '2026-07-13T10:00:02.000Z' },
    processedAt: '2026-07-13T10:00:03.000Z',
  }))
  assert.equal(aggregateTranscript?.latestProcessing?.captureId, 'mic-b', 'canonical last capture anchors public evidence')
  assert.equal(tracker.recordTranscript(transcript({
    sourceChunkIds: ['mic-a'],
    sourceSequenceRange: { start: 1, end: 1 },
    capturedAtRange: { start: '2026-07-13T10:00:01.000Z', end: '2026-07-13T10:00:01.000Z' },
    processedAt: '2026-07-13T10:00:04.000Z',
  })), undefined, 'a regrouped [A] retry after [A,B] is terminal and cannot emit false evidence')

  tracker.recordCapture(capture({
    id: 'screen-a', source: 'screen', sequence: 1,
    capturedAt: '2026-07-13T10:00:05.000Z', contentType: 'image/jpeg',
  }))
  tracker.recordCapture(capture({
    id: 'screen-b', source: 'screen', sequence: 2,
    capturedAt: '2026-07-13T10:00:06.000Z', contentType: 'image/jpeg',
  }))
  const aggregateOcr = tracker.recordOcr(ocr({
    id: 'ocr-aggregate', sourceChunks: ['screen-a', 'screen-b'],
    capturedAt: '2026-07-13T10:00:06.000Z', createdAt: '2026-07-13T10:00:07.000Z',
  }))
  assert.equal(aggregateOcr?.latestProcessing?.captureId, 'screen-b')
  assert.equal(tracker.recordOcr(ocr({
    id: 'ocr-regrouped', sourceChunks: ['screen-a'],
    capturedAt: '2026-07-13T10:00:05.000Z', createdAt: '2026-07-13T10:00:08.000Z',
  })), undefined, 'multi-source OCR marks each frame terminal against subset regrouping')
})

test('OCR exact correlation: older late completion advances evidence but never clears a newer queue', () => {
  const tracker = new SenseLaneTracker({ now: () => new Date('2026-07-13T12:00:00.000Z') })
  tracker.startSession(session())
  tracker.recordCapture(capture({ id: 'screen-a', source: 'screen', sequence: 1, capturedAt: '2026-07-13T10:00:02.000Z', contentType: 'image/jpeg' }))
  tracker.recordCapture(capture({ id: 'screen-b', source: 'screen', sequence: 2, capturedAt: '2026-07-13T10:00:04.000Z', contentType: 'image/jpeg' }))

  assert.equal(tracker.recordOcr(ocr({ sourceChunks: ['missing'] })), undefined)
  assert.equal(tracker.recordOcr(ocr({ sourceChunks: ['screen-a'], capturedAt: '2026-07-13T10:00:09.000Z' })), undefined)
  const older = tracker.recordOcr(ocr({
    id: 'ocr-a', sourceChunks: ['screen-a'], capturedAt: '2026-07-13T10:00:02.000Z',
    createdAt: '2026-07-13T10:00:08.000Z',
  }))
  assert.equal(older?.disposition, 'queued')
  assert.equal(older?.latestCapture?.id, 'screen-b')
  assert.equal(older?.latestProcessing?.captureId, 'screen-a')
  assert.equal(older?.latestProcessing?.lagMs, 6_000)
  assert.equal(tracker.recordOcr(ocr({
    id: 'ocr-a-retry', sourceChunks: ['screen-a'], capturedAt: '2026-07-13T10:00:02.000Z',
    createdAt: '2026-07-13T10:00:09.000Z',
  })), undefined, 'same processed capture id is a no-op even with a later retry timestamp')

  const newest = tracker.recordOcr(ocr({
    id: 'ocr-b', sourceChunks: ['screen-b'], capturedAt: '2026-07-13T10:00:04.000Z',
    createdAt: '2026-07-13T10:00:07.000Z',
  }))
  assert.equal(newest?.disposition, 'processed')
  assert.equal(newest?.latestProcessing?.captureId, 'screen-a', 'latest evidence stays the later completion, not highest capture id')

  assert.equal(tracker.recordCapture(capture({ id: 'screen-b', source: 'screen', sequence: 2, capturedAt: '2026-07-13T10:00:04.000Z', contentType: 'image/jpeg' })), undefined)
  assert.equal(tracker.snapshotSet('w1').lanes[2].disposition, 'processed', 'late queued retry cannot regress processed')

  const laterQueue = tracker.recordCapture(capture({ id: 'screen-c', source: 'screen', sequence: 3, capturedAt: '2026-07-13T10:00:10.000Z', contentType: 'image/jpeg' }))
  assert.equal(laterQueue?.disposition, 'queued')
  assert.equal(laterQueue?.health, 'healthy', 'a prior processing success is retained as lane health evidence')
})
