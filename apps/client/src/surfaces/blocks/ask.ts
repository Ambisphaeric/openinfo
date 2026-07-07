import { h } from '../block-renderer/vnode.js'
import type { BlockRenderer } from '../block-renderer/registry.js'

/**
 * The `ask` block — an ad-hoc "ask this context" affordance. The recall/answer path is P3 and the
 * input palette is P6, so this slice renders a visible-but-inert prompt row so the block type has a
 * home and the renderer is complete. No query is compiled for it yet.
 */
export const renderAsk: BlockRenderer = () =>
  h(
    'div',
    { class: 'hgroup' },
    h('div', { class: 'glbl' }, 'Ask'),
    h('div', { class: 'rel' }, h('span', { class: 'mk p' }, '·'), h('span', { class: 'body' }, h('span', { class: 'why' }, 'ask this context — recall path P3'))),
  )
