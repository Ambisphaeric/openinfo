import type { Block, TodoItem } from '@openinfo/contracts'
import { h, type VNode } from '../block-renderer/vnode.js'
import type { BlockRenderer } from '../block-renderer/registry.js'
import { stateDot, resolveStateVocab, type StateVocab } from '../block-renderer/micro-state.js'
import { rowAffordances, type ActionPayload } from './actions.js'

type Actions = NonNullable<Block['actions']>
/** The workspace + source a row's dismiss glyph addresses (the item id is added per row). */
type DismissBase = { workspaceId: string; source: string }

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

const todoRow = (item: TodoItem, actions: Actions, vocab: StateVocab, dismissBase: DismissBase): VNode => {
  const done = item.done === true
  // mark-done addresses PUT /todos/:sessionId. The flattened query row keeps the item's provenance, and
  // the extraction pass stamps `provenance.sessionId` on every item it distils (act/todo composeTaskExtract);
  // an item lacking it (a hand-added row with no session trail) leaves the verb inert rather than firing a
  // write it can't address — honest, not falsely live (#15).
  const sessionId = item.provenance?.sessionId
  const markDone = sessionId !== undefined ? { sessionId, todoId: item.id } : undefined
  // dismiss (#66): every row is addressable (source + workspace + the item's stable id), so the glyph is
  // live wherever the block configures a `dismiss` action. The micro-state dot renders ONLY when the item
  // carries a `state` — nothing pretends to be reviewed (no judge stamps one yet, so today it stays absent).
  const dismiss: ActionPayload['dismiss'] = { ...dismissBase, itemId: item.id }
  return h(
    'div',
    { class: 'rel' },
    h('span', { class: `mk ${done ? 'c' : 'q'}` }, done ? '✓' : '○'),
    h(
      'span',
      { class: 'body' },
      h('span', { class: done ? 'ttl done' : 'ttl' }, stateDot(item.state, vocab), item.text),
      h('span', { class: 'why' }, whyLine(item)),
    ),
    h('span', { class: 'go' }, ...rowAffordances(actions, item.text, { markDone, dismiss })),
  )
}

/**
 * The empty state, EXPLAINABLE not silent. Three honest truths, told apart (#215/hud-voice):
 *  - NO session running (`noCurrentSession`, #210): the list is empty because nothing is capturing yet —
 *    say so and what to do (start a session), NOT "found nothing this session" which would imply one is live.
 *  - emptied by DISMISSAL (#66): disclose "N dismissed" rather than implying task-extract found nothing.
 *  - a live session that has genuinely produced no follow-ups yet: the original "nothing this session" line.
 * A block never mysteriously disappears, and never fakes a running session.
 */
const emptyRow = (suppressed: number, noSession: boolean): VNode => {
  const [title, why] = noSession
    ? ['No session running', 'follow-ups collect here once you start a session']
    : suppressed > 0
      ? ['No follow-ups shown', `${suppressed} follow-up${suppressed === 1 ? '' : 's'} dismissed — nothing else to show`]
      : ['No follow-ups yet', 'task-extract has found no follow-ups this session']
  return h(
    'div',
    { class: 'rel' },
    h('span', { class: 'mk q' }, '○'),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, title),
      h('span', { class: 'why' }, why),
    ),
  )
}

export const renderTodos: BlockRenderer = ({ block, result }) => {
  if (block.collapsed) return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, LABEL))
  const actions = block.actions ?? []
  const vocab = resolveStateVocab(block.states)
  const source = block.query?.source ?? 'todos'
  const workspaceParam = block.query?.params?.['workspace']
  const workspaceId = typeof workspaceParam === 'string' ? workspaceParam : 'default'
  const dismissBase: DismissBase = { workspaceId, source }
  const all = (result?.items ?? []) as TodoItem[]
  const items = block.top !== undefined ? all.slice(0, block.top) : all
  const rows: VNode[] =
    items.length > 0 ? items.map((item) => todoRow(item, actions, vocab, dismissBase)) : [emptyRow(result?.suppressed ?? 0, result?.noCurrentSession === true)]
  return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, LABEL), ...rows)
}
