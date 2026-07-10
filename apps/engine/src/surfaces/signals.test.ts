import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ItemSignal, Moment, TodoItem, TodoList } from '@openinfo/contracts'
import { WorkspaceRegistry } from '../store/index.js'
import { TodoDocuments } from '../act/index.js'
import { ItemSignalStore } from './signals.js'
import { compileQuery } from './query.js'

const signal = (source: string, itemId: string, kind: ItemSignal['kind'] = 'dismiss'): ItemSignal => ({
  workspaceId: 'ws-s', source, itemId, kind, at: '2026-07-09T12:00:00Z',
})
const todo = (id: string, text: string): TodoItem => ({ id, text, createdAt: '2026-07-07T14:40:00Z' })
const todoList = (items: TodoItem[]): TodoList => ({
  id: 'ses-s', name: 'to-do', version: 1, sessionId: 'ses-s', workspaceId: 'ws-s', items,
})

test('ItemSignalStore: records signals, is idempotent per (source,itemId,kind), and exposes dismissed keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-signals-'))
  const store = new WorkspaceRegistry(dir)
  const signals = new ItemSignalStore(store)
  try {
    assert.deepEqual(signals.list('ws-s'), []) // none yet
    signals.add(signal('todos', 't1'))
    signals.add(signal('todos', 't1')) // re-dismiss — idempotent, no duplicate
    signals.add(signal('relevant-now', 'ent-1'))
    signals.add(signal('todos', 't2', 'follow-up')) // a different kind on the same store

    assert.equal(signals.list('ws-s').length, 3)
    assert.deepEqual([...signals.dismissedKeys('ws-s')].sort(), ['relevant-now:ent-1', 'todos:t1'])
    assert.deepEqual([...signals.keysOfKind('ws-s', 'follow-up')], ['todos:t2']) // follow-up is persisted + queryable
    assert.deepEqual(signals.dismissedKeys('other-ws'), new Set()) // scoped per workspace
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('dismiss round-trip: a dismissed to-do is EXCLUDED from the query and the suppressed count is disclosed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-signals-'))
  const store = new WorkspaceRegistry(dir)
  const todos = new TodoDocuments(store)
  const signals = new ItemSignalStore(store)
  try {
    todos.save(todoList([todo('t1', 'Send the MSA'), todo('t2', 'Book the walkthrough'), todo('t3', 'Draft the SOW')]))

    // before dismissal: all three rows, no suppressed field
    const before = compileQuery(store, { source: 'todos', params: { workspace: 'ws-s' } })
    assert.deepEqual((before.items as TodoItem[]).map((i) => i.id), ['t1', 't2', 't3'])
    assert.equal(before.suppressed, undefined)

    // dismiss t2 → the suppression record persists
    signals.add(signal('todos', 't2'))

    // after: t2 excluded, and the query DISCLOSES one suppressed row
    const after = compileQuery(store, { source: 'todos', params: { workspace: 'ws-s' } })
    assert.deepEqual((after.items as TodoItem[]).map((i) => i.id), ['t1', 't3'])
    assert.equal(after.suppressed, 1)

    // a follow-up signal does NOT suppress (only `dismiss` does) — t1 still present after flagging it
    signals.add(signal('todos', 't1', 'follow-up'))
    const stillThere = compileQuery(store, { source: 'todos', params: { workspace: 'ws-s' } })
    assert.deepEqual((stillThere.items as TodoItem[]).map((i) => i.id), ['t1', 't3'])
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('all-suppressed → empty items with a suppressed count (the empty-state disclosure input)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-signals-'))
  const store = new WorkspaceRegistry(dir)
  const todos = new TodoDocuments(store)
  const signals = new ItemSignalStore(store)
  try {
    todos.save(todoList([todo('t1', 'a'), todo('t2', 'b')]))
    signals.add(signal('todos', 't1'))
    signals.add(signal('todos', 't2'))
    const result = compileQuery(store, { source: 'todos', params: { workspace: 'ws-s' } })
    assert.deepEqual(result.items, [])
    assert.equal(result.suppressed, 2) // "2 dismissed" — a block emptied purely by suppression can say so
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('suppression is per-source: dismissing todos:id does NOT hide a same-id row from another source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-signals-'))
  const store = new WorkspaceRegistry(dir)
  const todos = new TodoDocuments(store)
  const signals = new ItemSignalStore(store)
  try {
    // a moment and a to-do that happen to share the id "x1"
    store.saveMoment({ id: 'x1', sessionId: 'ses-s', workspaceId: 'ws-s', at: '2026-07-07T14:00:00Z', kind: 'decision', text: 'm', refs: [], source: 'mic', confidence: 0.8 } as Moment)
    todos.save(todoList([todo('x1', 'shared id')]))

    signals.add(signal('todos', 'x1')) // dismiss only the to-do

    const todosResult = compileQuery(store, { source: 'todos', params: { workspace: 'ws-s' } })
    assert.deepEqual((todosResult.items as TodoItem[]).map((i) => i.id), []) // to-do gone
    const momentsResult = compileQuery(store, { source: 'moments', params: { workspace: 'ws-s' } })
    assert.deepEqual((momentsResult.items as Moment[]).map((m) => m.id), ['x1']) // moment untouched
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
