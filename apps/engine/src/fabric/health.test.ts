import { createServer } from 'node:http'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Endpoint } from '@openinfo/contracts'
import { checkEndpoint } from './health.js'

test('http endpoint health performs a GET with latency', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200)
    res.end('ok')
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const endpoint: Endpoint = { kind: 'http', name: 'probe', url: `http://127.0.0.1:${address.port}`, api: 'native' }
    const health = await checkEndpoint(endpoint)
    assert.equal(health.ok, true)
    assert.equal(health.name, 'probe')
    assert.equal(typeof health.latencyMs, 'number')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('openai-compat health falls back to /v1/models when the bare root 404s (FastAPI-style servers)', async () => {
  // omlx (and FastAPI servers generally) serve no root route — GET / is 404 while /v1 works fine. The
  // ping must not call such a server unhealthy when the dialect's own listing route answers.
  const server = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'lfm' }] }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ detail: 'Not Found' }))
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const url = `http://127.0.0.1:${address.port}`
    const compat: Endpoint = { kind: 'http', name: 'omlx', url, api: 'openai-compat' }
    const health = await checkEndpoint(compat)
    assert.equal(health.ok, true)
    assert.equal(typeof health.latencyMs, 'number')
    // The fallback is the openai-compat dialect's — a native endpoint on the same server stays honest.
    const native: Endpoint = { kind: 'http', name: 'raw', url, api: 'native' }
    const nativeHealth = await checkEndpoint(native)
    assert.equal(nativeHealth.ok, false)
    assert.equal(nativeHealth.error, 'HTTP 404')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
