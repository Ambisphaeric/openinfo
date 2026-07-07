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
