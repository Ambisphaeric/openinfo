import type { Block, FieldValue } from '@openinfo/contracts'
import { h, type VNode } from '../block-renderer/vnode.js'
import type { BlockRenderer } from '../block-renderer/registry.js'
import { clockLabel } from '../block-renderer/format.js'
import { stateDot, resolveStateVocab, type StateVocab } from '../block-renderer/micro-state.js'
import { rowAffordances } from './actions.js'

type Actions = NonNullable<Block['actions']>

const LABEL = 'Fields · fast'

/**
 * The `fields` block — the fan-out substrate's surface (#61). It reads the hydrated `fields` query
 * (`source: 'fields'`, one row per FieldValue, freshest first) and renders each field's CURRENT value
 * with its label, a micro-state dot, and a one-line WHY phrased for a HUMAN reading the HUD (#117/#118):
 * recency — when this value last updated — never the endpoint, model id, or template id that produced
 * it. The full machine trail stays RECORDED on the value's provenance (product principle 1: every
 * rendered value is inspectable back to the exact prompt document and endpoint) and remains reachable
 * on the diagnostics surfaces and the ledger — it is simply not the HUD's job to render it. Nothing is
 * ever shown without that recorded provenance, so there are no fabricated values.
 *
 * The micro-state dot (#66) renders the field's `state`: fast results are `provisional` by definition
 * (a judge review (#62) moves it to confirmed/corrected/flagged), so the dot — not the why line — is
 * the judge-tier carrier. The dot vocabulary is document-configurable via `block.states`. Empty is
 * EXPLAINABLE, never silent: an always-visible block with no field values yet renders a "no fields yet"
 * line rather than a blank card; an `on-match` block simply stays hidden (renderSurface drops it before
 * this runs). `top` caps the list.
 */
const whyLine = (value: FieldValue): string => {
  const window = value.provenance.windowEnd ?? value.provenance.windowStart
  const when = clockLabel(value.updatedAt) || (window ? clockLabel(window) : '')
  return when ? `updated ${when}` : 'updated this session'
}

const fieldRow = (value: FieldValue, actions: Actions, vocab: StateVocab): VNode =>
  h(
    'div',
    { class: 'rel' },
    h('span', { class: 'mk t' }, value.label),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, stateDot(value.state, vocab), value.value),
      h('span', { class: 'why' }, whyLine(value)),
    ),
    // The full #66 affordance: text verbs (copy) as `.mini` buttons + glyph verbs (dismiss/pin/follow-up)
    // as the compact glyph strip. `dismiss` renders LIVE only when we hand it the suppression payload the
    // fields source keys on (workspace + `fields:<fieldId>`); pin / follow-up are honestly-inert glyphs.
    h(
      'span',
      { class: 'go' },
      ...rowAffordances(actions, value.value, {
        dismiss: { workspaceId: value.workspaceId, source: 'fields', itemId: value.fieldId },
      }),
    ),
  )

const emptyRow = (suppressed: number): VNode => {
  // Honest, not silent: point at the fix rather than an opaque "nothing here". Fast fields only exist
  // when the fields feature (the distill.fields flag) is ON (it defaults OFF), so an empty panel most
  // often means it is off — the message points at the Settings toggle either way (it is still accurate
  // when the feature is on but no session/material has produced a field yet). The renderer is pure and
  // cannot read the runtime flag, so it names the enablement path in every non-suppressed empty rather
  // than falsely asserting off vs on. HUMAN copy (#118): the toggle's home, never the raw flag key.
  const why =
    suppressed > 0
      ? `${suppressed} field${suppressed === 1 ? '' : 's'} dismissed — nothing else to show`
      : 'turn on Fields in Settings → Features; fields fill as prompts run this session'
  return h(
    'div',
    { class: 'rel' },
    h('span', { class: 'mk t' }, '—'),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, suppressed > 0 ? 'No fields shown' : 'No fields yet'),
      h('span', { class: 'why' }, why),
    ),
  )
}

export const renderFields: BlockRenderer = ({ block, result }) => {
  if (block.collapsed) return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, LABEL))
  const actions = block.actions ?? []
  const vocab = resolveStateVocab(block.states)
  const all = (result?.items ?? []) as FieldValue[]
  const values = block.top !== undefined ? all.slice(0, block.top) : all
  const rows: VNode[] = values.length > 0 ? values.map((v) => fieldRow(v, actions, vocab)) : [emptyRow(result?.suppressed ?? 0)]
  return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, LABEL), ...rows)
}
