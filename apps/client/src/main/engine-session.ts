import type { Fabric, Session, StartSessionRequest } from '@openinfo/contracts'
import type { EngineSenseVerdict, Sense } from './capture-status.js'
import {
  EngineAuthDiscovery,
  fetchEngineControl,
  type EngineCredentialSource,
  type EngineFetchLike,
  type EngineFetchResponse,
} from './engine-auth.js'

/**
 * The tray's session control, over the engine HTTP API — the client NEVER opens a DB (dependency
 * rule). A dedicated tiny client rather than EngineLink because (1) EngineLink pulls node:fs for its
 * capture spool, which the tray has no use for, and (2) taking `fetch` as an injected dependency
 * lets the tray-toggle calls be tested against a stub with no network and no display. Mirrors the
 * sessions routes: GET /sessions?live, POST /sessions, POST /sessions/:id/end.
 */
export type FetchLike = EngineFetchLike

export class EngineSessionClient {
  private readonly baseUrl: string
  private readonly fetchImpl: FetchLike
  private readonly credentials: EngineCredentialSource

  constructor(baseUrl: string, fetchImpl?: FetchLike, credentials?: EngineCredentialSource) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.fetchImpl = fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
    this.credentials = credentials ?? new EngineAuthDiscovery()
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

  /** The live fabric (active-profile view) — the tray reads it to decide the "Set up models…" nudge. */
  fabric(): Promise<Fabric> {
    return this.request('GET', '/fabric') as Promise<Fabric>
  }

  /**
   * The engine-side per-sense gate verdicts (GET /senses, issue #7) — reduced to the FIRST blocking gate
   * per sense the tray chains after its client-side gates. Defensive: an old engine with no /senses route
   * (404) or a malformed body yields [] so the tray simply omits the engine-side gates, never crashes.
   */
  async senses(): Promise<EngineSenseVerdict[]> {
    const chains = (await this.request('GET', '/senses')) as { sense?: unknown; blocking?: { id?: unknown; label?: unknown; fix?: unknown } }[]
    if (!Array.isArray(chains)) return []
    return chains.flatMap((c) => {
      if (typeof c.sense !== 'string') return []
      const verdict: EngineSenseVerdict = { sense: c.sense as Sense }
      const b = c.blocking
      if (b && typeof b.id === 'string' && typeof b.label === 'string') {
        verdict.blocking = { id: b.id, label: b.label, ...(typeof b.fix === 'string' ? { fix: b.fix } : {}) }
      }
      return [verdict]
    })
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const init: { method: string; headers?: Record<string, string>; body?: string } = { method }
    if (['POST', 'PUT', 'DELETE'].includes(method.toUpperCase())) {
      init.headers = { 'content-type': 'application/json' }
    }
    if (body !== undefined) {
      init.body = JSON.stringify(body)
    }
    const response: EngineFetchResponse = await fetchEngineControl({
      fetchImpl: this.fetchImpl,
      credentials: this.credentials,
      baseUrl: this.baseUrl,
      path,
      init,
    })
    if (!response.ok) throw new Error(`engine ${method} ${path} failed: ${response.status}`)
    return response.json()
  }
}

/**
 * Does the live fabric need a model set up? True when the llm slot has no endpoint — nothing can
 * distill until one exists, so the tray surfaces "Set up models…" prominently. Pure so the tray's
 * first-run nudge is asserted headless; the shell recomputes it on connect and on `fabric.changed`.
 */
export const needsModelSetup = (fabric: Fabric): boolean => fabric.slots.llm.length === 0

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
  private liveTitle: string | undefined
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

  /** The live session's episode title (#211), or undefined until one is derived/set — the tray names by it. */
  get liveSessionTitle(): string | undefined {
    return this.liveTitle
  }

  /** Seed from the initial fetch (or a fresh reconnect). */
  seed(session: Session | undefined): void {
    this.apply(session && session.endedAt === undefined ? session : undefined)
  }

  /** Apply a WS event; ignores events for other workspaces. Returns true if the tray-visible state changed. */
  applyEvent(event: { name: string; payload: unknown }): boolean {
    const session = event.payload as Session | undefined
    if (!session || session.workspaceId !== this.workspace) return false
    if (event.name === 'session.started') return this.apply(session)
    if (event.name === 'session.ended') {
      // Only clear if it's the session we think is live (a stale end for another session is a no-op).
      if (this.liveId === session.id) return this.apply(undefined)
      return false
    }
    // #211: the live session was (re)named — refresh the tray's episode label without a liveness flip.
    if (event.name === 'session.titled') {
      if (this.liveId !== session.id) return false
      const nextTitle = session.title
      if (nextTitle === this.liveTitle) return false
      this.liveTitle = nextTitle
      this.onChangeCb?.(this.live)
      return true
    }
    return false
  }

  private apply(session: Session | undefined): boolean {
    const next = session?.id
    const nextTitle = session?.title
    if (next === this.liveId && nextTitle === this.liveTitle) return false
    this.liveId = next
    this.liveTitle = nextTitle
    this.onChangeCb?.(this.live)
    return true
  }
}
