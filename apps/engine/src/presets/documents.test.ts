import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PromptTemplate } from '@openinfo/contracts'
import { WorkspaceRegistry } from '../store/index.js'
import { PresetDocuments } from './documents.js'
import { defaultPresets } from './defaults.js'

const withStore = async (fn: (store: WorkspaceRegistry, presets: PresetDocuments) => void | Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-presets-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const presets = new PresetDocuments(store)
    presets.ensureDefaults()
    await fn(store, presets)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
}

test('pill P2: the five shipped presets seed as preset-kind prompt-template documents', async () => {
  await withStore((_store, presets) => {
    const list = presets.list()
    assert.deepEqual(
      list.map((p) => p.id).sort(),
      ['preset-meetings', 'preset-recruiting', 'preset-sales', 'preset-school', 'preset-support'],
      'exactly the five glass-parity presets',
    )
    assert.ok(list.every((p) => p.kind === 'preset'), 'every one is kind preset')
    // Bodies ship SIMPLE (#130): short, one-sentence, no baked voice dials.
    assert.ok(list.every((p) => !/\{\{(tone|warmth|wit|charm|specificity|brevity|voice\.rules)\}\}/.test(p.body)), 'no baked voice vector')
    assert.ok(list.every((p) => p.body.length > 0 && p.body.length < 240), 'neutral and short')
  })
})

test('pill P2: get resolves store-first + code fallback, and guards on kind preset', async () => {
  await withStore((store, presets) => {
    assert.equal(presets.get('preset-sales')?.name, 'Sales', 'resolves a seeded preset')
    assert.equal(presets.isPreset('preset-sales'), true)
    assert.equal(presets.isPreset('does-not-exist'), false, 'unknown id is not a preset')
    // A non-preset prompt-template (same store kind) is NOT a preset — the kind guard holds.
    store.layouts.put('prompt-template', 'tpl-distill-default', {
      id: 'tpl-distill-default', name: 'distill-default', kind: 'distill', slot: 'llm', body: 'x',
    } satisfies PromptTemplate)
    assert.equal(presets.isPreset('tpl-distill-default'), false, 'an ordinary template is never a preset')
    assert.equal(presets.get('tpl-distill-default'), undefined)
  })
})

test('pill P2: resolveActive is the narrow read — unset undefined, set resolves, deleted degrades', async () => {
  await withStore((store, presets) => {
    assert.equal(presets.resolveActive('default'), undefined, 'unset ⇒ undefined (no injection)')
    presets.setActive('default', 'preset-school')
    assert.equal(presets.resolveActive('default')?.id, 'preset-school', 'set ⇒ the preset resolves')
    assert.equal(store.getActivePreset('default'), 'preset-school', 'the raw store seam agrees')
    // A dangling selection (preset id that resolves to nothing) degrades to no-injection, never throws.
    store.setActivePreset('default', 'preset-gone')
    assert.equal(presets.resolveActive('default'), undefined, 'a dangling selection degrades to undefined')
    presets.setActive('default', undefined)
    assert.equal(presets.resolveActive('default'), undefined, 'cleared ⇒ undefined')
  })
})

test('pill P2: a user edit over the /templates substrate is never clobbered by ensureDefaults', async () => {
  await withStore((store, presets) => {
    // Simulate an edit landing via PUT /templates/:id (saveTemplate → layouts.put), then re-seed.
    const edited: PromptTemplate = { ...defaultPresets[1]!, body: 'Context: my customized meetings preset.' }
    store.layouts.put('prompt-template', edited.id, edited)
    presets.ensureDefaults()
    assert.equal(presets.get('preset-meetings')?.body, 'Context: my customized meetings preset.', 'edit survives re-seed')
  })
})
