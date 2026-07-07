import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk } from '@openinfo/contracts'
import { createEngineApp } from './http.js'

test('capture route validates and publishes chunks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  const seen: CaptureChunk[] = []
  app.bus.subscribe('capture.received', (chunk) => {
    seen.push(chunk)
  })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    const chunk: CaptureChunk = {
      id: 'chunk-1',
      sessionId: 'session-1',
      workspaceId: 'default',
      source: 'screen',
      sequence: 1,
      capturedAt: '2026-07-07T14:00:00Z',
      contentType: 'text/plain',
      encoding: 'utf8',
      data: 'frame',
    }
    const response = await fetch(`${base}/capture/screen`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chunk),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(seen.map((entry) => entry.id), ['chunk-1'])
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('GET /registers serves the seeded builtin registers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const response = await fetch(`http://127.0.0.1:${address.port}/registers`)
    assert.equal(response.status, 200)
    const registers = (await response.json()) as { id: string; name: string }[]
    assert.ok(registers.some((r) => r.id === 'reg-boardroom'))
    assert.ok(registers.some((r) => r.id === 'reg-sales-floor'))
    assert.equal(registers.length, 5)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})
