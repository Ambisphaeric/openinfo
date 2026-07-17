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
 * the draft's own trail — its act kind and the source distillate/moment counts it was composed from,
 * phrased for a HUMAN (#118): NEVER the fabric endpoint, model, or template id. The full machine trail
 * stays RECORDED on the draft's provenance (product principle 1: every draft is inspectable back to what
 * it was built from) and remains reachable on the diagnostics surfaces + the ledger — it is simply not
 * this block's job to render it. A draft is PREPARED, never sent — the copy affordance carries the body so the human
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
  return `${kind} · from ${sources}`
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

/**
 * The empty state, EXPLAINABLE not silent — and honest about WHY (#215/hud-voice). With no session live
 * this process (`noCurrentSession`, #210) nothing can be prepared yet, so it says so and what to do; with a
 * session live it reflects that a draft is prepared when the session ends. The two are visibly distinct.
 */
const emptyRow = (noSession: boolean): VNode =>
  h(
    'div',
    { class: 'rel' },
    h('span', { class: 'mk d' }, '✎'),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, noSession ? 'No session running' : 'No drafts prepared yet'),
      h(
        'span',
        { class: 'why' },
        noSession ? 'start a session — a draft is prepared when it ends' : 'a follow-up draft is prepared when a session ends',
      ),
    ),
  )

export const renderDrafts: BlockRenderer = ({ block, result }) => {
  if (block.collapsed) return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, LABEL))
  const actions = block.actions ?? []
  const all = (result?.items ?? []) as Draft[]
  const drafts = block.top !== undefined ? all.slice(0, block.top) : all
  const rows: VNode[] = drafts.length > 0 ? drafts.map((draft) => draftRow(draft, actions)) : [emptyRow(result?.noCurrentSession === true)]
  return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, LABEL), ...rows)
}
