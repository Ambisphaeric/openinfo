import type { Block, TodoItem } from '@openinfo/contracts'
import { h, type VNode } from '../block-renderer/vnode.js'
import type { BlockRenderer } from '../block-renderer/registry.js'
import { actionButtons } from './actions.js'

type Actions = NonNullable<Block['actions']>

const LABEL = 'To-do · this session'

/**
 * The `todos` block — the accumulated follow-up list (task-extract, P4). It reads the hydrated `todos`
 * query (`source: 'todos'`, one row per TodoItem, in accumulation order — see #9) and renders each item
 * with its STATUS (checked-off items are struck and marked ✓; open items ○) and a one-line WHY built
 * from the item's provenance: an item the extraction pass distilled out of the meeting (a distillate or
 * moment behind it) reads "from the meeting", a hand-added item reads "added by you" (the constrain /
 * unconstrain loop's two authors — TodoProvenance's own note). Empty is EXPLAINABLE, never silent: an
 * always-visible block with no items renders a "no follow-ups yet" line rather than a blank card (an
 * `on-match` block just stays hidden, since renderSurface drops it before this runs). `top` caps the
 * list like the sibling list blocks (HUD shows top-K; the workbench holds the rest).
 */
const isExtracted = (item: TodoItem): boolean =>
  item.provenance?.distillateId !== undefined || item.provenance?.momentId !== undefined

const whyLine = (item: TodoItem): string => {
  const origin = isExtracted(item) ? 'from the meeting' : 'added by you'
  return item.done === true ? `done · ${origin}` : origin
}

const todoRow = (item: TodoItem, actions: Actions): VNode => {
  const done = item.done === true
  // mark-done addresses PUT /todos/:sessionId. The flattened query row keeps the item's provenance, and
  // the extraction pass stamps `provenance.sessionId` on every item it distils (act/todo composeTaskExtract);
  // an item lacking it (a hand-added row with no session trail) leaves the verb inert rather than firing a
  // write it can't address — honest, not falsely live (#15).
  const sessionId = item.provenance?.sessionId
  const markDone = sessionId !== undefined ? { sessionId, todoId: item.id } : undefined
  return h(
    'div',
    { class: 'rel' },
    h('span', { class: `mk ${done ? 'c' : 'q'}` }, done ? '✓' : '○'),
    h(
      'span',
      { class: 'body' },
      h('span', { class: done ? 'ttl done' : 'ttl' }, item.text),
      h('span', { class: 'why' }, whyLine(item)),
    ),
    h('span', { class: 'go' }, ...actionButtons(actions, item.text, { markDone })),
  )
}

const emptyRow = (): VNode =>
  h(
    'div',
    { class: 'rel' },
    h('span', { class: 'mk q' }, '○'),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, 'No follow-ups yet'),
      h('span', { class: 'why' }, 'task-extract has found no follow-ups this session'),
    ),
  )

export const renderTodos: BlockRenderer = ({ block, result }) => {
  if (block.collapsed) return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, LABEL))
  const actions = block.actions ?? []
  const all = (result?.items ?? []) as TodoItem[]
  const items = block.top !== undefined ? all.slice(0, block.top) : all
  const rows: VNode[] = items.length > 0 ? items.map((item) => todoRow(item, actions)) : [emptyRow()]
  return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, LABEL), ...rows)
}
