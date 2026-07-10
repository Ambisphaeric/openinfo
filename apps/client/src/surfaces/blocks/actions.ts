import type { Action, AttributionPattern } from '@openinfo/contracts'
import { h, type VNode } from '../block-renderer/vnode.js'

/**
 * The per-row payload a block hands its wired action verbs. A verb only renders LIVE (a solid `.mini`
 * button the mount layer will act on) when the block supplies the data that verb needs to write; absent
 * that data it renders visible-but-inert (`.mini ghost`), so a button is never falsely live. `copy`
 * always carries its ready-to-copy text; `markDone` addresses a to-do for PUT /todos/:sessionId;
 * `accept` carries the teach candidate to apply via PUT /hints/:workspaceId (#15).
 */
export interface ActionPayload {
  copy: string
  markDone?: { sessionId: string; todoId: string }
  accept?: { workspaceId: string; pattern: AttributionPattern }
  /** dismiss (#66): the item to suppress — the source it came from + its stable id, scoped to a workspace. */
  dismiss?: { workspaceId: string; source: string; itemId: string }
}

/**
 * The glyph-scale verbs (#66) and their marks: a compact per-row strip fits three ~15px glyphs. `dismiss`
 * has a real write path this slice (a suppression record); `pin` and `mark-for-follow-up` are honestly
 * inert per the #15 pattern (visible glyph, `ghost` styling — no fabricated Pin / cross-session to-do).
 * The verb SET is document-configurable via `block.actions`; these are the shipped defaults.
 */
export const GLYPH_VERBS: Readonly<Record<string, string>> = {
  dismiss: '✕',
  pin: '⊚',
  'mark-for-follow-up': '⚑',
}

const isGlyphVerb = (verb: string): boolean => Object.prototype.hasOwnProperty.call(GLYPH_VERBS, verb)

/**
 * Render a block's action affordances as the HUD's `.mini` buttons. Each button carries the verb and
 * action id as data-attributes so the (imperative) mount layer can wire them — the pure renderer never
 * touches the DOM or the network. A verb the mount layer WIRES this slice (copy/mark-done/accept) renders
 * as a live `.mini` button carrying its write payload, but ONLY when this block supplied that payload;
 * every other verb — and a wired verb with no payload — renders visible-but-inert (`.mini ghost`), so a
 * button is live iff it can actually act (the app prepares; verbs never send/commit outward — Action's
 * own contract note). `copyText` is accepted positionally (every block has it); richer write payloads
 * ride in the optional `wired` arg (only the todos/teach blocks supply them).
 */
export const actionButtons = (
  actions: readonly Action[],
  copyText: string,
  wired: { markDone?: ActionPayload['markDone']; accept?: ActionPayload['accept'] } = {},
): VNode[] =>
  actions.map((action) => {
    const data: Record<string, string> = {}
    let live = false
    if (action.verb === 'copy') {
      data['data-copy'] = copyText
      live = true
    } else if (action.verb === 'mark-done' && wired.markDone) {
      data['data-session'] = wired.markDone.sessionId
      data['data-todo'] = wired.markDone.todoId
      live = true
    } else if (action.verb === 'accept' && wired.accept) {
      data['data-workspace'] = wired.accept.workspaceId
      data['data-pattern'] = JSON.stringify(wired.accept.pattern)
      live = true
    }
    return h(
      'button',
      {
        class: live ? 'mini' : 'mini ghost',
        'data-verb': action.verb,
        'data-action': action.id,
        ...data,
      },
      action.label,
    )
  })

/**
 * Render a block's glyph verbs (#66) as a compact per-row strip of ~15px glyph buttons — the dot-scale
 * affordance, not text `.mini` buttons. Each glyph carries its verb + action id as data-attributes for
 * the mount layer, and its human label as `title` (so hover discloses what the glyph does). Honesty per
 * #15: `dismiss` renders LIVE (a solid `.gverb`) only when this block supplied the dismiss payload it
 * needs to write (workspace + source + item id); `pin` / `mark-for-follow-up` have no write path this
 * slice, so they render visible-but-inert (`.gverb ghost`) — a glyph is live iff it can actually act.
 * Returns null when the block configures no glyph verbs (the strip simply doesn't render).
 */
export const glyphStrip = (
  actions: readonly Action[],
  wired: { dismiss?: ActionPayload['dismiss'] } = {},
): VNode | null => {
  const glyphs = actions.filter((action) => isGlyphVerb(action.verb))
  if (glyphs.length === 0) return null
  return h(
    'span',
    { class: 'glyphs' },
    ...glyphs.map((action) => {
      const data: Record<string, string> = {}
      let live = false
      if (action.verb === 'dismiss' && wired.dismiss) {
        data['data-workspace'] = wired.dismiss.workspaceId
        data['data-source'] = wired.dismiss.source
        data['data-item'] = wired.dismiss.itemId
        live = true
      }
      // pin / mark-for-follow-up: no write path this slice — honestly inert (see PHASE4-NOTES / #15).
      return h(
        'button',
        {
          class: live ? 'gverb' : 'gverb ghost',
          'data-verb': action.verb,
          'data-action': action.id,
          title: action.label,
          ...data,
        },
        GLYPH_VERBS[action.verb] ?? '·',
      )
    }),
  )
}

/**
 * The full per-row action affordance (#66): the block's TEXT verbs as `.mini` buttons plus its GLYPH
 * verbs as the compact strip, partitioned by verb. A row renders whatever its document configured —
 * copy/open/mark-done as text, dismiss/pin/mark-for-follow-up as glyphs — with each verb honest about
 * whether it can act. Returns the children for the row's `.go` slot.
 */
export const rowAffordances = (
  actions: readonly Action[],
  copyText: string,
  wired: { markDone?: ActionPayload['markDone']; accept?: ActionPayload['accept']; dismiss?: ActionPayload['dismiss'] } = {},
): VNode[] => {
  const textVerbs = actions.filter((action) => !isGlyphVerb(action.verb))
  const strip = glyphStrip(actions, wired.dismiss ? { dismiss: wired.dismiss } : {})
  return [...actionButtons(textVerbs, copyText, wired), ...(strip ? [strip] : [])]
}
