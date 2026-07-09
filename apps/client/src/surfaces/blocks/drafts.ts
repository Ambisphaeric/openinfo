import type { Block, Draft } from '@openinfo/contracts'
import { h, type VNode } from '../block-renderer/vnode.js'
import type { BlockRenderer } from '../block-renderer/registry.js'
import { actionButtons } from './actions.js'

type Actions = NonNullable<Block['actions']>

const LABEL = 'Prepared drafts'

/**
 * The `drafts` block — prepared Act artifacts (the follow-up draft, P2) on a panel. It reads the
 * hydrated `drafts` query (`source: 'drafts'`, newest-first, workspace/session-scoped — see #10) and
 * renders one row per Draft: the draft BODY (the prepared prose) plus a PROVENANCE why-line built from
 * the draft's own trail — its act kind, the source distillate/moment counts it was composed from, and
 * the fabric endpoint that produced it (product principle 1: every draft is inspectable back to what it
 * was built from). A draft is PREPARED, never sent — the copy affordance carries the body so the human
 * executes (ARCHITECTURE §1). Empty is EXPLAINABLE, not silent: an always-visible block with no drafts
 * renders a "no drafts prepared yet" line rather than a blank card; an `on-match` block just stays
 * hidden. `top` caps like the sibling list blocks.
 */
const ACT_LABEL: Record<Draft['actKind'], string> = {
  'follow-up-draft': 'follow-up draft',
  'task-extract': 'task extract',
  nudge: 'nudge',
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

const whyLine = (draft: Draft): string => {
  const kind = ACT_LABEL[draft.actKind] ?? draft.actKind
  const sources = `${plural(draft.provenance.sourceDistillates.length, 'distillate')} + ${plural(draft.provenance.sourceMoments.length, 'moment')}`
  return `${kind} · from ${sources} · via ${draft.provenance.endpoint}`
}

const draftRow = (draft: Draft, actions: Actions): VNode =>
  h(
    'div',
    { class: 'rel' },
    h('span', { class: 'mk d' }, '✎'),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, draft.body),
      h('span', { class: 'why' }, whyLine(draft)),
    ),
    h('span', { class: 'go' }, ...actionButtons(actions, draft.body)),
  )

const emptyRow = (): VNode =>
  h(
    'div',
    { class: 'rel' },
    h('span', { class: 'mk d' }, '✎'),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, 'No drafts prepared yet'),
      h('span', { class: 'why' }, 'a follow-up draft is prepared when a session ends'),
    ),
  )

export const renderDrafts: BlockRenderer = ({ block, result }) => {
  if (block.collapsed) return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, LABEL))
  const actions = block.actions ?? []
  const all = (result?.items ?? []) as Draft[]
  const drafts = block.top !== undefined ? all.slice(0, block.top) : all
  const rows: VNode[] = drafts.length > 0 ? drafts.map((draft) => draftRow(draft, actions)) : [emptyRow()]
  return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, LABEL), ...rows)
}
