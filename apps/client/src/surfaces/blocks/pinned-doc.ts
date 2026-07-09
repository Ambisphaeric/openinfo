import type { Block, Pin } from '@openinfo/contracts'
import { h, type VNode } from '../block-renderer/vnode.js'
import type { BlockRenderer } from '../block-renderer/registry.js'
import { actionButtons } from './actions.js'

type Actions = NonNullable<Block['actions']>

/**
 * The `pinned-doc` block — a card for canon documents with a copy bar (hud-v2.html compose view). It
 * reads the hydrated pins query (`source: 'pins'`, newest-first, workspace-scoped — see #8): one row
 * per pin with its title, kind and ingest state, honouring the block's `top` cap like the sibling list
 * blocks. With no hydrated pin it falls back to the configured doc reference (`query.params.doc`) plus
 * an explainable why-line rather than fabricating an excerpt — so an always-visible card never shows a
 * broken/blank body (an `on-match` block simply stays hidden). Gated in the seed by the
 * `surface.block.pinned-doc` flag; not in the default HUD stack this slice.
 */
const ingestWhy = (pin: Pin): string => {
  if (pin.ingest.status === 'ingested') {
    return pin.ingest.pages !== undefined ? `ingested · ${pin.ingest.pages} pages` : 'ingested'
  }
  return pin.ingest.status === 'pending' ? 'ingestion pending' : 'ingestion failed'
}

const pinRow = (pin: Pin, actions: Actions): VNode =>
  h(
    'div',
    { class: 'rel' },
    h('span', { class: 'mk a' }, '✱'),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, pin.title, ' ', h('span', { class: 'ext' }, pin.kind)),
      h('span', { class: 'why' }, ingestWhy(pin)),
    ),
    h('span', { class: 'go' }, ...actionButtons(actions, `${pin.title} — ${pin.uri}`)),
  )

const fallbackRow = (block: Block, actions: Actions): VNode => {
  const doc = typeof block.query?.params?.['doc'] === 'string' ? (block.query.params['doc'] as string) : 'pinned document'
  return h(
    'div',
    { class: 'rel' },
    h('span', { class: 'mk a' }, '✱'),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, doc),
      h('span', { class: 'why' }, 'configured reference · awaiting a matching pin'),
    ),
    h('span', { class: 'go' }, ...actionButtons(actions, doc)),
  )
}

export const renderPinnedDoc: BlockRenderer = ({ block, result }) => {
  const actions = block.actions ?? []
  const all = (result?.items ?? []) as Pin[]
  const pins = block.top !== undefined ? all.slice(0, block.top) : all
  const rows: VNode[] = pins.length > 0 ? pins.map((pin) => pinRow(pin, actions)) : [fallbackRow(block, actions)]
  return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, 'Pinned'), ...rows)
}
