import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Bundle } from '@openinfo/contracts'
import { WorkspaceRegistry } from '../store/index.js'
import { BundleDocuments } from './documents.js'
import { DEFAULT_BUNDLE_ID, PREVIOUS_DEFAULT_BUNDLE_BODIES } from './defaults.js'

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

test('ensureDefaults refreshes an UNEDITED v1 seed to the new shipped plan (the #130 seed-or-refresh, bundle edition)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-bundle-refresh-'))
  const store = new WorkspaceRegistry(dir)
  try {
    // Simulate an OLD install: the store holds the PREVIOUS shipped body (seven chat sources, no `screen`).
    const previous = JSON.parse(PREVIOUS_DEFAULT_BUNDLE_BODIES[0]!) as Bundle
    store.layouts.put('bundle', DEFAULT_BUNDLE_ID, previous)
    const docs = new BundleDocuments(store)
    docs.ensureDefaults()
    const refreshed = docs.get(DEFAULT_BUNDLE_ID)!
    assert.equal(refreshed.version, 2, 'the refresh is itself a versioned put')
    assert.ok(refreshed.chat!.sources.some((s) => s.kind === 'screen'), 'the upgraded plan carries the Ask face screen source')
    // At most once: a second ensureDefaults does not re-bump (v2 no longer matches the previous body).
    docs.ensureDefaults()
    assert.equal(docs.get(DEFAULT_BUNDLE_ID)!.version, 2)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('ensureDefaults NEVER clobbers a user-edited bundle (version off 1, or a diverged body)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-bundle-noclobber-'))
  const store = new WorkspaceRegistry(dir)
  try {
    // A user PUT bumped the version — the plan (which deliberately DROPS sources) must be left untouched.
    const docs = new BundleDocuments(store)
    docs.ensureDefaults()
    const mine = docs.get(DEFAULT_BUNDLE_ID)!
    docs.save({ ...mine, chat: { sources: [{ kind: 'bundle-prompt' }] } })
    docs.ensureDefaults()
    const kept = docs.get(DEFAULT_BUNDLE_ID)!
    assert.equal(kept.version, 2)
    assert.deepEqual(kept.chat!.sources.map((s) => s.kind), ['bundle-prompt'], 'the user-owned plan survives')

    // And a v1 body that DIVERGES from every previous shipped body is conservatively left alone too.
    const store2dir = await mkdtemp(join(tmpdir(), 'openinfo-bundle-noclobber2-'))
    const store2 = new WorkspaceRegistry(store2dir)
    try {
      const diverged = { ...(JSON.parse(PREVIOUS_DEFAULT_BUNDLE_BODIES[0]!) as Bundle), description: 'hand-tuned' }
      store2.layouts.put('bundle', DEFAULT_BUNDLE_ID, diverged)
      const docs2 = new BundleDocuments(store2)
      docs2.ensureDefaults()
      assert.equal(docs2.get(DEFAULT_BUNDLE_ID)!.description, 'hand-tuned', 'a diverged v1 is user-owned — untouched')
    } finally {
      store2.close()
      await rm(store2dir, { recursive: true, force: true })
    }
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
