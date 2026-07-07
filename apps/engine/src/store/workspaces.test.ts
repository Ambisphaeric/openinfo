import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WorkspaceRegistry } from './workspaces.js'

test('workspace registry creates one sqlite file per workspace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-store-'))
  try {
    const registry = new WorkspaceRegistry(dir)
    const workspace = registry.ensureWorkspace({ id: 'sales', name: 'Sales' })
    assert.equal(workspace.dbFile, 'sales.db')
    assert.ok(existsSync(join(dir, '_meta.db')))
    assert.ok(existsSync(join(dir, 'default.db')))
    assert.ok(existsSync(join(dir, 'sales.db')))
    assert.deepEqual(registry.all().map((entry) => entry.id), ['default', 'sales'])
    registry.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('upsertEntity resolves the same entity across windows into ONE record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-entities-'))
  try {
    const registry = new WorkspaceRegistry(dir)

    // window 1: "Dana" — created, mentions 1
    const first = registry.upsertEntity({
      workspaceId: 'ws-ent', kind: 'person', name: 'Dana', seenAt: '2026-07-07T14:00:00Z',
      provenance: { distillateId: 'dst-1', slot: 'llm', endpoint: 'llm.fast' },
      momentRefs: ['mom-1'],
    })
    assert.equal(first.mentions, 1)
    assert.equal(first.firstSeen, '2026-07-07T14:00:00Z')

    // window 2: "dana" (case/whitespace-insensitive match) with a new alias — merged, mentions 2
    const second = registry.upsertEntity({
      workspaceId: 'ws-ent', kind: 'person', name: '  dana ', aliases: ['Dana Cruz'], seenAt: '2026-07-07T14:45:00Z',
      provenance: { distillateId: 'dst-2', slot: 'llm', endpoint: 'llm.fast' },
      momentRefs: ['mom-2', 'mom-1'],
    })
    assert.equal(second.id, first.id)
    assert.equal(second.mentions, 2)
    assert.equal(second.name, 'Dana') // canonical name stays; the variant is not duplicated
    assert.deepEqual(second.aliases, ['Dana Cruz'])
    assert.equal(second.firstSeen, '2026-07-07T14:00:00Z')
    assert.equal(second.lastSeen, '2026-07-07T14:45:00Z')
    assert.deepEqual(second.momentRefs, ['mom-1', 'mom-2']) // unioned, no dupes
    assert.deepEqual(second.provenance?.map((p) => p.distillateId), ['dst-1', 'dst-2']) // full trail

    // window 3: mention via the ALIAS resolves to the same record
    const third = registry.upsertEntity({
      workspaceId: 'ws-ent', kind: 'person', name: 'dana cruz', seenAt: '2026-07-07T15:00:00Z',
    })
    assert.equal(third.id, first.id)
    assert.equal(third.mentions, 3)

    // same name, DIFFERENT KIND is a different entity (a topic "dana" is a distinct record)
    const topic = registry.upsertEntity({
      workspaceId: 'ws-ent', kind: 'topic', name: 'Dana', seenAt: '2026-07-07T15:00:00Z',
    })
    assert.notEqual(topic.id, first.id)

    assert.equal(registry.listEntities('ws-ent').length, 2)
    registry.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('addEntityMomentRefs appends refs; unknown entity is undefined', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-entities-'))
  try {
    const registry = new WorkspaceRegistry(dir)
    const entity = registry.upsertEntity({
      workspaceId: 'ws-ent', kind: 'artifact', name: 'SOC 2 addendum', seenAt: '2026-07-07T14:00:00Z', momentRefs: ['mom-1'],
    })
    const updated = registry.addEntityMomentRefs('ws-ent', entity.id, ['mom-2', 'mom-1'])
    assert.deepEqual(updated?.momentRefs, ['mom-1', 'mom-2'])
    assert.equal(registry.addEntityMomentRefs('ws-ent', 'ent-nowhere', ['mom-9']), undefined)
    registry.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
