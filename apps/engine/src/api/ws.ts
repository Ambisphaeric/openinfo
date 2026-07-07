import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'

const acceptKey = (key: string): string =>
  createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')

const frameText = (message: string): Buffer => {
  const payload = Buffer.from(message)
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload])
  if (payload.length > 65_535) throw new Error('Phase 1 websocket frame too large')
  const header = Buffer.alloc(4)
  header[0] = 0x81
  header[1] = 126
  header.writeUInt16BE(payload.length, 2)
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
