import type { Ack, BlockQuery, CaptureChunk, Fabric, Flag, Health, QueryResult, Session, StartSessionRequest, Surface, Workspace } from '@openinfo/contracts'
import {
  EngineAuthDiscovery,
  engineWebSocketProtocols,
  fetchEngineControl,
  maySendEngineCredential,
  type EngineCredentialSource,
  type EngineFetchLike,
} from '../main/engine-auth.js'
import { OfflineSpool } from './spool.js'

export interface EngineLinkOptions {
  baseUrl: string
  spoolDir: string
  flushIntervalMs?: number
  credentials?: EngineCredentialSource
  fetchImpl?: EngineFetchLike
  webSocketFactory?: (url: string, protocols?: string[]) => WebSocket
  scheduleReconnect?: (callback: () => void, delayMs: number) => unknown
}

export class EngineLink {
  private baseUrl: string
  private flushing = false
  private readonly credentials: EngineCredentialSource
  private readonly fetchImpl: EngineFetchLike
  private readonly webSocketFactory: (url: string, protocols?: string[]) => WebSocket
  private readonly scheduleReconnect: (callback: () => void, delayMs: number) => unknown
  readonly spool: OfflineSpool

  constructor(options: EngineLinkOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.credentials = options.credentials ?? new EngineAuthDiscovery()
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as EngineFetchLike)
    this.webSocketFactory = options.webSocketFactory ?? ((url, protocols) => protocols ? new WebSocket(url, protocols) : new WebSocket(url))
    this.scheduleReconnect = options.scheduleReconnect ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.spool = new OfflineSpool(options.spoolDir)
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  health(): Promise<Health> {
    return this.get('/health')
  }

  flags(): Promise<Flag[]> {
    return this.getArray('/flags')
  }

  putFlag(flag: Flag): Promise<Flag> {
    return this.request('PUT', `/flags/${encodeURIComponent(flag.key)}`, flag)
  }

  fabric(): Promise<Fabric> {
    return this.get('/fabric')
  }

  putFabric(fabric: Fabric): Promise<Fabric> {
    return this.request('PUT', '/fabric', fabric)
  }

  workspaces(): Promise<Workspace[]> {
    return this.getArray('/workspaces')
  }

  /** List sessions for a workspace; `live: true` narrows to the current live session (HUD Now line). */
  sessions(query: { workspace?: string; live?: boolean } = {}): Promise<Session[]> {
    const params = new URLSearchParams()
    if (query.workspace !== undefined) params.set('workspace', query.workspace)
    if (query.live) params.set('live', 'true')
    const suffix = params.toString()
    return this.getArray(`/sessions${suffix ? `?${suffix}` : ''}`)
  }

  startSession(request: StartSessionRequest): Promise<Session> {
    return this.request('POST', '/sessions', request)
  }

  endSession(id: string): Promise<Session> {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/end`)
  }

  /** Fetch a surface (HUD layout) document — the block renderer's single source of truth. */
  surface(id: string): Promise<Surface> {
    return this.get(`/layouts/surfaces/${encodeURIComponent(id)}`)
  }

  /** Persist an edited surface document (the WYSIWYG editor's write path lands in P6). */
  putSurface(surface: Surface): Promise<Surface> {
    return this.request('PUT', `/layouts/surfaces/${encodeURIComponent(surface.id)}`, surface)
  }

  /** Compile + hydrate a block query server-side — how every HUD block gets its data. */
  query(query: BlockQuery): Promise<QueryResult> {
    return this.request('POST', '/query', query)
  }

  /**
   * Subscribe to the engine's WS event feed (the HUD's live-update trigger). Returns an unsubscribe.
   * Uses the WebSocket global (Node 22+ and browsers), so this method works in Electron; the browser
   * dev entry uses its own fetch-based transport because EngineLink also pulls in node:fs for capture.
   */
  subscribe(handler: (event: { name: string; payload: unknown }) => void): () => void {
    let socket: WebSocket | undefined
    let stopped = false
    let retryMs = 1_000

    const schedule = (): void => {
      if (stopped) return
      const delay = retryMs
      retryMs = Math.min(retryMs * 2, 10_000)
      this.scheduleReconnect(() => void connect(), delay)
    }

    const connect = async (): Promise<void> => {
      if (stopped) return
      try {
        // Reload before EVERY connection, including reconnects: an engine restart rotates its token.
        const credential = await this.credentials.credentialFor(this.baseUrl, { refresh: true })
        if (stopped) return
        if (!credential) throw new Error('engine websocket credential unavailable')
        if (credential && !maySendEngineCredential(this.baseUrl)) throw new Error('engine websocket credential refused')
        const protocols = engineWebSocketProtocols(credential)
        const wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}/events`
        socket = this.webSocketFactory(wsUrl, protocols)
        socket.addEventListener('open', () => {
          retryMs = 1_000
          handler({ name: 'ws.open', payload: undefined })
        })
        socket.addEventListener('message', (event) => {
          let parsed: { name?: unknown; payload?: unknown }
          try {
            parsed = JSON.parse(String((event as { data: unknown }).data)) as { name?: unknown; payload?: unknown }
          } catch {
            return
          }
          if (typeof parsed.name === 'string') handler({ name: parsed.name, payload: parsed.payload })
        })
        socket.addEventListener('close', schedule, { once: true })
      } catch {
        schedule()
      }
    }

    void connect()
    return () => {
      stopped = true
      socket?.close()
    }
  }

  async capture(chunk: CaptureChunk): Promise<Ack | undefined> {
    if ((await this.spool.pendingCount()) > 0) {
      await this.spool.enqueue(chunk)
      await this.flush().catch(() => undefined)
      return undefined
    }
    try {
      return await this.postChunk(chunk)
    } catch {
      await this.spool.enqueue(chunk)
      return undefined
    }
  }

  /**
   * Send a chunk WITHOUT the offline spool — fire-and-forget, dropped on failure. For EPHEMERAL,
   * low-value-when-stale signals (focus/context): replaying "which window was focused 10 minutes ago"
   * out of a spool is noise, not signal, so a focus chunk that can't reach the engine is simply dropped
   * (the next poll re-announces the current context anyway). Audio capture uses `capture` (spooled) —
   * a lost utterance is real data loss; a lost focus tick is not. Never throws (returns undefined on
   * failure) so the caller's poll loop keeps running offline.
   */
  async captureEphemeral(chunk: CaptureChunk): Promise<Ack | undefined> {
    try {
      return await this.postChunk(chunk)
    } catch {
      return undefined
    }
  }

  async flush(): Promise<number> {
    if (this.flushing) return 0
    this.flushing = true
    try {
      return await this.spool.flush(async (chunk) => {
        await this.postChunk(chunk)
      })
    } finally {
      this.flushing = false
    }
  }

  startFlushLoop(intervalMs = 250): () => void {
    const timer = setInterval(() => void this.flush().catch(() => undefined), intervalMs)
    return () => clearInterval(timer)
  }

  private get<T>(path: string): Promise<T> {
    return this.request('GET', path, undefined)
  }

  private async getArray<T>(path: string): Promise<T[]> {
    const value = await this.requestRaw('GET', path)
    if (!Array.isArray(value)) throw new Error(`invalid array response from ${path}`)
    return value as T[]
  }

  private postChunk(chunk: CaptureChunk): Promise<Ack> {
    return this.request('POST', `/capture/${encodeURIComponent(chunk.source)}`, chunk)
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.requestRaw(method, path, body)) as T
  }

  private async requestRaw(method: string, path: string, body?: unknown): Promise<unknown> {
    const init: { method: string; headers?: Record<string, string>; body?: string } = { method }
    if (['POST', 'PUT', 'DELETE'].includes(method.toUpperCase())) {
      init.headers = { 'content-type': 'application/json' }
    }
    if (body !== undefined) {
      init.body = JSON.stringify(body)
    }
    const response = await fetchEngineControl({
      fetchImpl: this.fetchImpl,
      credentials: this.credentials,
      baseUrl: this.baseUrl,
      path,
      init,
    })
    if (!response.ok) throw new Error(`engine ${method} ${path} failed: ${response.status}`)
    return (await response.json()) as unknown
  }
}
