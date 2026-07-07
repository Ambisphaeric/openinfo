import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
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
