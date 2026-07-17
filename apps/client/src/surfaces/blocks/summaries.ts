import type { Block, Summary } from '@openinfo/contracts'
import { h, type VNode } from '../block-renderer/vnode.js'
import type { BlockRenderer } from '../block-renderer/registry.js'
import { clockLabel } from '../block-renderer/format.js'
import { actionButtons } from './actions.js'

type Actions = NonNullable<Block['actions']>

const LABEL = 'Summary'

/**
 * The `summaries` block (#177 slice 2) — the human headline the default HUD leads with. It reads the
 * hydrated `summaries` query (`source: 'summaries'`, one level via params.level, newest window first) and
 * renders one row per Summary: the model-PROPOSED prose with its clock label and a `.why` line phrased for a
 * HUMAN (hud-voice §2) — what the row is ("a summary of what's been said"), never the endpoint/model id or a
 * raw confidence score. Sentence-level (distillate-stream) processing is NOT here — it lives on the
 * Diagnostics/Fields surfaces; the human surface leads with the five-minute and session VIEW, not every
 * sentence (#177 acceptance).
 *
 * HONEST DEGRADED (hud-voice §3): a summary whose model was unavailable carries NO prose — it renders a calm
 * "Summary unavailable — no summary model connected" line, never fabricated text, with the recorded machine
 * reason available on inspection (title) rather than in glance position. Empty is EXPLAINABLE, not silent.
 */

/** Human level labels (hud-voice §2: no jargon in glance position) — the timescale the row speaks to. */
const levelLabel = (level: Summary['level']): string =>
  level === 'five-minute'
    ? 'Last five minutes'
    : level === 'session'
      ? 'This session'
      : level === 'episode'
        ? 'This stretch'
        : level === 'project'
          ? 'Project so far'
          : 'Just now'

const summaryRow = (summary: Summary, actions: Actions): VNode => {
  const degraded = summary.text === undefined
  const body = degraded ? 'Summary unavailable — no summary model connected' : summary.text!
  // The prose is a PROPOSAL (#189) — say so plainly (a line the user can correct), never assert it as truth.
  const why = degraded ? 'nothing invented — connect a model to summarize' : `${levelLabel(summary.level)} · a draft you can correct`
  return h(
    'div',
    { class: 'rel' },
    h('span', { class: 'mk t' }, clockLabel(summary.windowEnd)),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, body),
      // The recorded machine reason stays reachable on inspection (hud-voice §4), never in glance position.
      h('span', degraded && summary.degraded ? { class: 'why', title: summary.degraded.reason } : { class: 'why' }, why),
    ),
    h('span', { class: 'go' }, ...actionButtons(actions, degraded ? '' : summary.text!)),
  )
}

const emptyRow = (): VNode =>
  h(
    'div',
    { class: 'rel' },
    h('span', { class: 'mk t' }, '—'),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, 'No summary yet'),
      h('span', { class: 'why' }, 'a summary appears as the session builds up'),
    ),
  )

export const renderSummaries: BlockRenderer = ({ block, result }) => {
  if (block.collapsed) return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, LABEL))
  const actions = block.actions ?? []
  const all = (result?.items ?? []) as Summary[]
  const rows = block.top !== undefined ? all.slice(0, block.top) : all
  const nodes: VNode[] = rows.length > 0 ? rows.map((s) => summaryRow(s, actions)) : [emptyRow()]
  return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, LABEL), ...nodes)
}
