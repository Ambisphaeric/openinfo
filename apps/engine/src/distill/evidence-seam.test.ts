import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk } from '@openinfo/contracts'
import { FabricDocuments, defaultFabric } from '../fabric/index.js'
import { WorkspaceRegistry } from '../store/index.js'
import { VoiceDocuments } from '../voice/index.js'
import { Distiller } from './distiller.js'
import { DistillDocuments } from './documents.js'

/**
 * #91 — ENTITY EVIDENCE population at the distiller seam, driven through the REAL Distiller + REAL invokeLlm
 * against a fake HTTP endpoint (no injected invoke). The #73 evidence (a `heard` sighting tied to the
 * distillate + a `stt` heardAs per resolved mention) and the #74 crossSighting wiring (heard + same-window
 * OCR → a `seen` sighting recorded, the record promoted to confirmed, the ASR surface taught as a heardAs)
 * were previously covered only below/above this seam (store merge; resolver) or by an injected-invoke e2e.
 * These drive the WHOLE pass through the HTTP invoke path the production drain uses.
 */

interface FakeLlm {
  server: Server
  url: string
}
const startFakeLlm = async (reply: (prompt: string) => string): Promise<FakeLlm> => {
  const server = createServer((req, res) => {
    const bufs: Buffer[] = []
    req.on('data', (c: Buffer) => bufs.push(c))
    req.on('end', () => {
      let prompt = ''
      try {
        const body = JSON.parse(Buffer.concat(bufs).toString('utf8')) as { messages: { content: string }[] }
        prompt = body.messages.map((m) => m.content).join('\n')
      } catch {
        /* empty prompt is fine */
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply(prompt) } }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}` }
}
const stop = (llm: FakeLlm): Promise<void> => new Promise((resolve) => llm.server.close(() => resolve()))

const chunk = (sequence: number, sec: number, data: string): CaptureChunk => ({
  id: `chunk-${sequence}`,
  sessionId: 'ses-ev',
  workspaceId: 'ws-ev',
  source: 'mic',
  sequence,
  capturedAt: new Date(Date.UTC(2026, 6, 10, 14, 0, sec)).toISOString(),
  contentType: 'text/plain',
  encoding: 'utf8',
  data,
})

const makeRig = async (): Promise<{ dir: string; store: WorkspaceRegistry; deps: { store: WorkspaceRegistry; voice: VoiceDocuments; docs: DistillDocuments; fabric: FabricDocuments } }> => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-evidence-seam-'))
  const store = new WorkspaceRegistry(dir)
  const voice = new VoiceDocuments(store)
  voice.ensureDefaults()
  const docs = new DistillDocuments(store)
  docs.ensureDefaults()
  const fabric = new FabricDocuments(store)
  return { dir, store, deps: { store, voice, docs, fabric } }
}

test('seam: a resolved mention writes a heard sighting with the WINDOW-derived timestamp and a stt heardAs', async () => {
  const llm = await startFakeLlm((prompt) =>
    prompt.includes('JSON array of entities') ? '[{"kind": "person", "name": "Dana"}]' : 'SUMMARY: Dana joined.',
  )
  const { dir, store, deps } = await makeRig()
  try {
    deps.fabric.save({ slots: { ...defaultFabric().slots, llm: [{ kind: 'http', name: 'llm.local', url: llm.url, api: 'openai-compat' }] } })
    const produced = await new Distiller({ ...deps }).distillChunks(
      [chunk(1, 0, 'Dana joined the call'), chunk(2, 4, 'welcome Dana')],
      { extractEntities: true },
    )
    assert.equal(produced.length, 1)
    const distillate = produced[0]!

    const dana = store.listEntities('ws-ev').find((e) => e.name === 'Dana')
    assert.ok(dana, 'the mention resolved to a record')
    // The #73 heard sighting: via 'heard', tied to THIS distillate, timestamped from the window (not now()).
    const heard = (dana!.sightings ?? []).find((s) => s.via === 'heard')
    assert.ok(heard, 'a heard sighting was recorded')
    assert.equal(heard!.at, distillate.windowEnd, 'the sighting timestamp is the window end, not wall-clock')
    assert.equal(heard!.distillateId, distillate.id, 'the sighting is tied to the producing distillate')
    // The #73 stt heardAs: the surface form that resolved here, disclosed as an ASR variant.
    const heardAs = (dana!.heardAs ?? []).find((h) => h.text === 'Dana')
    assert.ok(heardAs, 'the surface form was recorded as a heardAs variant')
    assert.equal(heardAs!.source, 'stt')
    assert.equal(heardAs!.at, distillate.windowEnd)
  } finally {
    await stop(llm)
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('seam: #74 crossSighting — a heard mangle + same-window OCR records a seen sighting, confirms, and teaches the alias', async () => {
  // The entities prompt emits the ASR-mangled "pie dev"; everything else is the summary.
  const llm = await startFakeLlm((prompt) =>
    prompt.includes('JSON array of entities') ? '[{"kind": "artifact", "name": "pie dev"}]' : 'SUMMARY: they discussed the pie dev PR.',
  )
  const { dir, store, deps } = await makeRig()
  try {
    deps.fabric.save({ slots: { ...defaultFabric().slots, llm: [{ kind: 'http', name: 'llm.local', url: llm.url, api: 'openai-compat' }] } })

    // The corpus already knows the repo `pi.dev`; the same string is on screen inside the audio window.
    store.upsertEntity({ workspaceId: 'ws-ev', kind: 'artifact', name: 'pi.dev', seenAt: '2026-07-09T13:00:00Z' })
    store.saveOcrResult({
      id: 'ocr-ev', sessionId: 'ses-ev', workspaceId: 'ws-ev', sourceChunks: ['frame-1'],
      text: 'acme/pi.dev · Pull requests · #218 retry backoff',
      provenance: { slot: 'ocr', endpoint: 'ocr.local' },
      schemaVersion: 1, createdAt: '2026-07-10T14:00:06Z', capturedAt: '2026-07-10T14:00:04Z',
    })

    const produced = await new Distiller({ ...deps }).distillChunks(
      [chunk(1, 0, 'can you check the pie dev PR'), chunk(2, 4, 'yeah on it')],
      { extractEntities: true },
    )
    const distillate = produced[0]!

    const piDev = store.listEntities('ws-ev').find((e) => e.name === 'pi.dev')
    assert.ok(piDev, 'the mangled mention resolved to the corpus pi.dev record')
    assert.equal(piDev!.state, 'confirmed', 'cross-source corroboration confirmed it with no user ask')
    // Both senses on the evidence trail — the heard sighting AND the correlated seen sighting.
    const senses = new Set((piDev!.sightings ?? []).map((s) => s.via))
    assert.ok(senses.has('heard'), 'the transcript sighting')
    assert.ok(senses.has('seen'), 'the #74 correlated screen sighting')
    const seen = (piDev!.sightings ?? []).find((s) => s.via === 'seen')
    assert.ok(seen, 'a seen sighting was appended')
    // The ASR-mangled surface form was taught as a heardAs alias, tied to the window.
    const taught = (piDev!.heardAs ?? []).find((h) => h.text === 'pie dev')
    assert.ok(taught, 'the mangled surface form was taught')
    assert.equal(taught!.at, distillate.windowEnd)
  } finally {
    await stop(llm)
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
