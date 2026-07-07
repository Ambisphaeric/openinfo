import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk, Distillate, Fabric } from '@openinfo/contracts'
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
      prompts.push(body.messages[0]!.content)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'SUMMARY: they agreed to ship Thursday.' } }] }))
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
    // vector reached the prompt as both raw numbers and compiled rules
    assert.equal(d.voice.registerId, 'reg-boardroom')
    assert.equal(d.voice.scope, 'mode')
    assert.equal(d.voice.dials.charm, 2)
    assert.match(llm.prompts[0]!, /specificity 9\/10/)
    assert.match(llm.prompts[0]!, /we should ship Thursday/)

    assert.equal((await queue.status()).pendingFiles, 0) // file drained after processing
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => llm.server.close(() => resolve()))
  }
})
