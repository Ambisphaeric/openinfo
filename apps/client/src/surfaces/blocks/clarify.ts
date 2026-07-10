import type { Entity } from '@openinfo/contracts'
import { h, type VNode } from '../block-renderer/vnode.js'

/**
 * The ≟ clarify affordance (#75) — the dot-scale ask a HUD-tier row grows when the resolver flagged its
 * mention AMBIGUOUS (a plausible rival within the margin; entity.ambiguity is stamped by #72). It is the
 * SAME glyph idiom as the #66 glyph verbs (an 18px `.gverb`), NEVER a modal: a single ≟ that expands INLINE
 * to ONE dismissible ask line offering the choice — the linked candidate vs the rival — with the answer
 * teaching a sovereign override and dismiss teaching nothing.
 *
 * HARD RULES (issue #75 + canon):
 *  - Never a modal; the ask is one inline line on the row.
 *  - At most ONE ask per entity per session: once answered OR dismissed, the entity id enters the session
 *    `suppressed` set (owned by the Hud) and no ≟ renders for it again this session; a confirmed override
 *    also clears the record's ambiguity, so it does not re-appear across reloads either.
 *  - The copy is HUMAN (#117 humans-not-robots): the ask names the heard form and the two ENTITY NAMES —
 *    never a model id, endpoint name, or template id.
 */

/** The clarify session context threaded from the Hud (session-ephemeral, like the #96 system-mute bit). */
export interface ClarifyContext {
  /** entity ids the user already answered or dismissed THIS session — no ≟ renders for them. */
  suppressed: ReadonlySet<string>
  /** the single entity whose ask line is currently expanded (only one open at a time). */
  expanded?: string
}

/** The ≟ mark — kept the same scale/idiom as the #66 glyph verbs (an 18px `.gverb`). */
export const CLARIFY_GLYPH = '≟'

/**
 * Is this entity a LIVE clarify question — the resolver flagged a plausible rival, the record is not yet
 * user-confirmed, and the user has not already settled/dismissed it this session? The gate the renderer
 * consults so an answered/dismissed row goes quiet.
 */
export const isClarifiable = (entity: Entity, ctx?: ClarifyContext): boolean =>
  entity.ambiguity?.rivalName !== undefined &&
  entity.ambiguity.rivalName.length > 0 &&
  entity.state !== 'confirmed' &&
  !(ctx?.suppressed.has(entity.id) ?? false)

/**
 * The heard surface form the resolver flagged ambiguous — the most recent ambiguous resolution entry's
 * `heard`, else the entity name. Never a model/endpoint/template id (the ask copy is human).
 */
export const heardForm = (entity: Entity): string => {
  const resolutions = entity.resolutions ?? []
  for (let i = resolutions.length - 1; i >= 0; i -= 1) {
    const heard = resolutions[i]?.heard
    if (resolutions[i]?.ambiguous && heard && heard.length > 0) return heard
  }
  return entity.name
}

/**
 * The collapsed ≟ glyph for a row (or null when the entity is not a live clarify question) — rides the
 * row's `.go` slot beside the #66 glyph strip. Carries only its verb + entity id; the mount layer opens the
 * ask (client-local, no write). `title` discloses the human question on hover.
 */
export const clarifyGlyph = (entity: Entity, ctx?: ClarifyContext): VNode | null => {
  if (!isClarifiable(entity, ctx)) return null
  const rivalName = entity.ambiguity!.rivalName!
  return h(
    'button',
    {
      class: 'gverb clarify-open',
      'data-verb': 'clarify-open',
      'data-entity': entity.id,
      title: `Which one — ${entity.name} or ${rivalName}?`,
    },
    CLARIFY_GLYPH,
  )
}

/**
 * The inline ask LINE for a row — rendered only when this entity is the expanded one (and still a live
 * clarify question). ONE dismissible line: a human question, then a choice per candidate (✓-class), then a
 * dismiss (✗) that only quiets the ask this session. The choice buttons carry the correction payload the
 * mount layer POSTs to /teach/entity. The rival choice renders only when the ambiguity named a rival id
 * (the disambiguate write needs it) — otherwise the honest ask is confirm-or-dismiss. Returns null when not
 * expanded/clarifiable, so a row with no open ask adds no line.
 */
export const clarifyAsk = (entity: Entity, workspaceId: string, ctx?: ClarifyContext): VNode | null => {
  if (!isClarifiable(entity, ctx) || ctx?.expanded !== entity.id) return null
  const rivalName = entity.ambiguity!.rivalName!
  const rivalId = entity.ambiguity!.rivalId
  const heard = heardForm(entity)
  const base: Record<string, string> = {
    'data-workspace': workspaceId,
    'data-entity': entity.id,
    'data-heard': heard,
    'data-rival-name': rivalName,
    ...(rivalId !== undefined ? { 'data-rival-id': rivalId } : {}),
  }
  const choices: VNode[] = [
    h('button', { class: 'clarify-choice ok', 'data-verb': 'clarify-confirm', ...base }, entity.name),
  ]
  // The rival choice writes a `disambiguate` override, which needs the rival's id — only offer it when the
  // resolver named one (it does today; guarded so a rival-less ambiguity never posts an unresolvable verdict).
  if (rivalId !== undefined) {
    choices.push(h('button', { class: 'clarify-choice', 'data-verb': 'clarify-rival', ...base }, rivalName))
  }
  return h(
    'span',
    { class: 'clarify-ask' },
    h('span', { class: 'clarify-q' }, `Heard “${heard}” — which one?`),
    ...choices,
    h(
      'button',
      { class: 'gverb clarify-dismiss', 'data-verb': 'clarify-dismiss', 'data-entity': entity.id, title: 'Ask me later' },
      '✕',
    ),
  )
}
