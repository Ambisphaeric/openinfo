import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { QueryResult, Surface, TodoItem } from '@openinfo/contracts'
import { renderSurface, renderToHtml, type NowContext } from '../block-renderer/index.js'
import { defaultBlockRegistry } from './index.js'

const now: NowContext = { live: true, workspace: 'acme', title: 'Renewal — security review' }
const result = (items: unknown[]): QueryResult => ({ source: 'todos', items, truncated: false })

const todo = (id: string, text: string, extra: Partial<TodoItem> = {}): TodoItem => ({
  id, text, createdAt: '2026-07-07T14:40:00Z', ...extra,
})

const surface: Surface = {
  id: 's', name: 's', context: 'meeting', version: 1,
  stack: [
    { block: 'now' },
    {
      block: 'todos', show: 'always',
      query: { source: 'todos', params: { session: 'current' } },
      actions: [
        { id: 'a-copy', label: 'Copy', verb: 'copy', params: {} },
        { id: 'a-done', label: 'Done', verb: 'mark-done', params: {} },
      ],
    },
  ],
}

test('the todos block renders STORE-DERIVED items: text, done status and a provenance why-line', () => {
  // The render half of the todos slice (#9): the renderer reads the hydrated `result.items` (the
  // to-do documents the engine flattened from the store), NOT anything static in the block config. The
  // seeded item text below is the proof of provenance — it can only come from the query result.
  const items = [
    todo('t1', 'Send Dana the signed MSA', { provenance: { sessionId: 'ses', distillateId: 'dst-9' } }),
    todo('t2', 'Book the SOC 2 walkthrough', { done: true, provenance: { sessionId: 'ses', momentId: 'mom-3' } }),
    todo('t3', 'Ping legal about redlines'), // no provenance ⇒ user-added
  ]
  const html = renderToHtml(
    renderSurface({ surface, now, results: [undefined, result(items)] }, defaultBlockRegistry),
  )

  assert.match(html, /To-do · this session/) // the block's group label
  // store-derived item text (only reachable via result.items)
  assert.match(html, /Send Dana the signed MSA/)
  assert.match(html, /Book the SOC 2 walkthrough/)
  assert.match(html, /Ping legal about redlines/)
  // STATUS: an open item marks ○, a done item marks ✓ and is struck (class "ttl done")
  assert.match(html, /class="mk q">○/)
  assert.match(html, /class="mk c">✓/)
  assert.match(html, /class="ttl done">Book the SOC 2 walkthrough/)
  // WHY-line derived from provenance: extracted items read "from the meeting", hand-added "added by you"
  assert.match(html, /class="why">from the meeting/)
  assert.match(html, /class="why">done · from the meeting/) // the done item carries its status in the why
  assert.match(html, /class="why">added by you/)
  // the copy action carries the item text (verbs never send — the app prepares)
  assert.match(html, /data-copy="Send Dana the signed MSA"/)
  // mark-done is WIRED (#15): an item whose provenance carries its session renders a LIVE `.mini` button
  // addressing PUT /todos/:sessionId (data-session + data-todo — the read-flip-write key).
  assert.match(html, /<button class="mini" data-verb="mark-done" data-action="a-done" data-session="ses" data-todo="t1">Done<\/button>/)
  // an item with NO session trail (hand-added, t3) leaves mark-done visible-but-INERT (ghost, no payload) —
  // it can't address a write, so it is honestly inert rather than a falsely-live button (#15).
  assert.match(html, /<button class="mini ghost" data-verb="mark-done" data-action="a-done">Done<\/button>/)
})

test('empty is EXPLAINABLE, not silent: an always-visible todos block renders a no-follow-ups line', () => {
  const html = renderToHtml(
    renderSurface({ surface, now, results: [undefined, result([])] }, defaultBlockRegistry),
  )
  assert.match(html, /To-do · this session/) // the block still renders its label
  assert.match(html, /No follow-ups yet/)
  assert.match(html, /task-extract has found no follow-ups this session/) // the explainable why
})

test('top caps the rendered rows, and an on-match empty todos block stays hidden', () => {
  const items = [todo('t1', 'first'), todo('t2', 'second'), todo('t3', 'third')]
  const capped: Surface = {
    ...surface,
    stack: [{ block: 'now' }, { block: 'todos', top: 2, query: { source: 'todos', params: {} } }],
  }
  const html = renderToHtml(renderSurface({ surface: capped, now, results: [undefined, result(items)] }, defaultBlockRegistry))
  assert.match(html, /first/)
  assert.match(html, /second/)
  assert.doesNotMatch(html, /third/) // 3rd row cut by top:2

  // on-match + zero items → renderSurface drops the block before the renderer runs (explainable-empty)
  const onMatch: Surface = {
    ...surface,
    stack: [{ block: 'now' }, { block: 'todos', show: 'on-match', query: { source: 'todos', params: {} } }],
  }
  const hidden = renderToHtml(renderSurface({ surface: onMatch, now, results: [undefined, result([])] }, defaultBlockRegistry))
  assert.doesNotMatch(hidden, /To-do · this session/)
})
