import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Moment, Pin, RelevantEntity, Session, TodoItem, TodoList } from '@openinfo/contracts'
import { WorkspaceRegistry } from '../store/index.js'
import { TodoDocuments } from '../act/index.js'
import { compileQuery } from './query.js'

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
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
