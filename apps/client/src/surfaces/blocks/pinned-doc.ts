import { h } from '../block-renderer/vnode.js'
import type { BlockRenderer } from '../block-renderer/registry.js'
import { actionButtons } from './actions.js'

/**
 * The `pinned-doc` block — an always-visible card for a canon document with a copy bar (hud-v2.html
 * compose view). Pins are ingested in P3; until then the card shows the configured doc reference from
 * `query.params.doc` (or `block.custom`) with an inert copy bar, rather than fabricating an excerpt.
 * Gated in the seed by the `surface.block.pinned-doc` flag; not in the default HUD stack this slice.
 */
export const renderPinnedDoc: BlockRenderer = ({ block }) => {
  const doc = typeof block.query?.params?.['doc'] === 'string' ? (block.query.params['doc'] as string) : 'pinned document'
  return h(
    'div',
    { class: 'hgroup' },
    h('div', { class: 'glbl' }, 'Pinned'),
    h(
      'div',
      { class: 'rel' },
      h('span', { class: 'mk a' }, '✱'),
      h(
        'span',
        { class: 'body' },
        h('span', { class: 'ttl' }, doc),
        h('span', { class: 'why' }, 'ingestion & page-anchored answers land in P3'),
      ),
      h('span', { class: 'go' }, ...actionButtons(block.actions ?? [], doc)),
    ),
  )
}
