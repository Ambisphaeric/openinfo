import { test } from 'node:test'
import assert from 'node:assert/strict'
import { frameText } from './ws.js'

/**
 * frameText emits ONE RFC 6455 server→client text frame. These tests assert the framing bytes for each
 * of the three payload-length encodings AND that the payload round-trips, with the emphasis on the
 * regression the fix targets: a payload > 65 535 bytes (a large base64 screen frame rebroadcast on
 * `capture.received`) used to THROW; it must now frame cleanly as a 64-bit extended-length frame.
 */

/** Decode a single unmasked text frame back to its FIN/opcode/payload (the mirror of frameText). */
const decodeTextFrame = (buf: Buffer): { fin: boolean; opcode: number; masked: boolean; payload: string } => {
  const b0 = buf[0] ?? 0
  const b1 = buf[1] ?? 0
  const fin = (b0 & 0x80) !== 0
  const opcode = b0 & 0x0f
  const masked = (b1 & 0x80) !== 0
  let len = b1 & 0x7f
  let offset = 2
  if (len === 126) {
    len = buf.readUInt16BE(2)
    offset = 4
  } else if (len === 127) {
    len = Number(buf.readBigUInt64BE(2))
    offset = 10
  }
  return { fin, opcode, masked, payload: buf.subarray(offset, offset + len).toString('utf8') }
}

test('short payload (< 126 bytes): 7-bit length in byte1, FIN + text opcode, unmasked', () => {
  const msg = 'hello events'
  const frame = frameText(msg)
  assert.equal(frame[0], 0x81) // FIN + opcode 0x1 (text)
  assert.equal(frame[1], Buffer.byteLength(msg)) // raw 7-bit length, no extension
  const decoded = decodeTextFrame(frame)
  assert.equal(decoded.fin, true)
  assert.equal(decoded.opcode, 0x1)
  assert.equal(decoded.masked, false) // server frames are never masked
  assert.equal(decoded.payload, msg)
})

test('medium payload (126 .. 65 535 bytes): 126 marker + 16-bit big-endian length', () => {
  const msg = 'x'.repeat(1000)
  const frame = frameText(msg)
  assert.equal(frame[0], 0x81)
  assert.equal(frame[1], 126) // 16-bit extended-length marker
  assert.equal(frame.readUInt16BE(2), 1000)
  assert.equal(decodeTextFrame(frame).payload, msg)
})

test('boundary: 65 535 bytes stays 16-bit; 65 536 bytes crosses to the 64-bit form', () => {
  const at = frameText('a'.repeat(65_535))
  assert.equal(at[1], 126) // still fits the 16-bit length
  assert.equal(at.readUInt16BE(2), 65_535)

  const over = frameText('a'.repeat(65_536))
  assert.equal(over[1], 127) // 64-bit extended-length marker
  assert.equal(Number(over.readBigUInt64BE(2)), 65_536)
})

test('large payload > 64 KB (the old throw-point): 127 marker + 64-bit length, round-trips intact', () => {
  const msg = 'z'.repeat(70_000) // > 65 535 — the case the old cap rejected
  assert.doesNotThrow(() => frameText(msg)) // must NOT throw "frame too large" anymore
  const frame = frameText(msg)
  assert.equal(frame[0], 0x81)
  assert.equal(frame[1], 127)
  assert.equal(Number(frame.readBigUInt64BE(2)), 70_000)
  const decoded = decodeTextFrame(frame)
  assert.equal(decoded.payload.length, 70_000)
  assert.equal(decoded.payload, msg)
})

test('a capture.received-shaped broadcast carrying a big base64 image frames + round-trips', () => {
  // Mirrors what http.ts rebroadcasts: { name, payload } where payload is the full CaptureChunk incl.
  // a large base64 `data`. ~100 KB of base64 comfortably exceeds the old 65 535-byte cap.
  const chunk = {
    id: 'scr-sess-1-000001',
    source: 'screen',
    contentType: 'image/jpeg',
    encoding: 'base64',
    data: 'A'.repeat(100_000),
  }
  const message = JSON.stringify({ name: 'capture.received', payload: chunk })
  const frame = frameText(message)
  assert.equal(frame[1], 127) // 64-bit length form
  assert.deepEqual(JSON.parse(decodeTextFrame(frame).payload), { name: 'capture.received', payload: chunk })
})

test('multi-byte UTF-8 length is measured in BYTES, not characters', () => {
  // 130 emoji = 520 bytes (each is 4 bytes) → must use the 126/16-bit form even though it is 130 chars.
  const msg = '😀'.repeat(130)
  const frame = frameText(msg)
  assert.equal(frame[1], 126)
  assert.equal(frame.readUInt16BE(2), Buffer.byteLength(msg))
  assert.equal(decodeTextFrame(frame).payload, msg)
})
