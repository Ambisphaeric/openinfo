import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'

const acceptKey = (key: string): string =>
  createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')

/**
 * Frame a UTF-8 text message as a single RFC 6455 server→client (UNMASKED) WebSocket frame. byte0 is
 * `0x81` (FIN set, text opcode 0x1); the payload length has three wire encodings and we implement all
 * three so a frame of ANY size is emittable:
 *   - len < 126      → the 7-bit length lives in byte1
 *   - len ≤ 65 535   → byte1 = 126, then a 16-bit big-endian length
 *   - len > 65 535   → byte1 = 127, then a 64-bit big-endian length
 *
 * WHY this matters now: the old code threw ("Phase 1 websocket frame too large") for payloads over
 * 65 535 bytes. http.ts rebroadcasts `capture.received` with the FULL CaptureChunk — including the
 * base64 `data` — so a single large screen-capture frame would make `broadcast()` throw INSIDE the
 * capture-ingest path and take the event feed down with it. Implementing the extended lengths makes the
 * engine robust regardless of how big a broadcast payload gets. (Separately slimming that
 * `capture.received` payload so it doesn't ship the whole image over the event feed is an http.ts-owned
 * concern — P4A's file — not this fix.) Kept dependency-free (no `ws` package), matching the hand-rolled
 * handshake below. Exported for unit tests.
 */
export const frameText = (message: string): Buffer => {
  const payload = Buffer.from(message)
  const len = payload.length
  if (len < 126) return Buffer.concat([Buffer.from([0x81, len]), payload])
  if (len <= 65_535) {
    const header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
    return Buffer.concat([header, payload])
  }
  const header = Buffer.alloc(10)
  header[0] = 0x81
  header[1] = 127
  header.writeBigUInt64BE(BigInt(len), 2)
  return Buffer.concat([header, payload])
}

export class EventSocketHub {
  private readonly sockets = new Set<Socket>()

  handleUpgrade(req: IncomingMessage, socket: Socket): boolean {
    if (req.url !== '/events') return false
    const key = req.headers['sec-websocket-key']
    if (typeof key !== 'string') return false
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey(key)}`,
        '',
        '',
      ].join('\r\n'),
    )
    this.sockets.add(socket)
    socket.on('close', () => this.sockets.delete(socket))
    socket.on('error', () => this.sockets.delete(socket))
    return true
  }

  broadcast(name: string, payload: unknown): void {
    const message = frameText(JSON.stringify({ name, payload }))
    for (const socket of this.sockets) socket.write(message)
  }

  close(): void {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
  }
}
