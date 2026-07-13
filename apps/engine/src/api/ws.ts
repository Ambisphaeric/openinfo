import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import type { CaptureChunk, CaptureReceipt } from '@openinfo/contracts'

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
 * Kept dependency-free (no `ws` package), matching the hand-rolled handshake below. Exported for unit
 * tests. capture.received is now a compact CaptureReceipt, but other event types may still legitimately
 * cross either extended-length boundary.
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

export interface EventSocketPolicy {
  validateHost(host: string | undefined): boolean
  validateOrigin(origin: string | undefined): boolean
  authenticate(token: string): boolean
  /** Settings' system-browser WS cannot set Authorization; its HttpOnly session cookie is checked here. */
  authenticateBrowserSession?(cookieHeader: string | undefined): boolean
}

const DENY_ALL: EventSocketPolicy = {
  validateHost: () => false,
  validateOrigin: () => false,
  authenticate: () => false,
}

const statusText: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
}

const rejectUpgrade = (socket: Socket, status: 400 | 401 | 403): true => {
  socket.end(
    [
      `HTTP/1.1 ${status} ${statusText[status]}`,
      'Connection: close',
      'Content-Length: 0',
      ...(status === 401 ? ['WWW-Authenticate: Bearer'] : []),
      '',
      '',
    ].join('\r\n'),
  )
  return true
}

const oneHeader = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined

const isCanonicalBase64Url = (value: string): boolean => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false
  try {
    return Buffer.from(value, 'base64url').toString('base64url') === value
  } catch {
    return false
  }
}

const validWebSocketKey = (key: string | undefined): key is string =>
  key !== undefined && /^[A-Za-z0-9+/]{22}==$/.test(key) && Buffer.from(key, 'base64').byteLength === 16

type ProtocolCredentials = { valid: true; token?: string; offerV1: boolean } | { valid: false }

const protocolCredentials = (header: string | undefined): ProtocolCredentials => {
  if (header === undefined) return { valid: true, offerV1: false }
  const offered = header.split(',').map((part) => part.trim())
  if (offered.length === 1 && offered[0] === 'openinfo.v1') return { valid: true, offerV1: true }
  if (offered.length !== 2 || offered[0] !== 'openinfo.v1') return { valid: false }
  const prefix = 'openinfo.auth.'
  const credential = offered[1]
  if (credential === undefined || !credential.startsWith(prefix)) return { valid: false }
  const token = credential.slice(prefix.length)
  return isCanonicalBase64Url(token) ? { valid: true, token, offerV1: true } : { valid: false }
}

type BearerCredentials = { valid: true; token?: string } | { valid: false }

const bearerCredentials = (header: string | undefined): BearerCredentials => {
  if (header === undefined) return { valid: true }
  const match = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(header)
  if (match?.[1] === undefined || !isCanonicalBase64Url(match[1])) return { valid: false }
  return { valid: true, token: match[1] }
}

/** Convert an internal raw chunk to the only capture shape allowed on the public event feed. */
export const captureReceipt = (chunk: CaptureChunk): CaptureReceipt => ({
  id: chunk.id,
  sessionId: chunk.sessionId,
  workspaceId: chunk.workspaceId,
  source: chunk.source,
  sequence: chunk.sequence,
  capturedAt: chunk.capturedAt,
  contentType: chunk.contentType,
  encoding: chunk.encoding,
  payloadBytes: Buffer.byteLength(chunk.data, chunk.encoding === 'base64' ? 'base64' : 'utf8'),
})

export class EventSocketHub {
  private readonly sockets = new Set<Socket>()

  constructor(private readonly policy: EventSocketPolicy = DENY_ALL) {}

  handleUpgrade(req: IncomingMessage, socket: Socket): boolean {
    if (req.url !== '/events') {
      try {
        if (new URL(req.url ?? '/', 'http://event.invalid').pathname === '/events') {
          return rejectUpgrade(socket, 400)
        }
      } catch {
        // An invalid non-events request belongs to the outer HTTP server, not this hub.
      }
      return false
    }

    const singletonHeaders = [
      req.headers.host,
      req.headers.origin,
      req.headers.authorization,
      req.headers.upgrade,
      req.headers.connection,
      req.headers['sec-websocket-version'],
      req.headers['sec-websocket-key'],
      req.headers['sec-websocket-protocol'],
    ]
    if (singletonHeaders.some((value) => Array.isArray(value))) return rejectUpgrade(socket, 400)

    const upgrade = oneHeader(req.headers.upgrade)
    const connection = oneHeader(req.headers.connection)
    const version = oneHeader(req.headers['sec-websocket-version'])
    const key = oneHeader(req.headers['sec-websocket-key'])
    if (
      req.method !== 'GET' ||
      upgrade?.toLowerCase() !== 'websocket' ||
      !connection?.split(',').some((part) => part.trim().toLowerCase() === 'upgrade') ||
      version !== '13' ||
      !validWebSocketKey(key)
    ) return rejectUpgrade(socket, 400)

    const protocols = protocolCredentials(oneHeader(req.headers['sec-websocket-protocol']))
    const bearer = bearerCredentials(oneHeader(req.headers.authorization))
    if (!protocols.valid || !bearer.valid) return rejectUpgrade(socket, 400)

    let boundaryAllowed = false
    try {
      boundaryAllowed =
        this.policy.validateHost(oneHeader(req.headers.host)) &&
        this.policy.validateOrigin(oneHeader(req.headers.origin))
    } catch {
      boundaryAllowed = false
    }
    if (!boundaryAllowed) return rejectUpgrade(socket, 403)

    const tokens = [bearer.token, protocols.token].filter((token): token is string => token !== undefined)
    let authenticated = false
    try {
      authenticated = tokens.some((token) => this.policy.authenticate(token))
      if (!authenticated && this.policy.authenticateBrowserSession !== undefined) {
        authenticated = this.policy.authenticateBrowserSession(oneHeader(req.headers.cookie))
      }
    } catch {
      authenticated = false
    }
    if (!authenticated) return rejectUpgrade(socket, 401)

    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey(key)}`,
        ...(protocols.offerV1 ? ['Sec-WebSocket-Protocol: openinfo.v1'] : []),
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
    const publicPayload = name === 'capture.received'
      ? captureReceipt(payload as CaptureChunk)
      : payload
    const message = frameText(JSON.stringify({ name, payload: publicPayload }))
    for (const socket of this.sockets) socket.write(message)
  }

  close(): void {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
  }
}
