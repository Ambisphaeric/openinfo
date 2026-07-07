import { h } from '../block-renderer/vnode.js'
import type { BlockRenderer } from '../block-renderer/registry.js'
import { actionButtons } from './actions.js'

/**
 * The `hint` block — the answer-ready strip (design/renderings/hud-v2.html: the ✓ "Answer ready …
 * one tap puts the excerpt on your clipboard"). It is fed by pins (`source: pins`), whose ingestion
 * store is P3, so it renders nothing until a pin answers the live stream. Declared `show: on-match`,
 * it stays invisible until then. The copy affordance is the wired verb once content exists.
 */
export const renderHint: BlockRenderer = ({ block, result }) => {
  const items = (result?.items ?? []) as { text?: string; excerpt?: string }[]
  const first = items[0]
  if (!first) return null
  const excerpt = first.excerpt ?? first.text ?? ''
  return h(
    'div',
    { class: 'hintrow' },
    h('span', { class: 'hk' }, '✓'),
    h(
      'span',
      { class: 'hx' },
      h('b', {}, 'Answer ready'),
      ' — ',
      excerpt,
      h('span', { class: 'copybar' }, h('span', { class: 'txt' }, excerpt), ...actionButtons(block.actions ?? [], excerpt)),
    ),
  )
}
