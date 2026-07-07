import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Moment } from '@openinfo/contracts'
import { WorkspaceRegistry } from '../store/index.js'
import { relevantNow } from './relevant.js'

const moment = (id: string, sessionId: string, at: string, text: string, refs: string[] = []): Moment => ({
  id,
  sessionId,
  workspaceId: 'ws-rel',
  at,
  kind: 'decision',
  text,
  refs,
  source: 'mic',
  confidence: 0.8,
})

test('relevant-now joins ranked entities with the moments that reference them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-relevant-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const now = new Date('2026-07-07T15:00:00Z')

    // "soc 2" mentioned in two windows (mentions 2, fresher); "budget" once, older
    const soc1 = store.upsertEntity({ workspaceId: 'ws-rel', kind: 'topic', name: 'SOC 2', seenAt: '2026-07-07T14:00:00Z' })
    store.saveMoment(moment('mom-1', 'ses-a', '2026-07-07T14:00:00Z', 'SOC 2 addendum agreed', [soc1.id]))
    const soc2 = store.upsertEntity({
      workspaceId: 'ws-rel', kind: 'topic', name: 'soc 2', seenAt: '2026-07-07T14:45:00Z', momentRefs: ['mom-2'],
    })
    assert.equal(soc2.id, soc1.id) // same entity across windows
    store.saveMoment(moment('mom-2', 'ses-b', '2026-07-07T14:45:00Z', 'ship SOC 2 evidence Thursday', [soc2.id]))
    store.addEntityMomentRefs('ws-rel', soc1.id, ['mom-1'])

    const budget = store.upsertEntity({
      workspaceId: 'ws-rel', kind: 'topic', name: 'budget', seenAt: '2026-07-07T09:00:00Z', momentRefs: ['mom-3'],
    })
    store.saveMoment(moment('mom-3', 'ses-a', '2026-07-07T09:00:00Z', 'budget review moved', [budget.id]))

    const rows = relevantNow(store, 'ws-rel', { now })
    assert.deepEqual(rows.map((r) => r.entity.name), ['SOC 2', 'budget'])
    assert.ok(rows[0]!.score > rows[1]!.score)
    // the join: each row carries its referencing moments, most recent first — noise is inspectable
    assert.deepEqual(rows[0]!.moments.map((m) => m.id), ['mom-2', 'mom-1'])
    assert.deepEqual(rows[1]!.moments.map((m) => m.id), ['mom-3'])

    // session scoping: only entities referenced by that session's moments, joining only those
    const sesB = relevantNow(store, 'ws-rel', { now, sessionId: 'ses-b' })
    assert.deepEqual(sesB.map((r) => r.entity.name), ['SOC 2'])
    assert.deepEqual(sesB[0]!.moments.map((m) => m.id), ['mom-2'])

    // limit caps the ranked list
    assert.equal(relevantNow(store, 'ws-rel', { now, limit: 1 }).length, 1)

    // unknown workspace reads as [], not an error (mirrors GET /moments)
    assert.deepEqual(relevantNow(store, 'nowhere', { now }), [])
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
