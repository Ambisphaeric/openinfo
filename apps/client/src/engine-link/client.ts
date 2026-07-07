import type { Ack, CaptureChunk, Fabric, Flag, Health, Session, StartSessionRequest, Workspace } from '@openinfo/contracts'
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
