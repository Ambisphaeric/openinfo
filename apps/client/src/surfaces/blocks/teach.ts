import type { AttributionPattern, Block, HintCandidate } from '@openinfo/contracts'
import { h, type VNode } from '../block-renderer/vnode.js'
import type { BlockRenderer } from '../block-renderer/registry.js'
import { actionButtons } from './actions.js'

type Actions = NonNullable<Block['actions']>

const LABEL = 'Hints to review'

/**
 * The `teach` block — the REVIEW half of the quality flywheel (teach loop, P4D) on a panel. It reads the
 * hydrated `teach` query (`source: 'teach'`, SUGGESTED hint candidates the engine DERIVED from a
 * workspace's reroute corrections — see #11) and renders one row per candidate: the suggested match rule
 * (the focus field + the substring the reroutes agreed on) as the title, plus a WHY-line built from the
 * candidate's own trail — how many distinct corrections support it and which workspace it would teach
 * (`supportCount` is the confidence; the candidate is always traceable to its `sampleSessionIds`). The
 * candidate is SUGGESTED, never auto-applied: the user reviews it and, if right, applies the pattern to
 * the workspace's hints (the accept/dismiss write path is the action-verbs slice — this block renders the
 * affordances the block config carries, inert until then, like the sibling blocks' non-copy verbs). Empty
 * is EXPLAINABLE, not silent: an always-visible block with no candidates renders a "nothing to review"
 * line rather than a blank card; an `on-match` block just stays hidden. `top` caps like the siblings.
 */
const FIELD_LABEL: Record<AttributionPattern['field'], string> = {
  repoPath: 'repo',
  windowTitle: 'window',
  app: 'app',
  eventTitle: 'event',
  attendee: 'attendee',
}

const patternText = (candidate: HintCandidate): string => {
  const field = FIELD_LABEL[candidate.pattern.field] ?? candidate.pattern.field
  const contains = candidate.pattern.contains ?? ''
  return `${field} contains "${contains}"`
}

const whyLine = (candidate: HintCandidate): string => {
  const reroutes = `${candidate.supportCount} reroute${candidate.supportCount === 1 ? '' : 's'}`
  return `${reroutes} → would teach ${candidate.workspaceId}`
}

const candidateRow = (candidate: HintCandidate, actions: Actions): VNode =>
  h(
    'div',
    { class: 'rel' },
    h('span', { class: 'mk s' }, '✦'),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, patternText(candidate)),
      h('span', { class: 'why' }, whyLine(candidate)),
    ),
    h('span', { class: 'go' }, ...actionButtons(actions, candidate.pattern.contains ?? '')),
  )

const emptyRow = (): VNode =>
  h(
    'div',
    { class: 'rel' },
    h('span', { class: 'mk s' }, '✦'),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, 'Nothing to review yet'),
      h('span', { class: 'why' }, 'the teach loop suggests a hint once your reroutes agree on a signal'),
    ),
  )

export const renderTeach: BlockRenderer = ({ block, result }) => {
  if (block.collapsed) return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, LABEL))
  const actions = block.actions ?? []
  const all = (result?.items ?? []) as HintCandidate[]
  const candidates = block.top !== undefined ? all.slice(0, block.top) : all
  const rows: VNode[] = candidates.length > 0 ? candidates.map((c) => candidateRow(c, actions)) : [emptyRow()]
  return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, LABEL), ...rows)
}
