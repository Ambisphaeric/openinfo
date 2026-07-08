import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FabricProfile } from '@openinfo/contracts'
import { WorkspaceRegistry } from '../store/index.js'
import { FabricDocuments } from './document.js'
import { seededProfiles } from './defaults.js'

const withStore = async (fn: (store: WorkspaceRegistry) => void): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-profiles-'))
  const store = new WorkspaceRegistry(dir)
  try {
    fn(store)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
}

const sample = (id: string, url: string): FabricProfile => ({
  id,
  name: id,
  version: 1,
  fabric: { slots: { stt: [], tts: [], vlm: [], ocr: [], embed: [], llm: [{ kind: 'http', name: 'x', url, api: 'openai-compat' }] } },
})

test('ensureDefaults seeds the example profiles and leaves them INERT (GET /fabric unchanged)', async () => {
  await withStore((store) => {
    const fabric = new FabricDocuments(store)
    fabric.ensureDefaults()
    const ids = fabric.profiles.list().map((p) => p.id).sort()
    assert.deepEqual(ids, [...seededProfiles].map((p) => p.id).sort())
    // no profile is auto-activated → the live fabric is still the empty/legacy map
    assert.equal(fabric.profiles.activeId(), undefined)
    assert.deepEqual(fabric.load().slots.llm, [])
  })
})

test('save version-bumps monotonically and never clobbers (cloneable history)', async () => {
  await withStore((store) => {
    const profiles = new FabricDocuments(store).profiles
    const v1 = profiles.save(sample('p', 'http://a'))
    assert.equal(v1.version, 1)
    const v2 = profiles.save(sample('p', 'http://b'))
    assert.equal(v2.version, 2)
    assert.equal(profiles.get('p')?.version, 2)
    // createdAt is preserved across saves
    assert.equal(v2.createdAt, v1.createdAt)
  })
})

test('clone copies the map under a new id at version 1 (incl. keyRefs, never values)', async () => {
  await withStore((store) => {
    const profiles = new FabricDocuments(store).profiles
    profiles.save(sample('src', 'http://a'))
    const clone = profiles.clone('src', 'dst', 'My copy')
    assert.ok(clone)
    assert.equal(clone.id, 'dst')
    assert.equal(clone.name, 'My copy')
    assert.equal(clone.version, 1)
    assert.deepEqual(clone.fabric, profiles.get('src')?.fabric)
    assert.equal(profiles.clone('nope', 'x'), undefined)
  })
})

test('activate swaps the live fabric; delete removes; active pointer resolves', async () => {
  await withStore((store) => {
    const fabric = new FabricDocuments(store)
    fabric.profiles.save(sample('local', 'http://local'))
    fabric.profiles.save(sample('remote', 'http://remote'))

    assert.deepEqual(fabric.load().slots.llm, []) // nothing active yet

    fabric.profiles.activate('local')
    assert.equal(fabric.profiles.activeId(), 'local')
    assert.equal((fabric.load().slots.llm[0] as { url: string }).url, 'http://local')

    fabric.profiles.activate('remote')
    assert.equal((fabric.load().slots.llm[0] as { url: string }).url, 'http://remote')

    assert.equal(fabric.profiles.activate('ghost'), undefined) // unknown id → no swap
    assert.equal(fabric.profiles.activeId(), 'remote')

    assert.equal(fabric.profiles.delete('local'), true)
    assert.equal(fabric.profiles.get('local'), undefined)
    assert.equal(fabric.profiles.delete('local'), false)
  })
})

test('PUT /fabric edits the ACTIVE profile in place (the live fabric IS a profile)', async () => {
  await withStore((store) => {
    const fabric = new FabricDocuments(store)
    fabric.profiles.save(sample('p', 'http://old'))
    fabric.profiles.activate('p')

    fabric.save({ slots: { stt: [], tts: [], vlm: [], ocr: [], embed: [], llm: [{ kind: 'http', name: 'x', url: 'http://new', api: 'openai-compat' }] } })

    const p = fabric.profiles.get('p')
    assert.equal((p?.fabric.slots.llm[0] as { url: string }).url, 'http://new')
    assert.equal(p?.version, 2) // edit bumped the active profile's version
  })
})

test('PUT /fabric with NO active profile writes the legacy single doc (backward compat)', async () => {
  await withStore((store) => {
    const fabric = new FabricDocuments(store)
    fabric.save({ slots: { stt: [], tts: [], vlm: [], ocr: [], embed: [], llm: [{ kind: 'http', name: 'x', url: 'http://legacy', api: 'openai-compat' }] } })
    assert.equal((fabric.load().slots.llm[0] as { url: string }).url, 'http://legacy')
    assert.equal(fabric.profiles.list().length, 0) // no profile was created
  })
})
