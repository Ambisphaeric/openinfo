import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk, Distillate, Session, SessionTitling, FloorTitlingProvenance } from '@openinfo/contracts'
import { DISTILLATE_SCHEMA_VERSION } from '@openinfo/contracts'
import { WorkspaceRegistry } from '../store/index.js'
import { FloorTitleScheduler, deriveFloorTitle } from './floor-title.js'

const WS = 'default'
const SESS = 'sess-floor'
const NOW = new Date('2026-07-16T12:05:00.000Z')

const distillate = (id: string): Distillate => ({
  id,
  sessionId: SESS,
  workspaceId: WS,
  windowStart: '2026-07-16T12:00:00.000Z',
  windowEnd: '2026-07-16T12:01:00.000Z',
  sourceChunks: ['c-1'],
  text: 'work happened',
  voice: { scope: 'global', dials: { tone: 0, warmth: 0, wit: 0, charm: 0, specificity: 0, brevity: 0 } },
  provenance: { slot: 'llm', endpoint: 'llm', model: 'lfm-1b' },
  schemaVersion: DISTILLATE_SCHEMA_VERSION,
  createdAt: '2026-07-16T12:01:00.000Z',
})

const chunk = (): CaptureChunk => ({
  id: 'c-1',
  sessionId: SESS,
  workspaceId: WS,
  source: 'mic',
  sequence: 1,
  capturedAt: '2026-07-16T12:00:30.000Z',
  contentType: 'text/plain',
  encoding: 'utf8',
  data: 'hello',
})

/** Seed a session, a session distillate, and entities sighted in that distillate (so the floor can scope them). */
const seedSessionWithEntities = (
  store: WorkspaceRegistry,
  entities: { name: string; kind: 'person' | 'artifact' | 'topic'; mentions: number }[],
): void => {
  store.saveSession({ id: SESS, workspaceId: WS, modeId: 'mode-meeting', startedAt: '2026-07-16T12:00:00.000Z', attribution: { evidence: [], confidence: 1 } })
  store.saveDistillate(distillate('d1'))
  for (const e of entities) {
    // upsert `mentions` times so the recency×frequency scorer ranks by count; each names the session distillate.
    for (let i = 0; i < e.mentions; i += 1) {
      store.upsertEntity({
        workspaceId: WS,
        kind: e.kind,
        name: e.name,
        seenAt: '2026-07-16T12:01:00.000Z',
        provenance: { slot: 'llm', endpoint: 'llm', distillateId: 'd1' },
      })
    }
  }
}

const build = async (): Promise<{ store: WorkspaceRegistry; scheduler: FloorTitleScheduler; titled: Session[]; logs: string[]; dir: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-floor-'))
  const store = new WorkspaceRegistry(dir)
  const titled: Session[] = []
  const logs: string[] = []
  const scheduler = new FloorTitleScheduler({ store, now: () => NOW, publishTitled: (s) => void titled.push(s), log: (m) => void logs.push(m) })
  return { store, scheduler, titled, logs, dir }
}

const cleanup = async (store: WorkspaceRegistry, dir: string): Promise<void> => {
  store.close()
  await rm(dir, { recursive: true, force: true })
}

// ── The pure transform ──────────────────────────────────────────────────────────────────────────────

test('#226 deriveFloorTitle: one subject ⇒ "Working on <subject>" (beats "session live")', () => {
  assert.equal(deriveFloorTitle(['kubefast']), 'Working on kubefast')
})

test('#226 deriveFloorTitle: two subjects join the human way; a third is dropped (glanceable)', () => {
  assert.equal(deriveFloorTitle(['kubefast', 'billing', 'auth']), 'Working on kubefast and billing')
})

test('#226 deriveFloorTitle: no usable subject ⇒ undefined (honest — caller keeps the start-time fallback)', () => {
  assert.equal(deriveFloorTitle([]), undefined)
  assert.equal(deriveFloorTitle(['   ', '']), undefined)
})

test('#226 deriveFloorTitle: a runaway subject is clamped to a glanceable length on a word boundary', () => {
  const long = 'an extraordinarily long and rambling subject phrase that just keeps going well past any glanceable length'
  const title = deriveFloorTitle([long])!
  assert.ok(title.length <= 80, `expected clamp, got ${title.length}`)
  assert.doesNotMatch(title, /\s$/)
})

// ── The scheduler ───────────────────────────────────────────────────────────────────────────────────

test('#226 floor: a session with entities gets a deterministic floor title — persisted, materialised, published', async () => {
  const { store, scheduler, titled, dir } = await build()
  try {
    seedSessionWithEntities(store, [{ name: 'kubefast', kind: 'artifact', mentions: 3 }])
    const appended = await scheduler.run([chunk()])
    assert.equal(appended.length, 1)
    const t = store.listSessionTitlings(WS, SESS)[0]!
    assert.equal(t.source, 'floor', 'a deterministic-floor titling, NOT a derived/judge one')
    assert.equal(t.title, 'Working on kubefast')
    const prov = t.provenance as FloorTitlingProvenance
    assert.equal(prov.producer, 'session-entities', 'provenance names the deterministic producer, never the judge')
    assert.deepEqual(prov.subjects, ['kubefast'], 'the signal evidence is recorded')
    assert.equal(store.getSession(WS, SESS)?.title, 'Working on kubefast', 'materialised onto the session')
    assert.equal(titled.length, 1, 'session.titled published so the tray/pill refresh')
  } finally {
    await cleanup(store, dir)
  }
})

test('#226 floor: the top-ranked entities lead the name (recency×frequency)', async () => {
  const { store, scheduler, dir } = await build()
  try {
    seedSessionWithEntities(store, [
      { name: 'kubefast', kind: 'artifact', mentions: 5 },
      { name: 'billing', kind: 'topic', mentions: 2 },
    ])
    await scheduler.run([chunk()])
    assert.equal(store.getSession(WS, SESS)?.title, 'Working on kubefast and billing', 'most-mentioned first')
  } finally {
    await cleanup(store, dir)
  }
})

test('#226 floor: dedupe — an identical re-run appends nothing (no spam)', async () => {
  const { store, scheduler, titled, dir } = await build()
  try {
    seedSessionWithEntities(store, [{ name: 'kubefast', kind: 'artifact', mentions: 3 }])
    await scheduler.run([chunk()])
    await scheduler.run([chunk()])
    assert.equal(store.listSessionTitlings(WS, SESS).length, 1, 'the unchanged floor name is not re-appended')
    assert.equal(titled.length, 1)
  } finally {
    await cleanup(store, dir)
  }
})

test('#226 floor: NEVER runs once a session has a user title (sovereignty) or a judge-derived title', async () => {
  const { store, scheduler, dir } = await build()
  try {
    seedSessionWithEntities(store, [{ name: 'kubefast', kind: 'artifact', mentions: 3 }])
    const userTitling: SessionTitling = {
      id: `ot:${WS}:${SESS}:u1`, workspaceId: WS, sessionId: SESS, title: 'Acme kickoff', source: 'user',
      createdAt: '2026-07-16T12:02:00.000Z', schemaVersion: 1,
    }
    store.recordSessionTitling(userTitling)
    const appended = await scheduler.run([chunk()])
    assert.deepEqual(appended, [], 'a user-titled session gets no floor row')
    assert.equal(store.getSession(WS, SESS)?.title, 'Acme kickoff', 'the sovereign user name stands')
  } finally {
    await cleanup(store, dir)
  }
})

test('#226 floor: no session entities ⇒ no floor (honest — session keeps its start-time fallback)', async () => {
  const { store, scheduler, titled, dir } = await build()
  try {
    store.saveSession({ id: SESS, workspaceId: WS, modeId: 'mode-meeting', startedAt: '2026-07-16T12:00:00.000Z', attribution: { evidence: [], confidence: 1 } })
    store.saveDistillate(distillate('d1')) // material exists, but no entities were indexed
    const appended = await scheduler.run([chunk()])
    assert.deepEqual(appended, [], 'nothing to name ⇒ no floor titling')
    assert.equal(store.getSession(WS, SESS)?.title, undefined)
    assert.equal(titled.length, 0)
  } finally {
    await cleanup(store, dir)
  }
})

test('#226 ladder: a later judge-DERIVED title supersedes a floor; the floor never clobbers it back', async () => {
  const { store, scheduler, dir } = await build()
  try {
    seedSessionWithEntities(store, [{ name: 'kubefast', kind: 'artifact', mentions: 3 }])
    await scheduler.run([chunk()]) // floor: "Working on kubefast"
    assert.equal(store.getSession(WS, SESS)?.title, 'Working on kubefast')
    // The orientation pass later appends a DERIVED title — it must win over the floor.
    store.recordSessionTitling({
      id: `ot:${WS}:${SESS}:d1`, workspaceId: WS, sessionId: SESS, title: 'Working on the kubefast rollout', source: 'derived',
      provenance: { annotationId: `oa:${WS}:${SESS}`, templateId: 'tpl-judge-orientation', endpoint: 'llm', classifiedAt: '2026-07-16T12:03:00.000Z', nature: 'solo-work', direction: 'unclear', topics: ['the kubefast rollout'] },
      createdAt: '2026-07-16T12:03:00.000Z', schemaVersion: 1,
    })
    assert.equal(store.getSession(WS, SESS)?.title, 'Working on the kubefast rollout', 'derived supersedes floor')
    // A subsequent floor run must NOT clobber the derived title (hasAuthoredTitle short-circuits).
    const appended = await scheduler.run([chunk()])
    assert.deepEqual(appended, [], 'floor stands down once a derived title exists')
    assert.equal(store.getSession(WS, SESS)?.title, 'Working on the kubefast rollout')
  } finally {
    await cleanup(store, dir)
  }
})
