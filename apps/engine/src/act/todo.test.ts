import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Distillate, Session, TodoItem, WorkflowStep } from '@openinfo/contracts'
import { FabricDocuments } from '../fabric/index.js'
import { WorkspaceRegistry } from '../store/index.js'
import { VoiceDocuments } from '../voice/index.js'
import { defaultMeetingMode } from '../distill/index.js'
import { ActDocuments } from './documents.js'
import { defaultTaskExtractTemplate } from './defaults.js'
import { TodoDocuments, TaskExtractor, composeTaskExtract, mergeTodoItems, renderTodo } from './todo.js'

const at = '2026-07-07T14:45:00Z'
const item = (id: string, text: string, done?: boolean): TodoItem => ({ id, text, createdAt: at, ...(done !== undefined ? { done } : {}) })
const distillate = (id: string, text: string, sessionId = 'ses-1'): Distillate => ({
  id, sessionId, workspaceId: 'ws-1', windowStart: '2026-07-07T14:43:00Z', windowEnd: at, sourceChunks: [], text,
  voice: { scope: 'mode', dials: { tone: 5, warmth: 5, wit: 5, charm: 5, specificity: 5, brevity: 5 } },
  provenance: { slot: 'llm', endpoint: 'llm.fast' }, schemaVersion: 1, createdAt: at,
})
const step: WorkflowStep = { id: 'task-extract', kind: 'act', trigger: 'drain', params: {} }
const cannedInvoke = (text: string) => async (): Promise<{ text: string; endpoint: string; slot: 'llm' }> => ({ text, endpoint: 'llm.fast', slot: 'llm' })

// ---- renderTodo (the {{todo}} value; empty-state honesty) ----

test('renderTodo: empty list → empty string (an omitted section, not an empty heading)', () => {
  assert.equal(renderTodo([]), '')
})

test('renderTodo: non-empty → titled bullet list, done items struck', () => {
  const rendered = renderTodo([item('t1', 'Send Dana the deck'), item('t2', 'Book the room', true)])
  assert.match(rendered, /Accumulated follow-ups so far/)
  assert.match(rendered, /- Send Dana the deck/)
  assert.match(rendered, /- \[x\] Book the room/)
})

// ---- mergeTodoItems (accumulation + dedupe, preserving user edits) ----

test('mergeTodoItems: appends new, dedupes by normalized text, preserves existing (incl. done)', () => {
  const existing = [item('t1', 'Send Dana the deck', true), item('t2', 'USER-ADDED: call legal')]
  const candidates = [
    item('c1', '  send   dana THE deck '), // normalized-equal to t1 → dropped
    item('c2', 'Confirm the ship date'), // new → appended
    item('c3', 'confirm the ship date'), // dupe of c2 within the batch → dropped
  ]
  const merged = mergeTodoItems(existing, candidates)
  assert.deepEqual(merged.map((i) => i.id), ['t1', 't2', 'c2'])
  assert.equal(merged[0]!.done, true) // the user's checkmark survived
})

test('mergeTodoItems: blank-text candidates are ignored', () => {
  assert.deepEqual(mergeTodoItems([], [item('c1', '   ')]).map((i) => i.id), [])
})

// ---- composeTaskExtract (the constrain call) ----

test('composeTaskExtract: no distillates and no moments → no items, no llm call', async () => {
  let calls = 0
  const result = await composeTaskExtract(
    { sessionId: 'ses-1', workspaceId: 'ws-1', distillates: [], moments: [], dials: { tone: 5, warmth: 5, wit: 5, charm: 5, specificity: 5, brevity: 5 } },
    { invoke: async () => { calls += 1; return { text: '[]', endpoint: 'e', slot: 'llm' } }, template: defaultTaskExtractTemplate },
  )
  assert.deepEqual(result.items, [])
  assert.equal(result.attempts, 0)
  assert.equal(calls, 0)
})

test('composeTaskExtract: parses items (text/task/bare-string), stamps provenance, drops textless', async () => {
  const raw = '[{"text": "Send Dana the deck"}, {"task": "Confirm ship date"}, "Book the room", {"note": 1}]'
  const result = await composeTaskExtract(
    {
      sessionId: 'ses-1', workspaceId: 'ws-1',
      distillates: [distillate('dst-9', 'agreed to ship Thursday')], moments: [],
      dials: { tone: 5, warmth: 5, wit: 5, charm: 5, specificity: 5, brevity: 5 }, provenanceDistillateId: 'dst-9',
    },
    { invoke: cannedInvoke(raw), template: defaultTaskExtractTemplate, newId: (() => { let n = 0; return () => `x${(n += 1)}` })() },
  )
  assert.deepEqual(result.items.map((i) => i.text), ['Send Dana the deck', 'Confirm ship date', 'Book the room'])
  assert.equal(result.dropped, 1)
  assert.equal(result.items[0]!.provenance?.distillateId, 'dst-9')
  assert.equal(result.items[0]!.provenance?.sessionId, 'ses-1')
})

test('composeTaskExtract: wholly unparseable → bounded re-sample then []', async () => {
  let calls = 0
  const result = await composeTaskExtract(
    { sessionId: 'ses-1', workspaceId: 'ws-1', distillates: [distillate('d', 's')], moments: [], dials: { tone: 5, warmth: 5, wit: 5, charm: 5, specificity: 5, brevity: 5 } },
    { invoke: async () => { calls += 1; return { text: 'sorry, no JSON here', endpoint: 'e', slot: 'llm' } }, template: defaultTaskExtractTemplate, maxAttempts: 2 },
  )
  assert.deepEqual(result.items, [])
  assert.equal(calls, 2)
})

// ---- TodoDocuments (the editable versioned document) ----

test('TodoDocuments: upsert creates then version-bumps; save validates + monotonic version', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-todo-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const todos = new TodoDocuments(store)
    assert.equal(todos.get('ses-1'), undefined)
    const first = todos.upsert('ses-1', 'ws-1', [item('c1', 'Send the deck')])
    assert.equal(first.version, 1)
    assert.deepEqual(first.items.map((i) => i.text), ['Send the deck'])
    // a user edit via save() bumps the version and is what get() returns
    const edited = todos.save({ ...first, items: [...first.items, item('u1', 'USER: call legal')] })
    assert.equal(edited.version, 2)
    assert.deepEqual(todos.get('ses-1')!.items.map((i) => i.text), ['Send the deck', 'USER: call legal'])
    // a later extraction merges without clobbering the user's item, and dedupes the deck
    const merged = todos.upsert('ses-1', 'ws-1', [item('c2', 'send the deck'), item('c3', 'Confirm ship date')])
    assert.equal(merged.version, 3)
    assert.deepEqual(merged.items.map((i) => i.text), ['Send the deck', 'USER: call legal', 'Confirm ship date'])
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

// ---- TaskExtractor (rides the drain, per-session over the batch) ----

test('TaskExtractor.runOnDrain: extracts + accumulates into the session to-do doc across drains', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-todo-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const voice = new VoiceDocuments(store); voice.ensureDefaults()
    const templates = new ActDocuments(store); templates.ensureDefaults()
    const todos = new TodoDocuments(store)
    const session: Session = {
      id: 'ses-1', workspaceId: 'ws-1', modeId: 'mode-meeting', startedAt: at,
      attribution: { evidence: [{ kind: 'manual', detail: 'm', weight: 1 }], confidence: 1 },
    }
    store.saveSession(session)

    let n = 0
    const extractor = new TaskExtractor({
      store, voice, fabric: new FabricDocuments(store), templates, todos, mode: () => defaultMeetingMode,
      invoke: async () => { n += 1; return { text: n === 1 ? '[{"text": "Send Dana the deck"}]' : '[{"text": "Send Dana the deck"}, {"text": "Confirm ship date"}]', endpoint: 'llm.fast', slot: 'llm' } },
    })
    const chunk = { workspaceId: 'ws-1', sessionId: 'ses-1' } as never

    // drain 1: one distillate → one item
    store.saveDistillate(distillate('dst-1', 'we should ship Thursday'))
    await extractor.runOnDrain([chunk], step)
    assert.deepEqual(todos.get('ses-1')!.items.map((i) => i.text), ['Send Dana the deck'])

    // drain 2: more distilled → the second item accumulates, the first is deduped (not doubled)
    store.saveDistillate(distillate('dst-2', 'Dana agreed, confirm the ship date'))
    await extractor.runOnDrain([chunk], step)
    assert.deepEqual(todos.get('ses-1')!.items.map((i) => i.text), ['Send Dana the deck', 'Confirm ship date'])
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('TaskExtractor.runOnDrain: a session with no distillates/moments writes no to-do doc', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-todo-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const voice = new VoiceDocuments(store); voice.ensureDefaults()
    const templates = new ActDocuments(store); templates.ensureDefaults()
    const todos = new TodoDocuments(store)
    const session: Session = {
      id: 'ses-2', workspaceId: 'ws-1', modeId: 'mode-meeting', startedAt: at,
      attribution: { evidence: [{ kind: 'manual', detail: 'm', weight: 1 }], confidence: 1 },
    }
    store.saveSession(session)
    const extractor = new TaskExtractor({ store, voice, fabric: new FabricDocuments(store), templates, todos, mode: () => defaultMeetingMode, invoke: cannedInvoke('[]') })
    await extractor.runOnDrain([{ workspaceId: 'ws-1', sessionId: 'ses-2' } as never], step)
    assert.equal(todos.get('ses-2'), undefined)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
