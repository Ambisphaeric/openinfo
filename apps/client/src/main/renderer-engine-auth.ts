import {
  EngineAuthError,
  fetchEngineControl,
  type EngineCredentialSource,
  type EngineFetchLike,
} from './engine-auth.js'

interface BeforeSendHeadersDetails {
  url: string
  webContentsId?: number
  requestHeaders: Record<string, string>
}

interface HeadersReceivedDetails {
  url: string
  webContentsId?: number
  statusCode: number
}

type BeforeSendHeadersCallback = (response: { cancel?: boolean; requestHeaders?: Record<string, string> }) => void
type HeadersReceivedCallback = (response: { cancel?: boolean }) => void

export interface ElectronWebRequestLike {
  onBeforeSendHeaders(
    filter: { urls: string[] },
    listener: (details: BeforeSendHeadersDetails, callback: BeforeSendHeadersCallback) => void,
  ): void
  onHeadersReceived(
    filter: { urls: string[] },
    listener: (details: HeadersReceivedDetails, callback: HeadersReceivedCallback) => void,
  ): void
}

const asControlOrigin = (value: string): URL => {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new EngineAuthError('bad-url')
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new EngineAuthError('bad-url')
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) throw new EngineAuthError('bad-url')
  return parsed
}

const controlOriginOfRequest = (value: string): string | undefined => {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return undefined
  }
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:'
  else if (parsed.protocol === 'wss:') parsed.protocol = 'https:'
  else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  return parsed.origin
}

const withoutAuthorization = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'authorization'))

const withoutOrigin = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'origin'))

/**
 * Owns the Electron Session's ONE auth listener. Only explicitly trusted built-in HUD webContents receive
 * the bearer, and only for the exact configured engine origin. Renderer JS never receives the credential.
 */
export class RendererEngineAuth {
  private readonly origin: string
  private readonly trusted = new Set<number>()
  private installed = false

  constructor(baseUrl: string, private readonly credentials: EngineCredentialSource) {
    this.origin = asControlOrigin(baseUrl).origin
  }

  trustWebContents(id: number): void {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('trusted webContents id must be a positive integer')
    this.trusted.add(id)
  }

  untrustWebContents(id: number): void {
    this.trusted.delete(id)
  }

  install(webRequest: ElectronWebRequestLike): void {
    if (this.installed) throw new Error('renderer engine auth listener already installed')
    this.installed = true
    const target = new URL(this.origin)
    const wsProtocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsOrigin = `${wsProtocol}//${target.host}`
    const filter = { urls: [`${this.origin}/*`, `${wsOrigin}/*`] }

    webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      const headers = withoutAuthorization(details.requestHeaders)
      if (controlOriginOfRequest(details.url) !== this.origin || !this.trusted.has(details.webContentsId ?? -1)) {
        callback({ requestHeaders: headers })
        return
      }
      const isSocket = details.url.startsWith('ws:') || details.url.startsWith('wss:')
      const trustedHeaders = withoutOrigin(headers)
      void this.credentials.credentialFor(this.origin, isSocket ? { refresh: true } : undefined).then(
        (credential) => callback(credential
          ? { requestHeaders: { ...trustedHeaders, Authorization: `Bearer ${credential.token}`, Origin: this.origin } }
          : { cancel: true, requestHeaders: trustedHeaders }),
        () => callback({ cancel: true, requestHeaders: headers }),
      )
    })

    // A renderer fetch wrapper retries one 401. Hold delivery of that 401 until the rotated discovery
    // record has been reloaded, so its immediate retry receives the new header from onBeforeSendHeaders.
    webRequest.onHeadersReceived(filter, (details, callback) => {
      if (
        details.statusCode !== 401 ||
        controlOriginOfRequest(details.url) !== this.origin ||
        !this.trusted.has(details.webContentsId ?? -1)
      ) {
        callback({})
        return
      }
      void this.credentials.credentialFor(this.origin, { refresh: true }).then(
        () => callback({}),
        () => callback({}),
      )
    })
  }
}

interface NavigationEventLike {
  preventDefault(): void
}

export interface TrustedSurfaceWebContentsLike {
  id: number
  once(event: 'destroyed', listener: () => void): unknown
  on(event: 'will-navigate' | 'will-redirect', listener: (event: NavigationEventLike, url: string) => void): unknown
  setWindowOpenHandler(handler: () => { action: 'deny' }): void
}

const sameTrustedDocument = (candidate: string, expected: string): boolean => {
  try {
    const next = new URL(candidate)
    const pinned = new URL(expected)
    return next.protocol === pinned.protocol && next.host === pinned.host && next.pathname === pinned.pathname
  } catch {
    return false
  }
}

/**
 * A trusted renderer keeps engine authority only while it is pinned to the built-in document that
 * earned that trust. External navigation is denied and permanently revokes the webContents id; new
 * windows are denied so an untrusted page can never inherit the trusted Electron session.
 */
export const pinTrustedSurface = (
  auth: Pick<RendererEngineAuth, 'trustWebContents' | 'untrustWebContents'>,
  contents: TrustedSurfaceWebContentsLike,
  documentUrl: string,
): void => {
  const id = contents.id
  auth.trustWebContents(id)
  const revoke = (): void => auth.untrustWebContents(id)
  const guard = (event: NavigationEventLike, url: string): void => {
    if (sameTrustedDocument(url, documentUrl)) return
    event.preventDefault()
    revoke()
  }
  contents.once('destroyed', revoke)
  contents.on('will-navigate', guard)
  contents.on('will-redirect', guard)
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

export const requestBrowserSettingsTicket = async (options: {
  baseUrl: string
  credentials: EngineCredentialSource
  fetchImpl?: EngineFetchLike
  now?: () => number
}): Promise<string> => {
  const base = asControlOrigin(options.baseUrl)
  const response = await fetchEngineControl({
    baseUrl: base.origin,
    path: '/auth/browser-ticket',
    credentials: options.credentials,
    fetchImpl: options.fetchImpl ?? (globalThis.fetch as unknown as EngineFetchLike),
    init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  })
  if (!response.ok || response.status !== 201) throw new Error(`settings authorization failed (HTTP ${response.status})`)
  const payload = (await response.json()) as { url?: unknown; expiresAt?: unknown }
  if (typeof payload.url !== 'string' || typeof payload.expiresAt !== 'string') {
    throw new Error('settings authorization returned an invalid response')
  }
  let ticketUrl: URL
  try {
    ticketUrl = new URL(payload.url)
  } catch {
    throw new Error('settings authorization returned an invalid URL')
  }
  const expiry = Date.parse(payload.expiresAt)
  if (
    !['http:', 'https:'].includes(ticketUrl.protocol) ||
    ticketUrl.username ||
    ticketUrl.password ||
    ticketUrl.origin !== base.origin ||
    !Number.isFinite(expiry) ||
    expiry <= (options.now?.() ?? Date.now())
  ) {
    throw new Error('settings authorization returned an invalid ticket')
  }
  return ticketUrl.toString()
}
