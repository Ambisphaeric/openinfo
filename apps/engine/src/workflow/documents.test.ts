import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { WorkflowSpec } from '@openinfo/contracts'
import { WorkspaceRegistry } from '../store/index.js'
import { WorkflowDocuments } from './documents.js'
import { DEFAULT_WORKFLOW_ID } from './defaults.js'

// The write half (save/list) the GET/PUT /workflows routes bind to. The read half (active/get) and the
// hot-read seam are exercised by the executor suite + the http e2e; here we prove the store-backed
// versioning, the seeded default enumerating, and the Tier-A validation gate at write time.

const withDocs = async (fn: (docs: WorkflowDocuments) => void | Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-workflow-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const docs = new WorkflowDocuments(store)
    docs.ensureDefaults()
    await fn(docs)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
}

test('list() contains the seeded default after ensureDefaults', async () => {
  await withDocs((docs) => {
    const ids = docs.list().map((w) => w.id)
    assert.deepEqual(ids, [DEFAULT_WORKFLOW_ID])
  })
})

test('save() stamps the next version, preserves history, and get() reads the edit back', async () => {
  await withDocs((docs) => {
    const current = docs.get(DEFAULT_WORKFLOW_ID)!
    assert.equal(current.version, 1)
    // drop the moments step — a legal edit (still minItems 1); the executor reads active() fresh so this
    // would take effect on the next drain with no restart.
    const edited: WorkflowSpec = { ...current, steps: current.steps.filter((s) => s.kind !== 'moments') }
    const saved = docs.save(edited)
    assert.equal(saved.version, 2, 'version bumped off the latest stored, not the caller-supplied value')
    const readBack = docs.get(DEFAULT_WORKFLOW_ID)!
    assert.equal(readBack.version, 2)
    assert.ok(!readBack.steps.some((s) => s.kind === 'moments'), 'the edit landed in the record the executor reads')
  })
})

test('save() ignores a caller-supplied version and always bumps off the store', async () => {
  await withDocs((docs) => {
    const current = docs.get(DEFAULT_WORKFLOW_ID)!
    // a client sending a stale/forged version must not win — the store is the monotonic source of truth
    const saved = docs.save({ ...current, version: 999 })
    assert.equal(saved.version, 2)
  })
})

test('save() rejects an unrunnable step kind at write time (the Tier-A gate)', async () => {
  await withDocs((docs) => {
    const current = docs.get(DEFAULT_WORKFLOW_ID)!
    // `kind` is a CLOSED union — a `foo` step has no executor path, so it must be refused at write time
    // rather than reach the executor as a silent no-op (see WorkflowStepKind).
    const bad = { ...current, steps: [{ id: 'x', kind: 'foo', params: {} }] } as unknown as WorkflowSpec
    assert.throws(() => docs.save(bad), /contract validation/)
    // and nothing was written — the stored default is untouched
    assert.equal(docs.get(DEFAULT_WORKFLOW_ID)!.version, 1)
  })
})

test('save() creates a brand-new named workflow (PUT-unknown-id create semantics)', async () => {
  await withDocs((docs) => {
    assert.equal(docs.get('workflow-custom'), undefined)
    const spec = docs.get(DEFAULT_WORKFLOW_ID)!
    const created = docs.save({ ...spec, id: 'workflow-custom', name: 'my pipeline' })
    assert.equal(created.version, 1, 'a first write to a new id stamps version 1')
    assert.equal(docs.get('workflow-custom')!.name, 'my pipeline')
    assert.deepEqual(docs.list().map((w) => w.id).sort(), ['workflow-custom', DEFAULT_WORKFLOW_ID].sort())
  })
})
