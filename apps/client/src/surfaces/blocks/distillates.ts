import type { Block, Distillate } from '@openinfo/contracts'
import { h, type VNode } from '../block-renderer/vnode.js'
import type { BlockRenderer } from '../block-renderer/registry.js'
import { clockLabel } from '../block-renderer/format.js'
import { actionButtons } from './actions.js'

type Actions = NonNullable<Block['actions']>

// hud-voice §2: "distillate" is banned end-user vocabulary; the block is framed to the user as the
// transcript (its empty state and Settings toggle already say so), so the label is the human word (#242).
const LABEL = 'Transcript'

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
      h('span', { class: 'why' }, 'from what was captured'),
    ),
    h('span', { class: 'go' }, ...actionButtons(actions, distillate.text)),
  )

/**
 * The empty state, EXPLAINABLE not silent — and honest about WHY (#215/#227/hud-voice). Two distinct truths
 * (#215 progressive disclosure, session gate first): with NO session live this process (`noCurrentSession`,
 * #210) the stream is empty because nothing is being captured, so it stays session-first — start one. With a
 * session live but the stream empty, the dominant cause on a fresh install is that capture-to-text is OFF
 * (`distill.enabled` / `distill.transcribe` default OFF, enabled out-of-surface in Settings → Features), so
 * the line NAMES that toggle and where it lives — the honest enablement disclosure #227 mandates. The renderer
 * is pure and cannot read the runtime flag, so it names the enablement PATH rather than asserting off vs on
 * (the fields.ts pattern). HUMAN copy (hud-voice §2): the toggle's own Settings label, never the raw flag key,
 * and never the banned "distillate"/"distilled" display vocabulary.
 */
const emptyRow = (noSession: boolean): VNode =>
  h(
    'div',
    { class: 'rel' },
    h('span', { class: 'mk t' }, '—'),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, noSession ? 'No session running' : 'No transcript yet'),
      h(
        'span',
        { class: 'why' },
        noSession
          ? 'a transcript appears here once you start a session'
          : 'turn on “Distill what is captured” in Settings → Features — the transcript fills as you talk',
      ),
    ),
  )

export const renderDistillates: BlockRenderer = ({ block, result }) => {
  if (block.collapsed) return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, LABEL))
  const actions = block.actions ?? []
  const all = (result?.items ?? []) as Distillate[]
  const windows = block.top !== undefined ? all.slice(0, block.top) : all
  const rows: VNode[] = windows.length > 0 ? windows.map((d) => streamRow(d, actions)) : [emptyRow(result?.noCurrentSession === true)]
  return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, LABEL), ...rows)
}
