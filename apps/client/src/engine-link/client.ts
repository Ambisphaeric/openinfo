import type { Ack, BlockQuery, CaptureChunk, Fabric, Flag, Health, QueryResult, Session, StartSessionRequest, Surface, Workspace } from '@openinfo/contracts'
import { OfflineSpool } from './spool.js'

export interface EngineLinkOptions {
  baseUrl: string
  spoolDir: string
  flushIntervalMs?: number
}

export class EngineLink {
  private baseUrl: string
  private flushing = false
  readonly spool: OfflineSpool

  constructor(options: EngineLinkOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
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
    const socket = new WebSocket(`${this.baseUrl.replace(/^http/, 'ws')}/events`)
    socket.addEventListener('message', (event) => {
      let parsed: { name?: unknown; payload?: unknown }
      try {
        parsed = JSON.parse(String((event as { data: unknown }).data)) as { name?: unknown; payload?: unknown }
      } catch {
        return
      }
      if (typeof parsed.name === 'string') handler({ name: parsed.name, payload: parsed.payload })
    })
    return () => socket.close()
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
    const init: RequestInit = { method }
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    const response = await fetch(`${this.baseUrl}${path}`, init)
    if (!response.ok) throw new Error(`engine ${method} ${path} failed: ${response.status}`)
    return (await response.json()) as unknown
  }
}
