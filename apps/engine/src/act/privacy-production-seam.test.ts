import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Distillate, Fabric, Session, WorkflowStep } from '@openinfo/contracts'
import { WorkspaceRegistry } from '../store/index.js'
import { VoiceDocuments } from '../voice/index.js'
import { FabricDocuments, defaultFabric } from '../fabric/index.js'
import { GuardDocuments, GuardHoldStore } from '../guard/index.js'
import { defaultMeetingMode } from '../distill/index.js'
import { ActDocuments } from './documents.js'
import { Actor } from './draft.js'
import { TaskExtractor, TodoDocuments } from './todo.js'

interface FakeChat {
  server: Server
  url: string
  prompts: string[]
}

const startChat = async (reply: (prompt: string) => string): Promise<FakeChat> => {
  const prompts: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: { content: string }[] }
      const prompt = body.messages.map((message) => message.content).join('\n')
      prompts.push(prompt)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: reply(prompt) } }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}`, prompts }
}

const stop = (fake: FakeChat): Promise<void> => new Promise((resolve) => fake.server.close(() => resolve()))

const session = (id: string): Session => ({
  id,
  workspaceId: 'default',
  modeId: defaultMeetingMode.id,
  startedAt: '2026-07-14T12:00:00.000Z',
  attribution: { evidence: [{ kind: 'manual', detail: 'privacy seam', weight: 1 }], confidence: 1 },
})

const distillate = (sessionId: string, slot: 'llm' | 'ocr', id = `dst-${sessionId}`): Distillate => ({
  id,
  sessionId,
  workspaceId: 'default',
  windowStart: '2026-07-14T12:00:00.000Z',
  windowEnd: '2026-07-14T12:00:10.000Z',
  sourceChunks: [`chunk-${sessionId}`],
  text: slot === 'ocr' ? 'PRIVATE SCREEN: contract total is $9,000' : 'Dana agreed to send the contract Friday',
  voice: { scope: 'global', dials: { tone: 5, warmth: 5, wit: 5, charm: 5, specificity: 5, brevity: 5 } },
  provenance: { slot, endpoint: slot === 'ocr' ? 'ocr.local' : 'llm.fast' },
  schemaVersion: 1,
  createdAt: '2026-07-14T12:00:11.000Z',
})

const taskStep: WorkflowStep = { id: 'task-extract', kind: 'act', trigger: 'drain', params: {} }

test('production Actor/Task preserve mixed screen origin and allow transcript-only hosted routing', async () => {
  const hosted = await startChat((prompt) => prompt.includes('JSON array') ? '[{"text":"Send the contract Friday"}]' : 'Follow-up draft')
  const local = await startChat((prompt) => prompt.includes('JSON array') ? '[{"text":"Review the screen contract"}]' : 'Local follow-up draft')
  const documentedHosted = `http://act.egress.test:${new URL(hosted.url).port}`
  const originalFetch = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (raw.startsWith(documentedHosted)) return originalFetch(`${hosted.url}${raw.slice(documentedHosted.length)}`, init)
    return originalFetch(input, init)
  }) as typeof fetch
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-act-privacy-production-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const voice = new VoiceDocuments(store); voice.ensureDefaults()
    const docs = new ActDocuments(store); docs.ensureDefaults()
    const fabric = new FabricDocuments(store)
    fabric.save({ slots: { ...defaultFabric().slots, llm: [
      { kind: 'http', name: 'hosted-first', url: documentedHosted, api: 'openai-compat' },
      { kind: 'http', name: 'local-second', url: local.url, api: 'openai-compat' },
    ] } })
    const todos = new TodoDocuments(store)
    const actor = new Actor({ store, voice, fabric, docs, todos, mode: () => defaultMeetingMode })
    const tasks = new TaskExtractor({ store, voice, fabric, templates: docs, todos, mode: () => defaultMeetingMode })

    const screenSession = session('ses-screen-act')
    store.saveSession(screenSession)
    store.saveDistillate(distillate(screenSession.id, 'ocr'))
    const screenDraft = await actor.runFollowUpDraft(screenSession)
    const screenTodos = await tasks.extractForSession(screenSession, taskStep)
    assert.equal(hosted.prompts.length, 0)
    assert.equal(local.prompts.length, 2)
    assert.equal(screenDraft?.provenance.contentClass, 'screen')
    assert.equal(screenDraft?.provenance.endpoint, 'local-second')
    assert.equal(screenDraft?.provenance.egress?.decidedBy, 'content-class')
    assert.equal(screenTodos?.items[0]?.provenance?.contentClass, 'screen')
    assert.equal(screenTodos?.items[0]?.provenance?.endpoint, 'local-second')

    const transcriptSession = session('ses-transcript-act')
    store.saveSession(transcriptSession)
    store.saveDistillate(distillate(transcriptSession.id, 'llm'))
    const transcriptDraft = await actor.runFollowUpDraft(transcriptSession)
    const transcriptTodos = await tasks.extractForSession(transcriptSession, taskStep)
    assert.equal(hosted.prompts.length, 2)
    assert.equal(transcriptDraft?.provenance.contentClass, 'transcript')
    assert.equal(transcriptDraft?.provenance.endpoint, 'hosted-first')
    assert.equal(transcriptDraft?.provenance.egress?.destination, 'hosted-public')
    assert.equal(transcriptTodos?.items[0]?.provenance?.contentClass, 'transcript')
    assert.equal(transcriptTodos?.items[0]?.provenance?.endpoint, 'hosted-first')
  } finally {
    store.close()
    globalThis.fetch = originalFetch
    await stop(hosted)
    await stop(local)
    await rm(dir, { recursive: true, force: true })
  }
})

test('production strict guard holds Actor and Task once each before hosted target bytes', async () => {
  const hosted = await startChat(() => 'must not run')
  const local = await startChat(() => 'must not become a fallback')
  const guard = await startChat(() => '{"flagged":[{"start":0,"length":4,"kind":"secret"}]}')
  const documentedHosted = `http://act-hold.egress.test:${new URL(hosted.url).port}`
  const originalFetch = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (raw.startsWith(documentedHosted)) return originalFetch(`${hosted.url}${raw.slice(documentedHosted.length)}`, init)
    return originalFetch(input, init)
  }) as typeof fetch
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-act-strict-production-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const voice = new VoiceDocuments(store); voice.ensureDefaults()
    const docs = new ActDocuments(store); docs.ensureDefaults()
    const fabric = new FabricDocuments(store)
    fabric.save({ slots: { ...defaultFabric().slots, llm: [
      { kind: 'http', name: 'hosted-first', url: documentedHosted, api: 'openai-compat' },
      { kind: 'http', name: 'local-second', url: local.url, api: 'openai-compat' },
    ], guard: [{ kind: 'http', name: 'guard.local', url: guard.url, api: 'openai-compat' }] } })
    const guardDocs = new GuardDocuments(store); guardDocs.ensureDefaults()
    guardDocs.savePolicy({ id: 'guard-policy', version: 2, behavior: 'hold-and-surface', acknowledgeUnguardedEgress: false })
    const guardHolds = new GuardHoldStore(store)
    const todos = new TodoDocuments(store)
    const shared = { store, voice, fabric, mode: () => defaultMeetingMode, guardDocs, guardHolds, guardEnabled: () => true }
    const actor = new Actor({ ...shared, docs, todos })
    const tasks = new TaskExtractor({ ...shared, templates: docs, todos })
    const active = session('ses-act-hold')
    store.saveSession(active)
    store.saveDistillate(distillate(active.id, 'llm'))

    assert.equal(await actor.runFollowUpDraft(active), undefined)
    assert.equal(await tasks.extractForSession(active, taskStep), undefined)
    assert.equal(hosted.prompts.length, 0)
    assert.equal(local.prompts.length, 0)
    assert.equal(guard.prompts.length, 2)
    assert.deepEqual(guardHolds.list('default').map((hold) => hold.stage).sort(), ['follow-up-draft', 'task-extract'])
    for (const hold of guardHolds.list('default')) {
      assert.equal(hold.target?.endpoint, 'hosted-first')
      assert.equal(hold.target?.delivery, undefined)
      assert.equal(hold.classifierDestination, 'device-local')
      assert.deepEqual(hold.sourceChunks, [`chunk-${active.id}`])
    }
    assert.deepEqual(store.listDrafts('default', active.id), [])
    assert.equal(todos.get(active.id), undefined)
  } finally {
    store.close()
    globalThis.fetch = originalFetch
    await stop(hosted)
    await stop(local)
    await stop(guard)
    await rm(dir, { recursive: true, force: true })
  }
})
