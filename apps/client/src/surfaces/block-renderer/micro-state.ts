import type { Block } from '@openinfo/contracts'
import { h, type VNode } from './vnode.js'

/**
 * The field micro-state dot (#66) — a dot-scale, colour-coded indicator of a field's judge tier, NOT a
 * chip and NOT text. Human oversight of machine-filled fields must cost pixels, not panels.
 *
 * HONESTY RULE (the whole point): a dot renders ONLY when the item carries a `state`. No judge exists
 * yet, so today nothing stamps `state` — which means nothing renders a dot, and nothing pretends to be
 * reviewed. This is the PRIMITIVE, wired to real data the day a judge stamps a tier; it fabricates none.
 *
 * The state VOCABULARY is document-configurable per surface: the shipped default is
 * provisional → confirmed / corrected, but a document may re-vocabularize it (approved/denied/tabled, …)
 * via `block.states`. An item whose state is not in the vocabulary still shows a dot (its reviewed-ness
 * is real and must not be silently dropped) in a neutral tone, with the raw state on hover.
 */

/** The shipped default field-state vocabulary: state key → dot tone class (see hud/styles.ts `.dot`). */
export const DEFAULT_STATE_VOCAB: ReadonlyArray<{ key: string; tone: string }> = [
  { key: 'provisional', tone: 'provisional' },
  { key: 'confirmed', tone: 'confirmed' },
  { key: 'corrected', tone: 'corrected' },
]

export type StateVocab = Map<string, string>

/**
 * Resolve the effective vocabulary for a block: the document's `block.states` REPLACES the default when
 * present (a surface built on approved/denied/tabled does not want provisional bleeding in), else the
 * shipped default. Returns a key → tone map.
 */
export const resolveStateVocab = (states?: Block['states']): StateVocab =>
  new Map((states && states.length > 0 ? states : DEFAULT_STATE_VOCAB).map(({ key, tone }) => [key, tone]))

/**
 * Render the micro-state dot for one item, or NOTHING when the item carries no state (the honesty rule).
 * A recognized state gets its vocabulary tone; an unrecognized-but-present state gets a neutral tone so a
 * real review signal is never hidden. The raw state rides in `title` so the dot is always inspectable.
 */
export const stateDot = (state: string | undefined, vocab: StateVocab): VNode | null => {
  if (state === undefined || state.length === 0) return null // no state → no dot; nothing pretends to be reviewed
  const tone = vocab.get(state) ?? 'unknown'
  return h('span', { class: `dot ${tone}`, title: state })
}
