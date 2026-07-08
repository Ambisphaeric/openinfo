import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk, Draft, Fabric, Moment, QueryResult, RelevantEntity, Session, Surface } from '@openinfo/contracts'
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

test('surface routes: seeded HUD is served, edits round-trip with a bumped version', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // the seeded openinfo HUD surface is served through the block-renderer's single source of truth
    const hud = (await (await fetch(`${base}/layouts/surfaces/surf-openinfo-hud`)).json()) as Surface
    assert.equal(hud.name, 'openinfo HUD')
    assert.deepEqual(hud.stack.map((b) => b.block), ['now', 'relevant-now', 'moments'])
    assert.equal(hud.version, 1)

    // unknown surface ⇒ 404
    assert.equal((await fetch(`${base}/layouts/surfaces/surf-nope`)).status, 404)

    // PUT an edit → version bumps to 2 and the GET reflects it
    const edited: Surface = { ...hud, stack: hud.stack.filter((b) => b.block !== 'moments') }
    const putRes = await fetch(`${base}/layouts/surfaces/surf-openinfo-hud`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(edited),
    })
    assert.equal(putRes.status, 200)
    assert.equal(((await putRes.json()) as Surface).version, 2)
    const reloaded = (await (await fetch(`${base}/layouts/surfaces/surf-openinfo-hud`)).json()) as Surface
    assert.deepEqual(reloaded.stack.map((b) => b.block), ['now', 'relevant-now'])

    // id mismatch and invalid body are rejected
    assert.equal((await fetch(`${base}/layouts/surfaces/surf-openinfo-hud`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...hud, id: 'surf-other' }),
    })).status, 400)
    assert.equal((await fetch(`${base}/layouts/surfaces/surf-openinfo-hud`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nope: true }),
    })).status, 400)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('POST /query compiles block queries to store calls (moments, relevant-now, empty ledger)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    app.store.saveMoment({
      id: 'mom-q', sessionId: 'ses-q', workspaceId: 'ws-q', at: '2026-07-07T14:45:00Z',
      kind: 'commitment', text: 'send the report', refs: [], source: 'mic', confidence: 0.8,
    })

    const query = async (body: unknown): Promise<QueryResult> =>
      (await (await fetch(`${base}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })).json()) as QueryResult

    const moments = await query({ source: 'moments', params: { workspace: 'ws-q' }, top: 5 })
    assert.equal(moments.source, 'moments')
    assert.deepEqual((moments.items as Moment[]).map((m) => m.id), ['mom-q'])
    assert.equal(moments.truncated, false)

    // ledger has no backing store yet (P4) → empty, not an error
    const ledger = await query({ source: 'ledger', params: {}, top: 2 })
    assert.deepEqual(ledger.items, [])

    // invalid BlockQuery is rejected
    assert.equal((await fetch(`${base}/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'not-a-source', params: {} }),
    })).status, 400)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('e2e: fake llm + seeded HUD surface → data hydration round-trip through the API', async () => {
  const llm = await startFakeLlm()
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // point the llm slot at the fake, and flip the full distill pass on over the API
    const fabric = (await (await fetch(`${base}/fabric`)).json()) as Fabric
    const fabricDoc: Fabric = { slots: { ...fabric.slots, llm: [{ kind: 'http', name: 'llm.fast', url: llm.url, api: 'openai-compat', model: 'llama-3.2-3b' }] } }
    await fetch(`${base}/fabric`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fabricDoc) })
    for (const key of ['distill.enabled', 'distill.moments', 'distill.index']) {
      await fetch(`${base}/flags/${key}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, default: true, scope: 'engine', description: key }),
      })
    }

    // start a live session, then stream two mic chunks (a >30s gap forces one merge window here)
    const started = (await (await fetch(`${base}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'default', modeId: 'mode-meeting' }),
    })).json()) as Session
    const chunk = (sequence: number, sec: number, data: string): CaptureChunk => ({
      id: `c-${sequence}`, sessionId: started.id, workspaceId: 'default', source: 'mic', sequence,
      capturedAt: new Date(Date.UTC(2026, 6, 7, 14, 0, sec)).toISOString(), contentType: 'text/plain', encoding: 'utf8', data,
    })
    for (const c of [chunk(1, 0, 'we should ship Thursday'), chunk(2, 20, 'Dana agreed, ship Thursday')]) {
      await fetch(`${base}/capture/mic`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })
    }

    // the drain distills at idle → wait for moments to appear over the API
    await eventuallyHttp(async () => {
      const moments = (await (await fetch(`${base}/moments?workspace=default&session=${started.id}`)).json()) as Moment[]
      assert.ok(moments.length >= 1)
    })

    // hydrate the seeded HUD exactly as the client will: GET the surface, POST /query per block
    const hud = (await (await fetch(`${base}/layouts/surfaces/surf-openinfo-hud`)).json()) as Surface
    for (const block of hud.stack) {
      if (!block.query) continue
      const result = (await (await fetch(`${base}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(block.query),
      })).json()) as QueryResult
      assert.equal(result.source, block.query.source)
      if (block.block === 'moments') {
        // "session: current" bound to the live session → the extracted commitment hydrates the stream
        assert.ok((result.items as Moment[]).some((m) => m.kind === 'commitment' && /Thursday/.test(m.text)))
      }
      if (block.block === 'relevant-now') {
        // the entity index produced a ranked, joined row — every card is inspectable to its moments
        assert.ok((result.items as RelevantEntity[]).length >= 1)
      }
    }
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => llm.server.close(() => resolve()))
  }
})

interface FakeLlm { server: Server; url: string }
const startFakeLlm = async (): Promise<FakeLlm> => {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: { content: string }[] }
      const prompt = body.messages[0]!.content
      const content = prompt.includes('JSON array of entities')
        ? '[{"kind": "person", "name": "Dana"}, {"kind": "topic", "name": "Thursday ship date", "aliases": ["ship Thursday"]}]'
        : prompt.includes('Return ONLY a JSON array')
          ? '[{"kind": "commitment", "text": "ship Thursday", "speaker": "user", "confidence": 0.85}]'
          : 'they agreed to ship Thursday.'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}` }
}

const eventuallyHttp = async (assertion: () => Promise<void>, timeoutMs = 4000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try { await assertion(); return } catch (error) { lastError = error; await new Promise((r) => setTimeout(r, 25)) }
  }
  throw lastError instanceof Error ? lastError : new Error('condition not met')
}

test('e2e: session start → capture → distill → end → follow-up draft ≤60s → store → bus → GET /drafts', async () => {
  const llm = await startFakeLlm()
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  const drafts: Draft[] = []
  app.bus.subscribe('draft.created', (d) => {
    drafts.push(d)
  })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    const fabric = (await (await fetch(`${base}/fabric`)).json()) as Fabric
    await fetch(`${base}/fabric`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slots: { ...fabric.slots, llm: [{ kind: 'http', name: 'llm.fast', url: llm.url, api: 'openai-compat', model: 'llama-3.2-3b' }] } }),
    })
    // the full pass plus the act: distill produces the summaries the draft is composed from
    for (const key of ['distill.enabled', 'distill.moments', 'act.enabled']) {
      await fetch(`${base}/flags/${key}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, default: true, scope: 'engine', description: key }),
      })
    }

    const started = (await (await fetch(`${base}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'default', modeId: 'mode-meeting' }),
    })).json()) as Session
    const chunk = (sequence: number, sec: number, data: string): CaptureChunk => ({
      id: `c-${sequence}`, sessionId: started.id, workspaceId: 'default', source: 'mic', sequence,
      capturedAt: new Date(Date.UTC(2026, 6, 7, 14, 0, sec)).toISOString(), contentType: 'text/plain', encoding: 'utf8', data,
    })
    for (const c of [chunk(1, 0, 'we should ship Thursday'), chunk(2, 20, 'agreed, Thursday it is')]) {
      await fetch(`${base}/capture/mic`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })
    }
    // distillation happens at idle on the drain
    await eventuallyHttp(async () => {
      const moments = (await (await fetch(`${base}/moments?workspace=default&session=${started.id}`)).json()) as Moment[]
      assert.ok(moments.length >= 1)
    })

    // end the call — the Act trigger flushes the drain then composes the follow-up draft
    const endAt = Date.now()
    const endRes = await fetch(`${base}/sessions/${encodeURIComponent(started.id)}/end`, { method: 'POST' })
    assert.equal(endRes.status, 200)

    await eventuallyHttp(async () => assert.equal(drafts.length, 1))
    const elapsed = Date.now() - endAt
    assert.ok(elapsed < 60_000, `draft prepared in ${elapsed}ms — under the ≤60s budget`)

    // the published draft is composed from the session's stored distillates, register-bound (the
    // meeting mode defaults to boardroom), and prepared (never sent)
    const draft = drafts[0]!
    assert.equal(draft.actKind, 'follow-up-draft')
    assert.equal(draft.status, 'prepared')
    assert.equal(draft.sessionId, started.id)
    assert.ok(draft.body.length > 0)
    assert.ok(draft.provenance.sourceDistillates.length >= 1)
    assert.equal(draft.provenance.templateId, 'tpl-followup-default')
    assert.equal(draft.voice.registerId, 'reg-boardroom')

    // retrievable over the API (the exit criterion: a draft that exists and can be fetched)
    const listed = (await (await fetch(`${base}/drafts?workspace=default&session=${started.id}`)).json()) as Draft[]
    assert.deepEqual(listed.map((d) => d.id), [draft.id])
    // unknown workspace reads empty, not an error
    assert.deepEqual(await (await fetch(`${base}/drafts?workspace=nowhere`)).json(), [])
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => llm.server.close(() => resolve()))
  }
})

test('act.enabled OFF: ending a session prepares no draft', async () => {
  const llm = await startFakeLlm()
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  const drafts: Draft[] = []
  app.bus.subscribe('draft.created', (d) => {
    drafts.push(d)
  })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    const fabric = (await (await fetch(`${base}/fabric`)).json()) as Fabric
    await fetch(`${base}/fabric`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slots: { ...fabric.slots, llm: [{ kind: 'http', name: 'llm.fast', url: llm.url, api: 'openai-compat', model: 'llama-3.2-3b' }] } }),
    })
    // distill on, but act.enabled stays OFF (default) → summaries exist, no draft is prepared
    await fetch(`${base}/flags/distill.enabled`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'distill.enabled', default: true, scope: 'engine', description: 'd' }),
    })
    const started = (await (await fetch(`${base}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'default', modeId: 'mode-meeting' }),
    })).json()) as Session
    await fetch(`${base}/capture/mic`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'c-1', sessionId: started.id, workspaceId: 'default', source: 'mic', sequence: 1, capturedAt: '2026-07-07T14:00:00Z', contentType: 'text/plain', encoding: 'utf8', data: 'we should ship Thursday' }),
    })
    // wait for the drain to distill (a summary exists) — so the ONLY reason there is no draft is
    // that act.enabled is off, not that there was nothing to draft
    await eventuallyHttp(async () => assert.ok(app.store.listDistillates('default', started.id).length >= 1))
    await fetch(`${base}/sessions/${encodeURIComponent(started.id)}/end`, { method: 'POST' })

    // give the (disabled) act trigger a chance to NOT fire
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(drafts.length, 0)
    assert.deepEqual(await (await fetch(`${base}/drafts?workspace=default`)).json(), [])
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => llm.server.close(() => resolve()))
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

test('fabric profiles: seeded list, GET, PUT create, clone, activate, delete-active refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // the three example profiles are seeded and listable
    const seeded = (await (await fetch(`${base}/fabric/profiles`)).json()) as { id: string }[]
    assert.deepEqual(seeded.map((p) => p.id).sort(), ['lm-studio-local', 'ollama-local', 'remote-http-template'])
    // seeded but INERT — GET /fabric is still the empty/legacy map
    assert.deepEqual(((await (await fetch(`${base}/fabric`)).json()) as Fabric).slots.llm, [])

    // GET one; unknown id → 404
    assert.equal((await fetch(`${base}/fabric/profiles/lm-studio-local`)).status, 200)
    assert.equal((await fetch(`${base}/fabric/profiles/nope`)).status, 404)

    // PUT create a profile; id mismatch → 400
    const profile = { id: 'my-rig', name: 'My rig', version: 1, fabric: { slots: { stt: [], tts: [], vlm: [], ocr: [], embed: [], llm: [{ kind: 'http', name: 'x', url: 'http://host:8000', api: 'openai-compat' }] } } }
    const created = await fetch(`${base}/fabric/profiles/my-rig`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(profile) })
    assert.equal(created.status, 200)
    assert.equal((await created.json() as { version: number }).version, 1)
    assert.equal((await fetch(`${base}/fabric/profiles/mismatch`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(profile) })).status, 400)

    // clone; duplicate id → 409, unknown source → 404
    const cloned = await fetch(`${base}/fabric/profiles/my-rig/clone`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'my-rig-2', name: 'Copy' }) })
    assert.equal(cloned.status, 200)
    assert.equal((await cloned.json() as { id: string }).id, 'my-rig-2')
    assert.equal((await fetch(`${base}/fabric/profiles/my-rig/clone`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'my-rig' }) })).status, 409)
    assert.equal((await fetch(`${base}/fabric/profiles/ghost/clone`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'z' }) })).status, 404)

    // activate → GET /fabric now reflects the active profile's map
    const activated = await fetch(`${base}/fabric/profiles/my-rig/activate`, { method: 'POST' })
    assert.equal(activated.status, 200)
    assert.equal(((await (await fetch(`${base}/fabric`)).json()) as Fabric).slots.llm.length, 1)
    assert.equal((await fetch(`${base}/fabric/profiles/ghost/activate`, { method: 'POST' })).status, 404)

    // deleting the ACTIVE profile is refused (409); a non-active one deletes (200); unknown → 404
    assert.equal((await fetch(`${base}/fabric/profiles/my-rig`, { method: 'DELETE' })).status, 409)
    assert.equal((await fetch(`${base}/fabric/profiles/my-rig-2`, { method: 'DELETE' })).status, 200)
    assert.equal((await fetch(`${base}/fabric/profiles/my-rig-2`, { method: 'DELETE' })).status, 404)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('secrets never echo: write/list/delete carry only refs; no value reaches GET /fabric or the fabric.changed event', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  const fabricEvents: unknown[] = []
  app.bus.subscribe('fabric.changed', (f) => { fabricEvents.push(f) })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  const SECRET = 'sk-super-secret-value-xyz'
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // empty to start
    assert.deepEqual(await (await fetch(`${base}/fabric/secrets`)).json(), [])

    // PUT a secret value → response is a bare ref, NEVER the value
    const put = await fetch(`${base}/fabric/secrets/remote-llm-key`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: SECRET }) })
    assert.equal(put.status, 200)
    const putBody = await put.text()
    assert.deepEqual(JSON.parse(putBody), { ref: 'remote-llm-key' })
    assert.equal(putBody.includes(SECRET), false, 'PUT response leaked the value')

    // GET list returns refs only, never values
    const list = await (await fetch(`${base}/fabric/secrets`)).text()
    assert.deepEqual(JSON.parse(list), [{ ref: 'remote-llm-key' }])
    assert.equal(list.includes(SECRET), false, 'GET /fabric/secrets leaked the value')

    // put a profile whose endpoint references the key by ref, activate it → GET /fabric + the event
    const profile = { id: 'authed', name: 'Authed', version: 1, fabric: { slots: { stt: [], tts: [], vlm: [], ocr: [], embed: [], llm: [{ kind: 'http', name: 'r', url: 'http://host:8000', api: 'openai-compat', auth: { keyRef: 'remote-llm-key' } }] } } }
    await fetch(`${base}/fabric/profiles/authed`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(profile) })
    await fetch(`${base}/fabric/profiles/authed/activate`, { method: 'POST' })

    const fabricText = await (await fetch(`${base}/fabric`)).text()
    assert.equal(fabricText.includes(SECRET), false, 'GET /fabric leaked the value')
    assert.equal(fabricText.includes('remote-llm-key'), true, 'the keyRef (not the value) should be present')

    // the fabric.changed event payload carries the keyRef, never the value
    assert.ok(fabricEvents.length >= 1)
    const eventText = JSON.stringify(fabricEvents)
    assert.equal(eventText.includes(SECRET), false, 'fabric.changed leaked the value')
    assert.equal(eventText.includes('remote-llm-key'), true)

    // DELETE returns the ref, never the value; unknown → 404
    const del = await fetch(`${base}/fabric/secrets/remote-llm-key`, { method: 'DELETE' })
    assert.equal(del.status, 200)
    assert.equal((await del.text()).includes(SECRET), false)
    assert.equal((await fetch(`${base}/fabric/secrets/remote-llm-key`, { method: 'DELETE' })).status, 404)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('e2e: activating a profile swaps what the distiller invokes, and its keyRef reaches the server Authorization header', async () => {
  const authHeaders: string[] = []
  const server = createServer((req, res) => {
    authHeaders.push(String(req.headers['authorization'] ?? ''))
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'summary via active profile' } }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const llmAddr = server.address()
  assert.ok(llmAddr && typeof llmAddr === 'object')
  const llmUrl = `http://127.0.0.1:${llmAddr.port}`

  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  const SECRET = 'sk-profile-key-777'
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // store the secret the profile's endpoint references, create + activate the profile
    await fetch(`${base}/fabric/secrets/prof-key`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: SECRET }) })
    const profile = { id: 'live-remote', name: 'Live remote', version: 1, fabric: { slots: { stt: [], tts: [], vlm: [], ocr: [], embed: [], llm: [{ kind: 'http', name: 'remote', url: llmUrl, api: 'openai-compat', model: 'm', auth: { keyRef: 'prof-key' } }] } } }
    await fetch(`${base}/fabric/profiles/live-remote`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(profile) })
    await fetch(`${base}/fabric/profiles/live-remote/activate`, { method: 'POST' })

    await fetch(`${base}/flags/distill.enabled`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'distill.enabled', default: true, scope: 'engine', description: 'on' }) })

    const started = (await (await fetch(`${base}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: 'default', modeId: 'mode-meeting' }) })).json()) as Session
    const chunk = (sequence: number, sec: number, data: string): CaptureChunk => ({ id: `c-${sequence}`, sessionId: started.id, workspaceId: 'default', source: 'mic', sequence, capturedAt: new Date(Date.UTC(2026, 6, 7, 14, 0, sec)).toISOString(), contentType: 'text/plain', encoding: 'utf8', data })
    for (const c of [chunk(1, 0, 'ship it'), chunk(2, 40, 'agreed, ship it')]) {
      await fetch(`${base}/capture/mic`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })
    }

    // the drain distills via the ACTIVE profile's endpoint, carrying its resolved keyRef
    await eventuallyHttp(async () => {
      const distillates = (await (await fetch(`${base}/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'moments', params: { workspace: 'default' } }) })).json()) as QueryResult
      void distillates
      assert.ok(authHeaders.length >= 1)
    }, 8000)
    assert.equal(authHeaders[0], `Bearer ${SECRET}`)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('GET /setup serves the self-contained page (skeleton, seeded profiles, first-run banner, ?edit)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    // keep this unit test offline + deterministic: an empty probe list ⇒ discovery does no real network I/O
    app.store.layouts.put('discovery-probes', 'probes-default', { id: 'probes-default', version: 1, probes: [] })

    const res = await fetch(`${base}/setup`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/html/)
    const html = await res.text()
    assert.match(html, /openinfo · model setup/)
    assert.match(html, /id="row-tpl"/) // the add-endpoint template is present
    // fresh install: the live fabric's llm slot is empty ⇒ the first-run banner shows
    assert.match(html, /class="banner"/)
    // seeded profiles are listed and are inert (none active ⇒ each offers Activate)
    assert.match(html, /data-act="activate" data-id="lm-studio-local"/)
    // ?edit selects which profile the editor opens
    const edited = await (await fetch(`${base}/setup?edit=ollama-local`)).text()
    assert.match(edited, /data-target-id="ollama-local"/)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('POST /fabric/test probes an endpoint: reachable+latency, 401 hint, unresolved-keyRef hint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  // a fake server whose GET status we can flip (health checks GET the base url)
  let status = 200
  const upstream = createServer((_req, res) => { res.writeHead(status); res.end('ok') })
  await new Promise<void>((resolve) => upstream.listen(0, resolve))
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const upAddr = upstream.address()
    const appAddr = app.server.address()
    assert.ok(upAddr && typeof upAddr === 'object' && appAddr && typeof appAddr === 'object')
    const url = `http://127.0.0.1:${upAddr.port}`
    const base = `http://127.0.0.1:${appAddr.port}`
    const probe = async (endpoint: unknown) =>
      (await (await fetch(`${base}/fabric/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(endpoint) })).json()) as { ok: boolean; latencyMs?: number; error?: string; hint?: string }

    // reachable
    status = 200
    const ok = await probe({ kind: 'http', name: 'lm', url, api: 'openai-compat' })
    assert.equal(ok.ok, true)
    assert.equal(typeof ok.latencyMs, 'number')

    // 401 with no keyRef ⇒ honest hint to add a key
    status = 401
    const unauth = await probe({ kind: 'http', name: 'lm', url, api: 'openai-compat' })
    assert.equal(unauth.ok, false)
    assert.match(unauth.error ?? '', /HTTP 401/)
    assert.match(unauth.hint ?? '', /authorization required/)

    // an endpoint whose keyRef has no stored value fails gracefully with an actionable hint (no fetch)
    const missing = await probe({ kind: 'http', name: 'lm', url, api: 'openai-compat', auth: { keyRef: 'nope' } })
    assert.equal(missing.ok, false)
    assert.match(missing.error ?? '', /unresolved secret keyRef/)
    assert.match(missing.hint ?? '', /no value stored/)

    // invalid body ⇒ 400
    const bad = await fetch(`${base}/fabric/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nope: true }) })
    assert.equal(bad.status, 400)
  } finally {
    await app.close()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

// --- Onboarding discovery + the Get-Started lens ---

/** A fake OpenAI-compatible server whose /v1/models list we control. */
const startFakeModels = async (ids: string[]) => {
  const server = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) }))
      return
    }
    res.writeHead(200); res.end('ok') // the base-url GET (health/test) answers too
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}` }
}

/** Point the engine's seeded probe list at fake servers so discovery is deterministic. */
const setProbes = (app: Awaited<ReturnType<typeof createEngineApp>>, probes: { name: string; url: string }[]) =>
  app.store.layouts.put('discovery-probes', 'probes-default', { id: 'probes-default', version: 1, probes })

test('GET /fabric/discover probes servers, classifies models, and synthesizes a suggestion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  const lm = await startFakeModels(['qwen3.6-35b-a3b', 'glm-ocr', 'nomic-embed-text'])
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    setProbes(app, [{ name: 'lm-studio', url: lm.url }, { name: 'dead', url: 'http://127.0.0.1:1' }])

    const result = (await (await fetch(`${base}/fabric/discover`)).json()) as import('@openinfo/contracts').DiscoverResult
    const lmServer = result.servers.find((s) => s.name === 'lm-studio')!
    assert.equal(lmServer.reachable, true)
    assert.equal(lmServer.models.length, 3)
    assert.equal(result.servers.find((s) => s.name === 'dead')!.reachable, false)
    assert.equal(result.suggestion.slots.llm[0]!.kind === 'http' && result.suggestion.slots.llm[0]!.model, 'qwen3.6-35b-a3b')
    assert.equal(result.suggestion.slots.ocr[0]!.kind === 'http' && result.suggestion.slots.ocr[0]!.model, 'glm-ocr')
    assert.equal(result.suggestion.slots.embed.length, 1)
  } finally {
    await app.close()
    await new Promise<void>((resolve) => lm.server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('GET /setup on a fresh install shows the Get-Started lens with detected capabilities', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  const lm = await startFakeModels(['qwen3-8b', 'glm-ocr'])
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    setProbes(app, [{ name: 'lm-studio', url: lm.url }])

    const html = await (await fetch(`${base}/setup`)).text()
    assert.match(html, /Get started/)
    assert.match(html, /data-act="use-setup"/)
    assert.match(html, /Thinking/)
    assert.match(html, /qwen3-8b/) // the detected llm model surfaces in the lens
    assert.match(html, /<details id="advanced"/) // the editor moved behind Advanced
  } finally {
    await app.close()
    await new Promise<void>((resolve) => lm.server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('use-this-setup e2e: discover → config-1 written+activated → GET /fabric reflects it → not first-run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  const lm = await startFakeModels(['qwen3-8b', 'whisper-large-v3'])
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    setProbes(app, [{ name: 'lm-studio', url: lm.url }])

    // fresh install: /fabric is empty (first run)
    const before = (await (await fetch(`${base}/fabric`)).json()) as Fabric
    assert.equal(before.slots.llm.length, 0)

    // 1) discover (what the lens embeds)
    const result = (await (await fetch(`${base}/fabric/discover`)).json()) as import('@openinfo/contracts').DiscoverResult
    assert.ok(result.suggestion.slots.llm.length > 0)

    // 2) the exact routes the "Use this setup" button drives: PUT config-1 then activate
    const put = await fetch(`${base}/fabric/profiles/config-1`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'config-1', name: 'Config 1', version: 1, fabric: result.suggestion, description: 'Detected local setup.' }),
    })
    assert.equal(put.status, 200)
    const act = await fetch(`${base}/fabric/profiles/config-1/activate`, { method: 'POST' })
    assert.equal(act.status, 200)

    // 3) GET /fabric now reflects the detected setup (config-1 is the live fabric)
    const after = (await (await fetch(`${base}/fabric`)).json()) as Fabric
    assert.equal(after.slots.llm[0]!.kind === 'http' && after.slots.llm[0]!.model, 'qwen3-8b')
    assert.equal(after.slots.stt[0]!.kind === 'http' && after.slots.stt[0]!.model, 'whisper-large-v3')

    // 4) the page is no longer first-run: no banner, and the lens does not lead (llm is configured)
    const html = await (await fetch(`${base}/setup`)).text()
    assert.doesNotMatch(html, /class="banner"/)
    assert.doesNotMatch(html, /Get started/)
    // config-1 is the active profile
    assert.match(html, /badge active/)
  } finally {
    await app.close()
    await new Promise<void>((resolve) => lm.server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

// --- Slice (b): the Try-it "say something → watch it become a moment" loop on /setup ---

/** Collect named WS events off the engine's /events socket (server→client frames). */
const openEvents = async (base: string): Promise<{ events: { name: string; payload: { sessionId?: string } }[]; close: () => void }> => {
  const events: { name: string; payload: { sessionId?: string } }[] = []
  const socket = new WebSocket(base.replace(/^http/, 'ws') + '/events')
  socket.addEventListener('message', (event) => {
    const parsed = JSON.parse(String(event.data)) as { name: string; payload: { sessionId?: string } }
    events.push(parsed)
  })
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('ws failed')), { once: true })
  })
  return { events, close: () => socket.close() }
}

/** What the Try-it card's browser script does over HTTP: flip a flag on, preserving its doc shape. */
const enableFlag = async (base: string, key: string): Promise<void> => {
  await fetch(`${base}/flags/${key}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, default: true, scope: 'engine', description: key }),
  })
}

test('e2e (Try-it TYPE path): flags flip → onboarding session → text chunk → drain → moment.created on WS → introspection trail', async () => {
  const llm = await startFakeLlm()
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // point the llm slot at the fake (as "Use this setup" would), then subscribe to the WS
    const fabric = (await (await fetch(`${base}/fabric`)).json()) as Fabric
    await fetch(`${base}/fabric`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slots: { ...fabric.slots, llm: [{ kind: 'http', name: 'llm.fast', url: llm.url, api: 'openai-compat', model: 'qwen3-8b' }] } }),
    })
    const sub = await openEvents(base)
    try {
      // the card's consent-flip: distillation on (voice would add distill.transcribe; text needs neither)
      await enableFlag(base, 'distill.enabled')
      await enableFlag(base, 'distill.moments')

      // start the onboarding session on the seeded meeting mode, then POST one utf8 text chunk to /capture/mic
      const started = (await (await fetch(`${base}/sessions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'default', modeId: 'mode-meeting', title: 'onboarding try-it' }),
      })).json()) as Session
      const chunk: CaptureChunk = {
        id: 'try-1', sessionId: started.id, workspaceId: 'default', source: 'mic', sequence: 0,
        capturedAt: new Date().toISOString(), contentType: 'text/plain', encoding: 'utf8', data: 'we should ship Thursday',
      }
      const ack = await fetch(`${base}/capture/mic`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chunk) })
      assert.equal(ack.status, 200)

      // the payoff: moment.created for THIS session arrives on the WS (the card renders it live)
      await eventuallyHttp(async () => {
        assert.ok(sub.events.some((e) => e.name === 'moment.created' && e.payload.sessionId === started.id))
      }, 6000)
      const created = sub.events.find((e) => e.name === 'moment.created' && e.payload.sessionId === started.id)!
        .payload as unknown as Moment
      assert.ok(created.text.length > 0)
      assert.ok(created.provenance && created.provenance.endpoint === 'llm.fast')

      // the introspection trail the card falls back on: moments read back, flags stuck on
      const moments = (await (await fetch(`${base}/moments?workspace=default&session=${started.id}`)).json()) as Moment[]
      assert.ok(moments.some((m) => m.id === created.id))
      const flags = (await (await fetch(`${base}/flags`)).json()) as { key: string; default: boolean }[]
      const byKey = Object.fromEntries(flags.map((f) => [f.key, f.default]))
      assert.equal(byKey['distill.enabled'], true)
      assert.equal(byKey['distill.moments'], true)
    } finally {
      sub.close()
    }
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => llm.server.close(() => resolve()))
  }
})

test('e2e (Try-it VOICE path): a canned base64 webm chunk rides the stt slot → transcribed → moment.created on WS', async () => {
  const llm = await startFakeLlm()
  const stt = await startFakeSttReply('we should ship Thursday')
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // both slots filled (llm + stt), as a rig with a transcription server would be
    const fabric = (await (await fetch(`${base}/fabric`)).json()) as Fabric
    await fetch(`${base}/fabric`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slots: { ...fabric.slots, llm: [{ kind: 'http', name: 'llm.fast', url: llm.url, api: 'openai-compat', model: 'qwen3-8b' }], stt: [{ kind: 'http', name: 'whisper-box', url: stt.url, api: 'openai-compat', model: 'whisper-1' }] } }),
    })
    const sub = await openEvents(base)
    try {
      // the voice path flips the transcribe stage on too (the card's consent line names it when stt exists)
      await enableFlag(base, 'distill.enabled')
      await enableFlag(base, 'distill.moments')
      await enableFlag(base, 'distill.transcribe')

      const started = (await (await fetch(`${base}/sessions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'default', modeId: 'mode-meeting', title: 'onboarding try-it' }),
      })).json()) as Session
      // the same base64 audio/webm CaptureChunk shape the browser MediaRecorder + Electron client emit
      const chunk: CaptureChunk = {
        id: 'try-voice-1', sessionId: started.id, workspaceId: 'default', source: 'mic', sequence: 0,
        capturedAt: new Date().toISOString(), contentType: 'audio/webm', encoding: 'base64',
        data: Buffer.from('fake-webm-bytes').toString('base64'),
      }
      await fetch(`${base}/capture/mic`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chunk) })

      // audio → stt slot → utf8 text → distill → moment.created for this session on the WS
      await eventuallyHttp(async () => {
        assert.ok(sub.events.some((e) => e.name === 'moment.created' && e.payload.sessionId === started.id))
      }, 6000)
      // the stt server was actually hit (the transcription stage ran the audio chunk through it)
      assert.ok(stt.hits() >= 1)
    } finally {
      sub.close()
    }
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => llm.server.close(() => resolve()))
    await new Promise<void>((resolve) => stt.server.close(() => resolve()))
  }
})

/** A fake OpenAI-compatible STT server that returns a fixed transcript and counts transcription hits. */
const startFakeSttReply = async (reply: string): Promise<{ server: Server; url: string; hits: () => number }> => {
  let hits = 0
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (req.url && req.url.includes('/v1/audio/transcriptions')) hits += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ text: reply }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}`, hits: () => hits }
}

// --- Slice (c): engine-managed local runtimes / tier zero ---

/**
 * A FAKE local runtime binary: a node script that serves /health + /v1/chat/completions with the same
 * moment-producing branching as startFakeLlm, so a spawned local endpoint drives distill→moments end to
 * end. Real spawn (the engine's LocalRuntimeManager), fake model server — the CI-safe tier-zero e2e.
 */
const writeFakeRuntime = (dir: string): string => {
  const src =
    '#!/usr/bin/env node\n' +
    "const { createServer } = require('node:http')\n" +
    'const args = process.argv.slice(2)\n' +
    "const port = Number(args[args.indexOf('--port') + 1])\n" +
    'createServer((req, res) => {\n' +
    "  let body = ''\n" +
    "  req.on('data', (c) => (body += c))\n" +
    "  req.on('end', () => {\n" +
    "    if (req.url === '/health') { res.writeHead(200); res.end('{\"status\":\"ok\"}'); return }\n" +
    "    if (req.url === '/v1/chat/completions') {\n" +
    "      const p = JSON.parse(body || '{}'); const prompt = (p.messages && p.messages[0] && p.messages[0].content) || ''\n" +
    "      const content = prompt.includes('JSON array of entities')\n" +
    '        ? \'[{"kind":"person","name":"Dana"}]\'\n' +
    "        : prompt.includes('Return ONLY a JSON array')\n" +
    '          ? \'[{"kind":"commitment","text":"ship Thursday","speaker":"user","confidence":0.85}]\'\n' +
    "          : 'they agreed to ship Thursday.'\n" +
    "      res.writeHead(200, { 'content-type': 'application/json' })\n" +
    '      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] })); return\n' +
    '    }\n' +
    '    res.writeHead(404); res.end()\n' +
    '  })\n' +
    "}).listen(port, '127.0.0.1')\n"
  const bin = join(dir, 'fake-runtime')
  writeFileSync(bin, src)
  chmodSync(bin, 0o755)
  return bin
}

/** A blob download server (>100KB so it clears the truncation floor), Range-capable. */
const startBlobServer = async (): Promise<{ server: Server; url: string }> => {
  const blob = Buffer.alloc(200_000, 7)
  const server = createServer((req, res) => {
    const range = req.headers.range
    if (range) {
      const start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? '0')
      const slice = blob.subarray(start)
      res.writeHead(206, { 'content-length': String(slice.length), 'content-range': `bytes ${start}-${blob.length - 1}/${blob.length}` })
      res.end(slice)
    } else {
      res.writeHead(200, { 'content-length': String(blob.length) })
      res.end(blob)
    }
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}/fake.gguf` }
}

test('GET /fabric/local/models returns the seeded catalog with runtime availability; POST download 404s unknown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    const models = (await (await fetch(`${base}/fabric/local/models`)).json()) as { model: { id: string }; runtimeAvailable: boolean; state: string }[]
    assert.ok(models.length >= 2)
    assert.ok(models.some((m) => m.model.id === 'qwen2.5-1.5b-instruct-q4'))
    for (const m of models) assert.equal(typeof m.runtimeAvailable, 'boolean')
    const notFound = await fetch(`${base}/fabric/local/download`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelId: 'ghost' }),
    })
    assert.equal(notFound.status, 404)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('e2e (tier zero): nothing found → download a starter model → local endpoint active → Try-it yields a moment via the spawned runtime', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const binDir = await mkdtemp(join(tmpdir(), 'openinfo-bin-'))
  const fakeBin = writeFakeRuntime(binDir)
  const blob = await startBlobServer()
  const app = createEngineApp({
    dataRoot: dir,
    log: () => undefined,
    localRuntime: {
      findBinary: () => fakeBin,
      specs: { 'llama.cpp': { runtime: 'llama.cpp', binaryNames: ['fake-runtime'], installHint: 'x', args: (m, p) => ['--port', String(p), '-m', m], healthPath: '/health', chat: true } },
      readyTimeoutMs: 6_000,
    },
  })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    setProbes(app, []) // nothing found → the nothing-found lens
    // a starter catalog pointing at the blob server + our fake runtime
    app.store.layouts.put('starter-models', 'starter-models-default', {
      id: 'starter-models-default', version: 2,
      models: [{ id: 'fake-llm', slot: 'llm', runtime: 'llama.cpp', name: 'Fake LLM', filename: 'fake.gguf', url: blob.url, sizeBytes: 200_000 }],
    })

    // 1) the nothing-found lens leads with the starter offer + a download button (binary is available)
    const html = await (await fetch(`${base}/setup`)).text()
    assert.match(html, /No local model server responded/)
    assert.match(html, /Or download a starter model/)
    assert.match(html, /data-act="download-model"/)

    // 2) download the starter model (the explicit-click route), then poll until ready
    const dl = await fetch(`${base}/fabric/local/download`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelId: 'fake-llm' }),
    })
    assert.equal(dl.status, 200)
    await eventuallyHttp(async () => {
      const models = (await (await fetch(`${base}/fabric/local/models`)).json()) as { model: { id: string }; state: string }[]
      assert.equal(models.find((m) => m.model.id === 'fake-llm')!.state, 'ready')
    }, 6000)

    // 3) "Use this model": write config-1 with a LOCAL endpoint + activate (the existing profile routes)
    const put = await fetch(`${base}/fabric/profiles/config-1`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'config-1', name: 'Config 1', version: 1, fabric: { slots: { stt: [], tts: [], llm: [{ kind: 'local', name: 'starter-llm', runtime: 'llama.cpp', model: 'fake-llm' }], vlm: [], ocr: [], embed: [] } } }),
    })
    assert.equal(put.status, 200)
    assert.equal((await fetch(`${base}/fabric/profiles/config-1/activate`, { method: 'POST' })).status, 200)
    const fabric = (await (await fetch(`${base}/fabric`)).json()) as Fabric
    assert.equal(fabric.slots.llm[0]!.kind, 'local')

    // 4) Try-it TYPE path: flags on → session → text chunk → moment.created on WS, produced by the SPAWNED runtime
    const sub = await openEvents(base)
    try {
      await enableFlag(base, 'distill.enabled')
      await enableFlag(base, 'distill.moments')
      const started = (await (await fetch(`${base}/sessions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'default', modeId: 'mode-meeting', title: 'tier-zero try-it' }),
      })).json()) as Session
      const chunk: CaptureChunk = {
        id: 'tz-1', sessionId: started.id, workspaceId: 'default', source: 'mic', sequence: 0,
        capturedAt: new Date().toISOString(), contentType: 'text/plain', encoding: 'utf8', data: 'we should ship Thursday',
      }
      await fetch(`${base}/capture/mic`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chunk) })
      await eventuallyHttp(async () => {
        assert.ok(sub.events.some((e) => e.name === 'moment.created' && e.payload.sessionId === started.id))
      }, 8000)
      const created = sub.events.find((e) => e.name === 'moment.created' && e.payload.sessionId === started.id)!.payload as unknown as Moment
      assert.ok(created.text.length > 0)
      assert.equal(created.provenance?.endpoint, 'starter-llm') // produced by the spawned local runtime
    } finally {
      sub.close()
    }
  } finally {
    await app.close()
    await new Promise<void>((resolve) => blob.server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
    await rm(binDir, { recursive: true, force: true })
  }
})
