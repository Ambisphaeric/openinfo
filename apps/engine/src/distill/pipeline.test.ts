import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk, Distillate, Entity, Fabric, Moment, Session } from '@openinfo/contracts'
import { EventBus, type EngineEvents } from '../bus/index.js'
import { FabricDocuments, defaultFabric } from '../fabric/index.js'
import { CaptureQueue } from '../queue/spool.js'
import { WorkspaceRegistry } from '../store/index.js'
import { VoiceDocuments } from '../voice/index.js'
import { Distiller } from './distiller.js'
import { DistillDocuments } from './documents.js'

interface FakeLlm {
  server: Server
  url: string
  prompts: string[]
}

const startFakeLlm = async (): Promise<FakeLlm> => {
  const prompts: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: { content: string }[] }
      const prompt = body.messages[0]!.content
      prompts.push(prompt)
      // one fake model, three jobs, told apart by their template bodies: the entities prompt asks
      // for a 'JSON array of entities', the moment-extraction prompt for a strict JSON array, and
      // everything else is the summary pass.
      const content = prompt.includes('JSON array of entities')
        ? '[{"kind": "person", "name": "Dana"}, {"kind": "topic", "name": "Thursday ship date", "aliases": ["ship Thursday"]}, {"kind": "banana", "name": "invalid kind, dropped"}]'
        : prompt.includes('Return ONLY a JSON array')
          ? '[{"kind": "commitment", "text": "ship Thursday", "speaker": "user", "confidence": 0.85}, {"kind": "banana", "text": "invalid kind, dropped"}]'
          : 'SUMMARY: they agreed to ship Thursday.'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}`, prompts }
}

const chunk = (sequence: number, sec: number, data: string): CaptureChunk => ({
  id: `chunk-${sequence}`,
  sessionId: 'ses-e2e',
  workspaceId: 'ws-e2e',
  source: 'mic',
  sequence,
  capturedAt: new Date(Date.UTC(2026, 6, 7, 14, 0, sec)).toISOString(),
  contentType: 'text/plain',
  encoding: 'utf8',
  data,
})

test('drain → distill → store → bus with a fake llm endpoint', async () => {
  const llm = await startFakeLlm()
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-distill-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const voice = new VoiceDocuments(store)
    voice.ensureDefaults()
    const docs = new DistillDocuments(store)
    docs.ensureDefaults()
    const fabric = new FabricDocuments(store)
    const fabricDoc: Fabric = { slots: { ...defaultFabric().slots, llm: [{ kind: 'http', name: 'llm.fast', url: llm.url, api: 'openai-compat', model: 'llama-3.2-3b' }] } }
    fabric.save(fabricDoc)

    const bus = new EventBus<EngineEvents>()
    const published: Distillate[] = []
    bus.subscribe('distillate.updated', (d) => {
      published.push(d)
    })

    const distiller = new Distiller({ store, voice, fabric, docs, publish: (d) => bus.publish('distillate.updated', d) })
    // Real seam: the queue drain invokes the distiller processor.
    const queue = new CaptureQueue(join(dir, 'queue'), async (chunks) => {
      await distiller.distillChunks(chunks)
    })
    for (const c of [chunk(1, 0, 'we should ship Thursday'), chunk(2, 20, 'agreed, Thursday it is')]) await queue.append(c)

    queue.scheduleDrain(() => undefined)
    for (let i = 0; i < 40 && published.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10))

    // one merge window (steady stream) → one distillate, persisted and published
    assert.equal(published.length, 1)
    const stored = store.listDistillates('ws-e2e', 'ses-e2e')
    assert.equal(stored.length, 1)
    const d = stored[0]!
    assert.match(d.text, /Thursday/)
    assert.deepEqual(d.sourceChunks, ['chunk-1', 'chunk-2'])
    assert.equal(d.provenance.endpoint, 'llm.fast')
    assert.equal(d.provenance.model, 'llama-3.2-3b')
    assert.equal(d.schemaVersion, 1)

    // the meeting mode is bound to boardroom (mode.registerId) → its low-charm/high-specificity
    // vector is resolved and recorded on provenance. #130: the neutral default body no longer bakes
    // the dials INTO the prompt, so we assert the resolution (provenance) not the prompt text.
    assert.equal(d.voice.registerId, 'reg-boardroom')
    assert.equal(d.voice.scope, 'mode')
    assert.equal(d.voice.dials.charm, 2)
    assert.doesNotMatch(llm.prompts[0]!, /specificity \d+\/10/) // neutral default carries no dial line
    assert.match(llm.prompts[0]!, /we should ship Thursday/)

    assert.equal((await queue.status()).pendingFiles, 0) // file drained after processing

    // distill.moments was not enabled for this drain → no extraction call, no moments
    assert.equal(llm.prompts.filter((p) => p.includes('Return ONLY a JSON array')).length, 0)
    assert.deepEqual(store.listMoments('ws-e2e'), [])
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => llm.server.close(() => resolve()))
  }
})

test('a real session record steers voice resolution off the default-mode fallback', async () => {
  const llm = await startFakeLlm()
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-session-voice-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const voice = new VoiceDocuments(store)
    voice.ensureDefaults()
    const docs = new DistillDocuments(store)
    docs.ensureDefaults()
    const fabric = new FabricDocuments(store)
    fabric.save({ slots: { ...defaultFabric().slots, llm: [{ kind: 'http', name: 'llm.fast', url: llm.url, api: 'openai-compat', model: 'llama-3.2-3b' }] } })
    const distiller = new Distiller({ store, voice, fabric, docs })

    // a real session record for the chunks' sessionId, carrying a NON-default register (sales-floor,
    // charm 8 / specificity 5) instead of the meeting mode's boardroom default (charm 2 / spec 9).
    const session: Session = {
      id: 'ses-e2e', workspaceId: 'ws-e2e', modeId: 'mode-meeting', startedAt: '2026-07-07T13:59:00Z',
      attribution: { evidence: [{ kind: 'manual', detail: 'started manually', weight: 1 }], confidence: 1 },
      registerId: 'reg-sales-floor',
    }
    store.saveSession(session)

    const produced = await distiller.distillChunks([chunk(1, 0, 'we should ship Thursday'), chunk(2, 20, 'agreed, Thursday it is')])
    // session-scope binding wins over the mode-default boardroom → sales-floor reached the prompt
    assert.equal(produced.length, 1)
    assert.equal(produced[0]!.voice.registerId, 'reg-sales-floor')
    assert.equal(produced[0]!.voice.scope, 'session')
    assert.equal(produced[0]!.voice.dials.charm, 8) // sales-floor resolved, NOT boardroom's charm 2

    // contrast: a session id with NO record falls back to the default meeting mode → boardroom
    const fallback = await distiller.distillChunks([{ ...chunk(3, 0, 'different meeting'), sessionId: 'ses-unstarted' }])
    assert.equal(fallback[0]!.voice.registerId, 'reg-boardroom')
    assert.equal(fallback[0]!.voice.scope, 'mode')
    assert.equal(fallback[0]!.voice.dials.specificity, 9) // boardroom resolved on the fallback
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => llm.server.close(() => resolve()))
  }
})

test('drain → distill → moments → store → bus with a fake llm endpoint', async () => {
  const llm = await startFakeLlm()
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-moments-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const voice = new VoiceDocuments(store)
    voice.ensureDefaults()
    const docs = new DistillDocuments(store)
    docs.ensureDefaults()
    const fabric = new FabricDocuments(store)
    const fabricDoc: Fabric = { slots: { ...defaultFabric().slots, llm: [{ kind: 'http', name: 'llm.fast', url: llm.url, api: 'openai-compat', model: 'llama-3.2-3b' }] } }
    fabric.save(fabricDoc)

    const bus = new EventBus<EngineEvents>()
    const publishedMoments: Moment[] = []
    bus.subscribe('moment.created', (m) => {
      publishedMoments.push(m)
    })

    const distiller = new Distiller({
      store,
      voice,
      fabric,
      docs,
      publish: (d) => bus.publish('distillate.updated', d),
      publishMoment: (m) => bus.publish('moment.created', m),
    })
    // Real seam: the drain runs the distill pass with moment extraction on (distill.moments).
    const queue = new CaptureQueue(join(dir, 'queue'), async (chunks) => {
      await distiller.distillChunks(chunks, { extractMoments: true })
    })
    for (const c of [chunk(1, 0, 'we should ship Thursday'), chunk(2, 20, 'agreed, Thursday it is')]) await queue.append(c)

    queue.scheduleDrain(() => undefined)
    for (let i = 0; i < 40 && publishedMoments.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10))

    // the fake llm returned one valid commitment + one invalid kind (dropped, salvage policy)
    assert.equal(publishedMoments.length, 1)
    const stored = store.listMoments('ws-e2e', 'ses-e2e')
    assert.equal(stored.length, 1)
    const m = stored[0]!
    assert.equal(m.kind, 'commitment')
    assert.equal(m.text, 'ship Thursday')
    assert.equal(m.speaker, 'user')
    assert.equal(m.confidence, 0.85)
    assert.equal(m.source, 'mic')
    assert.equal(m.sessionId, 'ses-e2e')
    assert.equal(m.workspaceId, 'ws-e2e')

    // provenance ties the moment back to its distillate window and the producing endpoint
    const distillates = store.listDistillates('ws-e2e', 'ses-e2e')
    assert.equal(distillates.length, 1)
    assert.equal(m.provenance?.distillateId, distillates[0]!.id)
    assert.equal(m.provenance?.endpoint, 'llm.fast')
    assert.equal(m.provenance?.model, 'llama-3.2-3b')
    assert.equal(m.at, distillates[0]!.windowEnd)

    // the extraction prompt interpolated the window summary + transcript. #130: the neutral default
    // extract body no longer bakes the voice dials, so we assert the window inputs, not the dial line.
    const extractPrompt = llm.prompts.find((p) => p.includes('Return ONLY a JSON array'))
    assert.ok(extractPrompt)
    assert.doesNotMatch(extractPrompt, /specificity \d+\/10/)
    assert.match(extractPrompt, /they agreed to ship Thursday/) // {{summary}} from the distill call
    assert.match(extractPrompt, /we should ship Thursday/) // {{transcript}}

    assert.equal((await queue.status()).pendingFiles, 0)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => llm.server.close(() => resolve()))
  }
})

test('drain → distill → moments → entities → store → bus with a fake llm endpoint', async () => {
  const llm = await startFakeLlm()
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-index-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const voice = new VoiceDocuments(store)
    voice.ensureDefaults()
    const docs = new DistillDocuments(store)
    docs.ensureDefaults()
    const fabric = new FabricDocuments(store)
    const fabricDoc: Fabric = { slots: { ...defaultFabric().slots, llm: [{ kind: 'http', name: 'llm.fast', url: llm.url, api: 'openai-compat', model: 'llama-3.2-3b' }] } }
    fabric.save(fabricDoc)

    const bus = new EventBus<EngineEvents>()
    const publishedEntities: Entity[] = []
    const publishedMoments: Moment[] = []
    bus.subscribe('entity.updated', (e) => {
      publishedEntities.push(e)
    })
    bus.subscribe('moment.created', (m) => {
      publishedMoments.push(m)
    })

    const distiller = new Distiller({
      store,
      voice,
      fabric,
      docs,
      publish: (d) => bus.publish('distillate.updated', d),
      publishMoment: (m) => bus.publish('moment.created', m),
      publishEntity: (e) => bus.publish('entity.updated', e),
    })
    // Real seam: the drain runs the full pass — distill + moments (distill.moments) + entity
    // indexing (distill.index).
    const queue = new CaptureQueue(join(dir, 'queue'), async (chunks) => {
      await distiller.distillChunks(chunks, { extractMoments: true, extractEntities: true })
    })
    // a >30s gap forces TWO merge windows → the same entities are extracted twice and must MERGE
    for (const c of [chunk(1, 0, 'we should ship Thursday'), chunk(2, 40, 'Dana agreed, ship Thursday')]) await queue.append(c)

    queue.scheduleDrain(() => undefined)
    for (let i = 0; i < 100 && publishedEntities.length < 4; i += 1) await new Promise((r) => setTimeout(r, 10))

    // two windows × (Dana + topic) upserted — 4 entity.updated events — but ONE record each:
    // cross-window resolution merged them (mention count 2), never a duplicate row
    assert.equal(publishedEntities.length, 4)
    const entities = store.listEntities('ws-e2e')
    assert.equal(entities.length, 2)
    const dana = entities.find((e) => e.kind === 'person')!
    const topic = entities.find((e) => e.kind === 'topic')!
    assert.equal(dana.name, 'Dana')
    assert.equal(dana.mentions, 2)
    assert.equal(topic.name, 'Thursday ship date')
    assert.deepEqual(topic.aliases, ['ship Thursday'])
    assert.equal(topic.mentions, 2)

    // provenance: one entry per window that mentioned the entity, tied to real distillates
    const distillates = store.listDistillates('ws-e2e', 'ses-e2e')
    assert.equal(distillates.length, 2)
    assert.deepEqual(
      dana.provenance?.map((p) => p.distillateId).sort(),
      distillates.map((d) => d.id).sort(),
    )
    assert.equal(dana.provenance?.[0]?.endpoint, 'llm.fast')
    assert.equal(dana.provenance?.[0]?.model, 'llama-3.2-3b')

    // refs linking, both directions: each window's moment says "ship Thursday", which matches the
    // topic's alias — so moment.refs carries the entity id and the entity's momentRefs carry the
    // moment ids. Dana is never named in a moment text, so no link (post-hoc name matching only).
    const moments = store.listMoments('ws-e2e', 'ses-e2e')
    assert.equal(moments.length, 2)
    for (const m of moments) {
      assert.deepEqual(m.refs, [topic.id])
    }
    assert.deepEqual([...topic.momentRefs].sort(), moments.map((m) => m.id).sort())
    assert.deepEqual(dana.momentRefs, [])
    // published moment.created events already carried the linked refs (linking is same-pass, pre-persist)
    assert.equal(publishedMoments.length, 2)
    for (const m of publishedMoments) assert.deepEqual(m.refs, [topic.id])

    assert.equal((await queue.status()).pendingFiles, 0)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => llm.server.close(() => resolve()))
  }
})
