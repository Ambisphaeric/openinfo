import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk, FocusSignal } from '@openinfo/contracts'
import { FabricDocuments, defaultFabric } from '../fabric/index.js'
import { extractFocusSignals } from '../route/index.js'
import { WorkspaceRegistry } from '../store/index.js'
import { VoiceDocuments } from '../voice/index.js'
import { Distiller } from './distiller.js'
import { DistillDocuments } from './documents.js'

interface FakeLlm { server: Server; url: string; prompts: string[] }
const startFakeLlm = async (): Promise<FakeLlm> => {
  const prompts: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: { content: string }[] }
      prompts.push(body.messages[0]!.content)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'SUMMARY: ship Thursday.' } }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}`, prompts }
}

const FOCUS: FocusSignal = { app: 'Code', windowTitle: 'SECRET-FOCUS-TITLE', repoPath: '/Users/dev/openinfo' }
const speech = (sequence: number, sec: number, data: string): CaptureChunk => ({
  id: `sp-${sequence}`, sessionId: 'ses-mix', workspaceId: 'ws-mix', source: 'mic', sequence,
  capturedAt: new Date(Date.UTC(2026, 6, 7, 14, 0, sec)).toISOString(), contentType: 'text/plain', encoding: 'utf8', data,
})
const focusChunk = (sequence: number, sec: number): CaptureChunk => ({
  id: `fx-${sequence}`, sessionId: 'ses-mix', workspaceId: 'ws-mix', source: 'focus', sequence,
  capturedAt: new Date(Date.UTC(2026, 6, 7, 14, 0, sec)).toISOString(),
  contentType: 'application/json', encoding: 'utf8', data: JSON.stringify(FOCUS),
})

test('distill hygiene: a mixed spool distills ONLY speech; focus never leaks into the transcript, yet the detector sees it', async () => {
  const llm = await startFakeLlm()
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-hygiene-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const voice = new VoiceDocuments(store); voice.ensureDefaults()
    const docs = new DistillDocuments(store); docs.ensureDefaults()
    const fabric = new FabricDocuments(store)
    fabric.save({ slots: { ...defaultFabric().slots, llm: [{ kind: 'http', name: 'llm.fast', url: llm.url, api: 'openai-compat', model: 'llama-3.2-3b' }] } })
    const distiller = new Distiller({ store, voice, fabric, docs })

    // one spool batch: two speech chunks with a focus chunk interleaved between them.
    const mixed = [speech(1, 0, 'we should ship Thursday'), focusChunk(2, 10), speech(3, 20, 'agreed, Thursday it is')]
    const produced = await distiller.distillChunks(mixed)

    // exactly one distillate, built from the two SPEECH chunks only — the focus chunk is not a source.
    assert.equal(produced.length, 1)
    assert.deepEqual(produced[0]!.sourceChunks, ['sp-1', 'sp-3'])

    // the transcript that reached the llm contains the speech and NONE of the focus payload.
    const prompt = llm.prompts[0]!
    assert.match(prompt, /we should ship Thursday/)
    assert.match(prompt, /agreed, Thursday it is/)
    assert.doesNotMatch(prompt, /SECRET-FOCUS-TITLE/)
    assert.doesNotMatch(prompt, /application\/json/)
    assert.doesNotMatch(prompt, /repoPath/)

    // the SAME mixed spool still yields the focus signal for the detector — hygiene routes, not drops.
    const signals = extractFocusSignals(mixed)
    assert.equal(signals.length, 1)
    assert.deepEqual(signals[0]!.signal, FOCUS)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => llm.server.close(() => resolve()))
  }
})
