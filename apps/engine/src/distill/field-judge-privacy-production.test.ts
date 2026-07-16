import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { CaptureChunk, FieldValue, Session } from '@openinfo/contracts'
import { FIELD_VALUE_SCHEMA_VERSION } from '@openinfo/contracts'
import { WorkspaceRegistry } from '../store/index.js'
import { VoiceDocuments } from '../voice/index.js'
import { FabricDocuments, defaultFabric } from '../fabric/index.js'
import { GuardDocuments, GuardHoldStore } from '../guard/index.js'
import { DistillDocuments } from './documents.js'
import { FieldValueStore } from './field-values.js'
import { FastFieldScheduler } from './fields.js'
import { JudgeScheduler } from './judge.js'

interface FakeChat { server: Server; url: string; prompts: string[] }

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

const session: Session = {
  id: 'ses-field-judge-privacy', workspaceId: 'default', modeId: 'mode-meeting', startedAt: '2026-07-14T13:00:00.000Z',
  attribution: { evidence: [{ kind: 'manual', detail: 'privacy seam', weight: 1 }], confidence: 1 },
}

const material: CaptureChunk = {
  id: 'chunk-field-judge-privacy', sessionId: session.id, workspaceId: session.workspaceId, source: 'mic', sequence: 1,
  capturedAt: '2026-07-14T13:00:05.000Z', contentType: 'text/plain', encoding: 'utf8',
  data: 'Dana agreed to send Priya the Q3 contract deck by Friday and schedule a security review next week.',
}

const targetReply = (prompt: string): string => {
  if (prompt.includes('JSON object:')) return '{"nature":"meeting","direction":"mixed","topics":["Q3 contract"]}'
  if (prompt.includes('JSON array of verdicts:')) {
    return JSON.stringify([
      { fieldId: 'field-topic', verdict: 'confirm' },
      { fieldId: 'field-entities', verdict: 'confirm' },
      { fieldId: 'field-work-items', verdict: 'confirm' },
    ])
  }
  return 'field answer'
}

test('production fast fields + judge/orientation persist actual hosted and device-local guard provenance', async () => {
  const target = await startChat(targetReply)
  const guard = await startChat(() => '{"flagged":[]}')
  const documentedHosted = `http://field-judge.egress.test:${new URL(target.url).port}`
  const originalFetch = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (raw.startsWith(documentedHosted)) return originalFetch(`${target.url}${raw.slice(documentedHosted.length)}`, init)
    return originalFetch(input, init)
  }) as typeof fetch
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-field-judge-production-'))
  const store = new WorkspaceRegistry(dir)
  try {
    store.saveSession(session)
    const voice = new VoiceDocuments(store); voice.ensureDefaults()
    const docs = new DistillDocuments(store); docs.ensureDefaults()
    const fabric = new FabricDocuments(store)
    fabric.save({ slots: { ...defaultFabric().slots,
      llm: [{ kind: 'http', name: 'llm.judge', url: documentedHosted, api: 'openai-compat', model: 'judge-model' }],
      guard: [{ kind: 'http', name: 'guard.local', url: guard.url, api: 'openai-compat' }],
    } })
    const values = new FieldValueStore(store)
    const guardDocs = new GuardDocuments(store); guardDocs.ensureDefaults()
    const guardHolds = new GuardHoldStore(store)
    const shared = { store, fabric, docs, values, guardDocs, guardHolds, guardEnabled: () => true }
    const fields = new FastFieldScheduler({ ...shared, voice })
    const judge = new JudgeScheduler(shared)

    const fieldResults = await fields.runFields([material])
    assert.equal(fieldResults.length, 3)
    assert.equal(target.prompts.length, 3)
    assert.equal(guard.prompts.length, 3)
    for (const value of fieldResults) {
      assert.equal(value.provenance.endpoint, 'llm.judge')
      assert.equal(value.provenance.egress?.destination, 'hosted-public')
      assert.equal(value.provenance.guard?.outcome, 'clean')
      assert.equal(value.provenance.guard?.classifierDestination, 'device-local')
    }

    const reviewed = await judge.runJudge([material])
    assert.equal(reviewed.length, 3)
    assert.equal(target.prompts.length, 5, 'three fields + verdict judge + orientation')
    assert.equal(guard.prompts.length, 5)
    for (const value of values.list('default', session.id)) {
      assert.equal(value.provenance.judge?.endpoint, 'llm.judge')
      assert.equal(value.provenance.judge?.egress?.destination, 'hosted-public')
      assert.equal(value.provenance.judge?.guard?.classifierDestination, 'device-local')
      assert.deepEqual(value.provenance.judge?.sourceChunks, [material.id])
    }
    const annotation = judge.latestAnnotation('default', session.id)
    assert.equal(annotation?.provenance.endpoint, 'llm.judge')
    assert.equal(annotation?.provenance.egress?.destination, 'hosted-public')
    assert.equal(annotation?.provenance.guard?.classifierDestination, 'device-local')
    assert.deepEqual(annotation?.provenance.sourceChunks, [material.id])
    assert.deepEqual(guardHolds.list('default'), [])
  } finally {
    store.close()
    globalThis.fetch = originalFetch
    await stop(target)
    await stop(guard)
    await rm(dir, { recursive: true, force: true })
  }
})

test('production strict guard creates one hosted-zero hold per field, judge, and orientation attempt', async () => {
  const target = await startChat(() => 'must not run')
  const guard = await startChat(() => '{"flagged":[{"start":0,"length":4,"kind":"secret"}]}')
  const documentedHosted = `http://field-judge-hold.egress.test:${new URL(target.url).port}`
  const originalFetch = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (raw.startsWith(documentedHosted)) return originalFetch(`${target.url}${raw.slice(documentedHosted.length)}`, init)
    return originalFetch(input, init)
  }) as typeof fetch
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-field-judge-holds-'))
  const store = new WorkspaceRegistry(dir)
  try {
    store.saveSession(session)
    const voice = new VoiceDocuments(store); voice.ensureDefaults()
    const docs = new DistillDocuments(store); docs.ensureDefaults()
    const fabric = new FabricDocuments(store)
    fabric.save({ slots: { ...defaultFabric().slots,
      llm: [{ kind: 'http', name: 'llm.judge', url: documentedHosted, api: 'openai-compat' }],
      guard: [{ kind: 'http', name: 'guard.local', url: guard.url, api: 'openai-compat' }],
    } })
    const values = new FieldValueStore(store)
    const guardDocs = new GuardDocuments(store); guardDocs.ensureDefaults()
    guardDocs.savePolicy({ id: 'guard-policy', version: 2, behavior: 'hold-and-surface', acknowledgeUnguardedEgress: false })
    const guardHolds = new GuardHoldStore(store)
    const shared = { store, fabric, docs, values, guardDocs, guardHolds, guardEnabled: () => true }
    const fields = new FastFieldScheduler({ ...shared, voice })
    const judge = new JudgeScheduler(shared)

    assert.deepEqual(await fields.runFields([material]), [])
    assert.equal(target.prompts.length, 0)
    assert.equal(guard.prompts.length, 3)

    const provisional: FieldValue = {
      id: FieldValueStore.idFor('default', 'field-topic', session.id), fieldId: 'field-topic', workspaceId: 'default', sessionId: session.id,
      label: 'topic', value: 'Q3 contract', state: 'provisional',
      provenance: { templateId: 'tpl-field-topic', slot: 'llm', endpoint: 'seed', sourceChunks: [material.id] },
      updatedAt: '2026-07-14T13:00:06.000Z', schemaVersion: FIELD_VALUE_SCHEMA_VERSION,
    }
    values.put(provisional)
    assert.deepEqual(await judge.runJudge([material]), [])
    assert.equal(target.prompts.length, 0)
    assert.equal(guard.prompts.length, 5)
    assert.deepEqual(guardHolds.list('default').map((hold) => hold.stage).sort(), [
      'field:field-entities', 'field:field-topic', 'field:field-work-items', 'judge:tpl-judge-default', 'orientation:tpl-judge-orientation',
    ])
    for (const hold of guardHolds.list('default')) {
      assert.equal(hold.target?.endpoint, 'llm.judge')
      assert.equal(hold.target?.delivery, undefined)
      assert.equal(hold.classifierDestination, 'device-local')
      assert.deepEqual(hold.sourceChunks, [material.id])
    }
  } finally {
    store.close()
    globalThis.fetch = originalFetch
    await stop(target)
    await stop(guard)
    await rm(dir, { recursive: true, force: true })
  }
})
