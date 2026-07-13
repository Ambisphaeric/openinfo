import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import type { CaptureChunk } from '@openinfo/contracts'
import { createSecureTestEngineApp, TEST_CONTROL_TOKEN, testWsProtocols } from './test-control-plane.js'

const bearer = { authorization: `Bearer ${TEST_CONTROL_TOKEN}` }

const rawStatus = (url: string, headers: Record<string, string>): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.end()
  })

const withEngine = async (
  run: (args: { base: string; app: ReturnType<typeof createSecureTestEngineApp> }) => Promise<void>,
): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-http-security-'))
  const app = createSecureTestEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const address = app.server.address()
  assert.ok(address && typeof address === 'object')
  try {
    await run({ base: `http://127.0.0.1:${address.port}`, app })
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
}

test('only health is public; protected reads require the exact bearer and never expose the token', async () => {
  await withEngine(async ({ base }) => {
    const health = await globalThis.fetch(`${base}/health`)
    assert.equal(health.status, 200)
    const healthText = await health.text()
    assert.doesNotMatch(healthText, new RegExp(TEST_CONTROL_TOKEN))

    const missing = await globalThis.fetch(`${base}/flags`)
    assert.equal(missing.status, 401)
    assert.equal(missing.headers.get('www-authenticate'), 'Bearer')
    const wrong = await globalThis.fetch(`${base}/flags`, { headers: { authorization: `Bearer ${'x'.repeat(43)}` } })
    assert.equal(wrong.status, 401)
    assert.equal((await globalThis.fetch(`${base}/flags`, { headers: bearer })).status, 200)
  })
})

test('boundary order is Host → Origin → auth → Content-Type → JSON parse', async () => {
  await withEngine(async ({ base }) => {
    assert.equal(await rawStatus(`${base}/flags`, { ...bearer, host: 'attacker.example:8787' }), 421)

    const hostileOrigin = await globalThis.fetch(`${base}/flags`, {
      headers: { ...bearer, origin: 'https://attacker.example' },
    })
    assert.equal(hostileOrigin.status, 403)

    // Auth wins before media-type checks, so an unauthenticated drive-by body is never parsed.
    const unauthenticatedMutation = await globalThis.fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'not json',
    })
    assert.equal(unauthenticatedMutation.status, 401)

    for (const contentType of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
      const headers: Record<string, string> = { ...bearer }
      if (contentType !== undefined) headers['content-type'] = contentType
      const response = await globalThis.fetch(`${base}/sessions`, { method: 'POST', headers, body: '{}' })
      assert.equal(response.status, 415, String(contentType))
    }

    const malformed = await globalThis.fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { ...bearer, 'content-type': 'application/json; charset=utf-8' },
      body: '{ definitely not json',
    })
    assert.equal(malformed.status, 400)
    assert.match(await malformed.text(), /not valid JSON/)

    const bodylessMissingType = await globalThis.fetch(`${base}/sessions/no-such-session/end`, {
      method: 'POST', headers: bearer,
    })
    assert.equal(bodylessMissingType.status, 415)
    const bodylessJson = await globalThis.fetch(`${base}/sessions/no-such-session/end`, {
      method: 'POST', headers: { ...bearer, 'content-type': 'application/json' },
    })
    assert.equal(bodylessJson.status, 404) // it reached the route, rather than the media-type guard
  })
})

test('CORS is exact: an allowed preflight is echoed, a hostile origin never gets wildcard access', async () => {
  await withEngine(async ({ base }) => {
    const allowed = await globalThis.fetch(`${base}/flags`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization, content-type',
      },
    })
    assert.equal(allowed.status, 204)
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:3000')
    assert.notEqual(allowed.headers.get('access-control-allow-origin'), '*')
    assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true')

    const hostile = await globalThis.fetch(`${base}/flags`, {
      method: 'OPTIONS',
      headers: { origin: 'https://attacker.example', 'access-control-request-method': 'GET' },
    })
    assert.equal(hostile.status, 403)
    assert.equal(hostile.headers.get('access-control-allow-origin'), null)
  })
})

test('unauthenticated Settings is a locked shell; one-use browser ticket establishes an HttpOnly session', async () => {
  await withEngine(async ({ base }) => {
    const locked = await globalThis.fetch(`${base}/settings`)
    assert.equal(locked.status, 401)
    const lockedHtml = await locked.text()
    assert.match(lockedHtml, /Settings are locked/)
    assert.doesNotMatch(lockedHtml, /fabric|secret|workspace|endpoint/i)
    assert.doesNotMatch(lockedHtml, new RegExp(TEST_CONTROL_TOKEN))

    const issued = await globalThis.fetch(`${base}/auth/browser-ticket`, {
      method: 'POST',
      headers: { ...bearer, 'content-type': 'application/json' },
    })
    assert.equal(issued.status, 201)
    const ticket = (await issued.json()) as { url: string; expiresAt: string }
    assert.deepEqual(Object.keys(ticket).sort(), ['expiresAt', 'url'])
    assert.match(ticket.expiresAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.match(ticket.url, /\/auth\/browser\?ticket=/)
    assert.equal(ticket.url.includes(TEST_CONTROL_TOKEN), false)

    const consumed = await globalThis.fetch(ticket.url, { redirect: 'manual' })
    assert.equal(consumed.status, 302)
    assert.equal(consumed.headers.get('location'), '/settings')
    const setCookie = consumed.headers.get('set-cookie') ?? ''
    assert.match(setCookie, /^openinfo_control=[A-Za-z0-9_-]+;/)
    assert.match(setCookie, /HttpOnly/)
    assert.match(setCookie, /SameSite=Strict/)
    assert.doesNotMatch(setCookie, /Secure/) // local HTTP; tunnel sessions add Secure
    const cookie = setCookie.split(';', 1)[0]!

    const settings = await globalThis.fetch(`${base}/settings`, { headers: { cookie } })
    assert.equal(settings.status, 200)
    assert.match(await settings.text(), /openinfo · settings/)
    assert.equal((await globalThis.fetch(`${base}/flags`, { headers: { cookie } })).status, 200)

    // The URL credential was consumed before the redirect and can never mint a second browser session.
    const replay = await globalThis.fetch(ticket.url, { redirect: 'manual' })
    assert.equal(replay.status, 401)
    assert.match(await replay.text(), /Settings are locked/)
  })
})

test('authenticated capture keeps raw bytes internal while public WS receives only CaptureReceipt', async () => {
  await withEngine(async ({ base, app }) => {
    const internal: CaptureChunk[] = []
    app.bus.subscribe('capture.received', (chunk) => void internal.push(chunk))
    const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/events`, testWsProtocols())
    const event = new Promise<{ name: string; payload: Record<string, unknown> }>((resolve, reject) => {
      socket.addEventListener('message', (message) => {
        const parsed = JSON.parse(String(message.data)) as { name: string; payload: Record<string, unknown> }
        if (parsed.name === 'capture.received') resolve(parsed)
      })
      socket.addEventListener('error', () => reject(new Error('authenticated event socket failed')), { once: true })
    })
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error('authenticated event socket failed')), { once: true })
    })
    try {
      const raw = 'RAW_SCREEN_SENTINEL_DO_NOT_BROADCAST'
      const chunk: CaptureChunk = {
        id: 'security-screen-1', sessionId: 'security-session', workspaceId: 'default', source: 'screen',
        sequence: 7, capturedAt: '2026-07-12T14:00:00.000Z', contentType: 'image/jpeg', encoding: 'base64',
        data: Buffer.from(raw).toString('base64'),
      }
      const ingested = await globalThis.fetch(`${base}/capture/screen`, {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'application/json' },
        body: JSON.stringify(chunk),
      })
      assert.equal(ingested.status, 200)
      const received = await event
      assert.equal(internal[0]?.data, chunk.data)
      assert.equal(received.payload['id'], chunk.id)
      assert.equal(received.payload['payloadBytes'], Buffer.byteLength(raw))
      assert.equal('data' in received.payload, false)
      assert.equal('preview' in received.payload, false)
      assert.equal(JSON.stringify(received).includes(raw), false)
      assert.equal(JSON.stringify(received).includes(chunk.data), false)
    } finally {
      socket.close()
    }
  })
})
