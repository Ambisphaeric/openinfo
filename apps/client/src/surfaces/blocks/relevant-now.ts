import type { RelevantEntity } from '@openinfo/contracts'
import { h, type VNode } from '../block-renderer/vnode.js'
import type { BlockRenderer } from '../block-renderer/registry.js'
import { clockLabel } from '../block-renderer/format.js'
import { entityGlyph } from './glyphs.js'
import { actionButtons } from './actions.js'

/**
 * The `relevant-now` block — the live join, the heart of the HUD (design/renderings/hud-v2.html state
 * A). Each row is a ranked entity with its one-line WHY built from real index data: mention count plus
 * the most recent moment that referenced it. This honours display rule #1 ("nothing without a why —
 * can't produce the sentence → don't show the card"): a row with neither mentions nor a joined moment
 * still states when it was last seen, so every card is inspectable.
 */
const whyLine = (row: RelevantEntity): { why: VNode; text: string } => {
  const mentions = row.entity.mentions ?? 0
  const latest = row.moments[0]
  const parts: string[] = []
  if (mentions > 0) parts.push(`Referenced ${mentions}×`)
  if (latest) parts.push(latest.text)
  else parts.push(`last seen ${clockLabel(row.entity.lastSeen)}`)
  const text = parts.join(' · ')
  return { why: text, text }
}

const renderRow = (row: RelevantEntity, actions: NonNullable<import('@openinfo/contracts').Block['actions']>): VNode => {
  const mark = entityGlyph(row.entity.kind)
  const { why, text } = whyLine(row)
  const ext = `${row.entity.kind}${(row.entity.mentions ?? 0) > 0 ? ` · ${row.entity.mentions}×` : ''}`
  return h(
    'div',
    { class: 'rel' },
    h('span', { class: `mk ${mark.cls}` }, mark.glyph),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, row.entity.name, ' ', h('span', { class: 'ext' }, ext)),
      h('span', { class: 'why' }, why),
    ),
    h('span', { class: 'go' }, ...actionButtons(actions, `${row.entity.name} — ${text}`)),
  )
}

export const renderRelevantNow: BlockRenderer = ({ block, result }) => {
  if (block.collapsed) return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, 'Relevant now'))
  const all = (result?.items ?? []) as RelevantEntity[]
  const rows = block.top !== undefined ? all.slice(0, block.top) : all
  return h(
    'div',
    { class: 'hgroup' },
    h('div', { class: 'glbl' }, 'Relevant now'),
    ...rows.map((row) => renderRow(row, block.actions ?? [])),
  )
}
