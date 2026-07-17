import type { Block, EntityProvenance, MomentProvenance, RelevantEntity, Sighting } from '@openinfo/contracts'
import { h, type VNode } from '../block-renderer/vnode.js'
import type { BlockRenderer } from '../block-renderer/registry.js'
import { clockLabel } from '../block-renderer/format.js'
import { stateDot, resolveStateVocab, type StateVocab } from '../block-renderer/micro-state.js'
import { entityGlyph } from './glyphs.js'
import { rowAffordances, type ActionPayload } from './actions.js'
import { clarifyGlyph, clarifyAsk, type ClarifyContext } from './clarify.js'

/**
 * The `relevant-now` block — the live join, the heart of the HUD (design/renderings/hud-v2.html state
 * A). Each row is a ranked entity with its one-line WHY, phrased for a HUMAN reading the HUD (#117): why
 * the item is relevant — how it reached the user (heard / on screen / from calendar) and when. When the
 * pipeline RECORDED provenance on the entity (or on a joined moment) the why line is derived from that
 * recorded trail (#14) — but as a HUD-tier surface it states the human-legible slice (source kind +
 * recency) and NEVER the endpoint, model id, or template id that produced it. The full machine trail
 * (endpoint/model/window) stays recorded on the entity and remains reachable on the diagnostics surfaces
 * and the ledger — it is simply not the HUD's job to render it. When no provenance was recorded (Phase-0
 * rows, or a merge with no trail), the why FALLS BACK to the mention-count + latest-moment heuristic.
 * Either way this honours display rule #1 ("nothing without a why — can't produce the sentence → don't
 * show the card"): a row that can state neither a recorded trail, a mention count, a moment, nor a
 * last-seen time renders no card at all (renderRelevantNow drops it) rather than a why-less shell.
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

/** Human phrasing for how the item reached the user — the source kind, never a slot/model/endpoint id. */
const SOURCE_PHRASE: Record<Sighting['via'], string> = { heard: 'heard', seen: 'on screen', calendar: 'from calendar' }

/**
 * The human source kind for this row: the most recent typed SIGHTING (heard/seen/calendar) when the
 * entity carries an evidence trail, else `heard` — the honest default, since the only live producer of a
 * recorded provenance trail today is the heard (ASR → distill) pipeline. Never derived from the fabric
 * slot (`llm`/`stt`/…), which is a machine capability name, not how a human encountered the item.
 */
const sourceKind = (row: RelevantEntity): string => {
  const sightings = row.entity.sightings
  if (sightings && sightings.length > 0) {
    const latest = sightings.reduce((a, b) => (b.at > a.at ? b : a))
    return SOURCE_PHRASE[latest.via] ?? 'heard'
  }
  return 'heard'
}

/**
 * A one-line why built from a RECORDED provenance object, phrased for the HUD (#117): the human source
 * kind (heard / on screen / from calendar) and WHEN — never the endpoint, model id, or template id. The
 * "when" prefers the provenance window, falling back to the entity's last-seen time; a row that recorded
 * a trail but no usable time still states its source kind alone.
 */
const provenanceWhy = (row: RelevantEntity, recorded: { prov: Provenance; count: number }): string => {
  const { prov } = recorded
  const window = prov.windowEnd ?? prov.windowStart
  const when = (window && clockLabel(window)) || clockLabel(row.entity.lastSeen)
  const kind = sourceKind(row)
  return when ? `${kind} · ${when}` : kind
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
const whyLine = (row: RelevantEntity): { why: VNode } | undefined => {
  const recorded = recordedProvenance(row)
  const text = recorded ? provenanceWhy(row, recorded) : heuristicWhy(row)
  if (!text) return undefined
  return { why: text }
}

type DismissBase = { workspaceId: string; source: string }

const renderRow = (
  row: RelevantEntity,
  actions: NonNullable<Block['actions']>,
  dismissBase: DismissBase,
  vocab: StateVocab,
  clarify: ClarifyContext | undefined,
): VNode | undefined => {
  const line = whyLine(row)
  if (!line) return undefined // no why sentence → no card (display rule #1)
  const mark = entityGlyph(row.entity.kind)
  const { why } = line
  const ext = `${row.entity.kind}${(row.entity.mentions ?? 0) > 0 ? ` · ${row.entity.mentions}×` : ''}`
  // dismiss (#66): suppress this entity from the join — addressable by its stable id + source + workspace,
  // so the glyph is live wherever the block configures a `dismiss` action (pin / mark-for-follow-up stay
  // inert this slice). The #66 micro-state dot now renders the entity's resolution `state` (#73) — absent
  // ⇒ no dot (nothing pretends to be resolved), present (a user override stamps `confirmed`) ⇒ a real dot.
  const dismiss: ActionPayload['dismiss'] = { ...dismissBase, itemId: row.entity.id }
  // clarify (#75): an AMBIGUOUS mention (resolver flagged a rival within Δ) grows a ≟ in the `.go` strip;
  // when expanded, its ONE inline ask line rides in the body under the why. Both go quiet once the user
  // answered/dismissed this session (the Hud's session set), so a row asks at most once.
  const glyph = clarifyGlyph(row.entity, clarify)
  const ask = clarifyAsk(row.entity, dismissBase.workspaceId, clarify)
  const body: VNode[] = [
    h('span', { class: 'ttl' }, stateDot(row.entity.state, vocab), row.entity.name, ' ', h('span', { class: 'ext' }, ext)),
    h('span', { class: 'why' }, why),
  ]
  if (ask) body.push(ask)
  return h(
    'div',
    { class: 'rel' },
    h('span', { class: `mk ${mark.cls}` }, mark.glyph),
    h('span', { class: 'body' }, ...body),
    // copy payload = the entity VALUE ONLY (`row.entity.name`). The why line is display context (already
    // rendered on the row) — provenance/recency never rides into the clipboard (#118 / copy-value-only).
    h('span', { class: 'go' }, ...(glyph ? [glyph] : []), ...rowAffordances(actions, row.entity.name, { dismiss })),
  )
}

/**
 * The empty state, EXPLAINABLE not silent (#215/hud-voice): an always-visible join with no card left a
 * bare header. With no session live this process (`noCurrentSession`, #210) nothing is being captured to
 * rank — say so and what to do; with a session live it is the quiet "nothing relevant yet" state, kin to
 * the live-transcript strip's "listening…". Visibly distinct. (An `on-match` block never reaches here —
 * renderSurface drops it before this runs when it has no items.)
 */
const emptyRow = (noSession: boolean): VNode =>
  h(
    'div',
    { class: 'rel' },
    h('span', { class: 'mk a' }, '—'),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, noSession ? 'No session running' : 'Nothing relevant yet'),
      h(
        'span',
        { class: 'why' },
        noSession ? 'people and topics surface here once you start a session' : 'people and topics surface here as you talk',
      ),
    ),
  )

export const renderRelevantNow: BlockRenderer = ({ block, result, clarify }) => {
  if (block.collapsed) return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, 'Relevant now'))
  const source = block.query?.source ?? 'relevant-now'
  const workspaceParam = block.query?.params?.['workspace']
  const workspaceId = typeof workspaceParam === 'string' ? workspaceParam : 'default'
  const dismissBase: DismissBase = { workspaceId, source }
  const vocab = resolveStateVocab(block.states)
  const all = (result?.items ?? []) as RelevantEntity[]
  const rows = block.top !== undefined ? all.slice(0, block.top) : all
  const cards = rows
    .map((row) => renderRow(row, block.actions ?? [], dismissBase, vocab, clarify))
    .filter((card): card is VNode => card !== undefined)
  return h(
    'div',
    { class: 'hgroup' },
    h('div', { class: 'glbl' }, 'Relevant now'),
    ...(cards.length > 0 ? cards : [emptyRow(result?.noCurrentSession === true)]),
  )
}
