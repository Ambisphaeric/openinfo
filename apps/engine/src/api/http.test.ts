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

test('GET /moments serves stored moments per workspace/session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // empty default workspace and unknown workspaces both read as empty lists, not errors
    assert.deepEqual(await (await fetch(`${base}/moments`)).json(), [])
    assert.deepEqual(await (await fetch(`${base}/moments?workspace=nowhere`)).json(), [])

    app.store.saveMoment({
      id: 'mom-1', sessionId: 'ses-1', workspaceId: 'ws-api', at: '2026-07-07T14:45:00Z',
      kind: 'decision', text: 'ship Thursday', refs: [], source: 'mic', confidence: 0.8,
    })
    const listed = (await (await fetch(`${base}/moments?workspace=ws-api`)).json()) as { id: string }[]
    assert.deepEqual(listed.map((m) => m.id), ['mom-1'])
    const bySession = (await (await fetch(`${base}/moments?workspace=ws-api&session=ses-other`)).json()) as unknown[]
    assert.deepEqual(bySession, [])
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('GET /entities and GET /relevant serve the index per workspace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // empty default workspace and unknown workspaces both read as empty lists, not errors
    assert.deepEqual(await (await fetch(`${base}/entities`)).json(), [])
    assert.deepEqual(await (await fetch(`${base}/relevant?workspace=nowhere`)).json(), [])

    const recentAt = new Date(Date.now() - 60_000).toISOString()
    const dana = app.store.upsertEntity({ workspaceId: 'ws-api', kind: 'person', name: 'Dana', seenAt: recentAt })
    app.store.upsertEntity({ workspaceId: 'ws-api', kind: 'person', name: 'dana', seenAt: recentAt }) // merges
    const soc = app.store.upsertEntity({
      workspaceId: 'ws-api', kind: 'topic', name: 'SOC 2', seenAt: '2026-01-01T00:00:00Z', momentRefs: ['mom-1'],
    })
    app.store.saveMoment({
      id: 'mom-1', sessionId: 'ses-1', workspaceId: 'ws-api', at: '2026-01-01T00:00:00Z',
      kind: 'decision', text: 'SOC 2 addendum agreed', refs: [soc.id], source: 'mic', confidence: 0.8,
    })

    const entities = (await (await fetch(`${base}/entities?workspace=ws-api`)).json()) as { id: string; mentions: number }[]
    assert.equal(entities.length, 2)
    assert.equal(entities.find((e) => e.id === dana.id)?.mentions, 2)

    // relevant-now: fresh 2-mention Dana outranks the year-old topic; the topic row joins its moment
    const relevant = (await (await fetch(`${base}/relevant?workspace=ws-api`)).json()) as {
      entity: { id: string }; score: number; moments: { id: string }[]
    }[]
    assert.deepEqual(relevant.map((r) => r.entity.id), [dana.id, soc.id])
    assert.ok(relevant[0]!.score > relevant[1]!.score)
    assert.deepEqual(relevant[1]!.moments.map((m) => m.id), ['mom-1'])

    // limit + session narrowing
    assert.equal(((await (await fetch(`${base}/relevant?workspace=ws-api&limit=1`)).json()) as unknown[]).length, 1)
    const bySession = (await (await fetch(`${base}/relevant?workspace=ws-api&session=ses-1`)).json()) as { entity: { id: string } }[]
    assert.deepEqual(bySession.map((r) => r.entity.id), [soc.id])
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
