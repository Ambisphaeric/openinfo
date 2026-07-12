import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Bundle } from '@openinfo/contracts'
import { WorkspaceRegistry } from '../store/index.js'
import { BundleDocuments } from './documents.js'
import { DEFAULT_BUNDLE_ID } from './defaults.js'

// The store-backed write/read seam the GET/PUT /bundles routes bind to. Proves the versioning, the seeded
// Standard App enumerating, the get()/list() code fallbacks, and the Tier-A validation gate at write time
// (mirrors workflow/documents.test.ts).

const withDocs = async (fn: (docs: BundleDocuments) => void | Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-bundle-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const docs = new BundleDocuments(store)
    docs.ensureDefaults()
    await fn(docs)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
}

test('list() contains the seeded Standard App after ensureDefaults', async () => {
  await withDocs((docs) => {
    const ids = docs.list().map((b) => b.id)
    assert.deepEqual(ids, [DEFAULT_BUNDLE_ID])
  })
})

test('get() reads the seeded Standard App; an unknown id is undefined', async () => {
  await withDocs((docs) => {
    const standard = docs.get(DEFAULT_BUNDLE_ID)!
    assert.equal(standard.version, 1)
    assert.equal(standard.faces[0]!.kind, 'hud')
    assert.equal(docs.get('bundle-nope'), undefined)
  })
})

test('list()/get() fall back to the code default even against a never-seeded store', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-bundle-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const docs = new BundleDocuments(store) // NO ensureDefaults — the defensive fallback path
    assert.equal(docs.get(DEFAULT_BUNDLE_ID)!.id, DEFAULT_BUNDLE_ID, 'get() falls back to the code default')
    assert.deepEqual(docs.list().map((b) => b.id), [DEFAULT_BUNDLE_ID], 'list() unshifts the code default')
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('save() stamps the next version, preserves history, and get() reads the edit back', async () => {
  await withDocs((docs) => {
    const current = docs.get(DEFAULT_BUNDLE_ID)!
    assert.equal(current.version, 1)
    const edited: Bundle = { ...current, description: 'edited posture' }
    const saved = docs.save(edited)
    assert.equal(saved.version, 2, 'version bumped off the latest stored, not the caller-supplied value')
    assert.equal(docs.get(DEFAULT_BUNDLE_ID)!.description, 'edited posture')
  })
})

test('save() ignores a caller-supplied version and always bumps off the store', async () => {
  await withDocs((docs) => {
    const current = docs.get(DEFAULT_BUNDLE_ID)!
    const saved = docs.save({ ...current, version: 999 })
    assert.equal(saved.version, 2)
  })
})

test('save() rejects an unknown face kind at write time (the Tier-A gate)', async () => {
  await withDocs((docs) => {
    const current = docs.get(DEFAULT_BUNDLE_ID)!
    // face `kind` is a CLOSED union — a `sidebar` face has no shell role, so it must be refused at write
    // time rather than persisted as an unopenable face.
    const bad = { ...current, faces: [{ kind: 'sidebar', surfaceRef: 's' }] } as unknown as Bundle
    assert.throws(() => docs.save(bad), /contract validation/)
    assert.equal(docs.get(DEFAULT_BUNDLE_ID)!.version, 1, 'nothing was written — the seeded default is untouched')
  })
})

test('save() creates a brand-new named bundle (PUT-unknown-id create semantics)', async () => {
  await withDocs((docs) => {
    assert.equal(docs.get('bundle-custom'), undefined)
    const standard = docs.get(DEFAULT_BUNDLE_ID)!
    const created = docs.save({ ...standard, id: 'bundle-custom', name: 'My App' })
    assert.equal(created.version, 1, 'a first write to a new id stamps version 1')
    assert.equal(docs.get('bundle-custom')!.name, 'My App')
    assert.deepEqual(docs.list().map((b) => b.id).sort(), ['bundle-custom', DEFAULT_BUNDLE_ID].sort())
  })
})
