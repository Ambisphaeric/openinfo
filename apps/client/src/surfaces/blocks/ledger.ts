import { h, type VNode } from '../block-renderer/vnode.js'
import type { BlockRenderer } from '../block-renderer/registry.js'
import { actionButtons } from './actions.js'

/**
 * The `ledger` block — "You owe this room" (design/renderings/hud-v2.html state C). The commitment
 * store lands in P4, so `POST /query source:ledger` returns [] today; this block is typically declared
 * `show: on-match`, so it simply doesn't render yet. The renderer is complete so it lights up the day
 * the store exists — no later phase invents a home. Each item is treated as `{ text }` (Commitment's
 * headline field); its actions render through the shared affordance helper.
 */
export const renderLedger: BlockRenderer = ({ block, result }) => {
  if (block.collapsed) return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, 'You owe this room'))
  const all = (result?.items ?? []) as { text?: string }[]
  const rows = block.top !== undefined ? all.slice(0, block.top) : all
  if (rows.length === 0) return null
  return h(
    'div',
    { class: 'hgroup' },
    h('div', { class: 'glbl' }, 'You owe this room'),
    ...rows.map((item): VNode => {
      const text = item.text ?? ''
      return h(
        'div',
        { class: 'rel' },
        h('span', { class: 'mk c' }, '●'),
        h('span', { class: 'body' }, h('span', { class: 'ttl' }, text)),
        h('span', { class: 'go' }, ...actionButtons(block.actions ?? [], text)),
      )
    }),
  )
}
