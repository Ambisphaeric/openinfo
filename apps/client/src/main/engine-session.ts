import type { Session, StartSessionRequest } from '@openinfo/contracts'

/**
 * The tray's session control, over the engine HTTP API — the client NEVER opens a DB (dependency
 * rule). A dedicated tiny client rather than EngineLink because (1) EngineLink pulls node:fs for its
 * capture spool, which the tray has no use for, and (2) taking `fetch` as an injected dependency
 * lets the tray-toggle calls be tested against a stub with no network and no display. Mirrors the
 * sessions routes: GET /sessions?live, POST /sessions, POST /sessions/:id/end.
 */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export class EngineSessionClient {
  private readonly baseUrl: string
  private readonly fetchImpl: FetchLike

  constructor(baseUrl: string, fetchImpl?: FetchLike) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.fetchImpl = fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  }

  /** The live (unended) session for a workspace, or undefined — seeds the tray's initial state. */
  async liveSession(workspace: string): Promise<Session | undefined> {
    const params = new URLSearchParams({ workspace, live: 'true' })
    const sessions = (await this.request('GET', `/sessions?${params.toString()}`)) as Session[]
    return Array.isArray(sessions) ? sessions[0] : undefined
  }

  /** Start a session (the tray's "on"). The engine stamps id/startedAt and auto-ends any live one. */
  startSession(request: StartSessionRequest): Promise<Session> {
    return this.request('POST', '/sessions', request) as Promise<Session>
  }

  /** End a session by id (the tray's "off"). Idempotent server-side. */
  endSession(id: string): Promise<Session> {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/end`) as Promise<Session>
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const init: { method: string; headers?: Record<string, string>; body?: string } = { method }
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, init)
    if (!response.ok) throw new Error(`engine ${method} ${path} failed: ${response.status}`)
    return response.json()
  }
}

/**
 * Tracks whether a session is live from the engine's WS event stream — a PUSH source (session.started
 * / session.ended), so the tray reflects state instantly with zero idle cost. Polling was the
 * alternative; it would add fixed latency and waste requests while nothing happens. One initial
 * `liveSession` fetch seeds the current state (the WS only reports future transitions); the stream
 * keeps it fresh. Pure: fed events, it emits the current liveness and the live session's id (needed
 * to end it). Scoped to one workspace — the tray targets a single workspace (ShellConfig.workspace).
 */
export class SessionLiveState {
  private liveId: string | undefined
  private onChangeCb: ((live: boolean) => void) | undefined

  constructor(private readonly workspace: string) {}

  onChange(cb: (live: boolean) => void): void {
    this.onChangeCb = cb
  }

  get live(): boolean {
    return this.liveId !== undefined
  }

  /** The live session's id, for End Session. */
  get liveSessionId(): string | undefined {
    return this.liveId
  }

  /** Seed from the initial fetch (or a fresh reconnect). */
  seed(session: Session | undefined): void {
    this.apply(session && session.endedAt === undefined ? session : undefined)
  }

  /** Apply a WS event; ignores events for other workspaces. Returns true if liveness changed. */
  applyEvent(event: { name: string; payload: unknown }): boolean {
    const session = event.payload as Session | undefined
    if (!session || session.workspaceId !== this.workspace) return false
    if (event.name === 'session.started') return this.apply(session)
    if (event.name === 'session.ended') {
      // Only clear if it's the session we think is live (a stale end for another session is a no-op).
      if (this.liveId === session.id) return this.apply(undefined)
      return false
    }
    return false
  }

  private apply(session: Session | undefined): boolean {
    const next = session?.id
    if (next === this.liveId) return false
    this.liveId = next
    this.onChangeCb?.(this.live)
    return true
  }
}
