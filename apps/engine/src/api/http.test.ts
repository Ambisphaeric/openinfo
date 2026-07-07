import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk, Session } from '@openinfo/contracts'
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

test('session lifecycle: start/list/live/end over the routes, with bus events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  const started: Session[] = []
  const ended: Session[] = []
  app.bus.subscribe('session.started', (s) => {
    started.push(s)
  })
  app.bus.subscribe('session.ended', (s) => {
    ended.push(s)
  })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // empty/unknown workspaces read as empty lists, not errors
    assert.deepEqual(await (await fetch(`${base}/sessions`)).json(), [])
    assert.deepEqual(await (await fetch(`${base}/sessions?workspace=nowhere`)).json(), [])

    // start: engine stamps id/startedAt/manual-attribution from a lean request
    const startRes = await fetch(`${base}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-api', modeId: 'mode-meeting', registerId: 'reg-sales-floor', title: 'A' }),
    })
    assert.equal(startRes.status, 200)
    const a = (await startRes.json()) as Session
    assert.ok(a.id && a.startedAt)
    assert.equal(a.endedAt, undefined)
    assert.equal(a.attribution.confidence, 1)
    assert.deepEqual(a.attribution.evidence.map((e) => e.kind), ['manual'])
    assert.equal(started.length, 1)

    // live filter returns exactly the one unended session
    const live1 = (await (await fetch(`${base}/sessions?workspace=ws-api&live=true`)).json()) as Session[]
    assert.deepEqual(live1.map((s) => s.id), [a.id])

    // start-while-live: A auto-ends (session.ended), B starts (session.started); no reject
    const b = (await (await fetch(`${base}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-api', modeId: 'mode-meeting', title: 'B' }),
    })).json()) as Session
    assert.equal(started.length, 2)
    assert.deepEqual(ended.map((s) => s.id), [a.id]) // A was auto-ended
    const live2 = (await (await fetch(`${base}/sessions?workspace=ws-api&live=true`)).json()) as Session[]
    assert.deepEqual(live2.map((s) => s.id), [b.id]) // only B is live now

    // a DIFFERENT workspace is independent — starting there does not touch ws-api's live session
    await fetch(`${base}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-other', modeId: 'mode-meeting' }),
    })
    assert.equal((await (await fetch(`${base}/sessions?workspace=ws-api&live=true`)).json() as Session[]).length, 1)

    // end B by id; endedAt stamped, one session.ended, and B leaves the live list
    const endRes = await fetch(`${base}/sessions/${encodeURIComponent(b.id)}/end`, { method: 'POST' })
    assert.equal(endRes.status, 200)
    assert.ok(((await endRes.json()) as Session).endedAt)
    assert.deepEqual(ended.map((s) => s.id), [a.id, b.id])
    assert.deepEqual(await (await fetch(`${base}/sessions?workspace=ws-api&live=true`)).json(), [])

    // ending again is idempotent (no second event) and ending an unknown id is 404
    const endsBefore = ended.length
    assert.equal((await fetch(`${base}/sessions/${encodeURIComponent(b.id)}/end`, { method: 'POST' })).status, 200)
    assert.equal(ended.length, endsBefore)
    assert.equal((await fetch(`${base}/sessions/nope/end`, { method: 'POST' })).status, 404)

    // both sessions listed, newest first
    const all = (await (await fetch(`${base}/sessions?workspace=ws-api`)).json()) as Session[]
    assert.deepEqual(all.map((s) => s.id), [b.id, a.id])

    // invalid start request is rejected
    assert.equal((await fetch(`${base}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId: 'mode-meeting' }),
    })).status, 400)
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
