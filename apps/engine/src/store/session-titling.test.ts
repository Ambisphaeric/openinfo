import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Session, SessionTitling } from '@openinfo/contracts'
import { SESSION_TITLING_SCHEMA_VERSION } from '@openinfo/contracts'
import { WorkspaceRegistry } from './workspaces.js'

const WS = 'default'
const SESS = 's1'

const session = (over: Partial<Session> = {}): Session => ({
  id: SESS,
  workspaceId: WS,
  modeId: 'mode-meeting',
  startedAt: '2026-07-07T14:00:00.000Z',
  attribution: { evidence: [], confidence: 1 },
  ...over,
})

const titling = (over: Partial<SessionTitling> = {}): SessionTitling => ({
  id: `ot:${WS}:${SESS}:${Math.random().toString(36).slice(2)}`,
  workspaceId: WS,
  sessionId: SESS,
  title: 'Meeting on Q3 launch',
  source: 'derived',
  createdAt: '2026-07-07T14:05:00.000Z',
  schemaVersion: SESSION_TITLING_SCHEMA_VERSION,
  ...over,
})

const withStore = async (fn: (store: WorkspaceRegistry) => void | Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-titling-'))
  const store = new WorkspaceRegistry(dir)
  try {
    await fn(store)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
}

test('#211 resolveTitle: latest derived when there is no user title', () => {
  const resolved = WorkspaceRegistry.resolveTitle([
    titling({ source: 'derived', title: 'first read', createdAt: '2026-07-07T14:05:00.000Z' }),
    titling({ source: 'derived', title: 'second read', createdAt: '2026-07-07T14:10:00.000Z' }),
  ])
  assert.equal(resolved, 'second read')
})

test('#211 resolveTitle: a user title is SOVEREIGN over any derived title, regardless of order', () => {
  // user set BEFORE a later derivation still wins — a derivation never clobbers a human name.
  const resolved = WorkspaceRegistry.resolveTitle([
    titling({ source: 'user', title: 'Priya kickoff', createdAt: '2026-07-07T14:06:00.000Z' }),
    titling({ source: 'derived', title: 'Meeting on renewal', createdAt: '2026-07-07T14:20:00.000Z' }),
  ])
  assert.equal(resolved, 'Priya kickoff')
})

test('#211 resolveTitle: no titlings ⇒ undefined (caller supplies the honest fallback)', () => {
  assert.equal(WorkspaceRegistry.resolveTitle([]), undefined)
})

test('#226 resolveTitle ladder: floor names a session only when there is no derived/user title', () => {
  const floor = titling({ source: 'floor', title: 'Working on kubefast', provenance: { producer: 'session-entities', subjects: ['kubefast'], derivedAt: '2026-07-16T12:01:00.000Z' } })
  assert.equal(WorkspaceRegistry.resolveTitle([floor]), 'Working on kubefast', 'floor fills the gap')
  // A derived title always supersedes a floor, regardless of append order.
  const derived = titling({ source: 'derived', title: 'Meeting on Q3 launch', createdAt: '2026-07-16T12:02:00.000Z' })
  assert.equal(WorkspaceRegistry.resolveTitle([floor, derived]), 'Meeting on Q3 launch', 'derived beats floor (later)')
  assert.equal(WorkspaceRegistry.resolveTitle([derived, floor]), 'Meeting on Q3 launch', 'derived beats floor even when the floor row is later')
  // A user title beats both.
  const user = titling({ source: 'user', title: 'Acme kickoff' })
  assert.equal(WorkspaceRegistry.resolveTitle([floor, derived, user]), 'Acme kickoff', 'user is sovereign over floor + derived')
})

test('#226 latestFloorTitle + hasAuthoredTitle track the floor rung independently', async () => {
  await withStore((store) => {
    store.saveSession(session())
    store.recordSessionTitling(titling({ source: 'floor', title: 'Working on kubefast', provenance: { producer: 'session-entities', subjects: ['kubefast'], derivedAt: '2026-07-16T12:01:00.000Z' } }))
    assert.equal(store.latestFloorTitle(WS, SESS), 'Working on kubefast')
    assert.equal(store.hasAuthoredTitle(WS, SESS), false, 'a floor title is NOT an authored (user/derived) title')
    store.recordSessionTitling(titling({ source: 'derived', title: 'Meeting on Q3 launch' }))
    assert.equal(store.hasAuthoredTitle(WS, SESS), true, 'a derived title IS authored — the floor stands down')
    assert.equal(store.getSession(WS, SESS)?.title, 'Meeting on Q3 launch', 'derived materialised over the floor')
  })
})

test('#211 recordSessionTitling: appends the row AND materialises the resolved title onto the session', async () => {
  await withStore((store) => {
    store.saveSession(session())
    const updated = store.recordSessionTitling(titling({ source: 'derived', title: 'Meeting on Q3 launch' }))
    assert.equal(updated?.title, 'Meeting on Q3 launch', 'session.title materialised for existing surfaces')
    assert.equal(store.getSession(WS, SESS)?.title, 'Meeting on Q3 launch', 'persisted')
    assert.equal(store.listSessionTitlings(WS, SESS).length, 1, 'one append-only titling row')
  })
})

test('#211 append-only: a re-derivation appends a NEW row; the prior is never mutated', async () => {
  await withStore((store) => {
    store.saveSession(session())
    store.recordSessionTitling(titling({ source: 'derived', title: 'first read', createdAt: '2026-07-07T14:05:00.000Z' }))
    store.recordSessionTitling(titling({ source: 'derived', title: 'sharper read', createdAt: '2026-07-07T14:12:00.000Z' }))
    const rows = store.listSessionTitlings(WS, SESS)
    assert.equal(rows.length, 2, 'both titlings retained (append-only history)')
    assert.deepEqual(rows.map((r) => r.title), ['first read', 'sharper read'], 'oldest-first append order')
    assert.equal(store.getSession(WS, SESS)?.title, 'sharper read', 'latest derived resolved')
    assert.equal(store.latestDerivedTitle(WS, SESS), 'sharper read')
  })
})

test('#211 sovereignty: a user rename after a derivation wins; a later derivation does NOT clobber it', async () => {
  await withStore((store) => {
    store.saveSession(session())
    store.recordSessionTitling(titling({ source: 'derived', title: 'Meeting on renewal', createdAt: '2026-07-07T14:05:00.000Z' }))
    store.recordSessionTitling(titling({ source: 'user', title: 'Acme renewal call', createdAt: '2026-07-07T14:06:00.000Z' }))
    assert.equal(store.getSession(WS, SESS)?.title, 'Acme renewal call', 'user title materialised')
    // A LATER orientation pass appends another derived titling — the user name stays sovereign.
    store.recordSessionTitling(titling({ source: 'derived', title: 'Meeting on pricing', createdAt: '2026-07-07T14:30:00.000Z' }))
    assert.equal(store.getSession(WS, SESS)?.title, 'Acme renewal call', 'derived never clobbers the user title')
    assert.equal(store.listSessionTitlings(WS, SESS).length, 3, 'all three retained')
  })
})

test('#211 recordSessionTitling: no session record yet ⇒ titling still persisted, returns undefined', async () => {
  await withStore((store) => {
    store.ensureWorkspace({ id: WS, name: WS })
    const updated = store.recordSessionTitling(titling({ source: 'derived' }))
    assert.equal(updated, undefined, 'no session to materialise onto')
    assert.equal(store.listSessionTitlings(WS, SESS).length, 1, 'titling durable regardless')
  })
})

test('#211 reroute moves the titling history with the session', async () => {
  await withStore((store) => {
    store.ensureWorkspace({ id: 'ws-a', name: 'ws-a' })
    store.ensureWorkspace({ id: 'ws-b', name: 'ws-b' })
    store.saveSession(session({ id: 'sX', workspaceId: 'ws-a' }))
    store.recordSessionTitling(titling({ id: 'ot:ws-a:sX:1', workspaceId: 'ws-a', sessionId: 'sX', source: 'user', title: 'Kept name' }))
    store.moveSession('sX', 'ws-a', 'ws-b')
    assert.equal(store.listSessionTitlings('ws-a', 'sX').length, 0, 'source no longer holds the titlings')
    const moved = store.listSessionTitlings('ws-b', 'sX')
    assert.equal(moved.length, 1, 'titlings moved to the destination')
    assert.equal(moved[0]!.workspaceId, 'ws-b', 'workspace scope rewritten')
    assert.equal(store.getSession('ws-b', 'sX')?.title, 'Kept name', 'the rerouted session keeps its name')
  })
})
