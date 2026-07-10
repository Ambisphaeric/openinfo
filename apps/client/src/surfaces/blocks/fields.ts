import type { Block, FieldValue } from '@openinfo/contracts'
import { h, type VNode } from '../block-renderer/vnode.js'
import type { BlockRenderer } from '../block-renderer/registry.js'
import { stateDot, resolveStateVocab, type StateVocab } from '../block-renderer/micro-state.js'
import { actionButtons } from './actions.js'

type Actions = NonNullable<Block['actions']>

const LABEL = 'Fields · fast'

/**
 * The `fields` block — the fan-out substrate's surface (#61). It reads the hydrated `fields` query
 * (`source: 'fields'`, one row per FieldValue, freshest first) and renders each field's CURRENT value
 * with its label, a micro-state dot, and a one-line WHY built ENTIRELY from the value's provenance —
 * `via <endpoint> · <model> · <template id>` (product principle 1: every rendered value is inspectable
 * back to the exact prompt document and endpoint that produced it). Nothing is ever shown without that
 * provenance, so there are no fabricated values.
 *
 * The micro-state dot (#66) renders the field's `state`: fast results are `provisional` by definition
 * (the judge that confirms them is a later issue), so a provisional dot is honest, not decorative. The
 * dot vocabulary is document-configurable via `block.states`. Empty is EXPLAINABLE, never silent: an
 * always-visible block with no field values yet renders a "no fields yet" line rather than a blank card;
 * an `on-match` block simply stays hidden (renderSurface drops it before this runs). `top` caps the list.
 */
const whyLine = (value: FieldValue): string => {
  const { endpoint, model, templateId } = value.provenance
  return `via ${[endpoint, model, templateId].filter((p) => p !== undefined && p !== '').join(' · ')}`
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
    h('span', { class: 'go' }, ...actionButtons(actions, value.value)),
  )

const emptyRow = (suppressed: number): VNode => {
  const why =
    suppressed > 0
      ? `${suppressed} field${suppressed === 1 ? '' : 's'} dismissed — nothing else to show`
      : 'fields fill as fast-field prompts run over this session'
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
