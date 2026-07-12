import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Bundle, CaptureChunk, Distillate, Draft, Entity, Fabric, FabricProfile, FieldValue, FocusSignal, HintCandidate, Mode, Moment, Pin, PinChunk, PromptTemplate, QueryResult, QueueStatus, Register, RelevantEntity, Session, Surface, TodoList, WorkflowSpec, WorkspaceHints } from '@openinfo/contracts'
import { createEngineApp } from './http.js'
import { TeachStore } from '../teach/index.js'
import { detectSwitch, type TimedFocusSignal } from '../route/detector.js'

test('GET /health carries the engine version (the version handshake), additive on the payload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const health = (await (await fetch(`http://127.0.0.1:${address.port}/health`)).json()) as {
      ok: boolean
      phase: number
      uptimeMs: number
      checkedAt: string
      version?: string
    }
    assert.equal(health.ok, true) // the original contract is intact
    assert.equal(typeof health.checkedAt, 'string')
    // The engine reads its OWN package version at startup; the bundle stages that package.json beside dist,
    // so it resolves in both layouts. In-repo tests run against apps/engine/package.json ⇒ a semver string.
    assert.match(health.version ?? '', /^\d+\.\d+\.\d+/)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

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
    assert.deepEqual(hud.stack.map((b) => b.block), ['now', 'relevant-now', 'moments', 'fields'])
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
    assert.deepEqual(reloaded.stack.map((b) => b.block), ['now', 'relevant-now', 'fields'])

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

test('GET /layouts/surfaces lists surfaces (seeded + user), and PUT emits surface.updated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  const updates: Surface[] = []
  app.bus.subscribe('surface.updated', (s) => { updates.push(s) })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // the list starts with the seeded default surfaces (the HUD + #100 fields + #101 diagnostics + #133 note-taker)
    const initial = (await (await fetch(`${base}/layouts/surfaces`)).json()) as Surface[]
    assert.deepEqual(initial.map((s) => s.id).sort(), ['surf-openinfo-chat', 'surf-openinfo-diagnostics', 'surf-openinfo-fields', 'surf-openinfo-hud', 'surf-openinfo-notetaker', 'surf-openinfo-sidebar'])

    // clone a user surface via PUT (there is no clone endpoint — the editor PUTs a copy under a new id)
    const hud = (await (await fetch(`${base}/layouts/surfaces/surf-openinfo-hud`)).json()) as Surface
    const clone: Surface = { ...hud, id: 'surf-mine', name: 'My HUD', version: 1 }
    const putRes = await fetch(`${base}/layouts/surfaces/surf-mine`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(clone),
    })
    assert.equal(putRes.status, 200)

    // surface.updated fired with the SAVED (version-bumped) document
    assert.equal(updates.length, 1)
    assert.equal(updates[0]?.id, 'surf-mine')
    assert.equal(updates[0]?.version, 1)

    // the list now enumerates the seeded defaults plus the user clone, sorted by key
    const after = (await (await fetch(`${base}/layouts/surfaces`)).json()) as Surface[]
    assert.deepEqual(after.map((s) => s.id).sort(), ['surf-mine', 'surf-openinfo-chat', 'surf-openinfo-diagnostics', 'surf-openinfo-fields', 'surf-openinfo-hud', 'surf-openinfo-notetaker', 'surf-openinfo-sidebar'])
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('GET /modes serves the seeded mode documents (the fixed contract drift)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    const modes = (await (await fetch(`${base}/modes`)).json()) as { id: string; name: string }[]
    assert.ok(modes.some((m) => m.id === 'mode-meeting' && m.name === 'meeting'))
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('GET /setup?surface serves the HUD-layout editor; unknown surface 404s', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    const res = await fetch(`${base}/settings/hud-layout?surface=surf-openinfo-hud`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/html/)
    const html = await res.text()
    assert.match(html, /HUD layout/)
    assert.match(html, /id="base-surface"/)
    assert.match(html, /data-act="surface-save"/)
    assert.match(html, /data-act="surface-clone"/)
    assert.match(html, /id="add-block-type"/)

    // the Settings sidebar surfaces a discoverable "HUD layout" section
    assert.match(await (await fetch(`${base}/settings/hud-layout`)).text(), /HUD layout/)

    // the legacy /setup?surface= URL still works — it 301s to /settings (fetch follows it)
    const legacy = await fetch(`${base}/setup?surface=surf-openinfo-hud`)
    assert.equal(legacy.status, 200)
    assert.match(await legacy.text(), /id="base-surface"/)

    // unknown surface ⇒ 404 (HTML, with a way back)
    const nf = await fetch(`${base}/settings/hud-layout?surface=surf-nope`)
    assert.equal(nf.status, 404)
    assert.match(await nf.text(), /No such surface/)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('surface round-trip: a form edit (reorder + top/collapsed) preserves query params, use, actions, custom', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    const put = (id: string, body: unknown): Promise<Response> =>
      fetch(`${base}/layouts/surfaces/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

    const rich: Surface = {
      id: 'surf-rich', name: 'Rich', context: 'deep-work', version: 1,
      stack: [
        { block: 'now' },
        {
          block: 'relevant-now', id: 'blk-rel', top: 4, show: 'always',
          query: { source: 'relevant-now', params: { session: 'current', k: 'v' }, top: 4 },
          use: { llm: 'llm.smart', register: 'reg-boardroom' },
          actions: [{ id: 'a1', label: 'Copy', verb: 'copy', params: {} }],
        },
        { block: 'custom', id: 'blk-c', show: 'manual', custom: { htmlEndpoint: '/custom/x.html' } },
      ],
    }
    assert.equal((await put('surf-rich', rich)).status, 200)
    const stored = (await (await fetch(`${base}/layouts/surfaces/surf-rich`)).json()) as Surface

    // exactly what the editor's buildSurface does: reuse the ORIGINAL block objects (preserving the
    // form-invisible fields) and overwrite ONLY the managed fields (top/collapsed), reordered.
    const rel = { ...stored.stack[1]!, top: 2, collapsed: true }
    const edited: Surface = { ...stored, stack: [stored.stack[0]!, stored.stack[2]!, rel] }
    assert.equal((await put('surf-rich', edited)).status, 200)

    const reloaded = (await (await fetch(`${base}/layouts/surfaces/surf-rich`)).json()) as Surface
    assert.deepEqual(reloaded.stack.map((b) => b.block), ['now', 'custom', 'relevant-now']) // reorder applied
    const r = reloaded.stack.find((b) => b.block === 'relevant-now')!
    assert.equal(r.top, 2)
    assert.equal(r.collapsed, true)
    // the form-invisible fields survived the edit verbatim
    assert.deepEqual(r.query?.params, { session: 'current', k: 'v' })
    assert.deepEqual(r.use, { llm: 'llm.smart', register: 'reg-boardroom' })
    assert.equal(r.actions?.length, 1)
    const custom = reloaded.stack.find((b) => b.block === 'custom')!
    assert.deepEqual(custom.custom, { htmlEndpoint: '/custom/x.html' })
    assert.equal(custom.id, 'blk-c')
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

test('e2e: a pinned-doc surface hydrates its pins block from the store over POST /query', async () => {
  // The served surface here is the DATA path the HUD drives: GET the surface for the layout, POST /query
  // per block. This slice reconnected `source: 'pins'` to the store — before, that route returned [] and a
  // pinned-doc block was silently empty even with real pins. This drives the whole served path over the
  // live server: ingest a pin (POST /pins), author a surface carrying a pinned-doc block whose query is
  // `source: 'pins'` (PUT /layouts/surfaces/:id), then POST that block's query and assert the pin hydrates.
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-pins-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // ingest a pin over the real route (POST /pins) — its workspace comes from the body
    const pin: Pin = {
      id: 'pin-soc2', workspaceId: 'ws-pins', uri: 'file:///soc2.pdf', title: 'SOC 2 Type II report',
      kind: 'pdf', ingest: { status: 'ingested', pages: 12, chunks: 24 }, createdAt: '2026-07-07T14:00:00Z',
    }
    assert.equal((await fetch(`${base}/pins`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pin),
    })).status, 200)

    // author a surface with a pinned-doc block bound to the pins source (saving a layout is not flagged)
    const surface: Surface = {
      id: 'surf-pins', name: 'Pins', context: 'meeting', version: 1,
      stack: [
        { block: 'now' },
        { block: 'pinned-doc', show: 'on-match', query: { source: 'pins', params: { workspace: 'ws-pins' }, top: 1 } },
      ],
    }
    assert.equal((await fetch(`${base}/layouts/surfaces/surf-pins`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(surface),
    })).status, 200)

    // hydrate exactly as the client will: GET the surface, POST /query for the pinned-doc block
    const served = (await (await fetch(`${base}/layouts/surfaces/surf-pins`)).json()) as Surface
    const pinnedBlock = served.stack.find((b) => b.block === 'pinned-doc')!
    const result = (await (await fetch(`${base}/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pinnedBlock.query),
    })).json()) as QueryResult
    // THE PROOF: the pins block now hydrates the ingested pin (the reconnect) — title + uri round-trip
    assert.equal(result.source, 'pins')
    assert.equal((result.items as Pin[]).length, 1)
    assert.equal((result.items as Pin[])[0]!.title, 'SOC 2 Type II report')
    assert.equal((result.items as Pin[])[0]!.uri, 'file:///soc2.pdf')

    // an empty backing store renders explainable-empty (items: [], not an error) — a workspace with no pins
    const empty = (await (await fetch(`${base}/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'pins', params: { workspace: 'ws-nopins' }, top: 1 }),
    })).json()) as QueryResult
    assert.deepEqual(empty.items, [])
    assert.equal(empty.truncated, false)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('e2e (#99): instantiate one template TWICE with different workspaces; each instance queries ONLY its own silo', async () => {
  // The DoD: an app INSTANCE is a template surface bound to a workspace silo. Instantiate the shipped HUD
  // twice for two "repos", seed DIFFERENT moments into each instance's workspace, then hydrate each
  // instance's moments block over POST /query?surface=<id> — each returns ONLY its silo's data, with the
  // SAME context-agnostic block document (its query names no workspace; the instance binding scopes it).
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-instances-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // author a TEMPLATE surface whose moments block names NO workspace (context-agnostic)
    const template: Surface = {
      id: 'surf-repo-hud', name: 'Repo HUD', context: 'deep-work', version: 1,
      stack: [{ block: 'now' }, { block: 'moments', query: { source: 'moments', params: {}, top: 10 } }],
    }
    assert.equal((await fetch(`${base}/layouts/surfaces/surf-repo-hud`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(template),
    })).status, 200)

    // instantiate it TWICE, each bound to its own workspace (one call per repo)
    const instantiate = async (body: unknown): Promise<{ status: number; surface: Surface }> => {
      const res = await fetch(`${base}/layouts/surfaces/surf-repo-hud/instantiate`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      return { status: res.status, surface: (await res.json()) as Surface }
    }
    const a = await instantiate({ newId: 'surf-repo-a', workspaceId: 'ws-repo-a', title: 'HUD — repo A' })
    const b = await instantiate({ newId: 'surf-repo-b', workspaceId: 'ws-repo-b', title: 'HUD — repo B' })
    assert.equal(a.status, 201)
    assert.equal(b.status, 201)
    // each instance is a FRESH doc: version 1, its own binding, cloned blocks, distinct title
    assert.equal(a.surface.version, 1)
    assert.equal(a.surface.workspaceId, 'ws-repo-a')
    assert.equal(b.surface.workspaceId, 'ws-repo-b')
    assert.deepEqual(a.surface.stack.map((s) => s.block), ['now', 'moments'])

    // both instances appear in the listing (the tray Apps folder reads this), each carrying its binding
    const listed = (await (await fetch(`${base}/layouts/surfaces`)).json()) as Surface[]
    const byId = new Map(listed.map((s) => [s.id, s]))
    assert.equal(byId.get('surf-repo-a')?.workspaceId, 'ws-repo-a')
    assert.equal(byId.get('surf-repo-b')?.workspaceId, 'ws-repo-b')

    // seed DIFFERENT data into each silo (store-level seeding is fine per the DoD)
    app.store.saveMoment({ id: 'mom-a', sessionId: 'ses-a', workspaceId: 'ws-repo-a', at: '2026-07-07T14:00:00Z', kind: 'decision', text: 'repo A decision', refs: [], source: 'mic', confidence: 0.9 })
    app.store.saveMoment({ id: 'mom-b', sessionId: 'ses-b', workspaceId: 'ws-repo-b', at: '2026-07-07T14:05:00Z', kind: 'decision', text: 'repo B decision', refs: [], source: 'mic', confidence: 0.9 })

    // hydrate each instance's moments block over POST /query?surface=<id> — the SAME block query, no workspace named
    const blockQuery = a.surface.stack.find((s) => s.block === 'moments')!.query
    const queryFor = async (surfaceId: string): Promise<QueryResult> =>
      (await (await fetch(`${base}/query?surface=${surfaceId}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(blockQuery),
      })).json()) as QueryResult

    // THE PROOF: each instance returns ONLY its silo's moment — the binding siloed the reads
    const resA = await queryFor('surf-repo-a')
    const resB = await queryFor('surf-repo-b')
    assert.deepEqual((resA.items as Moment[]).map((m) => m.text), ['repo A decision'])
    assert.deepEqual((resB.items as Moment[]).map((m) => m.text), ['repo B decision'])

    // 404 unknown source; 409 on an id collision (never clobber an existing surface)
    assert.equal((await fetch(`${base}/layouts/surfaces/surf-nope/instantiate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).status, 404)
    assert.equal((await instantiate({ newId: 'surf-repo-a' })).status, 409)

    // defaults: no body ⇒ generated id + slugged workspace ("HUD for X" is one call) + "(copy)" title
    const dflt = await instantiate({})
    assert.equal(dflt.status, 201)
    assert.match(dflt.surface.id, /^surf-/)
    assert.equal(dflt.surface.name, 'Repo HUD (copy)')
    assert.ok((dflt.surface.workspaceId ?? '').startsWith('ws-'))
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

// ---- pill P2: /active-preset selection + presets over the existing /templates substrate ----
test('pill P2: /active-preset GET/PUT — five presets listed, honest 400 on a nonexistent preset, set/clear round-trip, editable via /templates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-preset-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // The five presets seed and enumerate over the EXISTING /templates route (they are prompt-template docs).
    const templates = (await (await fetch(`${base}/templates`)).json()) as PromptTemplate[]
    const presetIds = templates.filter((t) => t.kind === 'preset').map((t) => t.id).sort()
    assert.deepEqual(presetIds, ['preset-meetings', 'preset-recruiting', 'preset-sales', 'preset-school', 'preset-support'])

    // GET selection: unset ⇒ presetId null; the five choices ride along.
    const initial = (await (await fetch(`${base}/active-preset`)).json()) as { workspaceId: string; presetId: string | null; presets: PromptTemplate[] }
    assert.equal(initial.workspaceId, 'default')
    assert.equal(initial.presetId, null, 'unset by default (byte-identical seam)')
    assert.equal(initial.presets.length, 5, 'the five choices are served')

    // PUT a nonexistent preset ⇒ honest 400 (never silently ignored).
    assert.equal((await putJson(base, '/active-preset', { presetId: 'preset-nope' })).status, 400)
    // PUT a non-string, non-null presetId ⇒ 400.
    assert.equal((await putJson(base, '/active-preset', { presetId: 42 })).status, 400)

    // PUT a real preset ⇒ 200, GET reflects it.
    assert.equal((await putJson(base, '/active-preset', { presetId: 'preset-sales' })).status, 200)
    const set = (await (await fetch(`${base}/active-preset`)).json()) as { presetId: string | null }
    assert.equal(set.presetId, 'preset-sales', 'the selection reads back')

    // Per-workspace scoping: another workspace is independent.
    const other = (await (await fetch(`${base}/active-preset?workspace=ws-other`)).json()) as { presetId: string | null }
    assert.equal(other.presetId, null, 'selection is per-workspace')

    // A preset edits over the EXISTING /templates route (no new editing UI) and reads back as a preset.
    const sales = (await (await fetch(`${base}/templates/preset-sales`)).json()) as PromptTemplate
    assert.equal(sales.kind, 'preset')
    const editedSales = { ...sales, body: 'Context: my customized sales preset.' }
    assert.equal((await putJson(base, '/templates/preset-sales', editedSales)).status, 200)
    const afterEdit = (await (await fetch(`${base}/templates/preset-sales`)).json()) as PromptTemplate
    assert.equal(afterEdit.body, 'Context: my customized sales preset.', 'the preset edit round-trips over /templates')

    // Clearing (presetId null) ⇒ back to unset.
    assert.equal((await putJson(base, '/active-preset', { presetId: null })).status, 200)
    const cleared = (await (await fetch(`${base}/active-preset`)).json()) as { presetId: string | null }
    assert.equal(cleared.presetId, null, 'cleared selection reads null')
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('e2e: a todos surface hydrates its todos block from the store over POST /query', async () => {
  // The data path the HUD drives for the todos block (#9): author a to-do list over the real served
  // write (PUT /todos/:sessionId), author a surface carrying a todos block whose query is
  // `source: 'todos'`, then POST that block's query and assert the items hydrate — status + provenance
  // round-trip. Mirrors the pins reconnect e2e: the whole path runs over the live server.
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-todos-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // author a session's to-do list over the real route (PUT /todos/:sessionId creates on first write)
    const list: TodoList = {
      id: 'ses-todo', name: 'to-do — ses-todo', version: 1, sessionId: 'ses-todo', workspaceId: 'ws-todo',
      items: [
        { id: 't1', text: 'Send Dana the signed MSA', createdAt: '2026-07-07T14:40:00Z', provenance: { sessionId: 'ses-todo', distillateId: 'dst-9' } },
        { id: 't2', text: 'Book the SOC 2 walkthrough', done: true, createdAt: '2026-07-07T14:41:00Z' },
      ],
    }
    assert.equal((await fetch(`${base}/todos/ses-todo`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(list),
    })).status, 200)

    // author a surface with a todos block bound to the todos source (saving a layout is not flagged)
    const surface: Surface = {
      id: 'surf-todos', name: 'To-do', context: 'meeting', version: 1,
      stack: [
        { block: 'now' },
        { block: 'todos', show: 'on-match', query: { source: 'todos', params: { workspace: 'ws-todo' }, top: 20 } },
      ],
    }
    assert.equal((await fetch(`${base}/layouts/surfaces/surf-todos`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(surface),
    })).status, 200)

    // hydrate exactly as the client will: GET the surface, POST /query for the todos block
    const served = (await (await fetch(`${base}/layouts/surfaces/surf-todos`)).json()) as Surface
    const todosBlock = served.stack.find((b) => b.block === 'todos')!
    const result = (await (await fetch(`${base}/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(todosBlock.query),
    })).json()) as QueryResult
    // THE PROOF: the todos block hydrates the stored items — text + done status + provenance round-trip
    assert.equal(result.source, 'todos')
    const items = result.items as { id: string; text: string; done?: boolean; provenance?: { distillateId?: string } }[]
    assert.deepEqual(items.map((t) => t.id), ['t1', 't2'])
    assert.equal(items[0]!.text, 'Send Dana the signed MSA')
    assert.equal(items[0]!.provenance?.distillateId, 'dst-9') // extracted → why-line reads "from the meeting"
    assert.equal(items[1]!.done, true) // status survives the round-trip

    // an empty backing store renders explainable-empty (items: [], not an error) — a workspace with no todos
    const empty = (await (await fetch(`${base}/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'todos', params: { workspace: 'ws-none' }, top: 20 }),
    })).json()) as QueryResult
    assert.deepEqual(empty.items, [])
    assert.equal(empty.truncated, false)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('e2e: dismiss over POST /item-signals persists a suppression that POST /query then honors (#66)', async () => {
  // The full dismiss path the HUD drives: author a to-do list, POST a dismiss signal for one item over the
  // real route, then POST the todos query and assert the dismissed item is EXCLUDED and the response discloses
  // the suppressed count. This is the "dismiss → suppression persisted → query excludes → empty-state explains"
  // round-trip over the live server (the QA served-driven rule for the write path, engine side).
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-dismiss-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    const list: TodoList = {
      id: 'ses-d', name: 'to-do — ses-d', version: 1, sessionId: 'ses-d', workspaceId: 'ws-d',
      items: [
        { id: 't1', text: 'Send the MSA', createdAt: '2026-07-07T14:40:00Z' },
        { id: 't2', text: 'Book the walkthrough', createdAt: '2026-07-07T14:41:00Z' },
      ],
    }
    assert.equal((await fetch(`${base}/todos/ses-d`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(list),
    })).status, 200)

    const query = { source: 'todos', params: { workspace: 'ws-d' }, top: 20 }
    const before = (await (await fetch(`${base}/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(query),
    })).json()) as QueryResult
    assert.deepEqual((before.items as { id: string }[]).map((i) => i.id), ['t1', 't2'])
    assert.equal(before.suppressed, undefined)

    // dismiss t2 over the real route — `at` is server-stamped, so the body omits it
    const dismissRes = await fetch(`${base}/item-signals`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-d', source: 'todos', itemId: 't2', kind: 'dismiss' }),
    })
    assert.equal(dismissRes.status, 200)
    const stored = (await dismissRes.json()) as { itemId: string; at: string }
    assert.equal(stored.itemId, 't2')
    assert.match(stored.at, /^\d{4}-\d{2}-\d{2}T/) // server stamped the timestamp

    // the query now excludes t2 and discloses the suppression
    const after = (await (await fetch(`${base}/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(query),
    })).json()) as QueryResult
    assert.deepEqual((after.items as { id: string }[]).map((i) => i.id), ['t1'])
    assert.equal(after.suppressed, 1)

    // a malformed signal (missing itemId) is a 400, never a silent accept
    const bad = await fetch(`${base}/item-signals`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-d', source: 'todos', kind: 'dismiss' }),
    })
    assert.equal(bad.status, 400)
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

test('e2e: fast fields fan out over the drain → field.updated on the bus + the fields query hydrates with provenance (#61)', async () => {
  const llm = await startFakeLlm()
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  // The bus is what the WS feed broadcasts from — subscribing here is the driven proof the fan-out
  // publishes field.updated (the same seam api/http.ts rebroadcasts to WS clients), mirroring the
  // draft.created e2e below rather than standing up a raw socket.
  const updates: FieldValue[] = []
  app.bus.subscribe('field.updated', (v) => {
    updates.push(v)
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
    // distill.enabled gates the drain that reaches distillThrottled (where the fan-out rides); distill.fields
    // is the field-specific gate. Text chunks skip transcription, so no stt endpoint is needed.
    for (const key of ['distill.enabled', 'distill.fields']) {
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
    // Two mic chunks spanning 20s (> the 15s cadence) so the accumulator releases mid-session; the material
    // is long enough to clear all three shipped fields' minChars gates (topic 40 / entities 60 / work 80).
    for (const c of [
      chunk(1, 0, 'we should ship the Q3 security review deck to Dana on Thursday afternoon'),
      chunk(2, 20, 'Dana agreed and will schedule the vendor security review for next week'),
    ]) {
      await fetch(`${base}/capture/mic`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })
    }

    // the drain fans out the fields at idle → the fields query hydrates all three with real provenance
    await eventuallyHttp(async () => {
      const result = (await (await fetch(`${base}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'fields', params: { workspace: 'default', session: started.id } }),
      })).json()) as QueryResult
      assert.equal(result.source, 'fields')
      const items = result.items as FieldValue[]
      const ids = new Set(items.map((v) => v.fieldId))
      assert.ok(ids.has('field-topic') && ids.has('field-entities') && ids.has('field-work-items'), 'all three shipped fields hydrate')
      for (const v of items) {
        assert.equal(v.provenance.endpoint, 'llm.fast') // real provenance (never fabricated)
        assert.equal(v.provenance.model, 'llama-3.2-3b')
        assert.equal(v.state, 'provisional') // fast results are provisional by definition (#66)
      }
    })
    // and the fan-out published field.updated on the bus (the WS broadcast seam) — the driven proof
    assert.ok(updates.length >= 3, `field.updated fired for each field (got ${updates.length})`)
    assert.ok(updates.every((u) => u.provenance.endpoint === 'llm.fast'))
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => llm.server.close(() => resolve()))
  }
})

test('e2e: judge stage reviews the fast result set + overrules in place → corrected state + judge provenance on the bus (#62)', async () => {
  const llm = await startFakeLlm()
  // A dedicated fake JUDGE endpoint: it always returns a per-field verdict array. The judge is routed to
  // the `llm.judge`-named endpoint specifically (a one-endpoint sub-fabric), so this proves the tier-gate
  // resolves the judge lane and never spills onto the fast endpoint.
  const judge = await new Promise<{ server: Server; url: string }>((resolve) => {
    const server = createServer((req, res) => {
      const buf: Buffer[] = []
      req.on('data', (c: Buffer) => buf.push(c))
      req.on('end', () => {
        const content = JSON.stringify([
          { fieldId: 'field-topic', verdict: 'correct', value: 'Q3 security review deck delivery', note: 'the fast tier was too generic' },
        ])
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }))
      })
    })
    server.listen(0, () => {
      const address = server.address()
      assert.ok(address && typeof address === 'object')
      resolve({ server, url: `http://127.0.0.1:${address.port}` })
    })
  })
  // Fire the judge on the SAME released batch as the fast fan-out (its own cadence, forced to 0 here so the
  // e2e need not wait the default ~60s). Read once at wiring, so it must be set BEFORE createEngineApp.
  const priorCadence = process.env['OPENINFO_JUDGE_CADENCE_MS']
  process.env['OPENINFO_JUDGE_CADENCE_MS'] = '0'
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  const updates: FieldValue[] = []
  app.bus.subscribe('field.updated', (v) => {
    updates.push(v)
  })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    const fabric = (await (await fetch(`${base}/fabric`)).json()) as Fabric
    await fetch(`${base}/fabric`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slots: {
          ...fabric.slots,
          llm: [
            { kind: 'http', name: 'llm.fast', url: llm.url, api: 'openai-compat', model: 'llama-3.2-3b' },
            { kind: 'http', name: 'llm.judge', url: judge.url, api: 'openai-compat', model: 'big-32b' },
          ],
        },
      }),
    })
    // distill.fields must produce the values; distill.judge runs the review over them. Both ride the drain.
    for (const key of ['distill.enabled', 'distill.fields', 'distill.judge']) {
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
      capturedAt: new Date(Date.UTC(2026, 6, 7, 15, 0, sec)).toISOString(), contentType: 'text/plain', encoding: 'utf8', data,
    })
    for (const c of [
      chunk(1, 0, 'we should ship the Q3 security review deck to Dana on Thursday afternoon'),
      chunk(2, 20, 'Dana agreed and will schedule the vendor security review for next week'),
    ]) {
      await fetch(`${base}/capture/mic`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })
    }

    // The drain fans out the fields (provisional) then the judge reviews + overrules field-topic in place.
    await eventuallyHttp(async () => {
      const result = (await (await fetch(`${base}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'fields', params: { workspace: 'default', session: started.id } }),
      })).json()) as QueryResult
      const topic = (result.items as FieldValue[]).find((v) => v.fieldId === 'field-topic')
      assert.ok(topic, 'field-topic hydrates')
      assert.equal(topic!.state, 'corrected', 'the judge overruled the topic in place')
      assert.equal(topic!.value, 'Q3 security review deck delivery', 'the value is the judge correction')
      assert.ok(topic!.provenance.judge, 'the overrule stamped judge provenance')
      assert.equal(topic!.provenance.judge!.endpoint, 'llm.judge', 'routed to the judge endpoint, not the fast one')
      assert.equal(topic!.provenance.judge!.model, 'big-32b')
      assert.equal(topic!.provenance.judge!.verdict, 'correct')
      assert.ok(topic!.provenance.judge!.priorValue, 'the overruled value is recorded (what changed)')
      assert.equal(topic!.provenance.endpoint, 'llm.fast', 'the fast lineage is preserved on the top-level provenance')
    })
    // The overrule republished field.updated with the corrected state — the WS broadcast seam.
    assert.ok(updates.some((u) => u.fieldId === 'field-topic' && u.state === 'corrected' && u.provenance.judge?.endpoint === 'llm.judge'), 'a corrected field.updated fired')
  } finally {
    if (priorCadence === undefined) delete process.env['OPENINFO_JUDGE_CADENCE_MS']
    else process.env['OPENINFO_JUDGE_CADENCE_MS'] = priorCadence
    await app.close()
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => llm.server.close(() => resolve()))
    await new Promise<void>((resolve) => judge.server.close(() => resolve()))
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

test('e2e: a drafts surface hydrates its drafts block from the store over POST /query', async () => {
  // The data path the HUD drives for the drafts block (#10). Drafts have no served WRITE route (they
  // are prepared at session end, never posted), so this drives the whole PRODUCING pipeline over the
  // live server — start → capture → distill → end → follow-up draft — then authors a surface carrying a
  // drafts block and POSTs its query exactly as the client hydrates: the prepared body + provenance
  // round-trip. Mirrors the pins/todos e2e for the read half, on top of the real act pass.
  const llm = await startFakeLlm()
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-drafts-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  const produced: Draft[] = []
  app.bus.subscribe('draft.created', (d) => {
    produced.push(d)
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
    for (const key of ['distill.enabled', 'distill.moments', 'act.enabled']) {
      await fetch(`${base}/flags/${key}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, default: true, scope: 'engine', description: key }),
      })
    }

    // produce a real draft: start a session, capture, let it distill, then end (the act composes it)
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
    await eventuallyHttp(async () => {
      const moments = (await (await fetch(`${base}/moments?workspace=default&session=${started.id}`)).json()) as Moment[]
      assert.ok(moments.length >= 1)
    })
    assert.equal((await fetch(`${base}/sessions/${encodeURIComponent(started.id)}/end`, { method: 'POST' })).status, 200)
    await eventuallyHttp(async () => assert.equal(produced.length, 1))
    const prepared = produced[0]!

    // author a surface with a drafts block bound to the drafts source (saving a layout is not flagged)
    const surface: Surface = {
      id: 'surf-drafts', name: 'Drafts', context: 'meeting', version: 1,
      stack: [
        { block: 'now' },
        { block: 'drafts', show: 'on-match', query: { source: 'drafts', params: { workspace: 'default' }, top: 3 } },
      ],
    }
    assert.equal((await fetch(`${base}/layouts/surfaces/surf-drafts`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(surface),
    })).status, 200)

    // hydrate exactly as the client will: GET the surface, POST /query for the drafts block
    const served = (await (await fetch(`${base}/layouts/surfaces/surf-drafts`)).json()) as Surface
    const draftsBlock = served.stack.find((b) => b.block === 'drafts')!
    const result = (await (await fetch(`${base}/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draftsBlock.query),
    })).json()) as QueryResult
    // THE PROOF: the drafts block hydrates the prepared draft — body + provenance round-trip
    assert.equal(result.source, 'drafts')
    const items = result.items as Draft[]
    assert.equal(items.length, 1)
    assert.equal(items[0]!.id, prepared.id)
    assert.equal(items[0]!.actKind, 'follow-up-draft')
    assert.ok(items[0]!.body.length > 0) // the prepared prose the renderer shows
    assert.ok(items[0]!.provenance.sourceDistillates.length >= 1) // the why-line's source count

    // an empty backing store renders explainable-empty (items: [], not an error) — a draft-less workspace
    const empty = (await (await fetch(`${base}/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'drafts', params: { workspace: 'ws-none' }, top: 3 }),
    })).json()) as QueryResult
    assert.deepEqual(empty.items, [])
    assert.equal(empty.truncated, false)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => llm.server.close(() => resolve()))
  }
})

test('e2e: a distillates surface hydrates its distillate-stream block from the store over POST /query', async () => {
  // The data path the HUD drives for the transcript/distillate stream block (#12). Distillates are the
  // persisted merge-window summaries (the queryable substance of the stream — raw pre-distill transcripts
  // are transient, rewritten in-flight with no persistence path), so this seeds them over the store seam
  // (saveDistillate — the distiller's own write path, no POST /distillates route), authors a surface
  // carrying a distillates block whose query is `source: 'distillates'`, then GET + POST /query hydrate
  // exactly as the client does: the window text + timestamp + provenance round-trip, NEWEST-first.
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-distillates-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // seed two distilled windows for a session (the distiller's persistence path)
    const distillate = (id: string, createdAt: string, text: string): Distillate => ({
      id, sessionId: 'ses-d', workspaceId: 'ws-d', windowStart: createdAt, windowEnd: createdAt,
      sourceChunks: [`c-${id}`], text,
      voice: { scope: 'session', dials: { tone: 3, warmth: 4, wit: 2, charm: 2, specificity: 9, brevity: 8 } },
      provenance: { slot: 'llm', endpoint: 'llm.fast' }, schemaVersion: 1, createdAt,
    })
    app.store.saveDistillate(distillate('dst-1', '2026-07-07T14:00:00Z', 'discussed the renewal timeline'))
    app.store.saveDistillate(distillate('dst-2', '2026-07-07T14:30:00Z', 'agreed to ship Thursday'))

    // author a surface with a distillates block bound to the distillates source (saving a layout is not flagged)
    const surface: Surface = {
      id: 'surf-distillates', name: 'Distillate stream', context: 'meeting', version: 1,
      stack: [
        { block: 'now' },
        { block: 'distillates', show: 'on-match', query: { source: 'distillates', params: { workspace: 'ws-d' }, top: 20 } },
      ],
    }
    assert.equal((await fetch(`${base}/layouts/surfaces/surf-distillates`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(surface),
    })).status, 200)

    // hydrate exactly as the client will: GET the surface, POST /query for the distillates block
    const served = (await (await fetch(`${base}/layouts/surfaces/surf-distillates`)).json()) as Surface
    const streamBlock = served.stack.find((b) => b.block === 'distillates')!
    const result = (await (await fetch(`${base}/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(streamBlock.query),
    })).json()) as QueryResult
    // THE PROOF: the block hydrates the stored windows, NEWEST-first — text + timestamp round-trip
    assert.equal(result.source, 'distillates')
    const items = result.items as Distillate[]
    assert.deepEqual(items.map((d) => d.id), ['dst-2', 'dst-1']) // newest window leads the stream
    assert.equal(items[0]!.text, 'agreed to ship Thursday')
    assert.equal(items[0]!.windowEnd, '2026-07-07T14:30:00Z') // the timestamp the renderer shows

    // an empty backing store renders explainable-empty (items: [], not an error) — a distillate-less workspace
    const empty = (await (await fetch(`${base}/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'distillates', params: { workspace: 'ws-none' }, top: 20 }),
    })).json()) as QueryResult
    assert.deepEqual(empty.items, [])
    assert.equal(empty.truncated, false)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
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
    // Two chunks spanning >15s so the distill cadence throttle (#58) releases a distill ON the drain — the
    // summary must exist so the ONLY reason there is no draft is that act.enabled is off, not empty input.
    for (const c of [
      { id: 'c-1', sessionId: started.id, workspaceId: 'default', source: 'mic', sequence: 1, capturedAt: '2026-07-07T14:00:00Z', contentType: 'text/plain', encoding: 'utf8', data: 'we should ship Thursday' },
      { id: 'c-2', sessionId: started.id, workspaceId: 'default', source: 'mic', sequence: 2, capturedAt: '2026-07-07T14:00:20Z', contentType: 'text/plain', encoding: 'utf8', data: 'agreed, Thursday it is' },
    ]) {
      await fetch(`${base}/capture/mic`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })
    }
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

// ---- workflow.enabled ON: the executor path is behavior-identical to the legacy wiring above ----
// The whole existing suite runs with workflow.enabled OFF (default), so those tests ARE the "flag OFF =
// legacy path untouched" proof. These two flip it ON and assert the SAME observable outcome through the
// real spool: the drain distills identically, and session-end drains-first then prepares one draft.

test('e2e: workflow.enabled ON → the executor drain distills identically (moments over the API)', async () => {
  const llm = await startFakeLlm()
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
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
    // the same distill flags as the legacy drain e2e, PLUS workflow.enabled ON → the executor runs
    for (const key of ['distill.enabled', 'distill.moments', 'distill.index', 'workflow.enabled']) {
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
    for (const c of [chunk(1, 0, 'we should ship Thursday'), chunk(2, 20, 'Dana agreed, ship Thursday')]) {
      await fetch(`${base}/capture/mic`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })
    }
    // identical outcome to the legacy drain e2e: the extracted commitment hydrates over the API
    await eventuallyHttp(async () => {
      const moments = (await (await fetch(`${base}/moments?workspace=default&session=${started.id}`)).json()) as Moment[]
      assert.ok(moments.some((m) => m.kind === 'commitment' && /Thursday/.test(m.text)))
    })
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => llm.server.close(() => resolve()))
  }
})

// ---- P4A slice 4: the dynamic-to-do seam (constrain/unconstrain loop) ----
// A dedicated fake llm that answers every pipeline prompt AND, for the draft, ECHOES the {{todo}} block
// out of the prompt into the draft body — so an e2e can prove the accumulated to-do reached the draft.
const startTodoLlm = async (): Promise<FakeLlm> => {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const prompt = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: { content: string }[] }).messages[0]!.content
      const todoBlock = prompt.match(/Accumulated follow-ups so far[\s\S]*?(?=\n\nWrite the follow-up)/)?.[0]
      const content = prompt.includes('JSON array of entities')
        ? '[{"kind": "person", "name": "Dana"}]'
        : prompt.includes('follow-up tasks') // the task-extract (constrain) prompt
          ? '[{"text": "Send Dana the updated deck"}]'
          : prompt.includes('Return ONLY a JSON array') // the moments prompt
            ? '[{"kind": "commitment", "text": "ship Thursday", "confidence": 0.9}]'
            : prompt.includes('follow-up message after a meeting') // the draft (unconstrain) prompt
              ? `Hi Dana,\n\nQuick recap and next steps.\n${todoBlock ?? '(no running to-do)'}`
              : 'they agreed to ship Thursday.' // distill fallback
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}` }
}

test('e2e: task-extract accumulates a to-do over the drain, the draft un-constrains it via {{todo}}, and the doc is editable', async () => {
  const llm = await startTodoLlm()
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  const drafts: Draft[] = []
  app.bus.subscribe('draft.created', (d) => { drafts.push(d) })
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
    // the whole loop ON: workflow executor + distill + moments + task-extract (constrain) + act (draft)
    for (const key of ['distill.enabled', 'distill.moments', 'workflow.enabled', 'act.enabled', 'act.tasks']) {
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
    for (const c of [chunk(1, 0, 'we should ship Thursday'), chunk(2, 20, 'Dana agreed, ship Thursday')]) {
      await fetch(`${base}/capture/mic`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })
    }

    // MID-MEETING: the drain ran task-extract, so the session's to-do document has accumulated an item
    // — retrievable over the read route the HUD will render (GET /todos/:sessionId).
    await eventuallyHttp(async () => {
      const todo = (await (await fetch(`${base}/todos/${encodeURIComponent(started.id)}`)).json()) as TodoList
      assert.ok(todo.items?.some((i) => /Send Dana the updated deck/.test(i.text)), 'to-do accumulated over the drain')
    })
    // the whole list is enumerable too
    const listed = (await (await fetch(`${base}/todos`)).json()) as TodoList[]
    assert.ok(listed.some((t) => t.sessionId === started.id))

    // end the call → drain-first flush runs task-extract once more, THEN the follow-up draft composes
    await fetch(`${base}/sessions/${encodeURIComponent(started.id)}/end`, { method: 'POST' })
    await eventuallyHttp(async () => assert.equal(drafts.length, 1))
    // THE PROOF: the accumulated to-do item was un-constrained back into the draft prose via {{todo}}
    const draft = (await (await fetch(`${base}/drafts?workspace=default&session=${started.id}`)).json()) as Draft[]
    assert.match(draft[0]!.body, /Send Dana the updated deck/, 'the draft interpolated {{todo}}')

    // EDITABLE DOCUMENT: a user PUTs an edited items array; GET reflects it (version bumped), proving the
    // to-do is a real editable document (the unit suite proves the edit reaches the NEXT draft via {{todo}}).
    const current = (await (await fetch(`${base}/todos/${encodeURIComponent(started.id)}`)).json()) as TodoList
    const editedItems = [...current.items, { id: 'u1', text: 'USER-ADDED: send the signed NDA', createdAt: '2026-07-07T15:00:00Z' }]
    const putRes = await fetch(`${base}/todos/${encodeURIComponent(started.id)}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...current, items: editedItems }),
    })
    assert.equal(putRes.status, 200)
    const saved = (await putRes.json()) as TodoList
    assert.ok(saved.version > current.version, 'edit bumped the version')
    const after = (await (await fetch(`${base}/todos/${encodeURIComponent(started.id)}`)).json()) as TodoList
    assert.ok(after.items.some((i) => /USER-ADDED: send the signed NDA/.test(i.text)), 'the user edit persisted')
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => llm.server.close(() => resolve()))
  }
})

test('/todos routes: unknown session 404, PUT validates body + sessionId matches the route', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    assert.deepEqual(await (await fetch(`${base}/todos`)).json(), []) // none yet
    assert.equal((await fetch(`${base}/todos/nope`)).status, 404)
    // a garbage body is a 400, not a 500
    assert.equal((await fetch(`${base}/todos/ses-x`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ not: 'a todo' }) })).status, 400)
    // a valid body whose sessionId disagrees with the route is a 400
    const mismatch = { id: 'ses-x', name: 't', version: 1, sessionId: 'ses-OTHER', workspaceId: 'default', items: [] }
    assert.equal((await fetch(`${base}/todos/ses-x`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(mismatch) })).status, 400)
    // a valid, matching body persists and reads back
    const ok = { id: 'ses-x', name: 'my to-do', version: 1, sessionId: 'ses-x', workspaceId: 'default', items: [{ id: 'i1', text: 'call legal', createdAt: '2026-07-07T15:00:00Z' }] }
    assert.equal((await fetch(`${base}/todos/ses-x`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ok) })).status, 200)
    const got = (await (await fetch(`${base}/todos/ses-x`)).json()) as TodoList
    assert.deepEqual(got.items.map((i) => i.text), ['call legal'])
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('e2e: workflow.enabled ON → session-end drains-first then prepares one follow-up draft', async () => {
  const llm = await startFakeLlm()
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  const drafts: Draft[] = []
  app.bus.subscribe('draft.created', (d) => { drafts.push(d) })
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
    for (const key of ['distill.enabled', 'distill.moments', 'act.enabled', 'workflow.enabled']) {
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
    await eventuallyHttp(async () => {
      const moments = (await (await fetch(`${base}/moments?workspace=default&session=${started.id}`)).json()) as Moment[]
      assert.ok(moments.length >= 1)
    })
    // end the call — the executor's session-end seam flushes the drain then composes the follow-up draft
    await fetch(`${base}/sessions/${encodeURIComponent(started.id)}/end`, { method: 'POST' })
    await eventuallyHttp(async () => assert.equal(drafts.length, 1))
    const draft = drafts[0]!
    assert.equal(draft.actKind, 'follow-up-draft')
    assert.equal(draft.status, 'prepared')
    assert.equal(draft.sessionId, started.id)
    assert.equal(draft.provenance.templateId, 'tpl-followup-default')
    // retrievable over the API, exactly like the legacy path
    const listed = (await (await fetch(`${base}/drafts?workspace=default&session=${started.id}`)).json()) as Draft[]
    assert.deepEqual(listed.map((d) => d.id), [draft.id])
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

    // the seeded manual scaffold is listable (the fictional lm-studio/ollama templates are gone —
    // discovery/scan are the truthful source of real-host offers, so nothing hardcodes a fake model)
    const seeded = (await (await fetch(`${base}/fabric/profiles`)).json()) as { id: string }[]
    assert.deepEqual(seeded.map((p) => p.id).sort(), ['remote-http-template'])
    // seeded but INERT — GET /fabric is still the empty/legacy map
    assert.deepEqual(((await (await fetch(`${base}/fabric`)).json()) as Fabric).slots.llm, [])

    // GET one; unknown id → 404
    assert.equal((await fetch(`${base}/fabric/profiles/remote-http-template`)).status, 200)
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

test('full-fabric round-trip: adding a tts endpoint to an llm+stt profile keeps every other slot (the user repro), local endpoints preserved', async () => {
  // Mirrors what the setup page's saveEditor does — it re-PUTs the WHOLE fabric on every Save. The
  // page now edits all six slots, so this proves a slot edit never drops the others (and a `local`
  // endpoint round-trips untouched through an unrelated edit).
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    const put = (id: string, body: unknown) =>
      fetch(`${base}/fabric/profiles/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

    // Start with a profile carrying llm (http) + stt (a `local` starter endpoint from tier zero).
    const llm = { kind: 'http', name: 'llm', url: 'http://192.168.1.105:1234', api: 'openai-compat', model: 'qwen3' }
    const sttLocal = { kind: 'local', name: 'starter-stt', runtime: 'whisper.cpp', model: 'whisper-base' }
    const start = { id: 'rig', name: 'Rig', version: 1, fabric: { slots: { stt: [sttLocal], tts: [], llm: [llm], vlm: [], ocr: [], embed: [] } } }
    assert.equal((await put('rig', start)).status, 200)

    // Save-with-a-new-tts: the whole fabric is re-PUT with a kokoro tts added, everything else the same.
    const kokoro = { kind: 'http', name: 'kokoro', url: 'http://192.168.1.105:8880', api: 'openai-compat', model: 'kokoro' }
    const withTts = { id: 'rig', name: 'Rig', version: 2, fabric: { slots: { stt: [sttLocal], tts: [kokoro], llm: [llm], vlm: [], ocr: [], embed: [] } } }
    assert.equal((await put('rig', withTts)).status, 200)

    // Add a vlm the same way; version bumps, nothing is lost.
    const vlm = { kind: 'http', name: 'vlm', url: 'http://192.168.1.105:1235', api: 'openai-compat', model: 'qwen-vl' }
    const withVlm = { id: 'rig', name: 'Rig', version: 3, fabric: { slots: { stt: [sttLocal], tts: [kokoro], llm: [llm], vlm: [vlm], ocr: [], embed: [] } } }
    assert.equal((await put('rig', withVlm)).status, 200)

    const got = (await (await fetch(`${base}/fabric/profiles/rig`)).json()) as FabricProfile
    assert.equal(got.fabric.slots.llm.length, 1) // llm intact
    assert.deepEqual(got.fabric.slots.stt[0], sttLocal) // the local stt endpoint survived every edit, byte-for-byte
    assert.equal(got.fabric.slots.tts[0]!.name, 'kokoro') // the user's added tts is present
    assert.equal(got.fabric.slots.vlm[0]!.name, 'vlm') // and the vlm
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

test('GET /settings serves the sidebar shell; sections carry profiles/editor; /setup 301s to it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    // keep this unit test offline + deterministic: an empty probe list ⇒ discovery does no real network I/O
    app.store.layouts.put('discovery-probes', 'probes-default', { id: 'probes-default', version: 1, probes: [] })

    const res = await fetch(`${base}/settings`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/html/)
    const html = await res.text()
    assert.match(html, /openinfo · settings/) // the shell title
    assert.match(html, /class="sidebar"/) // the persistent sidebar
    assert.match(html, /id="row-tpl"/) // the endpoints editor's add-row template
    // fresh install (llm empty) ⇒ default section is Get started
    assert.match(html, /class="nav-item active" href="\/settings\/get-started"/)

    // the legacy /setup URL 301s to /settings, without following
    const redir = await fetch(`${base}/setup`, { redirect: 'manual' })
    assert.equal(redir.status, 301)
    assert.equal(redir.headers.get('location'), '/settings')

    // the Profiles section lists the seeded profiles and offers Activate (none active)
    const profiles = await (await fetch(`${base}/settings/profiles`)).text()
    assert.match(profiles, /data-act="activate" data-id="remote-http-template"/)
    // on a non-get-started section, the fresh-install banner rides along
    assert.match(profiles, /class="banner"/)
    // ?edit selects which profile the Endpoints editor opens (301 from /setup?edit= carries the query)
    const edited = await (await fetch(`${base}/setup?edit=remote-http-template`)).text()
    assert.match(edited, /data-target-id="remote-http-template"/)
    assert.match(edited, /class="nav-item active" href="\/settings\/endpoints"/)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('Features: GET /flags enumerates all six real gating flags; a toggle round-trips via PUT /flags/:key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // SEEDING: all six real gating flags are seeded documents (from contracts flag.examples.json via
    // ensureDefaultFlags) — GET /flags enumerates them, so the Features section has something to render.
    const flags = (await (await fetch(`${base}/flags`)).json()) as { key: string; default: boolean }[]
    const keys = new Set(flags.map((f) => f.key))
    for (const k of ['distill.enabled', 'distill.transcribe', 'distill.moments', 'distill.index', 'act.enabled', 'route.detect']) {
      assert.ok(keys.has(k), `flag ${k} must be seeded`)
    }

    // the Features section renders each as a toggle, off by default
    let feat = await (await fetch(`${base}/settings/features`)).text()
    assert.match(feat, /data-flag-key="distill\.enabled"/)
    assert.doesNotMatch(feat, /data-flag-key="distill\.enabled" checked/)
    assert.match(feat, /class="dep unmet"/) // dependents show their unmet dependency while distill is off

    // flip distill.enabled via the exact route the toggle drives
    const put = await fetch(`${base}/flags/distill.enabled`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'distill.enabled', default: true, scope: 'engine', description: 'the distiller', minTier: 'T1' }),
    })
    assert.equal(put.status, 200)

    // GET /flags reflects it, and the section now shows it checked + dependents satisfied
    const after = (await (await fetch(`${base}/flags`)).json()) as { key: string; default: boolean }[]
    assert.equal(after.find((f) => f.key === 'distill.enabled')?.default, true)
    feat = await (await fetch(`${base}/settings/features`)).text()
    assert.match(feat, /data-flag-key="distill\.enabled" checked/)
    assert.match(feat, /class="dep ok"/)
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

// --- INVOKE-RESILIENCE: the real-generation probe + GET /queue ---

/**
 * A fake OpenAI-compatible server for the generate probe: the base GET (health ping) always 200s; the
 * completions call answers per `chat` ({status, body}); /v1/models lists `modelIds` (for the suggestion).
 */
const startFakeChat = async (chat: { status: number; body: string }, modelIds: string[] = []) => {
  const server = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: modelIds.map((id) => ({ id })) }))
      return
    }
    if (req.url === '/v1/chat/completions') {
      res.writeHead(chat.status, { 'content-type': 'application/json' })
      res.end(chat.body)
      return
    }
    res.writeHead(200); res.end('ok') // base-url GET (the ping)
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}` }
}

test('POST /fabric/test probe:generate — ping + REAL generation; llm success reports both', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  const up = await startFakeChat({ status: 200, body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const appAddr = app.server.address()
    assert.ok(appAddr && typeof appAddr === 'object')
    const base = `http://127.0.0.1:${appAddr.port}`
    const probe = (await (await fetch(`${base}/fabric/test`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'http', name: 'lm', url: up.url, api: 'openai-compat', model: 'qwen', probe: 'generate', slot: 'llm' }),
    })).json()) as { ok: boolean; generate?: { ok: boolean; latencyMs?: number; sample?: string } }
    assert.equal(probe.ok, true) // reachable
    assert.equal(probe.generate?.ok, true) // AND generation succeeded
    assert.equal(typeof probe.generate?.latencyMs, 'number')
    assert.equal(probe.generate?.sample, 'ok') // the model's actual reply rides back as the sample
  } finally {
    await app.close()
    await new Promise<void>((resolve) => up.server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('POST /fabric/test probe:generate — the model reply flows through as `sample` (proof, not a checkmark)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  // A real instruct model answers the probe prompt in words — that reply is what Test renders back.
  const up = await startFakeChat({
    status: 200,
    body: JSON.stringify({ choices: [{ message: { content: 'Yes, I can hear you loud and clear.' } }] }),
  })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const appAddr = app.server.address()
    assert.ok(appAddr && typeof appAddr === 'object')
    const base = `http://127.0.0.1:${appAddr.port}`
    const probe = (await (await fetch(`${base}/fabric/test`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'http', name: 'lm', url: up.url, api: 'openai-compat', model: 'lfm2.5-8b-a1b', probe: 'generate', slot: 'llm' }),
    })).json()) as { generate?: { ok: boolean; sample?: string } }
    assert.equal(probe.generate?.ok, true)
    assert.equal(probe.generate?.sample, 'Yes, I can hear you loud and clear.')
  } finally {
    await app.close()
    await new Promise<void>((resolve) => up.server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('POST /fabric/test probe:generate — a pings-200-but-model-load-400 server is caught HONESTLY', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  // The user's exact wall: the base GET answers (reachable), the completion 400s "failed to load", and
  // the server reports a smaller model it DOES have — so the hint gains the loaded-model suggestion.
  const up = await startFakeChat(
    { status: 400, body: JSON.stringify({ error: 'Model "qwen3.5-35b" failed to load. Error: failed to allocate buffer' }) },
    ['qwen3.5-35b', 'qwen3.5-9b'],
  )
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const appAddr = app.server.address()
    assert.ok(appAddr && typeof appAddr === 'object')
    const base = `http://127.0.0.1:${appAddr.port}`
    const probe = (await (await fetch(`${base}/fabric/test`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'http', name: 'lm', url: up.url, api: 'openai-compat', model: 'qwen3.5-35b', probe: 'generate', slot: 'llm' }),
    })).json()) as { ok: boolean; generate?: { ok: boolean; class?: string; error?: string; hint?: string } }
    assert.equal(probe.ok, true) // the PING still says reachable — which is exactly why the ping lied
    assert.equal(probe.generate?.ok, false) // the real generation tells the truth
    assert.equal(probe.generate?.class, 'model-load')
    assert.match(probe.generate?.error ?? '', /failed to load/)
    assert.match(probe.generate?.hint ?? '', /qwen3.5-9b/) // the loaded-model suggestion
  } finally {
    await app.close()
    await new Promise<void>((resolve) => up.server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('POST /fabric/test probe:generate — a reasoning model that spends the 1-token budget thinking still passes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  // A qwen3.5/LFM2.5-class reasoner burns the probe's whole budget on reasoning (content '', finish length).
  // The probe exists to prove the model LOADED and generated — which it did — so this is generation ✓ with
  // a note, not a failure that would mark every reasoning-model endpoint untestable.
  const up = await startFakeChat({
    status: 200,
    body: JSON.stringify({ choices: [{ message: { content: '', reasoning_content: 'thinking…' }, finish_reason: 'length' }] }),
  })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const appAddr = app.server.address()
    assert.ok(appAddr && typeof appAddr === 'object')
    const base = `http://127.0.0.1:${appAddr.port}`
    const probe = (await (await fetch(`${base}/fabric/test`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'http', name: 'lm', url: up.url, api: 'openai-compat', model: 'lfm2.5-8b-a1b', probe: 'generate', slot: 'llm' }),
    })).json()) as { ok: boolean; generate?: { ok: boolean; latencyMs?: number; note?: string } }
    assert.equal(probe.ok, true)
    assert.equal(probe.generate?.ok, true) // the model loaded and generated — the probe's purpose
    assert.equal(typeof probe.generate?.latencyMs, 'number')
    assert.match(probe.generate?.note ?? '', /thinking/) // but say WHY there was no content
  } finally {
    await app.close()
    await new Promise<void>((resolve) => up.server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('POST /fabric/test probe:generate — auth 401 and stt-skip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  const up = await startFakeChat({ status: 401, body: JSON.stringify({ error: 'invalid key' }) })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const appAddr = app.server.address()
    assert.ok(appAddr && typeof appAddr === 'object')
    const base = `http://127.0.0.1:${appAddr.port}`
    const post = async (body: unknown) =>
      (await (await fetch(`${base}/fabric/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()) as {
        generate?: { ok: boolean; class?: string; skipped?: boolean; note?: string }
      }
    const auth = await post({ kind: 'http', name: 'lm', url: up.url, api: 'openai-compat', probe: 'generate', slot: 'llm' })
    assert.equal(auth.generate?.ok, false)
    assert.equal(auth.generate?.class, 'auth')

    const stt = await post({ kind: 'http', name: 's', url: up.url, api: 'openai-compat', probe: 'generate', slot: 'stt' })
    assert.equal(stt.generate?.skipped, true)
    assert.match(stt.generate?.note ?? '', /needs audio/)
  } finally {
    await app.close()
    await new Promise<void>((resolve) => up.server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('GET /queue: empty; then a model-load drain records the classified last failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  const up = await startFakeChat(
    { status: 400, body: JSON.stringify({ error: 'Model "big" failed to load' }) },
    ['big', 'small'],
  )
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const appAddr = app.server.address()
    assert.ok(appAddr && typeof appAddr === 'object')
    const base = `http://127.0.0.1:${appAddr.port}`

    // empty queue: no failure yet
    const empty = (await (await fetch(`${base}/queue`)).json()) as { pendingFiles: number; lastFailure?: unknown }
    assert.equal(empty.pendingFiles, 0)
    assert.equal(empty.lastFailure, undefined)

    // point llm at the broken server and turn on distill so the drain actually invokes it
    const fabric = (await (await fetch(`${base}/fabric`)).json()) as Fabric
    await fetch(`${base}/fabric`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slots: { ...fabric.slots, llm: [{ kind: 'http', name: 'lm-studio', url: up.url, api: 'openai-compat', model: 'big' }] } }),
    })
    for (const key of ['distill.enabled', 'distill.moments']) {
      await fetch(`${base}/flags/${key}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, default: true, scope: 'engine', description: key }),
      })
    }
    const started = (await (await fetch(`${base}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'default', modeId: 'mode-meeting' }),
    })).json()) as Session
    // Two chunks spanning >15s so the distill cadence throttle (#58) releases the distill ON the drain — the
    // invoke then fails (model-load), and the queue records the classified failure exactly as before.
    for (const c of [
      { id: 'c-1', sessionId: started.id, workspaceId: 'default', source: 'mic', sequence: 0, capturedAt: '2026-07-07T14:00:00Z', contentType: 'text/plain', encoding: 'utf8', data: 'we will ship Thursday' },
      { id: 'c-2', sessionId: started.id, workspaceId: 'default', source: 'mic', sequence: 1, capturedAt: '2026-07-07T14:00:20Z', contentType: 'text/plain', encoding: 'utf8', data: 'ship it Thursday' },
    ]) {
      await fetch(`${base}/capture/mic`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })
    }

    // the drain re-queues (file safe) but now records WHY — classified, with the loaded-model suggestion
    await eventuallyHttp(async () => {
      const q = (await (await fetch(`${base}/queue`)).json()) as { lastFailure?: { class: string; endpoint: string; hint: string } }
      assert.equal(q.lastFailure?.class, 'model-load')
      assert.equal(q.lastFailure?.endpoint, 'lm-studio')
      assert.match(q.lastFailure?.hint ?? '', /small/) // the loaded-model suggestion made it into the hint
    })
  } finally {
    await app.close()
    await new Promise<void>((resolve) => up.server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('e2e: a queue surface hydrates its queue-status block — a SEEDED FAILURE surfaces through POST /query', async () => {
  // The data path the HUD drives for the queue/status block (#13). Queue status is OPERATIONAL engine
  // state (backlog/ETA/last-failure), not a store record, so the /query route injects the live status()
  // snapshot. This drives a REAL model-load failure (the drain re-queues and records WHY — the honest
  // "why nothing arrived"), authors a surface carrying a queue block, then GET + POST /query hydrate
  // exactly as the client does — and asserts the LAST-FAILURE text rides through the query pipeline
  // (never hidden, per the issue's honest-failure mandate).
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-queue-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  const up = await startFakeChat({ status: 400, body: JSON.stringify({ error: 'Model "big" failed to load' }) }, ['big', 'small'])
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // author a surface with a queue block bound to the queue source (saving a layout is not flagged)
    const surface: Surface = {
      id: 'surf-queue', name: 'Queue', context: 'meeting', version: 1,
      stack: [
        { block: 'now' },
        { block: 'queue', show: 'always', query: { source: 'queue', params: {}, top: 1 } },
      ],
    }
    assert.equal((await fetch(`${base}/layouts/surfaces/surf-queue`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(surface),
    })).status, 200)

    // an idle queue still hydrates ONE status row (a status panel is never silent), no failure yet
    const idle = (await (await fetch(`${base}/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(surface.stack[1]!.query),
    })).json()) as QueryResult
    assert.equal(idle.source, 'queue')
    assert.equal(idle.items.length, 1)
    assert.equal((idle.items[0] as QueueStatus).lastFailure, undefined)

    // point llm at the broken server and turn on distill so the drain invokes it and fails (model-load)
    const fabric = (await (await fetch(`${base}/fabric`)).json()) as Fabric
    await fetch(`${base}/fabric`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slots: { ...fabric.slots, llm: [{ kind: 'http', name: 'lm-studio', url: up.url, api: 'openai-compat', model: 'big' }] } }),
    })
    for (const key of ['distill.enabled', 'distill.moments']) {
      await fetch(`${base}/flags/${key}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, default: true, scope: 'engine', description: key }),
      })
    }
    const started = (await (await fetch(`${base}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: 'default', modeId: 'mode-meeting' }),
    })).json()) as Session
    // Two chunks spanning >15s so the distill cadence throttle (#58) releases the distill ON the drain — the
    // invoke then fails (model-load), and the queue records the classified failure exactly as before.
    for (const c of [
      { id: 'c-1', sessionId: started.id, workspaceId: 'default', source: 'mic', sequence: 0, capturedAt: '2026-07-07T14:00:00Z', contentType: 'text/plain', encoding: 'utf8', data: 'we will ship Thursday' },
      { id: 'c-2', sessionId: started.id, workspaceId: 'default', source: 'mic', sequence: 1, capturedAt: '2026-07-07T14:00:20Z', contentType: 'text/plain', encoding: 'utf8', data: 'ship it Thursday' },
    ]) {
      await fetch(`${base}/capture/mic`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })
    }

    // THE PROOF: the queue block's POST /query now hydrates the classified last failure — VISIBLE, not hidden
    await eventuallyHttp(async () => {
      const result = (await (await fetch(`${base}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(surface.stack[1]!.query),
      })).json()) as QueryResult
      assert.equal(result.source, 'queue')
      assert.equal(result.items.length, 1)
      const status = result.items[0] as QueueStatus
      assert.equal(status.lastFailure?.class, 'model-load')
      assert.equal(status.lastFailure?.endpoint, 'lm-studio')
      assert.match(status.lastFailure?.hint ?? '', /small/) // the loaded-model suggestion rides through
    })
  } finally {
    await app.close()
    await new Promise<void>((resolve) => up.server.close(() => resolve()))
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
    assert.match(html, /class="nav-item active" href="\/settings\/get-started"/) // Get started leads on first run
    assert.match(html, /href="\/settings\/endpoints">Advanced setup/) // full editor lives in the Endpoints section
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

    // 4) the page is no longer first-run: no banner, Status leads (not the lens), llm is configured
    const html = await (await fetch(`${base}/setup`)).text()
    assert.doesNotMatch(html, /class="banner"/)
    assert.doesNotMatch(html, /data-act="use-setup"/) // the Get-started lens no longer leads
    assert.match(html, /class="nav-item active" href="\/settings\/status"/)
    // config-1 is the active profile — the Profiles section marks it
    assert.match(await (await fetch(`${base}/settings/profiles`)).text(), /badge active/)
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
      // Two chunks spanning >15s: the distill cadence throttle (#58) releases a distill once the accumulated
      // capture span crosses the threshold, so the moment lands on the drain (mid-session) as this card expects.
      const base0 = new Date('2026-07-07T14:00:00Z').getTime()
      const mkChunk = (seq: number, sec: number, data: string): CaptureChunk => ({
        id: `try-${seq}`, sessionId: started.id, workspaceId: 'default', source: 'mic', sequence: seq,
        capturedAt: new Date(base0 + sec * 1000).toISOString(), contentType: 'text/plain', encoding: 'utf8', data,
      })
      let ack: Response | undefined
      for (const c of [mkChunk(0, 0, 'we should ship Thursday'), mkChunk(1, 20, 'agreed, Thursday it is')]) {
        ack = await fetch(`${base}/capture/mic`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })
      }
      assert.equal(ack!.status, 200)

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
      // the same base64 audio/webm CaptureChunk shape the browser MediaRecorder + Electron client emit —
      // two spanning >15s so the distill cadence throttle (#58) releases a distill on the drain (mid-session).
      const base0 = new Date('2026-07-07T14:00:00Z').getTime()
      const mkChunk = (seq: number, sec: number): CaptureChunk => ({
        id: `try-voice-${seq}`, sessionId: started.id, workspaceId: 'default', source: 'mic', sequence: seq,
        capturedAt: new Date(base0 + sec * 1000).toISOString(), contentType: 'audio/webm', encoding: 'base64',
        data: Buffer.from('fake-webm-bytes').toString('base64'),
      })
      for (const c of [mkChunk(0, 0), mkChunk(1, 20)]) {
        await fetch(`${base}/capture/mic`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })
      }

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
    assert.ok(models.some((m) => m.model.id === 'qwen3-1.7b-q4'))
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
      // Two chunks spanning >15s so the distill cadence throttle (#58) releases the distill on the drain.
      const base0 = new Date('2026-07-07T14:00:00Z').getTime()
      const mkChunk = (seq: number, sec: number, data: string): CaptureChunk => ({
        id: `tz-${seq}`, sessionId: started.id, workspaceId: 'default', source: 'mic', sequence: seq,
        capturedAt: new Date(base0 + sec * 1000).toISOString(), contentType: 'text/plain', encoding: 'utf8', data,
      })
      for (const c of [mkChunk(0, 0, 'we should ship Thursday'), mkChunk(1, 20, 'agreed, Thursday it is')]) {
        await fetch(`${base}/capture/mic`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })
      }
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

test('POST /sessions/:id/reroute moves an ended session between workspace DBs, emits session.rerouted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  const rerouted: Session[] = []
  app.bus.subscribe('session.rerouted', (session) => {
    rerouted.push(session)
  })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // ws-a holds an ENDED session with a distillate + moment; ws-b exists as the reroute target
    app.store.ensureWorkspace({ id: 'ws-b', name: 'B' })
    app.store.saveSession({
      id: 'ses-r', workspaceId: 'ws-a', modeId: 'mode-meeting', startedAt: '2026-07-07T14:00:00Z', endedAt: '2026-07-07T15:00:00Z',
      attribution: { evidence: [{ kind: 'window', detail: 'code — repo/api', weight: 0.6 }], confidence: 0.6 },
    })
    app.store.saveDistillate({
      id: 'dst-r', sessionId: 'ses-r', workspaceId: 'ws-a', windowStart: '2026-07-07T14:00:00Z', windowEnd: '2026-07-07T14:02:00Z',
      sourceChunks: ['c1'], text: 'sync', voice: { scope: 'mode', dials: { tone: 5, warmth: 5, wit: 5, charm: 5, specificity: 5, brevity: 5 } },
      provenance: { slot: 'llm', endpoint: 'llm.fast' }, schemaVersion: 1, createdAt: '2026-07-07T14:02:00Z',
    })
    app.store.saveMoment({ id: 'mom-r', sessionId: 'ses-r', workspaceId: 'ws-a', at: '2026-07-07T14:01:00Z', kind: 'decision', text: 'ship it', refs: [], source: 'mic', confidence: 0.8 })

    const ok = await fetch(`${base}/sessions/ses-r/reroute`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ toWorkspaceId: 'ws-b' }),
    })
    assert.equal(ok.status, 200)
    const moved = (await ok.json()) as Session
    assert.equal(moved.workspaceId, 'ws-b')
    assert.equal(moved.reroutedFrom, 'ws-a')
    assert.equal(moved.attribution.confidence, 1)
    assert.deepEqual(moved.attribution.evidence.map((e) => e.kind), ['window', 'manual']) // history appended, not replaced

    // moved on disk: ws-b has it, ws-a does not
    const inA = (await (await fetch(`${base}/sessions?workspace=ws-a`)).json()) as Session[]
    const inB = (await (await fetch(`${base}/sessions?workspace=ws-b`)).json()) as Session[]
    assert.deepEqual(inA.map((s) => s.id), [])
    assert.deepEqual(inB.map((s) => s.id), ['ses-r'])
    const momentsB = (await (await fetch(`${base}/moments?workspace=ws-b`)).json()) as Moment[]
    assert.deepEqual(momentsB.map((m) => m.id), ['mom-r'])

    assert.deepEqual(rerouted.map((s) => s.id), ['ses-r']) // event fired once
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('POST /sessions/:id/reroute — 404 unknown, 400 same/unknown workspace, 409 live', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    const post = (id: string, toWorkspaceId: string) =>
      fetch(`${base}/sessions/${id}/reroute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ toWorkspaceId }) })

    // unknown session
    assert.equal((await post('nope', 'ws-b')).status, 404)

    // an ENDED session in ws-a; ws-b exists
    app.store.ensureWorkspace({ id: 'ws-b', name: 'B' })
    app.store.saveSession({
      id: 'ses-e', workspaceId: 'ws-a', modeId: 'mode-meeting', startedAt: '2026-07-07T14:00:00Z', endedAt: '2026-07-07T15:00:00Z',
      attribution: { evidence: [{ kind: 'manual', detail: 'x', weight: 1 }], confidence: 1 },
    })
    assert.equal((await post('ses-e', 'ws-a')).status, 400) // same workspace
    assert.equal((await post('ses-e', 'ws-nowhere')).status, 400) // unknown destination

    // a LIVE (unended) session cannot be rerouted in v0
    app.store.saveSession({
      id: 'ses-live', workspaceId: 'ws-a', modeId: 'mode-meeting', startedAt: '2026-07-07T14:00:00Z',
      attribution: { evidence: [{ kind: 'manual', detail: 'x', weight: 1 }], confidence: 1 },
    })
    assert.equal((await post('ses-live', 'ws-b')).status, 409)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

// ── Context-switch detection (route.detect) — focus chunks through the REAL spool ──────────────
const salesHints = { workspaceId: 'sales', patterns: [{ field: 'repoPath', contains: 'acme-crm', weight: 0.7 }] }
const focusStream = async (base: string, count: number, stepSec = 10): Promise<void> => {
  // Sequential so each append fully lands before the next POST — avoids racing the spool drain's
  // rename. Each focus chunk carries its own sessionId (a distinct spool file), so no chunk can be
  // lost to a mid-drain append; the detector ignores the chunk's sessionId/workspaceId anyway.
  for (let i = 0; i < count; i += 1) {
    await fetch(`${base}/capture/focus`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: `fx-${i}`, sessionId: `focus-${i}`, workspaceId: 'default', source: 'focus', sequence: i,
        capturedAt: new Date(Date.UTC(2026, 6, 7, 14, 0, 0) + i * stepSec * 1000).toISOString(),
        contentType: 'application/json', encoding: 'utf8',
        data: JSON.stringify({ app: 'Chrome', windowTitle: 'Acme — Salesforce', repoPath: '/Users/dev/acme-crm' }),
      }),
    })
  }
}

test('route.detect ON: sustained focus signals auto-start a session with the detector evidence trail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-detect-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    app.store.ensureWorkspace({ id: 'sales', name: 'Sales' })
    app.store.layouts.put('workspace-hints', 'sales', salesHints)
    await enableFlag(base, 'route.detect')

    await focusStream(base, 11)

    await eventuallyHttp(async () => {
      const live = (await (await fetch(`${base}/sessions?workspace=sales&live=true`)).json()) as Session[]
      assert.equal(live.length, 1)
      assert.ok(live[0]!.attribution.confidence < 1)
      assert.ok(live[0]!.attribution.evidence.some((e) => e.kind === 'repo'))
      assert.ok(!live[0]!.attribution.evidence.some((e) => e.kind === 'manual'))
    })
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('route.detect: a live session in another workspace is auto-ended and session.switched is emitted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-detect-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    app.store.ensureWorkspace({ id: 'sales', name: 'Sales' })
    app.store.layouts.put('workspace-hints', 'sales', salesHints)
    await enableFlag(base, 'route.detect')

    const switched: Session[] = []
    app.bus.subscribe('session.switched', (s) => { switched.push(s) })

    // a manual live session in 'default' — the switch must end it and move to 'sales'
    await fetch(`${base}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'default', modeId: 'mode-meeting' }),
    })
    await focusStream(base, 11)

    await eventuallyHttp(async () => {
      assert.equal(switched.length, 1)
      assert.equal(switched[0]!.workspaceId, 'sales')
      const defLive = (await (await fetch(`${base}/sessions?workspace=default&live=true`)).json()) as Session[]
      assert.equal(defLive.length, 0) // W1 auto-ended
      const salesLive = (await (await fetch(`${base}/sessions?workspace=sales&live=true`)).json()) as Session[]
      assert.equal(salesLive.length, 1)
    })
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('route.detect OFF (default): even a fully sustained stream does nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-detect-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    app.store.ensureWorkspace({ id: 'sales', name: 'Sales' })
    app.store.layouts.put('workspace-hints', 'sales', salesHints)

    await focusStream(base, 11) // flag OFF (default) → the detector never runs
    await new Promise((r) => setTimeout(r, 200))
    const live = (await (await fetch(`${base}/sessions?workspace=sales&live=true`)).json()) as Session[]
    assert.equal(live.length, 0)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('route.detect ON: a brief sub-sustain burst does not fire (thrash resistance)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-detect-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    app.store.ensureWorkspace({ id: 'sales', name: 'Sales' })
    app.store.layouts.put('workspace-hints', 'sales', salesHints)
    await enableFlag(base, 'route.detect')

    await focusStream(base, 3) // 3 signals span only 20s — well under the 90s sustain window
    await new Promise((r) => setTimeout(r, 200))
    const live = (await (await fetch(`${base}/sessions?workspace=sales&live=true`)).json()) as Session[]
    assert.equal(live.length, 0)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('e2e: PUT a surface edit → surface.updated on the WS with the changed layout (HUD hot-reload path)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    const hud = (await (await fetch(`${base}/layouts/surfaces/surf-openinfo-hud`)).json()) as Surface
    const sub = await openEvents(base)
    try {
      // the user scenario, via the editor's API path: collapse moments + drop relevant-now top to 2
      const stack = hud.stack.map((b) =>
        b.block === 'moments' ? { ...b, collapsed: true } : b.block === 'relevant-now' ? { ...b, top: 2 } : b,
      )
      const putRes = await fetch(`${base}/layouts/surfaces/surf-openinfo-hud`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...hud, stack }),
      })
      assert.equal(putRes.status, 200)

      // the WS carried surface.updated for THIS surface, with the edit — this is what the HUD refetches on
      await new Promise((r) => setTimeout(r, 150))
      const evt = sub.events.find((e) => e.name === 'surface.updated')
      assert.ok(evt, 'surface.updated must be broadcast')
      const payload = evt!.payload as unknown as Surface
      assert.equal(payload.id, 'surf-openinfo-hud')
      assert.equal(payload.version, 2)
      assert.equal(payload.stack.find((b) => b.block === 'moments')?.collapsed, true)
      assert.equal(payload.stack.find((b) => b.block === 'relevant-now')?.top, 2)
    } finally {
      sub.close()
    }
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

// --- HOST-SCAN + MODEL-DROPDOWN: POST /fabric/scan ---

/** A fake OpenAI-compatible model server; optionally demands a bearer on /v1/models (the auth case). */
const startModelServer = async (ids: string[], opts: { requireKey?: string } = {}) => {
  const server = createServer((req, res) => {
    if (opts.requireKey !== undefined && req.headers.authorization !== `Bearer ${opts.requireKey}`) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'missing bearer token' }))
      return
    }
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: ids.map((id) => ({ id })) }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}`, port: String(address.port) }
}

test('POST /fabric/scan url: classified models; body must carry exactly one of url|host', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  const up = await startModelServer(['ornith-1.0-9b', 'glm-ocr@q8_0', 'whisper-large-v3'])
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const appAddr = app.server.address()
    assert.ok(appAddr && typeof appAddr === 'object')
    const base = `http://127.0.0.1:${appAddr.port}`
    const scan = async (body: unknown) => fetch(`${base}/fabric/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

    const res = await scan({ url: up.url })
    assert.equal(res.status, 200)
    const result = (await res.json()) as { hosts: { url: string; reachable: boolean; authRequired: boolean; models: { id: string; slots: string[] }[] }[] }
    assert.equal(result.hosts.length, 1)
    assert.equal(result.hosts[0]!.reachable, true)
    assert.deepEqual(result.hosts[0]!.models, [
      { id: 'ornith-1.0-9b', slots: ['llm'] },
      { id: 'glm-ocr@q8_0', slots: ['ocr'] },
      { id: 'whisper-large-v3', slots: ['stt'] },
    ])

    // neither url nor host, both, and a non-bare host all 400 — the request semantics are exact
    assert.equal((await scan({})).status, 400)
    assert.equal((await scan({ url: up.url, host: 'localhost' })).status, 400)
    assert.equal((await scan({ host: 'http://localhost' })).status, 400)
    assert.equal((await scan({ host: 'localhost:1234' })).status, 400)
  } finally {
    await app.close()
    await new Promise<void>((resolve) => up.server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('POST /fabric/scan host: sweeps the probe-list DOCUMENT ports; dead port classified unreachable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  const a = await startModelServer(['ornith-1.0-9b'])
  const b = await startModelServer(['kokoro-82m'])
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    // The ports are a DOCUMENT (a user on a nonstandard port edits it) — point it at the fakes + a dead port.
    app.store.layouts.put('discovery-probes', 'probes-default', {
      id: 'probes-default',
      version: 1,
      probes: [
        { name: 'a', url: `http://localhost:${a.port}` },
        { name: 'b', url: `http://localhost:${b.port}` },
        { name: 'dead', url: 'http://localhost:1' },
      ],
    })
    const appAddr = app.server.address()
    assert.ok(appAddr && typeof appAddr === 'object')
    const base = `http://127.0.0.1:${appAddr.port}`
    const res = await fetch(`${base}/fabric/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: '127.0.0.1' }) })
    assert.equal(res.status, 200)
    const result = (await res.json()) as { hosts: { url: string; reachable: boolean; models: { id: string }[]; error?: { class: string; hint: string } }[] }
    assert.equal(result.hosts.length, 3)
    assert.equal(result.hosts[0]!.url, `http://127.0.0.1:${a.port}`)
    assert.deepEqual(result.hosts[0]!.models.map((m) => m.id), ['ornith-1.0-9b'])
    assert.deepEqual(result.hosts[1]!.models.map((m) => m.id), ['kokoro-82m'])
    assert.equal(result.hosts[2]!.reachable, false)
    assert.equal(result.hosts[2]!.error?.class, 'unreachable')
    assert.match(result.hosts[2]!.error?.hint ?? '', /is the server running/)
  } finally {
    await app.close()
    await new Promise<void>((resolve) => a.server.close(() => resolve()))
    await new Promise<void>((resolve) => b.server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('POST /fabric/scan auth: 401 → authRequired; store the key, rescan with keyRef → models; value-free', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  const up = await startModelServer(['ornith-1.0-9b'], { requireKey: 'sk-real-value-9871' })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const appAddr = app.server.address()
    assert.ok(appAddr && typeof appAddr === 'object')
    const base = `http://127.0.0.1:${appAddr.port}`
    const scan = async (body: unknown) =>
      (await (await fetch(`${base}/fabric/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()) as {
        hosts: { reachable: boolean; authRequired: boolean; models: { id: string }[]; error?: { class: string; hint: string } }[]
      }

    // 1. keyless scan → the server wants a key (the editor highlights the keyRef selector on this)
    const locked = await scan({ url: up.url })
    assert.equal(locked.hosts[0]!.reachable, true)
    assert.equal(locked.hosts[0]!.authRequired, true)
    assert.equal(locked.hosts[0]!.error?.class, 'auth')

    // 2. the user stores the key by REFERENCE and rescans with the keyRef → the models appear
    await fetch(`${base}/fabric/secrets/rig-key`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'sk-real-value-9871' }) })
    const unlocked = await scan({ url: up.url, keyRef: 'rig-key' })
    assert.equal(unlocked.hosts[0]!.authRequired, false)
    assert.deepEqual(unlocked.hosts[0]!.models.map((m) => m.id), ['ornith-1.0-9b'])

    // value-free discipline: no ScanResult ever carries key material
    assert.ok(!JSON.stringify(locked).includes('sk-real-value-9871'))
    assert.ok(!JSON.stringify(unlocked).includes('sk-real-value-9871'))
  } finally {
    await app.close()
    await new Promise<void>((resolve) => up.server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('scan → select → save round-trip: a scanned model id lands intact in the profile document', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  const up = await startModelServer(['ornith-1.0-9b', 'qwen3-8b'])
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const appAddr = app.server.address()
    assert.ok(appAddr && typeof appAddr === 'object')
    const base = `http://127.0.0.1:${appAddr.port}`

    // scan, pick the user's model from the discovered list (what the dropdown does)…
    const result = (await (await fetch(`${base}/fabric/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: up.url }) })).json()) as {
      hosts: { url: string; models: { id: string }[] }[]
    }
    const picked = result.hosts[0]!.models.find((m) => m.id === 'ornith-1.0-9b')
    assert.ok(picked, 'the scanned list must contain the model')

    // …save it into a profile through the existing routes, then read the document back
    const profile: FabricProfile = {
      id: 'scan-rt', name: 'Scan round-trip', version: 1,
      fabric: { slots: { stt: [], tts: [], llm: [{ kind: 'http', name: 'lm-studio', url: result.hosts[0]!.url, api: 'openai-compat', model: picked!.id }], vlm: [], ocr: [], embed: [] } },
    }
    const put = await fetch(`${base}/fabric/profiles/scan-rt`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(profile) })
    assert.equal(put.status, 200)
    const stored = (await (await fetch(`${base}/fabric/profiles/scan-rt`)).json()) as FabricProfile
    const ep = stored.fabric.slots.llm[0]
    assert.ok(ep && ep.kind === 'http')
    assert.equal(ep.model, 'ornith-1.0-9b')
    assert.equal(ep.url, result.hosts[0]!.url)
  } finally {
    await app.close()
    await new Promise<void>((resolve) => up.server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

// ---- P4-T1: GET/PUT /workflows — the pipeline itself is user-composable over the API ----
// The workflow document is the everything-is-a-document config the executor runs; these routes are the
// HTTP surface (mirroring /todos + /layouts/surfaces). The executor already reads active() fresh per
// drain, so the last test proves a stored edit takes effect with NO restart.

test('/workflows routes: list has the seeded default, GET 404 unknown, PUT invalid 400, PUT valid bumps version', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // the seeded default enumerates and resolves by id
    const listed = (await (await fetch(`${base}/workflows`)).json()) as WorkflowSpec[]
    assert.deepEqual(listed.map((w) => w.id), ['workflow-default'])
    const current = (await (await fetch(`${base}/workflows/workflow-default`)).json()) as WorkflowSpec
    assert.equal(current.version, 1)
    // unknown id ⇒ 404 (only workflow-default exists until a user authors another)
    assert.equal((await fetch(`${base}/workflows/nope`)).status, 404)
    // a garbage body is a 400, not a 500
    assert.equal((await fetch(`${base}/workflows/workflow-default`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ not: 'a workflow' }) })).status, 400)
    // an unrunnable step kind is rejected at write time by the CLOSED union (Tier-A gate) ⇒ 400
    const badKind = { ...current, steps: [{ id: 'x', kind: 'teleport', params: {} }] }
    assert.equal((await fetch(`${base}/workflows/workflow-default`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(badKind) })).status, 400)
    // a valid body whose id disagrees with the route is a 400
    assert.equal((await fetch(`${base}/workflows/workflow-default`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...current, id: 'other' }) })).status, 400)
    // a valid, matching edit persists (version stamped off the store) and reads back
    const edited = { ...current, steps: current.steps.filter((s) => s.kind !== 'moments') }
    const putRes = await fetch(`${base}/workflows/workflow-default`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(edited) })
    assert.equal(putRes.status, 200)
    const saved = (await putRes.json()) as WorkflowSpec
    assert.equal(saved.version, 2, 'the store stamped the next version')
    const after = (await (await fetch(`${base}/workflows/workflow-default`)).json()) as WorkflowSpec
    assert.equal(after.version, 2)
    assert.ok(!after.steps.some((s) => s.kind === 'moments'), 'GET reflects the edit')
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

// ---- #23: GET/PUT /templates, /registers, /modes — the prompt layer is user-composable like /workflows ----
// Templates gain a whole resource; registers/modes gain write + by-id reads (fixing the read-only drift).
// Every route follows the /workflows pattern: create-on-unknown-id, contract-validated body ⇒ 400, and the
// pipeline reads templates/modes/registers fresh, so a stored edit takes effect with no restart.

const putJson = (base: string, path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('/templates routes: list has the seeded defaults, GET default → PUT → GET returns the edit, invalid 400, unknown-id creates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // the shipped defaults enumerate — the distill trio plus the act templates seeded by the actor,
    // since /templates lists the WHOLE prompt-template store (not just the distill seeds)
    const listed = (await (await fetch(`${base}/templates`)).json()) as PromptTemplate[]
    const ids = listed.map((t) => t.id)
    for (const seeded of ['tpl-distill-default', 'tpl-extract-default', 'tpl-entities-default']) assert.ok(ids.includes(seeded), `lists ${seeded}`)
    // GET default resolves; an unknown id ⇒ 404
    const current = (await (await fetch(`${base}/templates/tpl-distill-default`)).json()) as PromptTemplate
    assert.equal(current.kind, 'distill')
    assert.equal((await fetch(`${base}/templates/nope`)).status, 404)
    // a garbage body ⇒ 400 (a malformed body must NOT persist silently)
    assert.equal((await putJson(base, '/templates/tpl-distill-default', { not: 'a template' })).status, 400)
    // an empty body violates minLength ⇒ 400
    assert.equal((await putJson(base, '/templates/tpl-distill-default', { ...current, body: '' })).status, 400)
    // a valid body whose id disagrees with the route ⇒ 400
    assert.equal((await putJson(base, '/templates/tpl-distill-default', { ...current, id: 'other' })).status, 400)
    // a valid, matching edit persists and reads back (round-trip)
    const edited = { ...current, body: 'edited body {{transcript}}' }
    const putRes = await putJson(base, '/templates/tpl-distill-default', edited)
    assert.equal(putRes.status, 200)
    const after = (await (await fetch(`${base}/templates/tpl-distill-default`)).json()) as PromptTemplate
    assert.equal(after.body, 'edited body {{transcript}}', 'GET reflects the edit')
    // unknown id CREATES (mirroring PUT /workflows) — it then enumerates and resolves
    const created: PromptTemplate = { id: 'tpl-mine', name: 'mine', kind: 'act', body: 'hello {{x}}' }
    assert.equal((await putJson(base, '/templates/tpl-mine', created)).status, 200)
    const relisted = (await (await fetch(`${base}/templates`)).json()) as PromptTemplate[]
    assert.ok(relisted.some((t) => t.id === 'tpl-mine'), 'the created template enumerates')
    assert.equal((await (await fetch(`${base}/templates/tpl-mine`)).json() as PromptTemplate).name, 'mine')
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('/registers + /modes routes: read-only drift fixed — by-id GET, PUT round-trips, invalid 400, unknown-id creates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // registers: by-id GET resolves a seeded builtin; unknown ⇒ 404
    const reg = (await (await fetch(`${base}/registers/reg-boardroom`)).json()) as Register
    assert.equal(reg.id, 'reg-boardroom')
    assert.equal((await fetch(`${base}/registers/nope`)).status, 404)
    // invalid body ⇒ 400; id/route mismatch ⇒ 400
    assert.equal((await putJson(base, '/registers/reg-boardroom', { not: 'a register' })).status, 400)
    assert.equal((await putJson(base, '/registers/reg-boardroom', { ...reg, id: 'other' })).status, 400)
    // a valid edit round-trips
    const regEdited = { ...reg, name: 'boardroom-edited' }
    assert.equal((await putJson(base, '/registers/reg-boardroom', regEdited)).status, 200)
    assert.equal((await (await fetch(`${base}/registers/reg-boardroom`)).json() as Register).name, 'boardroom-edited')
    // unknown id CREATES and then appears in the list
    const newReg: Register = { id: 'reg-mine', name: 'mine', dials: { tone: 5, warmth: 5, wit: 5, charm: 5, specificity: 5, brevity: 5 } }
    assert.equal((await putJson(base, '/registers/reg-mine', newReg)).status, 200)
    const regs = (await (await fetch(`${base}/registers`)).json()) as Register[]
    assert.ok(regs.some((r) => r.id === 'reg-mine'), 'the created register enumerates')

    // modes: by-id GET resolves the seeded meeting mode; unknown ⇒ 404
    const mode = (await (await fetch(`${base}/modes/mode-meeting`)).json()) as Mode
    assert.equal(mode.id, 'mode-meeting')
    assert.equal((await fetch(`${base}/modes/nope`)).status, 404)
    // invalid body ⇒ 400; id/route mismatch ⇒ 400
    assert.equal((await putJson(base, '/modes/mode-meeting', { not: 'a mode' })).status, 400)
    assert.equal((await putJson(base, '/modes/mode-meeting', { ...mode, id: 'other' })).status, 400)
    // a valid edit round-trips
    const modeEdited = { ...mode, name: 'meeting-edited' }
    assert.equal((await putJson(base, '/modes/mode-meeting', modeEdited)).status, 200)
    assert.equal((await (await fetch(`${base}/modes/mode-meeting`)).json() as Mode).name, 'meeting-edited')
    // unknown id CREATES and then enumerates
    const newMode = { ...mode, id: 'mode-mine', name: 'mine' }
    assert.equal((await putJson(base, '/modes/mode-mine', newMode)).status, 200)
    const modes = (await (await fetch(`${base}/modes`)).json()) as Mode[]
    assert.ok(modes.some((m) => m.id === 'mode-mine'), 'the created mode enumerates')
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('e2e: PUT an edited workflow with workflow.enabled ON — the drain honors it with no restart', async () => {
  const llm = await startFakeLlm()
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
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
    // the whole distill family ON (moments AND index) PLUS workflow.enabled → the executor runs the doc
    for (const key of ['distill.enabled', 'distill.moments', 'distill.index', 'workflow.enabled']) {
      await fetch(`${base}/flags/${key}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, default: true, scope: 'engine', description: key }),
      })
    }

    // THE USER COMPOSES THE PIPELINE: edit the running document to DROP the moments step — while its
    // when.flag (distill.moments) stays ON. If the executor read the flag it would still extract moments;
    // it reads the DOCUMENT, so moments stop. The index step stays, so distill+index still run — proving
    // the pipeline itself is live, not merely switched off. No engine restart between the PUT and the drain.
    const current = (await (await fetch(`${base}/workflows/workflow-default`)).json()) as WorkflowSpec
    const edited = { ...current, steps: current.steps.filter((s) => s.kind !== 'moments') }
    const putRes = await fetch(`${base}/workflows/workflow-default`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(edited) })
    assert.equal(putRes.status, 200)

    const started = (await (await fetch(`${base}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'default', modeId: 'mode-meeting' }),
    })).json()) as Session
    const chunk = (sequence: number, sec: number, data: string): CaptureChunk => ({
      id: `c-${sequence}`, sessionId: started.id, workspaceId: 'default', source: 'mic', sequence,
      capturedAt: new Date(Date.UTC(2026, 6, 8, 14, 0, sec)).toISOString(), contentType: 'text/plain', encoding: 'utf8', data,
    })
    for (const c of [chunk(1, 0, 'we should ship Thursday'), chunk(2, 20, 'Dana agreed, ship Thursday')]) {
      await fetch(`${base}/capture/mic`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })
    }

    // POSITIVE: entities hydrate → distill+index ran, so the drain's distill pass completed under the
    // edited document (the pipeline is live). Once this holds, moments WOULD have been extracted in the
    // SAME pass if the step were present.
    await eventuallyHttp(async () => {
      const entities = (await (await fetch(`${base}/entities?workspace=default`)).json()) as Entity[]
      assert.ok(entities.some((e) => /Dana/i.test(e.name)), 'distill+index ran under the edited document')
    })
    // NEGATIVE (the proof): no moments for this session — the removed step was honored with no restart,
    // even though distill.moments is still ON.
    const moments = (await (await fetch(`${base}/moments?workspace=default&session=${started.id}`)).json()) as Moment[]
    assert.equal(moments.length, 0, 'the dropped moments step took effect on the very next drain — hot edit')
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => llm.server.close(() => resolve()))
  }
})

// ---- P4-T2: /pins ingest/read + /teach/candidates — the P4D seams over HTTP (visible, citable chips) ----
// The store methods (savePin/getPin/listPins/listPinChunks) and pure derivations (ingestPin,
// deriveHintCandidates) already existed; these tests exercise the new HTTP surface end to end. The ingest
// e2e uses the FILE fetcher over a temp fixture (form-feed pages) so nothing touches the network.

test('/pins routes: create → ingest a file fixture → GET chunks returns page-anchored excerpts; 404/400', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // a two-page plaintext fixture (\f is the classic plaintext page separator the file fetcher splits on)
    const fixture = join(dir, 'acme-canon.txt')
    writeFileSync(fixture, 'First page prose about the Acme account.\fSecond page prose naming Dana and the Q3 renewal.')

    // an unknown workspace reads as an empty pin list, not an error (mirrors GET /entities)
    assert.deepEqual(await (await fetch(`${base}/pins?workspace=canon-ws`)).json(), [])

    // POST a PENDING pin (file kind, uri = the fixture path); it validates and persists
    const pin: Pin = {
      id: 'pin-1', workspaceId: 'canon-ws', uri: fixture, title: 'Acme canon', kind: 'file',
      ingest: { status: 'pending' }, createdAt: '2026-07-08T09:00:00Z',
    }
    const created = await fetch(`${base}/pins`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pin) })
    assert.equal(created.status, 200)
    const listed = (await (await fetch(`${base}/pins?workspace=canon-ws`)).json()) as Pin[]
    assert.deepEqual(listed.map((p) => p.id), ['pin-1'])

    // a garbage POST body is a 400, not a 500
    assert.equal((await fetch(`${base}/pins`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ not: 'a pin' }) })).status, 400)

    // before ingest, the pin has no chunks yet (pending, never fetched)
    assert.deepEqual(await (await fetch(`${base}/pins/pin-1/chunks?workspace=canon-ws`)).json(), [])

    // run the ingest lifecycle over the file fetcher: fetch → page-anchored chunk → persist
    const ingestRes = await fetch(`${base}/pins/pin-1/ingest?workspace=canon-ws`, { method: 'POST' })
    assert.equal(ingestRes.status, 200)
    const ingested = (await ingestRes.json()) as Pin
    assert.equal(ingested.ingest.status, 'ingested')
    assert.equal(ingested.ingest.pages, 2, 'the two form-feed pages were counted')

    // the "cite p. N" read: chunks come back in ordinal order, each anchored to its source page
    const chunks = (await (await fetch(`${base}/pins/pin-1/chunks?workspace=canon-ws`)).json()) as PinChunk[]
    assert.deepEqual(chunks.map((c) => c.page), [1, 2], 'page anchors preserved (the citation)')
    assert.ok(/Acme/.test(chunks[0]!.text) && /Dana/.test(chunks[1]!.text), 'each excerpt is the prose of its page')

    // unknown pin ⇒ 404 on both sub-routes
    assert.equal((await fetch(`${base}/pins/nope/ingest?workspace=canon-ws`, { method: 'POST' })).status, 404)
    assert.equal((await fetch(`${base}/pins/nope/chunks?workspace=canon-ws`)).status, 404)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('POST /pins/:id/ingest surfaces the pdf HONEST STUB failure verbatim — no fabricated success', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    const pin: Pin = {
      id: 'pin-pdf', workspaceId: 'canon-ws', uri: 'file:///tmp/does-not-matter.pdf', title: 'a pdf', kind: 'pdf',
      ingest: { status: 'pending' }, createdAt: '2026-07-08T09:00:00Z',
    }
    await fetch(`${base}/pins`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pin) })

    // ingestPin NEVER throws on a fetch failure — it records status:'failed' with the message — so the
    // HTTP call is a 200 whose ingest states the failure verbatim (the route fabricates no success).
    const res = await fetch(`${base}/pins/pin-pdf/ingest?workspace=canon-ws`, { method: 'POST' })
    assert.equal(res.status, 200)
    const p = (await res.json()) as Pin
    assert.equal(p.ingest.status, 'failed')
    assert.match(p.ingest.error ?? '', /PDF text extraction is not wired/)
    // nothing was written — a failed ingest leaves no chunks (never fabricated pages)
    assert.deepEqual(await (await fetch(`${base}/pins/pin-pdf/chunks?workspace=canon-ws`)).json(), [])
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('GET /teach/candidates derives SUGGESTED hint patterns per workspace (never writes hints)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // no signals yet ⇒ an empty candidate list, not an error
    assert.deepEqual(await (await fetch(`${base}/teach/candidates?workspace=sales`)).json(), [])

    // seed two reroutes corrected TO 'sales', both carrying the SAME repo evidence → one aggregated
    // candidate with supportCount 2 and the strongest supporting weight (the real capture path via TeachStore)
    const teach = new TeachStore(app.store)
    teach.record({ id: 'teach-reroute-s1', kind: 'reroute', fromWorkspaceId: 'default', toWorkspaceId: 'sales', sessionId: 's1', evidence: [{ kind: 'repo', detail: '~/code/acme', weight: 0.6 }], correctedAt: '2026-07-08T10:00:00Z' })
    teach.record({ id: 'teach-reroute-s2', kind: 'reroute', fromWorkspaceId: 'default', toWorkspaceId: 'sales', sessionId: 's2', evidence: [{ kind: 'repo', detail: '~/code/acme', weight: 0.9 }], correctedAt: '2026-07-08T11:00:00Z' })

    const candidates = (await (await fetch(`${base}/teach/candidates?workspace=sales`)).json()) as HintCandidate[]
    assert.equal(candidates.length, 1)
    const only = candidates[0]!
    assert.equal(only.workspaceId, 'sales')
    assert.equal(only.pattern.field, 'repoPath', 'repo evidence maps onto the repoPath focus field')
    assert.equal(only.pattern.contains, '~/code/acme')
    assert.equal(only.pattern.weight, 0.9, 'the strongest supporting evidence weight')
    assert.equal(only.supportCount, 2)
    assert.deepEqual(only.sampleSessionIds, ['s1', 's2'], 'traceable to the corrections behind it')

    // scoped by workspace: a different workspace's corrections do not leak in
    assert.deepEqual(await (await fetch(`${base}/teach/candidates?workspace=other`)).json(), [])

    // the read NEVER applied the candidate: the workspace's hints document is untouched (empty)
    assert.deepEqual(app.store.layouts.getLatest('workspace-hints', 'sales')?.body ?? null, null)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('e2e: a teach surface hydrates its teach block from the derived candidates over POST /query', async () => {
  // The data path the HUD drives for the teach/hint-review block (#11). Teach candidates are DERIVED
  // read-only over the stored teach-signals (there is no write route — corrections arrive as
  // session.rerouted, recorded by TeachStore), so this seeds signals via the real store seam, authors a
  // surface carrying a teach block whose query is `source: 'teach'`, then GET + POST /query hydrate
  // exactly as the client does: the SUGGESTED candidate + its support + its traceable sessions round-trip.
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-teach-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // seed two reroutes corrected TO 'sales' agreeing on the same repo evidence ⇒ one candidate, support 2
    const teach = new TeachStore(app.store)
    teach.record({ id: 'teach-reroute-s1', kind: 'reroute', fromWorkspaceId: 'default', toWorkspaceId: 'sales', sessionId: 's1', evidence: [{ kind: 'repo', detail: '~/code/acme', weight: 0.6 }], correctedAt: '2026-07-08T10:00:00Z' })
    teach.record({ id: 'teach-reroute-s2', kind: 'reroute', fromWorkspaceId: 'default', toWorkspaceId: 'sales', sessionId: 's2', evidence: [{ kind: 'repo', detail: '~/code/acme', weight: 0.9 }], correctedAt: '2026-07-08T11:00:00Z' })

    // author a surface with a teach block bound to the teach source (saving a layout is not flagged)
    const surface: Surface = {
      id: 'surf-teach', name: 'Teach review', context: 'meeting', version: 1,
      stack: [
        { block: 'now' },
        { block: 'teach', show: 'on-match', query: { source: 'teach', params: { workspace: 'sales' }, top: 5 } },
      ],
    }
    assert.equal((await fetch(`${base}/layouts/surfaces/surf-teach`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(surface),
    })).status, 200)

    // hydrate exactly as the client will: GET the surface, POST /query for the teach block
    const served = (await (await fetch(`${base}/layouts/surfaces/surf-teach`)).json()) as Surface
    const teachBlock = served.stack.find((b) => b.block === 'teach')!
    const result = (await (await fetch(`${base}/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(teachBlock.query),
    })).json()) as QueryResult
    // THE PROOF: the teach block hydrates the DERIVED candidate — pattern + support + traceable sessions
    assert.equal(result.source, 'teach')
    const cands = result.items as HintCandidate[]
    assert.equal(cands.length, 1)
    assert.equal(cands[0]!.workspaceId, 'sales')
    assert.equal(cands[0]!.pattern.field, 'repoPath')
    assert.equal(cands[0]!.pattern.contains, '~/code/acme')
    assert.equal(cands[0]!.supportCount, 2)
    assert.deepEqual(cands[0]!.sampleSessionIds, ['s1', 's2']) // always traceable to its corrections

    // the query NEVER applied the candidate: the workspace's hints document stays untouched (read-only loop)
    assert.deepEqual(app.store.layouts.getLatest('workspace-hints', 'sales')?.body ?? null, null)

    // an untaught workspace derives explainable-empty (items: [], not an error)
    const empty = (await (await fetch(`${base}/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'teach', params: { workspace: 'ws-untaught' }, top: 5 }),
    })).json()) as QueryResult
    assert.deepEqual(empty.items, [])
    assert.equal(empty.truncated, false)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

// ---- P4-T3b: GET/PUT /hints — the APPLY-with-review half of the teach loop ----
// /teach/candidates (above) SUGGESTS a pattern; these routes let the user review it and PUT it into the
// workspace's WorkspaceHints document over the existing HintsDocuments store seam (no auto-apply, no
// route/ logic touched). The final e2e closes the flywheel: correction → candidate → applied hint →
// the detector's hint provider (hintsDocs.all(), = GET /hints) now attributes on it.

test('/hints routes: list has the seeded default, GET 404 unknown, PUT invalid 400 / id-mismatch 400, PUT valid reads back and bumps version', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // v0 seeds ONE empty hints doc for the default workspace (patterns: []) — it enumerates and resolves
    const listed = (await (await fetch(`${base}/hints`)).json()) as WorkspaceHints[]
    assert.deepEqual(listed, [{ workspaceId: 'default', patterns: [] }])
    const seeded = (await (await fetch(`${base}/hints/default`)).json()) as WorkspaceHints
    assert.deepEqual(seeded, { workspaceId: 'default', patterns: [] })

    // a workspace with no hints doc yet ⇒ 404 (only default is seeded; others exist only once PUT)
    assert.equal((await fetch(`${base}/hints/sales`)).status, 404)

    // a garbage body is a 400, not a 500
    assert.equal((await fetch(`${base}/hints/sales`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ not: 'hints' }) })).status, 400)
    // a valid body whose workspaceId disagrees with the route is a 400
    assert.equal((await fetch(`${base}/hints/sales`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: 'other', patterns: [] }) })).status, 400)

    // a valid, matching PUT CREATES the workspace's hints doc (unknown workspace is not a 404 — mirrors
    // PUT /workflows creating on an unknown id) and reads back through GET
    const doc: WorkspaceHints = { workspaceId: 'sales', patterns: [{ field: 'repoPath', contains: '~/code/acme', weight: 0.7 }] }
    const putRes = await fetch(`${base}/hints/sales`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) })
    assert.equal(putRes.status, 200)
    assert.deepEqual(await putRes.json(), doc)
    assert.deepEqual(await (await fetch(`${base}/hints/sales`)).json(), doc)
    assert.equal(app.store.layouts.getLatest('workspace-hints', 'sales')?.version, 1, 'first write is version 1')

    // a second edit is version-stamped by the store (history preserved) and the new patterns read back
    const edited: WorkspaceHints = { workspaceId: 'sales', patterns: [...doc.patterns, { field: 'windowTitle', contains: 'Salesforce', weight: 0.5 }] }
    assert.equal((await fetch(`${base}/hints/sales`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(edited) })).status, 200)
    assert.deepEqual(await (await fetch(`${base}/hints/sales`)).json(), edited, 'GET reflects the edit')
    assert.equal(app.store.layouts.getLatest('workspace-hints', 'sales')?.version, 2, 'the store stamped the next version')

    // the list now carries both the seeded default and the applied workspace
    const after = (await (await fetch(`${base}/hints`)).json()) as WorkspaceHints[]
    assert.deepEqual(after.map((h) => h.workspaceId).sort(), ['default', 'sales'])
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('e2e flywheel: a correction derives a candidate → PUT /hints applies it → the detector now attributes on it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // CORRECTIONS: two reroutes to 'sales' carrying the same repo evidence (the real capture path). Before
    // any hint is applied, a stream of matching focus signals detects NOTHING — 'sales' has no hints yet.
    const teach = new TeachStore(app.store)
    teach.record({ id: 'teach-reroute-s1', kind: 'reroute', fromWorkspaceId: 'default', toWorkspaceId: 'sales', sessionId: 's1', evidence: [{ kind: 'repo', detail: '~/code/acme', weight: 0.6 }], correctedAt: '2026-07-08T10:00:00Z' })
    teach.record({ id: 'teach-reroute-s2', kind: 'reroute', fromWorkspaceId: 'default', toWorkspaceId: 'sales', sessionId: 's2', evidence: [{ kind: 'repo', detail: '~/code/acme', weight: 0.9 }], correctedAt: '2026-07-08T11:00:00Z' })

    // 11 focus signals at 10s spacing span 100s > the sustain window, all in ~/code/acme (the corrected repo)
    const at = (sec: number): string => new Date(Date.UTC(2026, 6, 8, 14, 0, 0) + sec * 1000).toISOString()
    const inAcme: FocusSignal = { app: 'Code', windowTitle: 'crm.ts — acme', repoPath: '~/code/acme/crm' }
    const stream: TimedFocusSignal[] = Array.from({ length: 11 }, (_, i) => ({ at: at(i * 10), signal: inAcme }))

    // NEGATIVE (pre-apply): the detector scores the SAME view the attributor uses (GET /hints = hintsDocs.all()).
    // With only the seeded empty default, the signals match nothing → stay, no attribution to 'sales'.
    const before = (await (await fetch(`${base}/hints`)).json()) as WorkspaceHints[]
    assert.equal(detectSwitch(stream, before, undefined).decision, 'stay')

    // SUGGEST: the corrections derive one candidate (repoPath / ~/code/acme). The user reviews it.
    const candidates = (await (await fetch(`${base}/teach/candidates?workspace=sales`)).json()) as HintCandidate[]
    assert.equal(candidates.length, 1)
    const candidate = candidates[0]!
    assert.equal(candidate.pattern.field, 'repoPath')
    assert.equal(candidate.pattern.contains, '~/code/acme')

    // APPLY: PUT a hints doc for 'sales' that includes the reviewed candidate's pattern — a plain edit
    const applied: WorkspaceHints = { workspaceId: 'sales', patterns: [candidate.pattern] }
    assert.equal((await fetch(`${base}/hints/sales`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(applied) })).status, 200)

    // GET /hints reflects the applied pattern (the detector's hint provider, hintsDocs.all())
    const after = (await (await fetch(`${base}/hints`)).json()) as WorkspaceHints[]
    const salesHints = after.find((h) => h.workspaceId === 'sales')
    assert.deepEqual(salesHints?.patterns, [candidate.pattern], 'the applied candidate is now live in the workspace hints')

    // POSITIVE (post-apply): the SAME focus stream now sustains dominance for 'sales' — the correction the
    // user made once is generalized by the detector. This is the flywheel closing: teach → suggest → apply → attribute.
    const result = detectSwitch(stream, after, undefined)
    assert.equal(result.decision, 'switch')
    assert.equal(result.toWorkspaceId, 'sales')
    assert.ok(result.evidence.some((e) => e.kind === 'repo' && /acme/.test(e.detail)), 'attributed on the applied repo hint')
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('POST /teach/entity: a clarify answer writes an override + teach signal, and the same collision never asks again (#75)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-clarify-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${(address as { port: number }).port}`

    // Seed a COLLISION: a well-known public project and an internal repo sharing a name (issue scenario).
    // A wide ambiguityMargin forces the linked mention to be flagged ambiguous; the rival is seeded with a
    // high provisionalBand so it stays a DISTINCT record instead of linking into the first.
    const AMBIGUOUS = { autoBand: 0.85, provisionalBand: 0.3, ambiguityMargin: 0.6, establishmentBoost: 0.1, establishmentSaturation: 32, halfLifeHours: 168 }
    const primary = app.store.upsertEntity({ workspaceId: 'ws-c', kind: 'artifact', name: 'Mercury', seenAt: '2026-07-08T09:00:00Z' })
    const rival = app.store.upsertEntity({ workspaceId: 'ws-c', kind: 'artifact', name: 'Mercury Bank', seenAt: '2026-07-08T09:01:00Z', resolverConfig: { ...AMBIGUOUS, provisionalBand: 0.95 } })
    const linked = app.store.upsertEntity({ workspaceId: 'ws-c', kind: 'artifact', name: 'Mercury', seenAt: '2026-07-08T09:02:00Z', resolverConfig: AMBIGUOUS })
    assert.equal(linked.id, primary.id)
    assert.equal(linked.ambiguity?.rivalName, 'Mercury Bank') // ONE ask surfaced on the linked row

    // The user answers: it IS the linked candidate (confirm) — reject the rival.
    const answer = await fetch(`${base}/teach/entity`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-c', entityId: primary.id, heard: 'Mercury', verdict: 'confirm', rivalId: rival.id, rivalName: 'Mercury Bank' }),
    })
    assert.equal(answer.status, 200)
    const settled = (await answer.json()) as Entity
    assert.equal(settled.state, 'confirmed') // the override stamped confirmed
    assert.equal(settled.ambiguity, undefined) // …and cleared the reviewable marker (the ask is gone)
    assert.equal(settled.overrides?.length, 1)
    assert.equal(settled.overrides?.[0]!.rejectedRivalId, rival.id) // the wrong rival is recorded rejected

    // The labeled TeachSignal was persisted (audit + teach loop), filed under the entity's workspace.
    const signals = new TeachStore(app.store).list('ws-c')
    assert.equal(signals.length, 1)
    assert.equal(signals[0]!.kind, 'alias-confirm')
    assert.equal(signals[0]!.entity?.entityId, primary.id)

    // GET /entities reflects the settled state (no ambiguity ⇒ no ≟ on reload).
    const entities = (await (await fetch(`${base}/entities?workspace=ws-c`)).json()) as Entity[]
    assert.equal(entities.find((e) => e.id === primary.id)?.ambiguity, undefined)

    // The SAME collision never asks again: a fresh "Mercury" mention resolves to the confirmed entity via
    // the sovereign override short-circuit — no re-score against the rejected rival, no new ambiguity.
    const again = app.store.upsertEntity({ workspaceId: 'ws-c', kind: 'artifact', name: 'Mercury', seenAt: '2026-07-08T12:00:00Z' })
    assert.equal(again.id, primary.id)
    assert.equal(again.state, 'confirmed')
    assert.equal(again.ambiguity, undefined)

    // A disambiguate with no rival is a 400 (the verdict is unresolvable without the entity it names).
    const bad = await fetch(`${base}/teach/entity`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-c', entityId: primary.id, heard: 'Mercury', verdict: 'disambiguate' }),
    })
    assert.equal(bad.status, 400)

    // An unknown entity is a 404, never a silent no-op.
    const missing = await fetch(`${base}/teach/entity`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-c', entityId: 'ent-nowhere', heard: 'x', verdict: 'confirm' }),
    })
    assert.equal(missing.status, 404)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('POST /teach/entity: a disambiguate verdict pins the rival and settles the once-linked row (#75)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-clarify-dis-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${(address as { port: number }).port}`
    const AMBIGUOUS = { autoBand: 0.85, provisionalBand: 0.3, ambiguityMargin: 0.6, establishmentBoost: 0.1, establishmentSaturation: 32, halfLifeHours: 168 }
    const primary = app.store.upsertEntity({ workspaceId: 'ws-d', kind: 'artifact', name: 'Mercury', seenAt: '2026-07-08T09:00:00Z' })
    const rival = app.store.upsertEntity({ workspaceId: 'ws-d', kind: 'artifact', name: 'Mercury Bank', seenAt: '2026-07-08T09:01:00Z', resolverConfig: { ...AMBIGUOUS, provisionalBand: 0.95 } })
    app.store.upsertEntity({ workspaceId: 'ws-d', kind: 'artifact', name: 'Mercury', seenAt: '2026-07-08T09:02:00Z', resolverConfig: AMBIGUOUS })

    // The user says the mention actually meant the RIVAL.
    const answer = await fetch(`${base}/teach/entity`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-d', entityId: primary.id, heard: 'Mercury', verdict: 'disambiguate', rivalId: rival.id, rivalName: 'Mercury Bank' }),
    })
    assert.equal(answer.status, 200)
    const settledRival = (await answer.json()) as Entity
    assert.equal(settledRival.id, rival.id) // the override is written on the RIVAL — the truth
    assert.equal(settledRival.state, 'confirmed')
    assert.equal(settledRival.overrides?.[0]!.rejectedRivalId, primary.id) // rejects the once-linked entity

    const entities = (await (await fetch(`${base}/entities?workspace=ws-d`)).json()) as Entity[]
    assert.equal(entities.find((e) => e.id === primary.id)?.ambiguity, undefined) // the once-linked row is settled too
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('POST /chat validates the body (400) and surfaces an honest failure with no llm slot (502)', async () => {
  // The served-route proof (#134): validation happens before any model is touched, and an empty llm slot
  // comes back as a 502 whose `error` the input block paints — never a silent success. (A green happy-path
  // over the REAL invoke lives in chat.test.ts against a throwaway openai-compat server.)
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${(address as { port: number }).port}`

    const bad = await fetch(`${base}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) })
    assert.equal(bad.status, 400)
    assert.match(((await bad.json()) as { error: string }).error, /invalid ChatRequest/)

    const empty = await fetch(`${base}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hello' }) })
    assert.equal(empty.status, 502)
    assert.match(((await empty.json()) as { error: string }).error, /llm/i) // the honest reason, verbatim
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the two #134 panel surfaces are seeded and served with their panel + input primitives', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${(address as { port: number }).port}`

    const chat = (await (await fetch(`${base}/layouts/surfaces/surf-openinfo-chat`)).json()) as Surface
    assert.equal(chat.panel?.edge, 'below')
    assert.equal(chat.panel?.expanded, 432)
    const input = chat.stack.find((b) => b.block === 'input')
    assert.equal(input?.input?.submit, '/chat')
    assert.equal(input?.input?.mode, 'both')

    const sidebar = (await (await fetch(`${base}/layouts/surfaces/surf-openinfo-sidebar`)).json()) as Surface
    assert.equal(sidebar.panel?.edge, 'right')
    assert.equal(sidebar.panel?.reveal, 'event')
    assert.equal(sidebar.panel?.openOn, 'entity.updated')
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('GET/PUT /bundles serves the Standard App bundle in the document-route idiom', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-api-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // Enumerate — the tray Apps catalog read. The seeded Standard App is always present.
    const list = (await (await fetch(`${base}/bundles`)).json()) as Bundle[]
    const standard = list.find((b) => b.id === 'bundle-standard-app')
    assert.ok(standard, 'GET /bundles lists the seeded Standard App')
    assert.equal(standard!.faces[0]!.kind, 'hud')

    // Read by id.
    const byId = (await (await fetch(`${base}/bundles/bundle-standard-app`)).json()) as Bundle
    assert.equal(byId.name, 'Standard App')

    // Unknown id ⇒ 404 (a resource read, not a gated behavior).
    assert.equal((await fetch(`${base}/bundles/bundle-nope`)).status, 404)

    // Validated PUT edits the document, version-stamped by the store.
    const put = await fetch(`${base}/bundles/bundle-standard-app`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...byId, description: 'edited over the API' }),
    })
    assert.equal(put.status, 200)
    assert.equal(((await put.json()) as Bundle).version, 2, 'the store stamped the next version')

    // A malformed body ⇒ 400 (the Tier-A gate: closed face-kind union), never persisted.
    const bad = await fetch(`${base}/bundles/bundle-standard-app`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...byId, faces: [{ kind: 'sidebar', surfaceRef: 's' }] }),
    })
    assert.equal(bad.status, 400)

    // An id/route mismatch ⇒ 400 (mirrors PUT /workflows).
    const mismatch = await fetch(`${base}/bundles/bundle-standard-app`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...byId, id: 'bundle-other' }),
    })
    assert.equal(mismatch.status, 400)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})
