import type { Block, EntityProvenance, MomentProvenance, RelevantEntity } from '@openinfo/contracts'
import { h, type VNode } from '../block-renderer/vnode.js'
import type { BlockRenderer } from '../block-renderer/registry.js'
import { clockLabel } from '../block-renderer/format.js'
import { stateDot, resolveStateVocab, type StateVocab } from '../block-renderer/micro-state.js'
import { entityGlyph } from './glyphs.js'
import { rowAffordances, type ActionPayload } from './actions.js'

/**
 * The `relevant-now` block — the live join, the heart of the HUD (design/renderings/hud-v2.html state
 * A). Each row is a ranked entity with its one-line WHY. When the pipeline RECORDED provenance on the
 * entity (or on a joined moment) — which distillate/window/endpoint/model named it — the why line is
 * derived from that recorded trail (#14), so the card explains itself from the truth the pipeline
 * stored rather than a re-guessed heuristic. When no provenance was recorded (Phase-0 rows, or a merge
 * with no trail), it FALLS BACK to the mention-count + latest-moment heuristic. Either way this honours
 * display rule #1 ("nothing without a why — can't produce the sentence → don't show the card"): a row
 * that can state neither a recorded trail, a mention count, a moment, nor a last-seen time renders no
 * card at all (renderRelevantNow drops it) rather than a why-less shell.
 */
type Provenance = EntityProvenance | MomentProvenance

/** The most recent recorded provenance for this row: the entity's own trail wins, else a joined moment's. */
const recordedProvenance = (row: RelevantEntity): { prov: Provenance; count: number } | undefined => {
  const trail = row.entity.provenance
  if (trail && trail.length > 0) return { prov: trail[trail.length - 1]!, count: trail.length }
  const withProv = row.moments.find((m) => m.provenance)
  if (withProv?.provenance) return { prov: withProv.provenance, count: 1 }
  return undefined
}

/** A one-line why built from a RECORDED provenance object — endpoint/model that named it, and when. */
const provenanceWhy = (recorded: { prov: Provenance; count: number }): string => {
  const { prov, count } = recorded
  const via = prov.model ? `${prov.endpoint} · ${prov.model}` : prov.endpoint
  const window = prov.windowEnd ?? prov.windowStart
  const when = window ? clockLabel(window) : count > 1 ? `${count} windows` : ''
  return when ? `via ${via} · ${when}` : `via ${via}`
}

/** The Phase-0 fallback: mention count + the most recent joined moment, else the last-seen time. */
const heuristicWhy = (row: RelevantEntity): string => {
  const mentions = row.entity.mentions ?? 0
  const latest = row.moments[0]
  const parts: string[] = []
  if (mentions > 0) parts.push(`Referenced ${mentions}×`)
  if (latest) parts.push(latest.text)
  else {
    const seen = clockLabel(row.entity.lastSeen)
    if (seen) parts.push(`last seen ${seen}`)
  }
  return parts.join(' · ')
}

/**
 * Prefer the recorded provenance trail; fall back to the heuristic. Returns undefined only when NEITHER
 * can produce a sentence (display rule #1: such a row must not render a card).
 */
const whyLine = (row: RelevantEntity): { why: VNode; text: string } | undefined => {
  const recorded = recordedProvenance(row)
  const text = recorded ? provenanceWhy(recorded) : heuristicWhy(row)
  if (!text) return undefined
  return { why: text, text }
}

type DismissBase = { workspaceId: string; source: string }

const renderRow = (
  row: RelevantEntity,
  actions: NonNullable<Block['actions']>,
  dismissBase: DismissBase,
  vocab: StateVocab,
): VNode | undefined => {
  const line = whyLine(row)
  if (!line) return undefined // no why sentence → no card (display rule #1)
  const mark = entityGlyph(row.entity.kind)
  const { why, text } = line
  const ext = `${row.entity.kind}${(row.entity.mentions ?? 0) > 0 ? ` · ${row.entity.mentions}×` : ''}`
  // dismiss (#66): suppress this entity from the join — addressable by its stable id + source + workspace,
  // so the glyph is live wherever the block configures a `dismiss` action (pin / mark-for-follow-up stay
  // inert this slice). The #66 micro-state dot now renders the entity's resolution `state` (#73) — absent
  // ⇒ no dot (nothing pretends to be resolved), present (a user override stamps `confirmed`) ⇒ a real dot.
  const dismiss: ActionPayload['dismiss'] = { ...dismissBase, itemId: row.entity.id }
  return h(
    'div',
    { class: 'rel' },
    h('span', { class: `mk ${mark.cls}` }, mark.glyph),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, stateDot(row.entity.state, vocab), row.entity.name, ' ', h('span', { class: 'ext' }, ext)),
      h('span', { class: 'why' }, why),
    ),
    h('span', { class: 'go' }, ...rowAffordances(actions, `${row.entity.name} — ${text}`, { dismiss })),
  )
}

export const renderRelevantNow: BlockRenderer = ({ block, result }) => {
  if (block.collapsed) return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, 'Relevant now'))
  const source = block.query?.source ?? 'relevant-now'
  const workspaceParam = block.query?.params?.['workspace']
  const workspaceId = typeof workspaceParam === 'string' ? workspaceParam : 'default'
  const dismissBase: DismissBase = { workspaceId, source }
  const vocab = resolveStateVocab(block.states)
  const all = (result?.items ?? []) as RelevantEntity[]
  const rows = block.top !== undefined ? all.slice(0, block.top) : all
  const cards = rows
    .map((row) => renderRow(row, block.actions ?? [], dismissBase, vocab))
    .filter((card): card is VNode => card !== undefined)
  return h(
    'div',
    { class: 'hgroup' },
    h('div', { class: 'glbl' }, 'Relevant now'),
    ...cards,
  )
}
