import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk } from '@openinfo/contracts'
import { DEFAULT_AUDIO_CONTENT_TYPE, normalizeContentType, segmentToChunk, type CaptureContext } from './chunk.js'
import type { RawSegment } from './protocol.js'

// The full CaptureChunk field set (payloads.ts) — asserted structurally without pulling typebox into
// the client package (it isn't a client dependency; the contract shape is stable and append-only).
const CHUNK_KEYS = ['id', 'sessionId', 'workspaceId', 'source', 'sequence', 'capturedAt', 'contentType', 'encoding', 'data'] as const

const bytesOf = (...values: number[]): ArrayBuffer => new Uint8Array(values).buffer
const ctx: CaptureContext = { sessionId: 'sess-1', workspaceId: 'ws-1' }
const segment = (over: Partial<RawSegment> = {}): RawSegment => ({
  bytes: bytesOf(1, 2, 3, 4),
  mimeType: 'audio/webm;codecs=opus',
  capturedAt: '2026-07-07T10:00:00.000Z',
  ...over,
})

test('segmentToChunk builds a contract-shaped mic CaptureChunk (exactly the expected fields)', () => {
  const chunk: CaptureChunk = segmentToChunk(segment(), ctx, 1)
  assert.deepEqual(Object.keys(chunk).sort(), [...CHUNK_KEYS].sort())
  assert.equal(chunk.source, 'mic')
  assert.equal(chunk.encoding, 'base64')
  assert.equal(chunk.sessionId, 'sess-1')
  assert.equal(chunk.workspaceId, 'ws-1')
  assert.equal(chunk.sequence, 1)
  assert.equal(chunk.capturedAt, '2026-07-07T10:00:00.000Z')
})

test('the base64 data round-trips back to the original container bytes', () => {
  const chunk = segmentToChunk(segment({ bytes: bytesOf(10, 20, 30, 255, 0) }), ctx, 1)
  assert.deepEqual([...Buffer.from(chunk.data, 'base64')], [10, 20, 30, 255, 0])
})

test('contentType is normalized to the bare audio/<subtype> the engine STT sniff expects', () => {
  // `audio/webm;codecs=opus` and `audio/webm` must both map to the same value (→ audio.webm server-side).
  assert.equal(normalizeContentType('audio/webm;codecs=opus'), 'audio/webm')
  assert.equal(normalizeContentType('audio/webm'), 'audio/webm')
  assert.equal(normalizeContentType('AUDIO/OGG; codecs=opus'), 'audio/ogg')
  assert.equal(segmentToChunk(segment({ mimeType: 'audio/wav' }), ctx, 1).contentType, 'audio/wav')
})

test('a missing or non-audio MIME falls back to the default audio container', () => {
  assert.equal(normalizeContentType(''), DEFAULT_AUDIO_CONTENT_TYPE)
  assert.equal(normalizeContentType('video/mp4'), DEFAULT_AUDIO_CONTENT_TYPE)
  assert.equal(normalizeContentType('audio/'), DEFAULT_AUDIO_CONTENT_TYPE)
})

test('sequence numbers are the caller-owned monotonic counter, folded into a stable id', () => {
  const first = segmentToChunk(segment(), ctx, 1)
  const second = segmentToChunk(segment(), ctx, 2)
  assert.equal(first.id, 'mic-sess-1-000001')
  assert.equal(second.id, 'mic-sess-1-000002')
  assert.notEqual(first.id, second.id)
})
