import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk } from '@openinfo/contracts'
import {
  DEFAULT_AUDIO_CONTENT_TYPE,
  DEFAULT_SCREEN_CONTENT_TYPE,
  SCREEN_META_CONTENT_TYPE,
  normalizeContentType,
  normalizeScreenContentType,
  segmentToChunk,
  frameMetaToChunk,
  type CaptureContext,
} from './chunk.js'
import type { RawSegment } from './protocol.js'

// The full CaptureChunk field set (payloads.ts) — asserted structurally without pulling typebox into
// the client package (it isn't a client dependency; the contract shape is stable and append-only).
const CHUNK_KEYS = ['id', 'sessionId', 'workspaceId', 'source', 'sequence', 'capturedAt', 'contentType', 'encoding', 'data'] as const

const bytesOf = (...values: number[]): ArrayBuffer => new Uint8Array(values).buffer
const ctx: CaptureContext = { sessionId: 'sess-1', workspaceId: 'ws-1' }
const segment = (over: Partial<RawSegment> = {}): RawSegment => ({
  source: 'mic',
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

test('the source rides through from the segment; system-audio carries its own contract source', () => {
  const chunk = segmentToChunk(segment({ source: 'system-audio' }), ctx, 1)
  assert.equal(chunk.source, 'system-audio') // the engine attributes this "them"
  assert.equal(chunk.encoding, 'base64')
})

test('mic and system-audio ids never collide even at the same sequence (distinct source prefixes)', () => {
  const mic = segmentToChunk(segment({ source: 'mic' }), ctx, 1)
  const sys = segmentToChunk(segment({ source: 'system-audio' }), ctx, 1)
  assert.equal(mic.id, 'mic-sess-1-000001')
  assert.equal(sys.id, 'sys-sess-1-000001')
  assert.notEqual(mic.id, sys.id) // the two source runs share a session id but never a chunk id
})

// --- screen source: a still-frame IMAGE chunk + its companion ScreenFrameMeta chunk -------------------

const screenSeg = (over: Partial<RawSegment> = {}): RawSegment => ({
  source: 'screen',
  bytes: bytesOf(0xff, 0xd8, 0xff, 0xe0), // JPEG SOI-ish marker bytes
  mimeType: 'image/jpeg',
  capturedAt: '2026-07-07T10:00:00.000Z',
  screenMeta: { displayId: 'display-1', width: 2560, height: 1440, scale: 2 },
  ...over,
})

test('a screen frame becomes a contract-shaped image CaptureChunk (scr prefix, image/jpeg, base64)', () => {
  const chunk: CaptureChunk = segmentToChunk(screenSeg(), ctx, 1)
  assert.deepEqual(Object.keys(chunk).sort(), [...CHUNK_KEYS].sort())
  assert.equal(chunk.source, 'screen')
  assert.equal(chunk.id, 'scr-sess-1-000001') // the scr- prefix, never collides with mic-/sys-
  assert.equal(chunk.contentType, 'image/jpeg')
  assert.equal(chunk.encoding, 'base64')
  assert.deepEqual([...Buffer.from(chunk.data, 'base64')], [0xff, 0xd8, 0xff, 0xe0]) // pixels round-trip
})

test('normalizeScreenContentType strips params and falls back to image/jpeg for junk/non-image', () => {
  assert.equal(normalizeScreenContentType('image/png'), 'image/png')
  assert.equal(normalizeScreenContentType('IMAGE/WEBP; quality=0.7'), 'image/webp')
  assert.equal(normalizeScreenContentType('image/jpeg'), DEFAULT_SCREEN_CONTENT_TYPE)
  assert.equal(normalizeScreenContentType(''), DEFAULT_SCREEN_CONTENT_TYPE)
  assert.equal(normalizeScreenContentType('audio/webm'), DEFAULT_SCREEN_CONTENT_TYPE) // wrong family → default
  assert.equal(normalizeScreenContentType('image/'), DEFAULT_SCREEN_CONTENT_TYPE) // bare family → default
  // The image and audio normalizers are independent — a screen frame never falls back to an audio type.
  assert.equal(segmentToChunk(screenSeg({ mimeType: 'image/png' }), ctx, 1).contentType, 'image/png')
})

test('frameMetaToChunk emits the companion ScreenFrameMeta as a utf8/json source:screen chunk', () => {
  const meta: CaptureChunk = frameMetaToChunk(screenSeg(), ctx, 2)
  assert.deepEqual(Object.keys(meta).sort(), [...CHUNK_KEYS].sort())
  assert.equal(meta.source, 'screen')
  assert.equal(meta.encoding, 'utf8')
  assert.equal(meta.contentType, SCREEN_META_CONTENT_TYPE)
  assert.equal(meta.contentType, 'application/json')
  assert.equal(meta.id, 'scr-sess-1-000002') // NEXT sequence after the image → adjacent, unique id
  assert.equal(meta.capturedAt, '2026-07-07T10:00:00.000Z') // matches the image frame's grab time
  // data is the decoded ScreenFrameMeta JSON — the FocusSignal-style companion (records/screen.ts).
  assert.deepEqual(JSON.parse(meta.data), { displayId: 'display-1', width: 2560, height: 1440, scale: 2 })
})

test('image + companion meta correlate by adjacent sequence and both carry the scr- prefix', () => {
  const image = segmentToChunk(screenSeg(), ctx, 1)
  const meta = frameMetaToChunk(screenSeg(), ctx, 2)
  assert.equal(image.sequence + 1, meta.sequence) // adjacency: meta is the frame's next chunk
  assert.ok(image.id.startsWith('scr-') && meta.id.startsWith('scr-'))
  assert.notEqual(image.id, meta.id)
  // Slice-4 view: an image/* chunk followed by an application/json chunk at the next sequence = one frame.
  assert.equal(image.contentType, 'image/jpeg')
  assert.equal(meta.contentType, 'application/json')
})

test('frameMetaToChunk without screenMeta is a programmer error (never reached on the audio path)', () => {
  assert.throws(() => frameMetaToChunk(segment(), ctx, 2), /screenMeta/) // audio segment carries none
})
