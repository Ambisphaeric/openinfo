import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { StarterModels } from '@openinfo/contracts'
import { WorkspaceRegistry } from '../store/index.js'
import { StarterModelsDocuments } from './local-documents.js'
import { seededStarterModels } from './local-defaults.js'

const withStore = async (fn: (store: WorkspaceRegistry) => void): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-starter-'))
  const store = new WorkspaceRegistry(dir)
  try {
    fn(store)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
}

test('ensureDefaults seeds the starter-models catalog when absent', async () => {
  await withStore((store) => {
    const docs = new StarterModelsDocuments(store)
    docs.ensureDefaults()
    const models = docs.models()
    assert.equal(models.length, seededStarterModels.models.length)
    assert.ok(models.some((m) => m.slot === 'llm' && m.runtime === 'llama.cpp'))
    assert.ok(models.some((m) => m.slot === 'stt' && m.runtime === 'whisper.cpp'))
    for (const m of models) assert.match(m.url, /^https:\/\//)
  })
})

test('ensureDefaults never clobbers a user edit; the store keeps versions', async () => {
  await withStore((store) => {
    const docs = new StarterModelsDocuments(store)
    docs.ensureDefaults()
    const edited: StarterModels = {
      ...seededStarterModels,
      version: 2,
      models: [
        {
          id: 'my-model', slot: 'llm', runtime: 'llama.cpp', name: 'Mine',
          filename: 'mine.gguf', url: 'https://example.com/mine.gguf', sizeBytes: 1,
        },
      ],
    }
    store.layouts.put('starter-models', seededStarterModels.id, edited)
    docs.ensureDefaults()
    assert.deepEqual(docs.models().map((m) => m.id), ['my-model'])
    assert.equal(store.layouts.getLatest('starter-models', seededStarterModels.id)!.version, 2)
  })
})
