import { h } from '../block-renderer/vnode.js'
import type { BlockRenderer } from '../block-renderer/registry.js'

/**
 * The `custom` block — and the registry's fallback for any block type it doesn't know (append-only
 * BlockTypeName: a forward-compatible document can name a block a given client build hasn't shipped a
 * renderer for). Custom blocks are self-contained sandboxed HTML surfaces served by the engine (the
 * rabbithole pattern), which is P6; this slice renders a labelled, inert placeholder so an unknown or
 * custom block degrades gracefully instead of breaking the whole surface render.
 */
export const renderCustom: BlockRenderer = ({ block }) =>
  h(
    'div',
    { class: 'hgroup' },
    h('div', { class: 'glbl' }, block.block === 'custom' ? 'Custom' : `Unsupported: ${block.block}`),
    h(
      'div',
      { class: 'rel' },
      h('span', { class: 'mk p' }, '·'),
      h('span', { class: 'body' }, h('span', { class: 'why' }, block.block === 'custom' ? 'a self-contained custom block' : 'no renderer for this block type in this client build')),
    ),
  )
