import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import type { CaptureChunk } from '@openinfo/contracts'
import { EventSocketHub, captureReceipt, frameText, type EventSocketPolicy } from './ws.js'

/**
 * frameText emits ONE RFC 6455 server→client text frame. These tests assert the framing bytes for each
 * of the three payload-length encodings AND that the payload round-trips, with the emphasis on the
 * regression the fix originally targeted: a payload > 65 535 bytes used to THROW; it must still frame
 * cleanly even though capture.received is now deliberately too small to contain raw capture bytes.
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

test('multi-byte UTF-8 length is measured in BYTES, not characters', () => {
  // 130 emoji = 520 bytes (each is 4 bytes) → must use the 126/16-bit form even though it is 130 chars.
  const msg = '😀'.repeat(130)
  const frame = frameText(msg)
  assert.equal(frame[1], 126)
  assert.equal(frame.readUInt16BE(2), Buffer.byteLength(msg))
  assert.equal(decodeTextFrame(frame).payload, msg)
})

const TOKEN = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64url')
const KEY = Buffer.from('0123456789abcdef').toString('base64')

class FakeSocket extends EventEmitter {
  readonly writes: Buffer[] = []
  ended = false

  write(chunk: string | Buffer): boolean {
    this.writes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    return true
  }

  end(chunk?: string | Buffer): this {
    if (chunk !== undefined) this.write(chunk)
    this.ended = true
    return this
  }

  destroy(): this {
    this.ended = true
    return this
  }
}

const allowPolicy = (): EventSocketPolicy => ({
  validateHost: (host) => host === '127.0.0.1:8787',
  validateOrigin: (origin) => origin === 'http://127.0.0.1:8787',
  authenticate: (token) => token === TOKEN,
})

const request = (headers: Record<string, string> = {}, url = '/events'): IncomingMessage => ({
  method: 'GET',
  url,
  headers: {
    host: '127.0.0.1:8787',
    origin: 'http://127.0.0.1:8787',
    upgrade: 'websocket',
    connection: 'keep-alive, Upgrade',
    'sec-websocket-version': '13',
    'sec-websocket-key': KEY,
    ...headers,
  },
}) as unknown as IncomingMessage

const handshake = (
  hub: EventSocketHub,
  headers: Record<string, string> = {},
  url = '/events',
): { handled: boolean; socket: FakeSocket; response: string } => {
  const socket = new FakeSocket()
  const handled = hub.handleUpgrade(request(headers, url), socket as unknown as Socket)
  return { handled, socket, response: Buffer.concat(socket.writes).toString('utf8') }
}

test('non-event upgrades are not claimed by the event hub', () => {
  const result = handshake(new EventSocketHub(allowPolicy()), { authorization: `Bearer ${TOKEN}` }, '/other')
  assert.equal(result.handled, false)
  assert.equal(result.response, '')
})

test('events query strings reject explicitly; credentials are never accepted from the URL', () => {
  const result = handshake(
    new EventSocketHub(allowPolicy()),
    { authorization: `Bearer ${TOKEN}` },
    `/events?token=${TOKEN}`,
  )
  assert.equal(result.handled, true)
  assert.match(result.response, /^HTTP\/1\.1 400 Bad Request/m)
  assert.equal(result.response.includes(TOKEN), false)
})

test('Bearer-authenticated handshake validates the boundary and upgrades', () => {
  for (const scheme of ['Bearer', 'bearer']) {
    const result = handshake(new EventSocketHub(allowPolicy()), { authorization: `${scheme} ${TOKEN}` })
    assert.equal(result.handled, true)
    assert.match(result.response, /^HTTP\/1\.1 101 Switching Protocols/m)
    assert.doesNotMatch(result.response, /Sec-WebSocket-Protocol:/i)
    assert.equal(result.socket.ended, false)
  }
})

test('browser subprotocol auth accepts openinfo.v1 + openinfo.auth token and echoes only openinfo.v1', () => {
  const secretProtocol = `openinfo.auth.${TOKEN}`
  const result = handshake(new EventSocketHub(allowPolicy()), {
    'sec-websocket-protocol': `openinfo.v1, ${secretProtocol}`,
  })
  assert.equal(result.handled, true)
  assert.match(result.response, /Sec-WebSocket-Protocol: openinfo\.v1\r\n/)
  assert.equal(result.response.includes(secretProtocol), false, 'the credential protocol is never echoed')
  assert.equal(result.response.includes(TOKEN), false, 'the token is never echoed')
})

test('an in-memory browser session cookie can authenticate the Settings event socket without exposing a bearer', () => {
  const cookie = 'openinfo_control=browser-session-id'
  const policy: EventSocketPolicy = {
    ...allowPolicy(),
    authenticateBrowserSession: (candidate) => candidate === cookie,
  }
  const result = handshake(new EventSocketHub(policy), { cookie })
  assert.equal(result.handled, true)
  assert.match(result.response, /^HTTP\/1\.1 101 Switching Protocols/m)
  assert.doesNotMatch(result.response, /openinfo_control|browser-session-id/i)
  assert.equal(result.socket.ended, false)
})

test('missing or wrong credentials reject explicitly with 401 and never join the broadcast set', () => {
  for (const headers of [{}, { authorization: `Bearer ${Buffer.from('wrong').toString('base64url')}` }]) {
    const hub = new EventSocketHub(allowPolicy())
    const result = handshake(hub, headers)
    assert.equal(result.handled, true)
    assert.match(result.response, /^HTTP\/1\.1 401 Unauthorized/m)
    assert.match(result.response, /WWW-Authenticate: Bearer/)
    const writesAfterReject = result.socket.writes.length
    hub.broadcast('queue.updated', { pendingFiles: 0 })
    assert.equal(result.socket.writes.length, writesAfterReject)
  }
})

test('malformed request lines, websocket headers, bearer values, and subprotocols reject with 400', () => {
  const cases: Array<{ headers?: Record<string, string>; mutate?: (req: IncomingMessage) => void }> = [
    { mutate: (req) => { req.method = 'POST' } },
    { headers: { upgrade: 'not-websocket' } },
    { headers: { connection: 'keep-alive' } },
    { headers: { 'sec-websocket-version': '12' } },
    { headers: { 'sec-websocket-key': 'not-a-key' } },
    { headers: { authorization: 'Basic abc' } },
    { headers: { authorization: 'Bearer ***' } },
    { headers: { 'sec-websocket-protocol': TOKEN } },
    { headers: { 'sec-websocket-protocol': 'openinfo.v1, openinfo.auth.***' } },
    { headers: { 'sec-websocket-protocol': `openinfo.auth.${TOKEN}, openinfo.v1` } },
  ]
  for (const entry of cases) {
    const req = request(entry.headers)
    entry.mutate?.(req)
    const socket = new FakeSocket()
    assert.equal(new EventSocketHub(allowPolicy()).handleUpgrade(req, socket as unknown as Socket), true)
    assert.match(Buffer.concat(socket.writes).toString('utf8'), /^HTTP\/1\.1 400 Bad Request/m)
    assert.equal(socket.ended, true)
  }
})

test('duplicate singleton handshake headers reject instead of degrading to an absent Origin or credential', () => {
  for (const header of ['origin', 'authorization', 'sec-websocket-protocol'] as const) {
    const req = request({ authorization: `Bearer ${TOKEN}` })
    const mutableHeaders = req.headers as unknown as Record<string, string | string[] | undefined>
    mutableHeaders[header] = ['first', 'second']
    const socket = new FakeSocket()
    assert.equal(new EventSocketHub(allowPolicy()).handleUpgrade(req, socket as unknown as Socket), true)
    assert.match(Buffer.concat(socket.writes).toString('utf8'), /^HTTP\/1\.1 400 Bad Request/m)
  }
})

test('Host and Origin policy denials reject explicitly before authentication', () => {
  let authCalls = 0
  const policy: EventSocketPolicy = {
    validateHost: (host) => host === 'allowed.test',
    validateOrigin: (origin) => origin === 'https://allowed.test',
    authenticate: () => { authCalls++; return true },
  }
  for (const headers of [
    { host: 'denied.test', origin: 'https://allowed.test', authorization: `Bearer ${TOKEN}` },
    { host: 'allowed.test', origin: 'https://denied.test', authorization: `Bearer ${TOKEN}` },
  ]) {
    const result = handshake(new EventSocketHub(policy), headers)
    assert.match(result.response, /^HTTP\/1\.1 403 Forbidden/m)
  }
  assert.equal(authCalls, 0, 'credentials are not consulted outside the allowed Host/Origin boundary')
})

test('default policy fails closed when slice A has not injected the control-plane policy', () => {
  const result = handshake(new EventSocketHub(), { authorization: `Bearer ${TOKEN}` })
  assert.match(result.response, /^HTTP\/1\.1 403 Forbidden/m)
})

const screenChunk = (): CaptureChunk => ({
  id: 'scr-sess-1-000001',
  sessionId: 'sess-1',
  workspaceId: 'default',
  source: 'screen',
  sequence: 1,
  capturedAt: '2026-07-12T12:00:00.000Z',
  contentType: 'image/jpeg',
  encoding: 'base64',
  data: Buffer.from('three raw bytes').toString('base64'),
})

test('capture receipt reports decoded byte size without data, hash, or preview', () => {
  const chunk = screenChunk()
  const receipt = captureReceipt(chunk)
  assert.deepEqual(receipt, {
    id: chunk.id,
    sessionId: chunk.sessionId,
    workspaceId: chunk.workspaceId,
    source: chunk.source,
    sequence: chunk.sequence,
    capturedAt: chunk.capturedAt,
    contentType: chunk.contentType,
    encoding: chunk.encoding,
    payloadBytes: Buffer.byteLength('three raw bytes'),
  })
  assert.equal(chunk.data.length > 0, true, 'the internal chunk retains bytes for OCR/STT')
  assert.equal('data' in receipt, false)
  assert.equal('hash' in receipt, false)
  assert.equal('preview' in receipt, false)
})

test('capture.received broadcast transforms only the public event and never serializes raw bytes', () => {
  const hub = new EventSocketHub(allowPolicy())
  const accepted = handshake(hub, { authorization: `Bearer ${TOKEN}` })
  const chunk = screenChunk()
  hub.broadcast('capture.received', chunk)
  const event = JSON.parse(decodeTextFrame(accepted.socket.writes.at(-1)!).payload) as {
    name: string
    payload: Record<string, unknown>
  }
  assert.equal(event.name, 'capture.received')
  assert.deepEqual(event.payload, captureReceipt(chunk))
  assert.equal('data' in event.payload, false)
  assert.equal(JSON.stringify(event).includes(chunk.data), false)
})
