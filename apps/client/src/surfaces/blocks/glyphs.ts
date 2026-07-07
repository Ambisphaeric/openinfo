import type { Entity, Moment } from '@openinfo/contracts'

/**
 * The moment-mark glyphs from design/renderings/hud-v2.html (its legend and CSS `--m-*` colors):
 * ● commitment · ◆ question-at-you · ▲ decision · ✱ artifact. mention/note fall back to a neutral
 * tick (·). The `cls` is the mark colour class (.mk.c/.q/.d/.a/.p) the ported HUD stylesheet defines.
 */
export const momentGlyph = (kind: Moment['kind']): { glyph: string; cls: string } => {
  switch (kind) {
    case 'commitment':
      return { glyph: '●', cls: 'c' }
    case 'question':
      return { glyph: '◆', cls: 'q' }
    case 'decision':
      return { glyph: '▲', cls: 'd' }
    case 'artifact':
      return { glyph: '✱', cls: 'a' }
    default:
      return { glyph: '·', cls: 'p' }
  }
}

/**
 * Entity-mark glyphs for relevant-now rows: ◉ person (hud-v2 legend), ✱ artifact (shares the
 * artifact mark), ◆ topic (a distinct decision-green diamond — topics have no glyph in the mockup,
 * so we pick a legible mark that is not the amber question).
 */
export const entityGlyph = (kind: Entity['kind']): { glyph: string; cls: string } => {
  switch (kind) {
    case 'person':
      return { glyph: '◉', cls: 'p' }
    case 'artifact':
      return { glyph: '✱', cls: 'a' }
    case 'topic':
      return { glyph: '◆', cls: 'd' }
    default:
      return { glyph: '·', cls: 'p' }
  }
}
