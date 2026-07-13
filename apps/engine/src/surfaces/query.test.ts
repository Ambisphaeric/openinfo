import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Distillate, Draft, Moment, Pin, QueueStatus, RelevantEntity, Session, TeachSignal, TodoItem, TodoList, TranscriptInspector } from '@openinfo/contracts'
import { WorkspaceRegistry } from '../store/index.js'
import { TodoDocuments } from '../act/index.js'
import { TeachStore, type HintCandidate } from '../teach/index.js'
import { compileQuery } from './query.js'
import type { SenseGateChain } from './settings/sense-gates.js'

const moment = (id: string, sessionId: string, at: string, refs: string[] = []): Moment => ({
  id, sessionId, workspaceId: 'ws-q', at, kind: 'decision', text: `moment ${id}`, refs, source: 'mic', confidence: 0.8,
})

const pin = (id: string, title: string, createdAt: string): Pin => ({
  id, workspaceId: 'ws-q', uri: `file:///${id}.pdf`, title, kind: 'pdf',
  ingest: { status: 'ingested', pages: 3, chunks: 6 }, createdAt,
})

test('compileQuery hydrates each backed source, respects top, and reports truncation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-query-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const now = new Date('2026-07-07T15:00:00Z')
    const soc = store.upsertEntity({ workspaceId: 'ws-q', kind: 'topic', name: 'SOC 2', seenAt: '2026-07-07T14:45:00Z', momentRefs: ['m-2'] })
    store.upsertEntity({ workspaceId: 'ws-q', kind: 'person', name: 'Dana', seenAt: '2026-07-07T14:50:00Z' })
    store.saveMoment(moment('m-1', 'ses-a', '2026-07-07T14:00:00Z'))
    store.saveMoment(moment('m-2', 'ses-a', '2026-07-07T14:45:00Z', [soc.id]))
    store.saveMoment(moment('m-3', 'ses-b', '2026-07-07T14:50:00Z'))

    // moments: newest-first, top caps and flags truncation
    const moments = compileQuery(store, { source: 'moments', params: { workspace: 'ws-q' }, top: 2 }, now)
    assert.equal(moments.source, 'moments')
    assert.deepEqual((moments.items as Moment[]).map((m) => m.id), ['m-3', 'm-2'])
    assert.equal(moments.top, 2)
    assert.equal(moments.truncated, true) // 3 exist, 2 returned

    // no top → all rows, never truncated
    const allMoments = compileQuery(store, { source: 'moments', params: { workspace: 'ws-q' } }, now)
    assert.equal(allMoments.items.length, 3)
    assert.equal(allMoments.truncated, false)
    assert.equal(allMoments.top, undefined)

    // relevant-now: ranked entities joined with their moments
    const relevant = compileQuery(store, { source: 'relevant-now', params: { workspace: 'ws-q' }, top: 4 }, now)
    assert.equal(relevant.source, 'relevant-now')
    assert.equal((relevant.items as RelevantEntity[]).length, 2)
    assert.equal((relevant.items as RelevantEntity[])[0]!.entity.kind !== undefined, true)

    // entities: newest lastSeen first
    const entities = compileQuery(store, { source: 'entities', params: { workspace: 'ws-q' } }, now)
    assert.equal(entities.items.length, 2)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('compileQuery binds session "current" to the workspace live session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-query-cur-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const live: Session = {
      id: 'ses-live', workspaceId: 'ws-q', modeId: 'mode-meeting', startedAt: '2026-07-07T14:00:00Z',
      attribution: { evidence: [{ kind: 'manual', detail: 'x', weight: 1 }], confidence: 1 },
    }
    store.saveSession(live)
    store.saveMoment(moment('m-live', 'ses-live', '2026-07-07T14:10:00Z'))
    store.saveMoment(moment('m-other', 'ses-old', '2026-07-07T13:00:00Z'))

    // "current" resolves to the live session id → only its moments
    const cur = compileQuery(store, { source: 'moments', params: { workspace: 'ws-q', session: 'current' } })
    assert.deepEqual((cur.items as Moment[]).map((m) => m.id), ['m-live'])

    // sessions source lists them all
    const sessions = compileQuery(store, { source: 'sessions', params: { workspace: 'ws-q' } })
    assert.deepEqual((sessions.items as Session[]).map((s) => s.id), ['ses-live'])
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('compileQuery resolves the pins source through the store (most-recent first, top caps + truncates)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-query-pins-'))
  const store = new WorkspaceRegistry(dir)
  try {
    store.savePin(pin('pin-1', 'SOC 2 Type II report', '2026-07-07T14:00:00Z'))
    store.savePin(pin('pin-2', 'MSA v3 redlines', '2026-07-07T14:30:00Z'))
    store.savePin(pin('pin-3', 'Security questionnaire', '2026-07-07T14:45:00Z'))

    // pins hydrate from the store, most-recently-created first (listPins order)
    const all = compileQuery(store, { source: 'pins', params: { workspace: 'ws-q' } })
    assert.equal(all.source, 'pins')
    assert.deepEqual((all.items as Pin[]).map((p) => p.id), ['pin-3', 'pin-2', 'pin-1'])
    assert.equal((all.items as Pin[])[0]!.title, 'Security questionnaire')
    assert.equal(all.truncated, false)

    // top caps the returned rows and flags truncation (3 exist, 2 returned)
    const capped = compileQuery(store, { source: 'pins', params: { workspace: 'ws-q' }, top: 2 })
    assert.deepEqual((capped.items as Pin[]).map((p) => p.id), ['pin-3', 'pin-2'])
    assert.equal(capped.top, 2)
    assert.equal(capped.truncated, true)

    // a KNOWN workspace with no pins reads as an empty list (explainable-empty, not an error)
    store.upsertEntity({ workspaceId: 'ws-empty', kind: 'topic', name: 'x', seenAt: '2026-07-07T14:00:00Z' })
    const none = compileQuery(store, { source: 'pins', params: { workspace: 'ws-empty' } })
    assert.deepEqual(none.items, [])
    assert.equal(none.truncated, false)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('compileQuery flattens the todos source through the store (per-session items, top caps + truncates)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-query-todos-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const todos = new TodoDocuments(store)
    const item = (id: string, text: string, extra: Partial<TodoItem> = {}): TodoItem => ({
      id, text, createdAt: '2026-07-07T14:40:00Z', ...extra,
    })
    // two sessions in ws-q each carry a to-do list; a third list belongs to a DIFFERENT workspace
    const listFor = (sessionId: string, workspaceId: string, items: TodoItem[]): TodoList => ({
      id: sessionId, name: `to-do ${sessionId}`, version: 1, sessionId, workspaceId, items,
    })
    todos.save(listFor('ses-a', 'ws-q', [item('a1', 'send the MSA', { provenance: { sessionId: 'ses-a', distillateId: 'd1' } }), item('a2', 'book walkthrough', { done: true })]))
    todos.save(listFor('ses-b', 'ws-q', [item('b1', 'ping legal')]))
    todos.save(listFor('ses-c', 'ws-other', [item('c1', 'not this workspace')]))

    // workspace-scoped: items from ws-q's lists flatten together; the other workspace's item is excluded
    const all = compileQuery(store, { source: 'todos', params: { workspace: 'ws-q' } })
    assert.equal(all.source, 'todos')
    assert.deepEqual((all.items as TodoItem[]).map((t) => t.id), ['a1', 'a2', 'b1'])
    assert.equal(all.truncated, false)

    // session-scoped: only that session's items
    const scoped = compileQuery(store, { source: 'todos', params: { workspace: 'ws-q', session: 'ses-a' } })
    assert.deepEqual((scoped.items as TodoItem[]).map((t) => t.id), ['a1', 'a2'])

    // top caps the flattened rows and flags truncation (3 exist across ws-q, 2 returned)
    const capped = compileQuery(store, { source: 'todos', params: { workspace: 'ws-q' }, top: 2 })
    assert.deepEqual((capped.items as TodoItem[]).map((t) => t.id), ['a1', 'a2'])
    assert.equal(capped.top, 2)
    assert.equal(capped.truncated, true)

    // a known workspace with no to-do documents reads as [] (explainable-empty, not an error)
    store.upsertEntity({ workspaceId: 'ws-empty', kind: 'topic', name: 'x', seenAt: '2026-07-07T14:00:00Z' })
    const none = compileQuery(store, { source: 'todos', params: { workspace: 'ws-empty' } })
    assert.deepEqual(none.items, [])
    assert.equal(none.truncated, false)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('compileQuery resolves the drafts source through the store (newest-first, top caps + truncates, session-scoped)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-query-drafts-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const draft = (id: string, sessionId: string, createdAt: string): Draft => ({
      id, sessionId, workspaceId: 'ws-q', actKind: 'follow-up-draft', body: `body ${id}`, status: 'prepared',
      voice: { scope: 'session', dials: { tone: 3, warmth: 4, wit: 2, charm: 2, specificity: 9, brevity: 8 } },
      provenance: { templateId: 'tpl-followup-default', slot: 'llm', endpoint: 'llm.fast', sourceDistillates: ['dst-1'], sourceMoments: [] },
      schemaVersion: 1, createdAt,
    })
    store.saveDraft(draft('drf-1', 'ses-a', '2026-07-07T14:00:00Z'))
    store.saveDraft(draft('drf-2', 'ses-a', '2026-07-07T14:30:00Z'))
    store.saveDraft(draft('drf-3', 'ses-b', '2026-07-07T14:45:00Z'))

    // drafts hydrate from the store, newest-first (listDrafts is oldest-first; the arm reverses for the HUD)
    const all = compileQuery(store, { source: 'drafts', params: { workspace: 'ws-q' } })
    assert.equal(all.source, 'drafts')
    assert.deepEqual((all.items as Draft[]).map((d) => d.id), ['drf-3', 'drf-2', 'drf-1'])
    assert.equal(all.truncated, false)

    // top caps the returned rows and flags truncation (3 exist, 2 returned — newest two)
    const capped = compileQuery(store, { source: 'drafts', params: { workspace: 'ws-q' }, top: 2 })
    assert.deepEqual((capped.items as Draft[]).map((d) => d.id), ['drf-3', 'drf-2'])
    assert.equal(capped.top, 2)
    assert.equal(capped.truncated, true)

    // session-scoped: only that session's drafts (still newest-first)
    const scoped = compileQuery(store, { source: 'drafts', params: { workspace: 'ws-q', session: 'ses-a' } })
    assert.deepEqual((scoped.items as Draft[]).map((d) => d.id), ['drf-2', 'drf-1'])

    // a known workspace with no drafts reads as [] (explainable-empty, not an error)
    store.upsertEntity({ workspaceId: 'ws-empty', kind: 'topic', name: 'x', seenAt: '2026-07-07T14:00:00Z' })
    const none = compileQuery(store, { source: 'drafts', params: { workspace: 'ws-empty' } })
    assert.deepEqual(none.items, [])
    assert.equal(none.truncated, false)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('compileQuery resolves the distillates source through the store (newest-first, top caps + truncates, session-scoped)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-query-distillates-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const distillate = (id: string, sessionId: string, createdAt: string): Distillate => ({
      id, sessionId, workspaceId: 'ws-q', windowStart: createdAt, windowEnd: createdAt,
      sourceChunks: [`c-${id}`], text: `window ${id}`,
      voice: { scope: 'session', dials: { tone: 3, warmth: 4, wit: 2, charm: 2, specificity: 9, brevity: 8 } },
      provenance: { slot: 'llm', endpoint: 'llm.fast' }, schemaVersion: 1, createdAt,
    })
    store.saveDistillate(distillate('dst-1', 'ses-a', '2026-07-07T14:00:00Z'))
    store.saveDistillate(distillate('dst-2', 'ses-a', '2026-07-07T14:30:00Z'))
    store.saveDistillate(distillate('dst-3', 'ses-b', '2026-07-07T14:45:00Z'))

    // distillates hydrate from the store, NEWEST-first (listDistillates is oldest-first; the arm reverses)
    const all = compileQuery(store, { source: 'distillates', params: { workspace: 'ws-q' } })
    assert.equal(all.source, 'distillates')
    assert.deepEqual((all.items as Distillate[]).map((d) => d.id), ['dst-3', 'dst-2', 'dst-1'])
    assert.equal(all.truncated, false)

    // top caps the returned rows and flags truncation (3 exist, 2 returned — newest two)
    const capped = compileQuery(store, { source: 'distillates', params: { workspace: 'ws-q' }, top: 2 })
    assert.deepEqual((capped.items as Distillate[]).map((d) => d.id), ['dst-3', 'dst-2'])
    assert.equal(capped.top, 2)
    assert.equal(capped.truncated, true)

    // session-scoped: only that session's distillates (still newest-first)
    const scoped = compileQuery(store, { source: 'distillates', params: { workspace: 'ws-q', session: 'ses-a' } })
    assert.deepEqual((scoped.items as Distillate[]).map((d) => d.id), ['dst-2', 'dst-1'])

    // a known workspace with no distillates reads as [] (explainable-empty, not an error)
    store.upsertEntity({ workspaceId: 'ws-empty', kind: 'topic', name: 'x', seenAt: '2026-07-07T14:00:00Z' })
    const none = compileQuery(store, { source: 'distillates', params: { workspace: 'ws-empty' } })
    assert.deepEqual(none.items, [])
    assert.equal(none.truncated, false)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('compileQuery derives the teach source through the store (SUGGESTED candidates, support-sorted, top caps + truncates)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-query-teach-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const teach = new TeachStore(store)
    // three reroutes correct sessions INTO ws-q: two agree on the same window title (support 2), one names
    // a repo (support 1); a fourth reroutes into a DIFFERENT workspace and must not leak into ws-q's view.
    const signal = (id: string, session: string, toWs: string, kind: 'window' | 'repo', detail: string): TeachSignal => ({
      id, kind: 'reroute', fromWorkspaceId: 'ws-other', toWorkspaceId: toWs, sessionId: session,
      evidence: [{ kind, detail, weight: 0.7 }, { kind: 'manual', detail: 'user reroute', weight: 1 }],
      correctedAt: '2026-07-07T14:40:00Z',
    })
    teach.record(signal('t1', 'ses-a', 'ws-q', 'window', 'Renewal — security review'))
    teach.record(signal('t2', 'ses-b', 'ws-q', 'window', 'Renewal — security review')) // agrees ⇒ support 2
    teach.record(signal('t3', 'ses-c', 'ws-q', 'repo', 'acme/infra'))
    teach.record(signal('t4', 'ses-d', 'ws-elsewhere', 'window', 'not this workspace'))

    // workspace-scoped: only ws-q's derived candidates, strongest support first (window support 2 leads)
    const all = compileQuery(store, { source: 'teach', params: { workspace: 'ws-q' } })
    assert.equal(all.source, 'teach')
    const cands = all.items as HintCandidate[]
    assert.deepEqual(cands.map((c) => c.pattern.contains), ['Renewal — security review', 'acme/infra'])
    assert.equal(cands[0]!.supportCount, 2)
    assert.equal(cands[0]!.pattern.field, 'windowTitle')
    assert.deepEqual(cands[0]!.sampleSessionIds, ['ses-a', 'ses-b']) // traceable to its corrections
    assert.equal(cands[1]!.pattern.field, 'repoPath')
    assert.equal(all.truncated, false)

    // top caps the derived rows and flags truncation (2 candidates exist for ws-q, 1 returned — the strongest)
    const capped = compileQuery(store, { source: 'teach', params: { workspace: 'ws-q' }, top: 1 })
    assert.deepEqual((capped.items as HintCandidate[]).map((c) => c.pattern.contains), ['Renewal — security review'])
    assert.equal(capped.top, 1)
    assert.equal(capped.truncated, true)

    // a workspace with no recorded corrections derives [] (explainable-empty, not an error)
    const none = compileQuery(store, { source: 'teach', params: { workspace: 'ws-untaught' } })
    assert.deepEqual(none.items, [])
    assert.equal(none.truncated, false)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('compileQuery resolves the queue source from the INJECTED status snapshot (one row), else explainable-empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-query-queue-'))
  const store = new WorkspaceRegistry(dir)
  try {
    // the queue source is operational engine state, not a store record: the route injects status() via
    // `sources`. A seeded status (with a last failure — the honest "why nothing arrived") returns ONE row.
    const status: QueueStatus = {
      pendingFiles: 2, pendingBytes: 4096, drainedFiles: 5, updatedAt: '2026-07-07T14:40:00Z',
      byKind: { audio: { pendingChunks: 3, pendingBytes: 3000 }, screen: { pendingChunks: 0, pendingBytes: 0 }, 'llm-work': { pendingChunks: 1, pendingBytes: 1096 } },
      eta: { basis: 'observed', etaMs: 12000, drainRateChunksPerSec: 0.3 },
      overflow: { policy: 'queue-for-idle', enforced: true },
      lastFailure: { class: 'model-load', endpoint: 'lm-studio', hint: 'try a smaller model', at: '2026-07-07T14:39:00Z' },
    }
    const resolved = compileQuery(store, { source: 'queue', params: {} }, new Date(), { queueStatus: status })
    assert.equal(resolved.source, 'queue')
    assert.equal(resolved.items.length, 1)
    assert.deepEqual(resolved.items[0], status) // the whole snapshot round-trips as the single row
    assert.equal(resolved.truncated, false)

    // no status injected (the queue unwired / a unit caller) ⇒ [] explainable-empty, never an error
    const none = compileQuery(store, { source: 'queue', params: {} })
    assert.deepEqual(none.items, [])
    assert.equal(none.truncated, false)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('compileQuery resolves the transcript source from the INJECTED inspector snapshot (one row), else explainable-empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-query-transcript-'))
  const store = new WorkspaceRegistry(dir)
  try {
    // the transcript source is operational/config engine state, not a store record: the route injects the
    // TranscriptInspector snapshot (recent ephemeral ring + current stt slot) via `sources`. ONE row.
    const snapshot: TranscriptInspector = {
      ringLimit: 50,
      sttSlot: [{ endpoint: 'whisper-cpp', model: 'ggml-base.en' }],
      chunks: [{
        sessionId: 's-1', source: 'mic', text: 'hello there', sourceChunkIds: ['mic-s-1-000001'],
        sourceSequenceRange: { start: 1, end: 1 },
        capturedAtRange: { start: '2026-07-07T14:40:00Z', end: '2026-07-07T14:40:02Z' },
        processedAt: '2026-07-07T14:40:02.250Z',
      }],
    }
    const resolved = compileQuery(store, { source: 'transcript', params: {} }, new Date(), { transcript: snapshot })
    assert.equal(resolved.source, 'transcript')
    assert.equal(resolved.items.length, 1)
    assert.deepEqual(resolved.items[0], snapshot) // the whole snapshot round-trips as the single row
    assert.equal(resolved.truncated, false)

    // no snapshot injected (a unit caller) ⇒ [] explainable-empty, never an error
    const none = compileQuery(store, { source: 'transcript', params: {} })
    assert.deepEqual(none.items, [])
    assert.equal(none.truncated, false)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('compileQuery resolves the senses source from the INJECTED gate chains, else explainable-empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-query-senses-'))
  const store = new WorkspaceRegistry(dir)
  try {
    // the senses source is computed engine state (GET /senses' verdict), not a store record: the route
    // evaluates the chains from live flags/fabric/last-failure and injects them. One row per sense.
    const chains: SenseGateChain[] = [
      { sense: 'mic', label: 'Microphone', gates: [{ id: 'distill.enabled', label: 'Distill enabled', pass: false, fix: 'Enable distill' }], blocking: { id: 'distill.enabled', label: 'Distill enabled', pass: false, fix: 'Enable distill' } },
      { sense: 'sys-audio', label: 'System audio', gates: [{ id: 'distill.enabled', label: 'Distill enabled', pass: true }] },
    ]
    const resolved = compileQuery(store, { source: 'senses', params: {} }, new Date(), { senseGates: chains })
    assert.equal(resolved.source, 'senses')
    assert.deepEqual(resolved.items, chains) // one row per sense, in order

    // not injected (a unit caller) ⇒ [] explainable-empty
    assert.deepEqual(compileQuery(store, { source: 'senses', params: {} }).items, [])
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('compileQuery uses the app-instance workspace binding as the default, but an explicit param still wins (#99)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-query-bind-'))
  const store = new WorkspaceRegistry(dir)
  try {
    // two silos, different data — the instance binding must scope reads to its OWN workspace
    store.saveMoment(moment('m-a', 'ses-a', '2026-07-07T14:00:00Z'))
    store.saveMoment({ ...moment('m-b', 'ses-b', '2026-07-07T14:10:00Z'), workspaceId: 'ws-b' })

    // no params.workspace + a bound default ⇒ reads the bound silo (ws-q holds m-a)
    const bound = compileQuery(store, { source: 'moments', params: {} }, undefined, {}, 'ws-q')
    assert.deepEqual((bound.items as Moment[]).map((m) => m.id), ['m-a'])

    // a DIFFERENT binding reads the other silo — one context-agnostic block, two instances, two silos
    const boundB = compileQuery(store, { source: 'moments', params: {} }, undefined, {}, 'ws-b')
    assert.deepEqual((boundB.items as Moment[]).map((m) => m.id), ['m-b'])

    // an explicit params.workspace OVERRIDES the binding (per-block wins)
    const explicit = compileQuery(store, { source: 'moments', params: { workspace: 'ws-b' } }, undefined, {}, 'ws-q')
    assert.deepEqual((explicit.items as Moment[]).map((m) => m.id), ['m-b'])

    // no binding + no param ⇒ 'default' (unchanged single-workspace v0 behavior), which is empty here
    const fallback = compileQuery(store, { source: 'moments', params: {} })
    assert.deepEqual(fallback.items, [])
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('compileQuery returns [] (not an error) for the unbuilt ledger store and unknown workspaces', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-query-empty-'))
  const store = new WorkspaceRegistry(dir)
  try {
    // ledger (P4) has no backing store yet → empty, explainable, never throws
    const ledger = compileQuery(store, { source: 'ledger', params: {}, top: 2 })
    assert.deepEqual(ledger.items, [])
    assert.equal(ledger.truncated, false)
    assert.equal(ledger.source, 'ledger')

    // unknown workspace reads as [] across every backed source (pins included), never an error
    assert.deepEqual(compileQuery(store, { source: 'moments', params: { workspace: 'nowhere' } }).items, [])
    assert.deepEqual(compileQuery(store, { source: 'relevant-now', params: { workspace: 'nowhere' } }).items, [])
    assert.deepEqual(compileQuery(store, { source: 'entities', params: { workspace: 'nowhere' } }).items, [])
    assert.deepEqual(compileQuery(store, { source: 'pins', params: { workspace: 'nowhere' } }).items, [])
    assert.deepEqual(compileQuery(store, { source: 'todos', params: { workspace: 'nowhere' } }).items, [])
    assert.deepEqual(compileQuery(store, { source: 'drafts', params: { workspace: 'nowhere' } }).items, [])
    assert.deepEqual(compileQuery(store, { source: 'teach', params: { workspace: 'nowhere' } }).items, [])
    assert.deepEqual(compileQuery(store, { source: 'distillates', params: { workspace: 'nowhere' } }).items, [])
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
