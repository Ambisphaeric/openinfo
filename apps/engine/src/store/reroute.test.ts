import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Distillate, Draft, Moment, Session } from '@openinfo/contracts'
import { WorkspaceRegistry } from './workspaces.js'

const dials = { tone: 5, warmth: 5, wit: 5, charm: 5, specificity: 5, brevity: 5 }

function endedSession(id: string, workspaceId: string): Session {
  return {
    id,
    workspaceId,
    modeId: 'mode-meeting',
    startedAt: '2026-07-07T14:00:00Z',
    endedAt: '2026-07-07T15:00:00Z',
    attribution: { evidence: [{ kind: 'window', detail: 'code — repo/api', weight: 0.6 }], confidence: 0.6 },
  }
}

function distillate(id: string, sessionId: string, workspaceId: string): Distillate {
  return {
    id, sessionId, workspaceId,
    windowStart: '2026-07-07T14:00:00Z', windowEnd: '2026-07-07T14:02:00Z',
    sourceChunks: ['chunk-1'], text: 'discussed the SOC 2 addendum with Dana',
    voice: { scope: 'mode', dials }, provenance: { slot: 'llm', endpoint: 'llm.fast' },
    schemaVersion: 1, createdAt: '2026-07-07T14:02:00Z',
  }
}

function moment(id: string, sessionId: string, workspaceId: string, refs: string[]): Moment {
  return {
    id, sessionId, workspaceId, at: '2026-07-07T14:01:00Z', kind: 'decision',
    text: 'ship the addendum Thursday', refs, source: 'mic', confidence: 0.8,
  }
}

function draft(id: string, sessionId: string, workspaceId: string): Draft {
  return {
    id, sessionId, workspaceId, actKind: 'follow-up-draft', body: 'Thanks all — recap below.', status: 'prepared',
    voice: { scope: 'mode', dials },
    provenance: { templateId: 'tpl-followup-default', slot: 'llm', endpoint: 'llm.fast', sourceDistillates: ['dst-1'], sourceMoments: [] },
    schemaVersion: 1, createdAt: '2026-07-07T15:00:01Z',
  }
}

/**
 * Seed workspace `ws-a` with an ended session `ses-1` owning dst-1/mom-1/draft-1, plus three entities:
 *  - Dana: mentioned ONLY by ses-1 (dst-1) → should be DELETED from source, upserted to dest.
 *  - Mercury: mentioned by ses-1 (dst-1) AND ses-2 (dst-2) → source survives at reduced mentions, dest gains 1.
 *  - Zeus: mentioned ONLY by ses-2 (dst-2) → untouched in source, NOT in dest; a mom-1 ref to it is dropped.
 * mom-1 refs both Dana and Zeus, so the move must remap Dana and drop Zeus.
 */
function seed(reg: WorkspaceRegistry) {
  reg.saveSession(endedSession('ses-1', 'ws-a'))
  reg.saveDistillate(distillate('dst-1', 'ses-1', 'ws-a'))
  const dana = reg.upsertEntity({ workspaceId: 'ws-a', kind: 'person', name: 'Dana', seenAt: '2026-07-07T14:02:00Z', provenance: { distillateId: 'dst-1', slot: 'llm', endpoint: 'llm.fast' }, momentRefs: ['mom-1'] })
  reg.upsertEntity({ workspaceId: 'ws-a', kind: 'topic', name: 'Mercury', seenAt: '2026-07-07T14:02:00Z', provenance: { distillateId: 'dst-1', slot: 'llm', endpoint: 'llm.fast' } })
  const mercury = reg.upsertEntity({ workspaceId: 'ws-a', kind: 'topic', name: 'Mercury', seenAt: '2026-07-07T16:00:00Z', provenance: { distillateId: 'dst-2', slot: 'llm', endpoint: 'llm.fast' } })
  const zeus = reg.upsertEntity({ workspaceId: 'ws-a', kind: 'topic', name: 'Zeus', seenAt: '2026-07-07T16:00:00Z', provenance: { distillateId: 'dst-2', slot: 'llm', endpoint: 'llm.fast' } })
  reg.saveMoment(moment('mom-1', 'ses-1', 'ws-a', [dana.id, zeus.id]))
  reg.saveDraft(draft('draft-1', 'ses-1', 'ws-a'))
  return { danaId: dana.id, mercuryId: mercury.id, zeusId: zeus.id }
}

test('moveSession relocates the session + all its records; source emptied, reroutedFrom stamped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-reroute-'))
  try {
    const reg = new WorkspaceRegistry(dir)
    seed(reg)
    reg.ensureWorkspace({ id: 'ws-b', name: 'B' })

    const moved = reg.moveSession('ses-1', 'ws-a', 'ws-b')
    assert.equal(moved.workspaceId, 'ws-b')
    assert.equal(moved.reroutedFrom, 'ws-a')

    // present in destination
    assert.equal(reg.getSession('ws-b', 'ses-1')?.reroutedFrom, 'ws-a')
    assert.deepEqual(reg.listDistillates('ws-b', 'ses-1').map((d) => ({ id: d.id, ws: d.workspaceId })), [{ id: 'dst-1', ws: 'ws-b' }])
    assert.deepEqual(reg.listMoments('ws-b', 'ses-1').map((m) => m.id), ['mom-1'])
    assert.deepEqual(reg.listDrafts('ws-b', 'ses-1').map((d) => ({ id: d.id, ws: d.workspaceId })), [{ id: 'draft-1', ws: 'ws-b' }])

    // absent from source
    assert.equal(reg.getSession('ws-a', 'ses-1'), undefined)
    assert.deepEqual(reg.listDistillates('ws-a', 'ses-1'), [])
    assert.deepEqual(reg.listMoments('ws-a', 'ses-1'), [])
    assert.deepEqual(reg.listDrafts('ws-a', 'ses-1'), [])

    // exactly one copy exists anywhere (no duplicate)
    assert.deepEqual(reg.sessionWorkspaces('ses-1'), ['ws-b'])
    reg.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('moveSession remaps a moment ref to the destination entity and drops a ref with no destination match', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-reroute-'))
  try {
    const reg = new WorkspaceRegistry(dir)
    const { danaId } = seed(reg)
    reg.ensureWorkspace({ id: 'ws-b', name: 'B' })

    reg.moveSession('ses-1', 'ws-a', 'ws-b')

    const destDana = reg.listEntities('ws-b').find((e) => e.name === 'Dana')
    assert.ok(destDana, 'Dana was upserted into the destination')
    assert.notEqual(destDana.id, danaId, 'destination Dana is a fresh record with its own id')

    const movedMoment = reg.listMoments('ws-b', 'ses-1')[0]!
    // Zeus (ws-a-only, did not move) is dropped; Dana is remapped to the destination id
    assert.deepEqual(movedMoment.refs, [destDana.id])
    reg.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('moveSession subtracts source entities, deletes those at zero, keeps a shared entity reduced', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-reroute-'))
  try {
    const reg = new WorkspaceRegistry(dir)
    seed(reg)
    reg.ensureWorkspace({ id: 'ws-b', name: 'B' })

    reg.moveSession('ses-1', 'ws-a', 'ws-b')

    const sourceNames = reg.listEntities('ws-a').map((e) => e.name).sort()
    assert.deepEqual(sourceNames, ['Mercury', 'Zeus'], 'Dana (0 mentions left) deleted from source; Mercury/Zeus remain')

    const sourceMercury = reg.listEntities('ws-a').find((e) => e.name === 'Mercury')!
    assert.equal(sourceMercury.mentions, 1, 'source Mercury lost its ses-1 mention')
    assert.deepEqual(sourceMercury.provenance?.map((p) => p.distillateId), ['dst-2'], 'only the ses-2 provenance survives in source')

    const destMercury = reg.listEntities('ws-b').find((e) => e.name === 'Mercury')!
    assert.equal(destMercury.mentions, 1, 'destination Mercury gained exactly the ses-1 mention')
    assert.deepEqual(destMercury.provenance?.map((p) => p.distillateId), ['dst-1'])

    // Zeus never touched the moved session — untouched in source, absent from destination
    assert.equal(reg.listEntities('ws-a').find((e) => e.name === 'Zeus')?.mentions, 1)
    assert.equal(reg.listEntities('ws-b').find((e) => e.name === 'Zeus'), undefined)
    reg.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('moveSession merges a contribution into an EXISTING destination entity (no duplicate)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-reroute-'))
  try {
    const reg = new WorkspaceRegistry(dir)
    seed(reg)
    // destination already knows Dana from its own prior session
    const destDana = reg.upsertEntity({ workspaceId: 'ws-b', kind: 'person', name: 'Dana', seenAt: '2026-07-06T10:00:00Z', provenance: { distillateId: 'dst-earlier', slot: 'llm', endpoint: 'llm.fast' } })

    reg.moveSession('ses-1', 'ws-a', 'ws-b')

    const danas = reg.listEntities('ws-b').filter((e) => e.kind === 'person' && e.name === 'Dana')
    assert.equal(danas.length, 1, 'merged into the existing record, not duplicated')
    assert.equal(danas[0]!.id, destDana.id)
    assert.equal(danas[0]!.mentions, 2, 'existing mention + the moved one')
    assert.deepEqual(danas[0]!.provenance?.map((p) => p.distillateId).sort(), ['dst-1', 'dst-earlier'])
    reg.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('moveSession is idempotent: re-run after a simulated mid-move crash converges (no double count)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-reroute-'))
  try {
    const reg = new WorkspaceRegistry(dir)
    seed(reg)
    reg.ensureWorkspace({ id: 'ws-b', name: 'B' })

    // crash staged: destination copy committed, source delete never ran
    reg.moveSession('ses-1', 'ws-a', 'ws-b', { stopAfterCopy: true })
    assert.deepEqual(reg.sessionWorkspaces('ses-1').sort(), ['ws-a', 'ws-b'], 'the detectable duplicate')

    // re-running the SAME move converges: source cleaned, one copy, entities not double-counted
    reg.moveSession('ses-1', 'ws-a', 'ws-b')
    assert.deepEqual(reg.sessionWorkspaces('ses-1'), ['ws-b'])
    assert.equal(reg.listEntities('ws-b').find((e) => e.name === 'Dana')?.mentions, 1, 'Dana not double-counted')
    assert.equal(reg.listEntities('ws-b').find((e) => e.name === 'Mercury')?.mentions, 1, 'Mercury not double-counted')
    assert.deepEqual(reg.listMoments('ws-a', 'ses-1'), [])

    // a further re-run on an already-completed move is a harmless no-op
    const again = reg.moveSession('ses-1', 'ws-a', 'ws-b')
    assert.equal(again.workspaceId, 'ws-b')
    assert.deepEqual(reg.sessionWorkspaces('ses-1'), ['ws-b'])
    reg.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('moveSession rejects a move to the same workspace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-reroute-'))
  try {
    const reg = new WorkspaceRegistry(dir)
    seed(reg)
    assert.throws(() => reg.moveSession('ses-1', 'ws-a', 'ws-a'), /same workspace/)
    reg.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
