import { randomBytes } from 'node:crypto'

export const CONTROL_COOKIE_NAME = 'openinfo_control'
export const BROWSER_TICKET_TTL_MS = 30_000
export const BROWSER_SESSION_TTL_MS = 8 * 60 * 60 * 1000

interface ExpiringValue {
  expiresAtMs: number
}

export interface BrowserTicket {
  url: string
  expiresAt: string
}

export interface ConsumedBrowserTicket {
  cookie: string
  expiresAt: string
}

export interface BrowserAuthOptions {
  now?: () => Date
  randomToken?: () => string
}

const defaultRandomToken = (): string => randomBytes(32).toString('base64url')

/** In-memory only: every ticket/session dies on engine restart along with the per-launch credential. */
export class BrowserAuthSessions {
  private readonly tickets = new Map<string, ExpiringValue>()
  private readonly sessions = new Map<string, ExpiringValue>()
  private readonly now: () => Date
  private readonly randomToken: () => string

  constructor(options: BrowserAuthOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.randomToken = options.randomToken ?? defaultRandomToken
  }

  issue(origin: string): BrowserTicket {
    this.prune()
    const ticket = this.randomToken()
    const expiresAtMs = this.now().getTime() + BROWSER_TICKET_TTL_MS
    this.tickets.set(ticket, { expiresAtMs })
    const url = new URL('/auth/browser', origin)
    url.searchParams.set('ticket', ticket)
    return { url: url.toString(), expiresAt: new Date(expiresAtMs).toISOString() }
  }

  consume(ticket: string | null, secure: boolean): ConsumedBrowserTicket | undefined {
    if (ticket === null || ticket === '') return undefined
    const pending = this.tickets.get(ticket)
    // Delete before checking time: a presented ticket is one-use even when it expired between reads.
    this.tickets.delete(ticket)
    if (pending === undefined || pending.expiresAtMs <= this.now().getTime()) return undefined

    const session = this.randomToken()
    const expiresAtMs = this.now().getTime() + BROWSER_SESSION_TTL_MS
    this.sessions.set(session, { expiresAtMs })
    const maxAge = Math.floor(BROWSER_SESSION_TTL_MS / 1000)
    const cookie =
      `${CONTROL_COOKIE_NAME}=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}` +
      (secure ? '; Secure' : '')
    return { cookie, expiresAt: new Date(expiresAtMs).toISOString() }
  }

  authenticateCookie(cookieHeader: string | undefined): boolean {
    if (cookieHeader === undefined) return false
    const raw = cookieHeader
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${CONTROL_COOKIE_NAME}=`))
      ?.slice(CONTROL_COOKIE_NAME.length + 1)
    if (raw === undefined || raw === '') return false
    const session = this.sessions.get(raw)
    if (session === undefined) return false
    if (session.expiresAtMs <= this.now().getTime()) {
      this.sessions.delete(raw)
      return false
    }
    return true
  }

  private prune(): void {
    const now = this.now().getTime()
    for (const [key, value] of this.tickets) if (value.expiresAtMs <= now) this.tickets.delete(key)
    for (const [key, value] of this.sessions) if (value.expiresAtMs <= now) this.sessions.delete(key)
  }
}
