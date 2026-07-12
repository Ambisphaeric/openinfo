import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WorkspaceRegistry } from '../store/index.js'
import { SurfaceDocuments } from '../surfaces/index.js'
import { WorkflowDocuments } from '../workflow/index.js'
import { DistillDocuments } from '../distill/index.js'
import { ActDocuments } from '../act/index.js'
import { loadDefaultFlags } from '../api/defaults.js'
import { BundleDocuments } from './documents.js'
import { DEFAULT_BUNDLE_ID } from './defaults.js'

// The seeded Standard App is the FIRST real bundle instance — its whole job is to prove the contract by
// composing EXISTING organs, not dangling refs. These tests boot the same store-backed doc modules
// createEngineApp wires and assert every reference the seed carries resolves to an organ the engine
// actually serves: a ref to a surface/workflow/template that does not exist would be a broken app that
// listed a face opening nothing.

const withOrgans = async (
  fn: (o: { bundles: BundleDocuments; surfaces: SurfaceDocuments; workflow: WorkflowDocuments; distill: DistillDocuments }) => void,
): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-seed-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const bundles = new BundleDocuments(store)
    const surfaces = new SurfaceDocuments(store)
    const workflow = new WorkflowDocuments(store)
    const distill = new DistillDocuments(store)
    // Act templates (tpl-followup-default …) live under the SAME `prompt-template` store kind distill reads,
    // seeded by ActDocuments — so seed it too, exactly as createEngineApp does, for the templateRef check.
    const act = new ActDocuments(store)
    bundles.ensureDefaults()
    surfaces.ensureDefaults()
    workflow.ensureDefaults()
    distill.ensureDefaults()
    act.ensureDefaults()
    fn({ bundles, surfaces, workflow, distill })
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
}

test('the seeded Standard App presents a hud, a chat, and at least one support face', async () => {
  await withOrgans(({ bundles }) => {
    const standard = bundles.get(DEFAULT_BUNDLE_ID)!
    const kinds = standard.faces.map((f) => f.kind)
    assert.equal(kinds.filter((k) => k === 'hud').length, 1, 'exactly one hud face (the pill)')
    assert.equal(kinds.filter((k) => k === 'chat').length, 1, 'exactly one chat face')
    assert.ok(kinds.filter((k) => k === 'support').length >= 1, 'at least one support face')
    assert.equal(kinds[0], 'hud', 'hud first by convention')
  })
})

test('every face surfaceRef maps to a surface the engine serves (no face opens nothing)', async () => {
  await withOrgans(({ bundles, surfaces }) => {
    const served = new Set(surfaces.list().map((s) => s.id))
    const standard = bundles.get(DEFAULT_BUNDLE_ID)!
    for (const face of standard.faces) {
      assert.ok(served.has(face.surfaceRef), `face ${face.kind} → ${face.surfaceRef} references a served surface`)
    }
  })
})

test('workflowRef + every templateRef resolve to existing documents', async () => {
  await withOrgans(({ bundles, workflow, distill }) => {
    const standard = bundles.get(DEFAULT_BUNDLE_ID)!
    assert.ok(standard.workflowRef, 'the Standard App names a workflow')
    assert.ok(workflow.get(standard.workflowRef!), `workflowRef ${standard.workflowRef} resolves`)
    for (const ref of standard.templateRefs ?? []) {
      assert.ok(distill.templateById(ref), `templateRef ${ref} resolves to a seeded template`)
    }
  })
})

test('every flag-overlay key is a real shipped flag key', async () => {
  await withOrgans(({ bundles }) => {
    const known = new Set(loadDefaultFlags().map((f) => f.key))
    const standard = bundles.get(DEFAULT_BUNDLE_ID)!
    for (const key of Object.keys(standard.flags ?? {})) {
      assert.ok(known.has(key), `flag overlay key ${key} is a real flag`)
    }
  })
})

test('the chat context-assembly declares all seven sources (honest, complete plan)', async () => {
  await withOrgans(({ bundles }) => {
    const standard = bundles.get(DEFAULT_BUNDLE_ID)!
    const kinds = new Set((standard.chat?.sources ?? []).map((s) => s.kind))
    assert.deepEqual(
      [...kinds].sort(),
      ['active-preset', 'attached-docs', 'bundle-prompt', 'insights', 'recent-turns', 'relevant-entities', 'transcript-window'],
      'all seven declared chat context sources are present',
    )
  })
})
