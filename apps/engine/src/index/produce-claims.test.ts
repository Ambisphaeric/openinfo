import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Moment } from '@openinfo/contracts'
import { WorkspaceRegistry } from '../store/index.js'
import { materializeClaims, ClaimBuildLog } from './produce-claims.js'

/**
 * #178 slice-1 live seam — the store-touching producer that wires the pure builder to the store at session
 * end. These pin the non-negotiables: idempotence (re-running is a no-op), workspace isolation (a build
 * reads/writes only its own workspace), CONTAINED FAILURE (a store error is recorded, never thrown), and the
 * build log surfaces the attempt.
 */

const CLOCK = () => new Date('2026-07-12T13:00:05.000Z')

/** Seed a session with two entities co-mentioned in one moment — the minimal co-occurrence evidence. */
const seedCoOccurrence = (store: WorkspaceRegistry, workspaceId: string, sessionId: string): void => {
  const a = store.upsertEntity({ workspaceId, kind: 'person', name: 'Ada', seenAt: '2026-07-12T13:00:00.000Z' })
  const b = store.upsertEntity({ workspaceId, kind: 'artifact', name: 'pi.dev', seenAt: '2026-07-12T13:00:00.000Z' })
  const moment: Moment = {
    id: `mom-${sessionId}`, sessionId, workspaceId, at: '2026-07-12T13:00:01.000Z', kind: 'mention',
    text: 'Ada is working on pi.dev', refs: [a.id, b.id], source: 'mic', confidence: 0.9,
  }
  store.saveMoment(moment)
}

test('the session-end seam materializes co-occurrence claims from stored evidence, idempotently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-produce-claims-'))
  try {
    const store = new WorkspaceRegistry(dir)
    const log = new ClaimBuildLog()
    seedCoOccurrence(store, 'default', 'ses-1')

    const first = materializeClaims({ store, log, now: CLOCK }, { workspaceId: 'default', sessionId: 'ses-1', trigger: 'session-end' })
    assert.equal(first.error, undefined)
    assert.equal(first.created.length, 1, 'the co-mention yields one claim')
    assert.equal(first.created[0]!.relation, 'co-occurs-with')

    // Idempotent: a second run over the converged session appends nothing.
    const second = materializeClaims({ store, log, now: CLOCK }, { workspaceId: 'default', sessionId: 'ses-1', trigger: 'session-end' })
    assert.equal(second.created.length, 0, 'rebuild over converged evidence is a no-op')
    assert.equal(second.unchanged.length, 1)

    // The build log surfaces the latest attempt (the diagnostics "last update" read).
    const attempt = log.latestFor('default', 'ses-1')
    assert.equal(attempt?.created, 0)
    assert.equal(attempt?.unchanged, 1)
    assert.equal(attempt?.error, undefined)

    assert.equal(store.listClaims('default', { sessionId: 'ses-1' }).length, 1, 'exactly one live claim persisted')
    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a build reads and writes ONLY its own workspace (isolation)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-produce-claims-iso-'))
  try {
    const store = new WorkspaceRegistry(dir)
    store.ensureWorkspace({ id: 'ws-a', name: 'A' })
    store.ensureWorkspace({ id: 'ws-b', name: 'B' })
    seedCoOccurrence(store, 'ws-a', 'ses-a')
    seedCoOccurrence(store, 'ws-b', 'ses-b')

    const a = materializeClaims({ store }, { workspaceId: 'ws-a', sessionId: 'ses-a', trigger: 'session-end' })
    assert.equal(a.created.length, 1)
    assert.equal(store.listClaims('ws-a').length, 1, 'ws-a has its claim')
    assert.equal(store.listClaims('ws-b').length, 0, 'ws-b untouched by the ws-a build')
    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('CONTAINED FAILURE: a store error is caught, recorded on the log, and returned — never thrown', () => {
  const log = new ClaimBuildLog()
  const brokenStore = {
    listContextPackets() { throw new Error('disk gone') },
    listMoments() { return [] },
    listEntities() { return [] },
    listClaims() { return [] },
    saveClaim(c: unknown) { return c },
  } as unknown as WorkspaceRegistry

  const outcome = materializeClaims({ store: brokenStore, log }, { workspaceId: 'default', sessionId: 'ses-1', trigger: 'session-end' })
  assert.equal(outcome.error, 'disk gone', 'the failure is returned, not thrown')
  assert.deepEqual(outcome.created, [])
  const attempt = log.latestFor('default', 'ses-1')
  assert.equal(attempt?.error, 'disk gone', 'the reason is on the log for the diagnostics surface')
})

test('a session with no co-occurrence evidence produces no claims (honest degradation)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-produce-claims-empty-'))
  try {
    const store = new WorkspaceRegistry(dir)
    // One entity mentioned alone — never a relationship.
    const a = store.upsertEntity({ workspaceId: 'default', kind: 'person', name: 'Solo', seenAt: '2026-07-12T13:00:00.000Z' })
    store.saveMoment({ id: 'mom-solo', sessionId: 'ses-1', workspaceId: 'default', at: '2026-07-12T13:00:01.000Z', kind: 'mention', text: 'Solo', refs: [a.id], source: 'mic', confidence: 0.9 })

    const outcome = materializeClaims({ store }, { workspaceId: 'default', sessionId: 'ses-1', trigger: 'session-end' })
    assert.deepEqual(outcome.created, [], 'no pair ⇒ no claim, never fabricated')
    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
