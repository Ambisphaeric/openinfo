import type { Block, Distillate } from '@openinfo/contracts'
import { h, type VNode } from '../block-renderer/vnode.js'
import type { BlockRenderer } from '../block-renderer/registry.js'
import { clockLabel } from '../block-renderer/format.js'
import { actionButtons } from './actions.js'

type Actions = NonNullable<Block['actions']>

const LABEL = 'Transcript · distillate stream'

/**
 * The `distillates` block — the transcript/distillate STREAM on a panel (#12). It reads the hydrated
 * `distillates` query (`source: 'distillates'`, newest-first, workspace/session-scoped) and renders one
 * timestamped row per Distillate: the merge-window's distilled text with its clock label and a `.why`
 * line phrased for a HUMAN (#117/#118) — what the row is (distilled from this session's capture), never
 * the endpoint id that produced it. The clock already leads the row, so the why does not repeat it. The
 * machine trail stays RECORDED on the distillate's provenance (product principle 1: every summary is
 * inspectable back to what produced it) and reachable on diagnostics surfaces and the ledger — it is
 * simply not this tier's job to render it. The stream renders DISTILLATES — the persisted, queryable
 * substance of the pipeline:
 * raw pre-distill transcripts are transient (the stt stage rewrites audio to text in-flight with no
 * persistence path), so the durable stream to put on a panel is the distilled-window text, which is also
 * what feeds moments/entities downstream. Ordering mirrors the moments arm (newest first — the compiler
 * reverses). `top` caps like the sibling list blocks. Empty is EXPLAINABLE, not silent: an always-visible
 * block with no windows renders a "no distilled windows yet" line rather than a blank card; an `on-match`
 * block just stays hidden.
 */
const streamRow = (distillate: Distillate, actions: Actions): VNode =>
  h(
    'div',
    { class: 'rel' },
    h('span', { class: 'mk t' }, clockLabel(distillate.windowEnd)),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, distillate.text),
      h('span', { class: 'why' }, 'distilled from capture'),
    ),
    h('span', { class: 'go' }, ...actionButtons(actions, distillate.text)),
  )

const emptyRow = (): VNode =>
  h(
    'div',
    { class: 'rel' },
    h('span', { class: 'mk t' }, '—'),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, 'No distilled windows yet'),
      h('span', { class: 'why' }, 'the distillate stream fills as capture is distilled this session'),
    ),
  )

export const renderDistillates: BlockRenderer = ({ block, result }) => {
  if (block.collapsed) return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, LABEL))
  const actions = block.actions ?? []
  const all = (result?.items ?? []) as Distillate[]
  const windows = block.top !== undefined ? all.slice(0, block.top) : all
  const rows: VNode[] = windows.length > 0 ? windows.map((d) => streamRow(d, actions)) : [emptyRow()]
  return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, LABEL), ...rows)
}
