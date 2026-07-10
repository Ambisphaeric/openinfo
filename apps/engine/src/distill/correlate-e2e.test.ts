import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk } from '@openinfo/contracts'
import { FabricDocuments, defaultFabric } from '../fabric/index.js'
import { WorkspaceRegistry } from '../store/index.js'
import { VoiceDocuments } from '../voice/index.js'
import { Distiller, type LlmInvoke } from './distiller.js'
import { DistillDocuments } from './documents.js'

const chunk = (sequence: number, sec: number, data: string): CaptureChunk => ({
  id: `chunk-${sequence}`,
  sessionId: 'ses-x',
  workspaceId: 'ws-x',
  source: 'system-audio',
  sequence,
  capturedAt: new Date(Date.UTC(2026, 6, 7, 14, 0, sec)).toISOString(),
  contentType: 'text/plain',
  encoding: 'utf8',
  data,
})

// One fake model, told apart by the prompt: the entities prompt emits the ASR-mangled "pie dev".
const fakeInvoke: LlmInvoke = async (messages) => {
  const prompt = messages[0]!.content
  const text = prompt.includes('JSON array of entities')
    ? '[{"kind": "artifact", "name": "pie dev"}]'
    : prompt.includes('Return ONLY a JSON array')
      ? '[]'
      : 'SUMMARY: they discussed the pie dev PR.'
  return { text, slot: 'llm', endpoint: 'fake.local' }
}

test('distiller: a heard mangle + same-window screen OCR confirms the entity and teaches the alias, end to end (#74)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-xsrc-e2e-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const voice = new VoiceDocuments(store)
    voice.ensureDefaults()
    const docs = new DistillDocuments(store)
    docs.ensureDefaults()
    const fabric = new FabricDocuments(store)
    fabric.save(defaultFabric())

    // Corpus already knows the repo `pi.dev` (learned over prior sessions).
    store.upsertEntity({ workspaceId: 'ws-x', kind: 'artifact', name: 'pi.dev', seenAt: '2026-07-07T13:00:00Z' })

    // The screen: the repo's PR page open in a browser, captured inside the audio window.
    store.saveOcrResult({
      id: 'ocr-x', sessionId: 'ses-x', workspaceId: 'ws-x', sourceChunks: ['frame-1'],
      text: 'acme/pi.dev · Pull requests · #218 retry backoff',
      provenance: { slot: 'ocr', endpoint: 'ocr.local' },
      schemaVersion: 1, createdAt: '2026-07-07T14:00:06Z', capturedAt: '2026-07-07T14:00:04Z',
    })

    const distiller = new Distiller({ store, voice, fabric, docs, invoke: fakeInvoke })
    await distiller.distillChunks(
      [chunk(1, 0, 'can you check the pie dev PR'), chunk(2, 4, 'yeah on it')],
      { extractEntities: true },
    )

    const piDev = store.listEntities('ws-x').find((e) => e.name === 'pi.dev')
    assert.ok(piDev, 'the mangled mention resolved to the corpus pi.dev record')
    // Cross-source corroboration confirmed it with no user ask.
    assert.equal(piDev!.state, 'confirmed')
    // The ASR-mangled surface form was taught as a heard-as alias.
    assert.ok((piDev!.heardAs ?? []).some((h) => h.text === 'pie dev'))
    // The evidence trail carries both senses: heard (the transcript) and seen (the screen).
    const senses = new Set((piDev!.sightings ?? []).map((s) => s.via))
    assert.ok(senses.has('heard'))
    assert.ok(senses.has('seen'))

    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
