import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Session, TeachSignal } from '@openinfo/contracts'
import { WorkspaceRegistry } from '../store/index.js'
import { EventBus, type EngineEvents } from '../bus/index.js'
import { TeachStore, captureReroute, captureEntityCorrection, deriveHintCandidates } from './signals.js'
import { wireTeach } from './index.js'

const reroutedSession = (over: Partial<Session> = {}): Session => ({
  id: 'ses-1',
  workspaceId: 'ws-oss', // corrected-TO
  modeId: 'mode-meeting',
  startedAt: '2026-07-07T14:00:00Z',
  endedAt: '2026-07-07T15:00:00Z',
  reroutedFrom: 'ws-sales', // the router's wrong guess
  attribution: {
    evidence: [
      { kind: 'window', detail: 'VS Code — openinfo/apps/engine', weight: 0.6 },
      { kind: 'repo', detail: 'github.com/openinfo/openinfo', weight: 0.7 },
      { kind: 'manual', detail: 'rerouted from workspace ws-sales by user', weight: 1 },
    ],
    confidence: 1,
  },
  ...over,
})

test('captureReroute turns a rerouted session into a labeled teach signal', () => {
  const signal = captureReroute(reroutedSession(), '2026-07-07T16:00:00Z')
  assert.ok(signal)
  assert.equal(signal.kind, 'reroute')
  assert.equal(signal.fromWorkspaceId, 'ws-sales')
  assert.equal(signal.toWorkspaceId, 'ws-oss')
  assert.equal(signal.sessionId, 'ses-1')
  assert.equal(signal.correctedAt, '2026-07-07T16:00:00Z')
  assert.equal(signal.id, 'teach-reroute-ses-1') // deterministic in session id
  assert.equal(signal.evidence?.length, 3) // the full router trail, verbatim
})

test('captureReroute ignores a non-rerouted session (no reroutedFrom)', () => {
  const plain = reroutedSession()
  delete (plain as { reroutedFrom?: string }).reroutedFrom
  assert.equal(captureReroute(plain), undefined)
})

test('TeachStore records per corrected-to workspace and is idempotent by signal id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-teach-'))
  try {
    const store = new WorkspaceRegistry(dir)
    const teach = new TeachStore(store)
    const signal = captureReroute(reroutedSession(), '2026-07-07T16:00:00Z')!

    teach.record(signal)
    teach.record(signal) // replay of the SAME reroute — must not double-count
    assert.equal(teach.list('ws-oss').length, 1)
    assert.equal(teach.list('ws-sales').length, 0) // stored under corrected-TO only

    // a second, different reroute into the same workspace accumulates
    teach.record(captureReroute(reroutedSession({ id: 'ses-2' }), '2026-07-07T17:00:00Z')!)
    assert.equal(teach.list('ws-oss').length, 2)
    assert.deepEqual(teach.all().map((s) => s.sessionId).sort(), ['ses-1', 'ses-2'])
    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('deriveHintCandidates maps window/repo evidence to suggested patterns, aggregates support', () => {
  const signals: TeachSignal[] = [
    captureReroute(reroutedSession({ id: 'ses-1' }), '2026-07-07T16:00:00Z')!,
    captureReroute(reroutedSession({ id: 'ses-2' }), '2026-07-07T17:00:00Z')!, // same evidence again
  ]
  const candidates = deriveHintCandidates(signals)
  // window + repo become candidates; the manual reroute marker + any calendar/voice do NOT
  assert.deepEqual(candidates.map((c) => c.pattern.field).sort(), ['repoPath', 'windowTitle'])
  for (const candidate of candidates) {
    assert.equal(candidate.workspaceId, 'ws-oss') // suggested for the corrected-to workspace
    assert.equal(candidate.supportCount, 2) // two reroutes agree
    assert.deepEqual(candidate.sampleSessionIds, ['ses-1', 'ses-2'])
    assert.ok(candidate.pattern.contains && candidate.pattern.contains.length > 0)
  }
})

test('wireTeach captures a session.rerouted bus event into the store, ignores a plain session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-teach-wire-'))
  try {
    const store = new WorkspaceRegistry(dir)
    const bus = new EventBus<EngineEvents>()
    const teach = wireTeach({ bus, store })

    // an ordinary session switch (no reroutedFrom) records nothing
    const plain = reroutedSession()
    delete (plain as { reroutedFrom?: string }).reroutedFrom
    await bus.publish('session.switched', plain)
    assert.equal(teach.list('ws-oss').length, 0)

    // a reroute is captured
    await bus.publish('session.rerouted', reroutedSession())
    assert.equal(teach.list('ws-oss').length, 1)
    assert.equal(teach.list('ws-oss')[0]!.sessionId, 'ses-1')
    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('deriveHintCandidates never suggests a pattern for a field the detector cannot test', () => {
  const signal = captureReroute(
    reroutedSession({
      attribution: {
        evidence: [
          { kind: 'calendar', detail: 'Sales sync', weight: 0.5 },
          { kind: 'voice', detail: 'Dana', weight: 0.4 },
          { kind: 'manual', detail: 'rerouted by user', weight: 1 },
        ],
        confidence: 1,
      },
    }),
    '2026-07-07T16:00:00Z',
  )!
  assert.deepEqual(deriveHintCandidates([signal]), []) // no repoPath/windowTitle evidence ⇒ no candidates
})

test('captureEntityCorrection turns a #75 clarify verdict into a labeled entity-correction signal (pure)', () => {
  const signal = captureEntityCorrection({
    kind: 'alias-confirm', workspaceId: 'ws-eng', entityId: 'ent-polaris', heard: 'Polaris',
    rivalId: 'ent-polaris-pub', rivalName: 'Polaris (public)', pinnedEntityId: 'ent-polaris', at: '2026-07-10T12:00:00Z',
  })
  assert.equal(signal.kind, 'alias-confirm')
  assert.equal(signal.correctedAt, '2026-07-10T12:00:00Z')
  assert.equal(signal.id, 'teach-alias-confirm-ent-polaris-polaris') // deterministic in (kind, entity, heard)
  assert.equal(signal.entity?.workspaceId, 'ws-eng')
  assert.equal(signal.entity?.entityId, 'ent-polaris')
  assert.equal(signal.entity?.heard, 'Polaris')
  assert.equal(signal.entity?.rivalId, 'ent-polaris-pub')
  assert.equal(signal.entity?.pinnedEntityId, 'ent-polaris')
  assert.equal(signal.fromWorkspaceId, undefined) // no reroute semantics
})

test('TeachStore files an entity-correction signal under its entity workspace and reads it back (idempotent)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-teach-ent-'))
  try {
    const registry = new WorkspaceRegistry(dir)
    const store = new TeachStore(registry)
    const signal = captureEntityCorrection({ kind: 'disambiguate', workspaceId: 'ws-eng', entityId: 'ent-x', heard: 'Orion', rivalId: 'ent-y', pinnedEntityId: 'ent-y', at: '2026-07-10T12:00:00Z' })
    store.record(signal)
    store.record(signal) // replay — same id ⇒ dedup, not double-counted
    const listed = store.list('ws-eng')
    assert.equal(listed.length, 1)
    assert.equal(listed[0]!.kind, 'disambiguate')
    assert.equal(listed[0]!.entity?.entityId, 'ent-x')
    // it does NOT leak into the attribution-hint derivation (only reroutes produce candidates)
    assert.deepEqual(deriveHintCandidates(listed), [])
    registry.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
