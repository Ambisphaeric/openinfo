import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Block, QueryResult, TodoItem } from '@openinfo/contracts'
import { renderToHtml, type NowContext } from '../block-renderer/index.js'
import { stateDot, resolveStateVocab, DEFAULT_STATE_VOCAB } from '../block-renderer/micro-state.js'
import { glyphStrip, rowAffordances, GLYPH_VERBS } from './actions.js'
import { renderTodos } from './todos.js'

const NOW: NowContext = { live: true }
const renderTodosBlock = (block: Block, result: QueryResult): string => {
  const node = renderTodos({ block, result, now: NOW })
  return Array.isArray(node) ? node.map(renderToHtml).join('') : node ? renderToHtml(node) : ''
}

/**
 * #66 display-layer primitives: the field micro-state dot and the glyph verb strip. The load-bearing
 * property under test is HONESTY — no dot renders for a stateless item (nothing pretends to be reviewed),
 * and a glyph verb is live iff it can actually act.
 */

const todo = (id: string, text: string, extra: Partial<TodoItem> = {}): TodoItem => ({
  id, text, createdAt: '2026-07-07T14:40:00Z', ...extra,
})
const todoResult = (items: TodoItem[], suppressed?: number): QueryResult => ({
  source: 'todos', items, truncated: false, ...(suppressed !== undefined ? { suppressed } : {}),
})
// ---- micro-state dot: the honesty rule ----

test('dot honesty: an item with NO state renders NO dot (nothing pretends to be reviewed)', () => {
  const vocab = resolveStateVocab()
  assert.equal(stateDot(undefined, vocab), null)
  assert.equal(stateDot('', vocab), null)
  // and end-to-end through the todos block: a stateless row has no .dot span
  const out = renderTodosBlock({ block: 'todos' }, todoResult([todo('t1', 'Send the MSA')]))
  assert.match(out, /Send the MSA/)
  assert.doesNotMatch(out, /class="dot/)
})

test('dot renders with its vocabulary tone ONLY when the item carries a state', () => {
  const vocab = resolveStateVocab()
  assert.match(renderToHtml(stateDot('confirmed', vocab)!), /class="dot confirmed" title="confirmed"/)
  assert.match(renderToHtml(stateDot('provisional', vocab)!), /class="dot provisional"/)
  assert.match(renderToHtml(stateDot('corrected', vocab)!), /class="dot corrected"/)
  // through the block: a stated item paints its dot before the title
  const out = renderTodosBlock({ block: 'todos' }, todoResult([todo('t1', 'Send the MSA', { state: 'confirmed' })]))
  assert.match(out, /class="dot confirmed" title="confirmed"><\/span>Send the MSA/)
})

test('an item whose state is not in the vocabulary still shows a dot (a real signal is never dropped) — neutral tone', () => {
  const vocab = resolveStateVocab()
  assert.match(renderToHtml(stateDot('needs-legal', vocab)!), /class="dot unknown" title="needs-legal"/)
})

test('the state vocabulary is document-configurable: block.states REPLACES the default', () => {
  const states: Block['states'] = [
    { key: 'approved', tone: 'confirmed' },
    { key: 'denied', tone: 'corrected' },
  ]
  const vocab = resolveStateVocab(states)
  assert.match(renderToHtml(stateDot('approved', vocab)!), /class="dot confirmed"/)
  assert.match(renderToHtml(stateDot('denied', vocab)!), /class="dot corrected"/)
  // a default-vocab key is NOT recognized under the overridden vocab → neutral dot (replace, not merge)
  assert.match(renderToHtml(stateDot('provisional', vocab)!), /class="dot unknown"/)
  assert.deepEqual([...DEFAULT_STATE_VOCAB].map((s) => s.key), ['provisional', 'confirmed', 'corrected'])
})

// ---- glyph verb strip: configurable set, live iff it can act ----

test('verb strip config: the strip renders the block’s glyph verbs; dismiss is live with a payload, inert without', () => {
  const actions: NonNullable<Block['actions']> = [
    { id: 'd', label: 'Dismiss', verb: 'dismiss', params: {} },
    { id: 'p', label: 'Pin', verb: 'pin', params: {} },
    { id: 'f', label: 'Follow up', verb: 'mark-for-follow-up', params: {} },
  ]
  // with a dismiss payload: dismiss is a live .gverb carrying its write coordinates; pin/follow-up stay ghost
  const live = renderToHtml(glyphStrip(actions, { dismiss: { workspaceId: 'ws', source: 'todos', itemId: 't1' } })!)
  assert.match(live, /class="glyphs"/)
  assert.match(live, /<button class="gverb" data-verb="dismiss" data-action="d" title="Dismiss" data-workspace="ws" data-source="todos" data-item="t1">✕<\/button>/)
  assert.match(live, /<button class="gverb ghost" data-verb="pin" data-action="p" title="Pin">⊚<\/button>/)
  assert.match(live, /<button class="gverb ghost" data-verb="mark-for-follow-up" data-action="f" title="Follow up">⚑<\/button>/)

  // no dismiss payload: dismiss is honestly inert (ghost, no data-item) — never a falsely-live button
  const inert = renderToHtml(glyphStrip(actions, {})!)
  assert.match(inert, /<button class="gverb ghost" data-verb="dismiss" data-action="d" title="Dismiss">✕<\/button>/)
})

test('verb strip config: a block with no glyph verbs renders no strip', () => {
  const actions: NonNullable<Block['actions']> = [{ id: 'c', label: 'Copy', verb: 'copy', params: {} }]
  assert.equal(glyphStrip(actions), null)
  // rowAffordances partitions: copy → text .mini button, glyph verbs → the strip
  const both = rowAffordances(
    [...actions, { id: 'd', label: 'Dismiss', verb: 'dismiss', params: {} }],
    'copy me',
    { dismiss: { workspaceId: 'ws', source: 'todos', itemId: 't1' } },
  )
  const rendered = both.map(renderToHtml).join('')
  assert.match(rendered, /<button class="mini" data-verb="copy"/) // text verb stays a mini button
  assert.match(rendered, /class="glyphs"><button class="gverb" data-verb="dismiss"/) // glyph verb in the strip
  assert.deepEqual(Object.keys(GLYPH_VERBS), ['dismiss', 'pin', 'mark-for-follow-up'])
})

// ---- empty-state disclosure: a block emptied by suppression explains itself ----

test('empty-state disclosure: a to-do block emptied purely by dismissal says so (explainable, not mysterious)', () => {
  const out = renderTodosBlock({ block: 'todos' }, todoResult([], 2))
  assert.match(out, /No follow-ups shown/)
  assert.match(out, /2 follow-ups dismissed/)
  // singular
  const one = renderTodosBlock({ block: 'todos' }, todoResult([], 1))
  assert.match(one, /1 follow-up dismissed/)
  // genuinely empty (nothing suppressed) keeps the original "found nothing" copy — no false disclosure
  const empty = renderTodosBlock({ block: 'todos' }, todoResult([]))
  assert.match(empty, /No follow-ups yet/)
  assert.match(empty, /task-extract has found no follow-ups/)
})
