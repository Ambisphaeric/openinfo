import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TodoList, WorkspaceHints } from '@openinfo/contracts'
import { wireActions, type ActionHandlers, type MountTarget } from '../block-renderer/index.js'
import { markTodoDone, acceptHintCandidate, dismissItem, submitEntityCorrection } from './dev-entry.js'

/**
 * The FIRST driven coverage over the wired action verbs (#15): mark-done and accept. Two layers —
 * (1) a DOM-level test that mounts the delegated listener, dispatches a click on each verb, and asserts
 *     the injected handler is called with the payload read off the button AND that a failed write paints
 *     visible failure text (never a silent no-op); and
 * (2) a served e2e that wires the REAL dev-entry write orchestrators through real `fetch` against a live
 *     throwaway HTTP engine, proving the write ROUND-TRIPS over the wire (mark-done flips `done` on the
 *     stored list; accept appends the pattern to the workspace's hints) and that a 500 surfaces as text.
 */

// ---- DOM harness (mirrors copy-feedback.test.ts: a structural target + a dispatchable button) ----
interface ActionButton {
  textContent: string
  className: string
  getAttribute(name: string): string | null
}
const makeStage = (): { target: MountTarget; clickButton: (button: ActionButton) => void } => {
  let handler: ((event: { target: { closest(sel: string): ActionButton | null } | null }) => void) | undefined
  const target = {
    innerHTML: '',
    addEventListener: (_type: 'click', h: typeof handler) => {
      handler = h
    },
  }
  return {
    target: target as unknown as MountTarget,
    clickButton: (button) => handler?.({ target: { closest: () => button } }),
  }
}
const makeButton = (attrs: Record<string, string>, label: string, className = 'mini'): ActionButton => ({
  textContent: label,
  className,
  getAttribute: (name) => attrs[name] ?? null,
})
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const eventually = async (fn: () => void): Promise<void> => {
  for (let i = 0; i < 200; i++) {
    try {
      fn()
      return
    } catch {
      await sleep(10)
    }
  }
  fn()
}

test('mark-done click calls its handler with the button payload, and a rejected write paints "Failed"', async () => {
  const calls: Array<{ sessionId: string; todoId: string }> = []
  const { target, clickButton } = makeStage()
  const handlers: ActionHandlers = {
    copy: () => undefined,
    markDone: async (payload) => void calls.push(payload),
    accept: async () => undefined,
  }
  wireActions(target, handlers)

  const ok = makeButton({ 'data-verb': 'mark-done', 'data-session': 'ses-1', 'data-todo': 't1' }, 'Mark done')
  clickButton(ok)
  await flush()
  assert.deepEqual(calls, [{ sessionId: 'ses-1', todoId: 't1' }]) // the exact payload reached the handler
  assert.equal(ok.textContent, 'Done')
  assert.match(ok.className, /\bcopied\b/)

  // an inert mark-done button (no data-session, e.g. a hand-added item) never calls the handler
  clickButton(makeButton({ 'data-verb': 'mark-done', 'data-todo': 't9' }, 'Done', 'mini ghost'))
  await flush()
  assert.equal(calls.length, 1) // unchanged — honestly inert, not a silent misfire

  // a rejected write paints visible failure text, never a silent no-op
  const failStage = makeStage()
  wireActions(failStage.target, { copy: () => undefined, markDone: async () => Promise.reject(new Error('boom')) })
  const bad = makeButton({ 'data-verb': 'mark-done', 'data-session': 'ses-1', 'data-todo': 't1' }, 'Mark done')
  failStage.clickButton(bad)
  await flush()
  assert.equal(bad.textContent, 'Failed')
  assert.match(bad.className, /\bcopyfail\b/)
})

test('accept click calls its handler with the workspace + pattern payload, and a rejected write paints "Failed"', async () => {
  const calls: Array<{ workspaceId: string; pattern: string }> = []
  const { target, clickButton } = makeStage()
  wireActions(target, { copy: () => undefined, accept: async (payload) => void calls.push(payload) })

  const pattern = JSON.stringify({ field: 'windowTitle', contains: 'Renewal', weight: 0.9 })
  const btn = makeButton({ 'data-verb': 'accept', 'data-workspace': 'sales', 'data-pattern': pattern }, 'Accept')
  clickButton(btn)
  await flush()
  assert.deepEqual(calls, [{ workspaceId: 'sales', pattern }])
  assert.equal(btn.textContent, 'Accepted')

  const failStage = makeStage()
  wireActions(failStage.target, { copy: () => undefined, accept: async () => Promise.reject(new Error('nope')) })
  const bad = makeButton({ 'data-verb': 'accept', 'data-workspace': 'sales', 'data-pattern': pattern }, 'Accept')
  failStage.clickButton(bad)
  await flush()
  assert.equal(bad.textContent, 'Failed')
})

test('dismiss click calls its handler with the item payload, and a rejected write paints failure (#66)', async () => {
  const calls: Array<{ workspaceId: string; source: string; itemId: string }> = []
  const { target, clickButton } = makeStage()
  wireActions(target, { copy: () => undefined, dismiss: async (payload) => void calls.push(payload) })

  const glyph = makeButton(
    { 'data-verb': 'dismiss', 'data-workspace': 'ws', 'data-source': 'todos', 'data-item': 't1' }, '✕', 'gverb',
  )
  clickButton(glyph)
  await flush()
  assert.deepEqual(calls, [{ workspaceId: 'ws', source: 'todos', itemId: 't1' }]) // exact payload off the glyph
  assert.equal(glyph.textContent, '✓')

  // an inert dismiss glyph (no data-item — pin/follow-up or an unaddressable row) never calls the handler
  clickButton(makeButton({ 'data-verb': 'dismiss', 'data-workspace': 'ws', 'data-source': 'todos' }, '✕', 'gverb ghost'))
  await flush()
  assert.equal(calls.length, 1) // unchanged — honestly inert, not a silent misfire

  const failStage = makeStage()
  wireActions(failStage.target, { copy: () => undefined, dismiss: async () => Promise.reject(new Error('boom')) })
  const bad = makeButton({ 'data-verb': 'dismiss', 'data-workspace': 'ws', 'data-source': 'todos', 'data-item': 't1' }, '✕', 'gverb')
  failStage.clickButton(bad)
  await flush()
  assert.equal(bad.textContent, '!')
  assert.match(bad.className, /\bcopyfail\b/)
})

// ---- served e2e: a live throwaway engine implementing the write routes over real fetch ----
interface StoredSignal { workspaceId: string; source: string; itemId: string; kind: string; at: string }
interface StoredCorrection { workspaceId: string; entityId: string; heard: string; verdict: string; rivalId?: string; rivalName?: string }
interface FakeEngine {
  baseUrl: string
  todos: Map<string, TodoList>
  hints: Map<string, WorkspaceHints>
  signals: StoredSignal[]
  corrections: StoredCorrection[]
  putStatus: number // the status the PUT/POST write routes return (200 = success; set to 500 to force failure)
  close: () => Promise<void>
}
const readBody = async (req: IncomingMessage): Promise<string> => {
  let body = ''
  for await (const chunk of req) body += chunk
  return body
}
const startFakeEngine = async (): Promise<FakeEngine> => {
  const engine: Partial<FakeEngine> = { todos: new Map(), hints: new Map(), signals: [], corrections: [], putStatus: 200 }
  const send = (res: ServerResponse, status: number, payload: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  }
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x')
      const todo = url.pathname.match(/^\/todos\/([^/]+)$/)
      const hint = url.pathname.match(/^\/hints\/([^/]+)$/)
      if (req.method === 'GET' && todo) {
        const list = engine.todos!.get(decodeURIComponent(todo[1]!))
        return list ? send(res, 200, list) : send(res, 404, { error: 'no such list' })
      }
      if (req.method === 'PUT' && todo) {
        if (engine.putStatus !== 200) return send(res, engine.putStatus!, { error: 'forced failure' })
        const list = JSON.parse(await readBody(req)) as TodoList
        engine.todos!.set(decodeURIComponent(todo[1]!), list)
        return send(res, 200, list)
      }
      if (req.method === 'GET' && hint) {
        const doc = engine.hints!.get(decodeURIComponent(hint[1]!))
        return doc ? send(res, 200, doc) : send(res, 404, { error: 'no hints doc' })
      }
      if (req.method === 'PUT' && hint) {
        if (engine.putStatus !== 200) return send(res, engine.putStatus!, { error: 'forced failure' })
        const doc = JSON.parse(await readBody(req)) as WorkspaceHints
        engine.hints!.set(decodeURIComponent(hint[1]!), doc)
        return send(res, 200, doc)
      }
      if (req.method === 'POST' && url.pathname === '/item-signals') {
        if (engine.putStatus !== 200) return send(res, engine.putStatus!, { error: 'forced failure' })
        const body = JSON.parse(await readBody(req)) as Omit<StoredSignal, 'at'>
        const stamped: StoredSignal = { ...body, at: new Date().toISOString() } // engine stamps `at`
        engine.signals!.push(stamped)
        return send(res, 200, stamped)
      }
      if (req.method === 'POST' && url.pathname === '/teach/entity') {
        if (engine.putStatus !== 200) return send(res, engine.putStatus!, { error: 'forced failure' })
        const body = JSON.parse(await readBody(req)) as StoredCorrection
        engine.corrections!.push(body)
        // the real engine responds with the settled entity; the client only needs a 200 for the paint
        return send(res, 200, { id: body.entityId, workspaceId: body.workspaceId, kind: 'artifact', name: body.heard, aliases: [], momentRefs: [], outboundCount: 0, firstSeen: '2026-07-10T00:00:00Z', lastSeen: '2026-07-10T00:00:00Z', state: 'confirmed' })
      }
      send(res, 404, { error: 'not found' })
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  if (!address || typeof address !== 'object') throw new Error('no server address')
  engine.baseUrl = `http://127.0.0.1:${address.port}`
  engine.close = () => new Promise<void>((resolve) => server.close(() => resolve()))
  return engine as FakeEngine
}

test('served e2e: a mark-done click flips `done` on the stored list over the live server and paints "Done"', async () => {
  const engine = await startFakeEngine()
  try {
    engine.todos.set('ses-1', {
      id: 'ses-1', name: 'to-do', version: 3, sessionId: 'ses-1', workspaceId: 'ws',
      items: [
        { id: 't1', text: 'Send Dana the MSA', createdAt: '2026-07-07T14:40:00Z' },
        { id: 't2', text: 'Book the walkthrough', done: true, createdAt: '2026-07-07T14:41:00Z' },
      ],
    })
    const { target, clickButton } = makeStage()
    wireActions(target, { copy: () => undefined, markDone: markTodoDone(engine.baseUrl) })

    const button = makeButton({ 'data-verb': 'mark-done', 'data-session': 'ses-1', 'data-todo': 't1' }, 'Mark done')
    clickButton(button)

    await eventually(() => assert.equal(button.textContent, 'Done')) // real round-trip resolved → success paint
    const stored = engine.todos.get('ses-1')!
    assert.equal(stored.items.find((i) => i.id === 't1')!.done, true) // t1 flipped over the wire
    assert.equal(stored.items.find((i) => i.id === 't2')!.done, true) // t2 untouched
  } finally {
    await engine.close()
  }
})

test('served e2e: an accept click appends the candidate pattern to the workspace hints over the live server', async () => {
  const engine = await startFakeEngine()
  try {
    // the workspace has no hints doc yet → GET 404 → the orchestrator starts a fresh doc and PUTs it
    const pattern = { field: 'windowTitle', contains: 'Renewal — security review', weight: 0.9 }
    const { target, clickButton } = makeStage()
    wireActions(target, { copy: () => undefined, accept: acceptHintCandidate(engine.baseUrl) })

    const button = makeButton(
      { 'data-verb': 'accept', 'data-workspace': 'sales', 'data-pattern': JSON.stringify(pattern) },
      'Accept',
    )
    clickButton(button)

    await eventually(() => assert.equal(button.textContent, 'Accepted'))
    const doc = engine.hints.get('sales')!
    assert.deepEqual(doc, { workspaceId: 'sales', patterns: [pattern] }) // pattern applied over the wire
  } finally {
    await engine.close()
  }
})

test('served e2e: a dismiss click writes a suppression record to the live server and paints success (#66)', async () => {
  const engine = await startFakeEngine()
  try {
    const { target, clickButton } = makeStage()
    wireActions(target, { copy: () => undefined, dismiss: dismissItem(engine.baseUrl) })

    const glyph = makeButton(
      { 'data-verb': 'dismiss', 'data-workspace': 'sales', 'data-source': 'todos', 'data-item': 't1' }, '✕', 'gverb',
    )
    clickButton(glyph)

    await eventually(() => assert.equal(glyph.textContent, '✓')) // real round-trip resolved → success paint
    assert.equal(engine.signals.length, 1)
    assert.deepEqual(
      { workspaceId: engine.signals[0]!.workspaceId, source: engine.signals[0]!.source, itemId: engine.signals[0]!.itemId, kind: engine.signals[0]!.kind },
      { workspaceId: 'sales', source: 'todos', itemId: 't1', kind: 'dismiss' }, // the suppression record persisted over the wire
    )
  } finally {
    await engine.close()
  }
})

test('served e2e: a failed dismiss (HTTP 500) surfaces as visible failure — never a silent swallow (#66)', async () => {
  const engine = await startFakeEngine()
  try {
    engine.putStatus = 500
    const { target, clickButton } = makeStage()
    wireActions(target, { copy: () => undefined, dismiss: dismissItem(engine.baseUrl) })
    const glyph = makeButton({ 'data-verb': 'dismiss', 'data-workspace': 'ws', 'data-source': 'todos', 'data-item': 't1' }, '✕', 'gverb')
    clickButton(glyph)
    await eventually(() => assert.equal(glyph.textContent, '!'))
    assert.match(glyph.className, /\bcopyfail\b/)
    assert.equal(engine.signals.length, 0) // nothing persisted on a failed write
  } finally {
    await engine.close()
  }
})

test('served e2e: a failed write (HTTP 500) surfaces as visible "Failed" text — never a silent swallow', async () => {
  const engine = await startFakeEngine()
  try {
    engine.todos.set('ses-1', {
      id: 'ses-1', name: 'to-do', version: 1, sessionId: 'ses-1', workspaceId: 'ws',
      items: [{ id: 't1', text: 'x', createdAt: '2026-07-07T14:40:00Z' }],
    })
    engine.putStatus = 500 // the PUT will fail
    const { target, clickButton } = makeStage()
    wireActions(target, { copy: () => undefined, markDone: markTodoDone(engine.baseUrl) })

    const button = makeButton({ 'data-verb': 'mark-done', 'data-session': 'ses-1', 'data-todo': 't1' }, 'Mark done')
    clickButton(button)
    await eventually(() => assert.equal(button.textContent, 'Failed'))
    assert.match(button.className, /\bcopyfail\b/)
  } finally {
    await engine.close()
  }
})

test('clarify-confirm/rival click posts the verdict payload and paints ✓; a rejected write paints failure (#75)', async () => {
  const calls: Array<{ workspaceId: string; entityId: string; heard: string; verdict: string; rivalId?: string; rivalName?: string }> = []
  const { target, clickButton } = makeStage()
  const opened: string[] = []
  const dismissed: string[] = []
  wireActions(target, {
    copy: () => undefined,
    clarify: async (payload) => void calls.push(payload),
    clarifyOpen: (id) => void opened.push(id),
    clarifyDismiss: (id) => void dismissed.push(id),
  })

  // opening the ask is client-local (no write) — the injected callback fires, nothing is posted
  clickButton(makeButton({ 'data-verb': 'clarify-open', 'data-entity': 'ent-1' }, '≟', 'gverb'))
  await flush()
  assert.deepEqual(opened, ['ent-1'])
  assert.equal(calls.length, 0)

  // confirm posts verdict=confirm with the payload read off the button, and paints ✓
  const ok = makeButton(
    { 'data-verb': 'clarify-confirm', 'data-workspace': 'ws', 'data-entity': 'ent-1', 'data-heard': 'Mercury', 'data-rival-id': 'ent-2', 'data-rival-name': 'Mercury Bank' },
    'Mercury', 'clarify-choice ok',
  )
  clickButton(ok)
  await flush()
  assert.deepEqual(calls, [{ workspaceId: 'ws', entityId: 'ent-1', heard: 'Mercury', verdict: 'confirm', rivalId: 'ent-2', rivalName: 'Mercury Bank' }])
  assert.equal(ok.textContent, '✓')

  // the rival choice posts verdict=disambiguate
  clickButton(makeButton(
    { 'data-verb': 'clarify-rival', 'data-workspace': 'ws', 'data-entity': 'ent-1', 'data-heard': 'Mercury', 'data-rival-id': 'ent-2', 'data-rival-name': 'Mercury Bank' },
    'Mercury Bank', 'clarify-choice',
  ))
  await flush()
  assert.equal(calls[1]!.verdict, 'disambiguate')

  // dismiss is client-local too (ask me later) — the callback fires, nothing is posted
  clickButton(makeButton({ 'data-verb': 'clarify-dismiss', 'data-entity': 'ent-1' }, '✕', 'gverb'))
  await flush()
  assert.deepEqual(dismissed, ['ent-1'])
  assert.equal(calls.length, 2) // unchanged

  // a rejected write paints visible failure, never a silent no-op
  const failStage = makeStage()
  wireActions(failStage.target, { copy: () => undefined, clarify: async () => Promise.reject(new Error('boom')) })
  const bad = makeButton({ 'data-verb': 'clarify-confirm', 'data-workspace': 'ws', 'data-entity': 'ent-1', 'data-heard': 'Mercury' }, 'Mercury', 'clarify-choice ok')
  failStage.clickButton(bad)
  await flush()
  assert.equal(bad.textContent, '!')
  assert.match(bad.className, /\bcopyfail\b/)
})

test('served e2e: a clarify confirm writes the correction over the live server and paints ✓ (#75)', async () => {
  const engine = await startFakeEngine()
  try {
    const { target, clickButton } = makeStage()
    wireActions(target, { copy: () => undefined, clarify: submitEntityCorrection(engine.baseUrl) })
    const button = makeButton(
      { 'data-verb': 'clarify-confirm', 'data-workspace': 'ws', 'data-entity': 'ent-1', 'data-heard': 'Mercury', 'data-rival-id': 'ent-2', 'data-rival-name': 'Mercury Bank' },
      'Mercury', 'clarify-choice ok',
    )
    clickButton(button)
    await eventually(() => assert.equal(button.textContent, '✓')) // real round-trip resolved → success paint
    assert.equal(engine.corrections.length, 1)
    assert.deepEqual(engine.corrections[0], { workspaceId: 'ws', entityId: 'ent-1', heard: 'Mercury', verdict: 'confirm', rivalId: 'ent-2', rivalName: 'Mercury Bank' })
  } finally {
    await engine.close()
  }
})

test('served e2e: a failed clarify write (HTTP 500) surfaces as visible failure — never a silent swallow (#75)', async () => {
  const engine = await startFakeEngine()
  try {
    engine.putStatus = 500
    const { target, clickButton } = makeStage()
    wireActions(target, { copy: () => undefined, clarify: submitEntityCorrection(engine.baseUrl) })
    const button = makeButton({ 'data-verb': 'clarify-confirm', 'data-workspace': 'ws', 'data-entity': 'ent-1', 'data-heard': 'Mercury' }, 'Mercury', 'clarify-choice ok')
    clickButton(button)
    await eventually(() => assert.equal(button.textContent, '!'))
    assert.match(button.className, /\bcopyfail\b/)
    assert.equal(engine.corrections.length, 0) // nothing persisted on a failed write
  } finally {
    await engine.close()
  }
})
