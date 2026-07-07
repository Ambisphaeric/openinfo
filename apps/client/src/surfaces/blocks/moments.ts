import type { Moment } from '@openinfo/contracts'
import { h, type VNode } from '../block-renderer/vnode.js'
import type { BlockRenderer } from '../block-renderer/registry.js'
import { clockLabel } from '../block-renderer/format.js'
import { momentGlyph } from './glyphs.js'

const LABEL = 'Moments · this session'

/**
 * The `moments` block — the typed-event stream (design/renderings/hud-v2.html: "events, not buckets";
 * each moment gets its own row, its own mark, at its own timestamp). Newest-first (the compiler already
 * sorts). A `question` that hasn't heard an answer carries the "unanswered" state marker. The absolute
 * tick-rail from the mockup is a deliberate simplification (it needs whole-session geometry) — the rows,
 * marks, and times carry the substance.
 */
const renderRow = (moment: Moment): VNode => {
  const mark = momentGlyph(moment.kind)
  const unanswered = moment.kind === 'question' && moment.answered !== true
  return h(
    'div',
    { class: 'mo' },
    h('span', { class: 't' }, clockLabel(moment.at)),
    h('span', { class: `g mk ${mark.cls}` }, mark.glyph),
    h(
      'span',
      { class: 'x' },
      moment.speaker ? h('b', {}, `${moment.speaker}: `) : null,
      moment.text,
      unanswered ? h('span', { class: 'unans' }, 'unanswered') : null,
    ),
  )
}

export const renderMoments: BlockRenderer = ({ block, result }) => {
  if (block.collapsed) return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, LABEL))
  const all = (result?.items ?? []) as Moment[]
  const rows = block.top !== undefined ? all.slice(0, block.top) : all
  return [
    h('div', { class: 'hgroup', style: 'padding-bottom:0' }, h('div', { class: 'glbl' }, LABEL)),
    h('div', { class: 'streamwrap' }, h('div', { class: 'stream' }, h('div', { class: 'rows' }, ...rows.map(renderRow)))),
  ]
}
