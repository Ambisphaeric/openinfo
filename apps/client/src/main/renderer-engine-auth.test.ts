import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EngineCredentialSource, EngineFetchLike } from './engine-auth.js'
import {
  pinTrustedSurface,
  RendererEngineAuth,
  requestBrowserSettingsTicket,
  type ElectronWebRequestLike,
  type TrustedSurfaceWebContentsLike,
} from './renderer-engine-auth.js'

const TOKEN_A = 'A'.repeat(43)
const TOKEN_B = 'B'.repeat(43)

class FakeWebRequest implements ElectronWebRequestLike {
  beforeCalls = 0
  receivedCalls = 0
  before: Parameters<ElectronWebRequestLike['onBeforeSendHeaders']>[1] | undefined
  received: Parameters<ElectronWebRequestLike['onHeadersReceived']>[1] | undefined

  onBeforeSendHeaders(_filter: { urls: string[] }, listener: Parameters<ElectronWebRequestLike['onBeforeSendHeaders']>[1]): void {
    this.beforeCalls += 1
    this.before = listener
  }

  onHeadersReceived(_filter: { urls: string[] }, listener: Parameters<ElectronWebRequestLike['onHeadersReceived']>[1]): void {
    this.receivedCalls += 1
    this.received = listener
  }

  runBefore(details: { url: string; webContentsId?: number; requestHeaders?: Record<string, string> }): Promise<{ cancel?: boolean; requestHeaders?: Record<string, string> }> {
    return new Promise((resolve) => this.before!({ requestHeaders: {}, ...details }, resolve))
  }

  runReceived(details: { url: string; webContentsId?: number; statusCode: number }): Promise<{ cancel?: boolean }> {
    return new Promise((resolve) => this.received!(details, resolve))
  }
}

class FakeTrustedSurface implements TrustedSurfaceWebContentsLike {
  readonly id = 17
  private destroyed: (() => void) | undefined
  private readonly navigation = new Map<string, (event: { preventDefault(): void }, url: string) => void>()
  private openHandler: (() => { action: 'deny' }) | undefined

  once(_event: 'destroyed', listener: () => void): void {
    this.destroyed = listener
  }

  on(event: 'will-navigate' | 'will-redirect', listener: (event: { preventDefault(): void }, url: string) => void): void {
    this.navigation.set(event, listener)
  }

  setWindowOpenHandler(handler: () => { action: 'deny' }): void {
    this.openHandler = handler
  }

  navigate(event: 'will-navigate' | 'will-redirect', url: string): boolean {
    let prevented = false
    this.navigation.get(event)!({ preventDefault: () => { prevented = true } }, url)
    return prevented
  }

  open(): { action: 'deny' } {
    return this.openHandler!()
  }

  destroy(): void {
    this.destroyed?.()
  }
}

test('one centralized listener injects only for trusted webContents and the exact engine origin', async () => {
  const loads: Array<boolean | undefined> = []
  const credentials: EngineCredentialSource = {
    credentialFor: async (_baseUrl, options) => { loads.push(options?.refresh); return { token: TOKEN_A } },
  }
  const request = new FakeWebRequest()
  const auth = new RendererEngineAuth('http://127.0.0.1:8787', credentials)
  auth.trustWebContents(7)
  auth.install(request)
  assert.equal(request.beforeCalls, 1)
  assert.equal(request.receivedCalls, 1)
  assert.throws(() => auth.install(request), /already installed/)

  const trusted = await request.runBefore({
    url: 'http://127.0.0.1:8787/query',
    webContentsId: 7,
    requestHeaders: { Existing: 'yes', authorization: 'renderer-supplied-value' },
  })
  assert.deepEqual(trusted.requestHeaders, {
    Existing: 'yes',
    Authorization: `Bearer ${TOKEN_A}`,
    Origin: 'http://127.0.0.1:8787',
  })
  assert.deepEqual(loads, [undefined])

  const untrusted = await request.runBefore({
    url: 'http://127.0.0.1:8787/query',
    webContentsId: 8,
    requestHeaders: { authorization: 'must-be-stripped' },
  })
  assert.deepEqual(untrusted.requestHeaders, {})
  assert.deepEqual(loads, [undefined])

  const lookalike = await request.runBefore({
    url: 'http://127.0.0.1:87870/query',
    webContentsId: 7,
    requestHeaders: { Authorization: 'must-also-be-stripped' },
  })
  assert.deepEqual(lookalike.requestHeaders, {})
  assert.deepEqual(loads, [undefined])
})

test('trusted renderer requests are cancelled before network I/O when no credential exists', async () => {
  const request = new FakeWebRequest()
  const auth = new RendererEngineAuth('http://127.0.0.1:8787', { credentialFor: async () => undefined })
  auth.trustWebContents(9)
  auth.install(request)
  const result = await request.runBefore({
    url: 'http://127.0.0.1:8787/sessions',
    webContentsId: 9,
    requestHeaders: { authorization: 'renderer-must-not-supply-this' },
  })
  assert.equal(result.cancel, true)
  assert.equal(result.requestHeaders?.['authorization'], undefined)
})

test('WS reloads before every handshake and 401 reload completes before renderer retry', async () => {
  const loads: Array<boolean | undefined> = []
  const credentials: EngineCredentialSource = {
    credentialFor: async (_baseUrl, options) => {
      loads.push(options?.refresh)
      return { token: loads.length === 1 ? TOKEN_A : TOKEN_B }
    },
  }
  const request = new FakeWebRequest()
  const auth = new RendererEngineAuth('https://control.example', credentials)
  auth.trustWebContents(11)
  auth.install(request)

  const socket = await request.runBefore({ url: 'wss://control.example/events', webContentsId: 11 })
  assert.equal(socket.requestHeaders?.['Authorization'], `Bearer ${TOKEN_A}`)
  assert.equal(socket.requestHeaders?.['Origin'], 'https://control.example')
  assert.deepEqual(loads, [true])

  await request.runReceived({ url: 'https://control.example/query', webContentsId: 11, statusCode: 401 })
  assert.deepEqual(loads, [true, true])
  const retried = await request.runBefore({ url: 'https://control.example/query', webContentsId: 11 })
  assert.equal(retried.requestHeaders?.['Authorization'], `Bearer ${TOKEN_B}`)
  assert.equal(retried.requestHeaders?.['Origin'], 'https://control.example')

  auth.untrustWebContents(11)
  const afterDestroy = await request.runBefore({ url: 'https://control.example/query', webContentsId: 11 })
  assert.equal(afterDestroy.requestHeaders?.['Authorization'], undefined)
})

test('trusted surface is pinned to its built-in document and loses authority on external navigation', async () => {
  const credentials: EngineCredentialSource = { credentialFor: async () => ({ token: TOKEN_A }) }
  const request = new FakeWebRequest()
  const auth = new RendererEngineAuth('http://127.0.0.1:8787', credentials)
  const contents = new FakeTrustedSurface()
  auth.install(request)
  pinTrustedSurface(auth, contents, 'file:///Applications/openinfo/hud.html')

  assert.equal(contents.navigate('will-navigate', 'file:///Applications/openinfo/hud.html?surface=repo#now'), false)
  assert.equal((await request.runBefore({ url: 'http://127.0.0.1:8787/query', webContentsId: contents.id })).requestHeaders?.['Authorization'], `Bearer ${TOKEN_A}`)
  assert.deepEqual(contents.open(), { action: 'deny' })

  assert.equal(contents.navigate('will-redirect', 'https://attacker.example/hud.html'), true)
  assert.equal((await request.runBefore({ url: 'http://127.0.0.1:8787/query', webContentsId: contents.id })).requestHeaders?.['Authorization'], undefined)
})

test('browser settings ticket uses authenticated POST and accepts only an unexpired exact-origin URL', async () => {
  const authorizations: string[] = []
  const credentials: EngineCredentialSource = { credentialFor: async () => ({ token: TOKEN_A }) }
  const fetchImpl: EngineFetchLike = async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:8787/auth/browser-ticket')
    assert.equal(init?.method, 'POST')
    authorizations.push(init?.headers?.['authorization'] ?? '')
    return {
      ok: true,
      status: 201,
      json: async () => ({
        url: 'http://127.0.0.1:8787/auth/browser?ticket=one-use',
        expiresAt: '2026-07-13T00:00:30.000Z',
      }),
    }
  }
  const url = await requestBrowserSettingsTicket({
    baseUrl: 'http://127.0.0.1:8787',
    credentials,
    fetchImpl,
    now: () => Date.parse('2026-07-13T00:00:00.000Z'),
  })
  assert.equal(url, 'http://127.0.0.1:8787/auth/browser?ticket=one-use')
  assert.deepEqual(authorizations, [`Bearer ${TOKEN_A}`])
})

test('browser settings ticket rejects an origin swap without reflecting the ticket URL', async () => {
  const secretTicket = 'secret-one-use-ticket'
  await assert.rejects(
    () => requestBrowserSettingsTicket({
      baseUrl: 'https://control.example',
      credentials: { credentialFor: async () => ({ token: TOKEN_A }) },
      fetchImpl: async () => ({
        ok: true,
        status: 201,
        json: async () => ({
          url: `https://evil.example/settings?ticket=${secretTicket}`,
          expiresAt: '2026-07-13T00:00:30.000Z',
        }),
      }),
      now: () => Date.parse('2026-07-13T00:00:00.000Z'),
    }),
    (error: unknown) => error instanceof Error && !error.message.includes(secretTicket),
  )
})
