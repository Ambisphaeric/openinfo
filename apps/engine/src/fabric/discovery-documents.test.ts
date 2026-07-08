import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ProbeList } from '@openinfo/contracts'
import { WorkspaceRegistry } from '../store/index.js'
import { DiscoveryDocuments } from './discovery-documents.js'
import { seededCapabilityMap, seededProbeList } from './discovery-defaults.js'

const withStore = async (fn: (store: WorkspaceRegistry) => void): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-discovery-'))
  const store = new WorkspaceRegistry(dir)
  try {
    fn(store)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
}

test('ensureDefaults seeds the probe list + capability map when absent', async () => {
  await withStore((store) => {
    const docs = new DiscoveryDocuments(store)
    docs.ensureDefaults()
    assert.deepEqual(docs.probeList().probes, seededProbeList.probes)
    assert.equal(docs.capabilityMap().default[0], 'llm')
    assert.equal(docs.capabilityMap().rules.length, seededCapabilityMap.rules.length)
  })
})

test('ensureDefaults never clobbers a user edit; the store keeps versions', async () => {
  await withStore((store) => {
    const docs = new DiscoveryDocuments(store)
    docs.ensureDefaults()
    // a user edits the probe list (nonstandard port) — bumps version
    const edited: ProbeList = { ...seededProbeList, version: 2, probes: [{ name: 'lm-studio', url: 'http://localhost:4321' }] }
    store.layouts.put('discovery-probes', seededProbeList.id, edited)
    // seeding again must not overwrite the edit
    docs.ensureDefaults()
    assert.deepEqual(docs.probeList().probes, [{ name: 'lm-studio', url: 'http://localhost:4321' }])
    // one seed (v1) + one user edit (v2); ensureDefaults did NOT add a version
    assert.equal(store.layouts.getLatest('discovery-probes', seededProbeList.id)!.version, 2)
  })
})
