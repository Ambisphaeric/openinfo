import type { Entity } from '@openinfo/contracts'
import { nameSimilarity, normalizeForm } from './phonetic.js'
import { DEFAULT_RESOLVER_CONFIG } from './resolve.js'
import { type GazetteerDocument, type GazetteerEntry } from './gazetteer-seed.js'

export { GAZETTEER_KIND, GAZETTEER_KEY, DEFAULT_GAZETTEER, type GazetteerDocument, type GazetteerEntry } from './gazetteer-seed.js'

/**
 * The public-name gazetteer matcher (#143). PURE — a deterministic function of a heard mention and the
 * gazetteer document, no store/model/DB. It is the collision-detection half of the clarify gate: it turns
 * a matching public name into a RIVAL CANDIDATE the resolver can weigh, but it NEVER decides ambiguity
 * itself and NEVER produces a record. The resolver's existing band + ambiguityMargin logic makes the call
 * (see resolve.ts `resolveEntity`, the `rivals` input); this module only supplies well-formed candidates.
 *
 * How it plugs in (the whole design in one paragraph): the store scores a heard mention against its CORPUS
 * as always; separately it asks this matcher for gazetteer rivals and passes them to the resolver as
 * rival-only candidates. If the mention LINKS/NEARLY-LINKS to a corpus entity AND a gazetteer name scored
 * within the resolver's ambiguity margin of that winner, the resolver marks the resolution `ambiguous` and
 * names the gazetteer hit as the rival — so the ≟ affordance (#75) fires with a real "did you mean the
 * public <X>?" option. A gazetteer hit with NO corpus link is IGNORED by the resolver's `new` branch, so a
 * mention that merely sounds like a public name (but matches nothing you own) stays SILENT: no entity is
 * created, no question is asked. Gazetteer rivals get STABLE SYNTHETIC ids (`gaz:<slug>`) so a rejection
 * via the ≟ answer (`rejectedRivalId`) is durable — the same public rival is never re-offered for the form.
 */

/**
 * The stable synthetic id for a gazetteer rival — `gaz:<slug>` where the slug is the normalized,
 * hyphenated public name. Stable across runs (a pure function of the name) so a sovereign override's
 * `rejectedRivalId` keeps matching it, and namespaced (`gaz:`) so it can never collide with a real
 * entity's UUID. It is NEVER written as an entity id — only referenced as a rival / rejected rival.
 */
export const gazetteerRivalId = (name: string): string => `gaz:${normalizeForm(name).replace(/\s+/g, '-')}`

/** Inputs the store supplies so a gazetteer rival is a well-formed, same-kind, un-established candidate. */
export interface GazetteerMatchOptions {
  /** the heard mention's kind — the synthetic rival takes it so it is a plausible SAME-KIND rival. */
  kind: Entity['kind']
  /** ISO time for the synthetic firstSeen/lastSeen (never persisted; only satisfies the Entity shape). */
  at: string
  /** the heard mention's workspace — carried onto the synthetic rival for shape parity. */
  workspaceId?: string
  /**
   * Minimum `nameSimilarity` (over heard-form × entry-form pairs) for an entry to be offered as a rival.
   * Defaults to the resolver's `provisionalBand`: an entry the resolver could never treat as a plausible
   * rival (its rival gate is itself `>= provisionalBand`) is not worth passing. Kept as a param so the
   * store can pass a per-call resolver config's band and the two stay in lock-step.
   */
  floor?: number
}

/**
 * Build a synthetic rival Entity for a gazetteer entry. It is a RIVAL-ONLY candidate — the resolver may
 * name it as the runner-up but never selects it as the winner/match (see resolve.ts), and it is never
 * written to any store. `mentions: 0` is load-bearing: it pins `corpusPrior` to the neutral 1.0, so a
 * gazetteer rival is scored on pure phonetic similarity and can NEVER out-boost an established corpus
 * entity — an equally-fuzzy public name ties (⇒ ambiguous, we ask) rather than winning silently.
 */
const syntheticRival = (entry: GazetteerEntry, opts: GazetteerMatchOptions): Entity => ({
  id: gazetteerRivalId(entry.name),
  workspaceId: opts.workspaceId ?? 'gazetteer',
  kind: opts.kind,
  name: entry.name,
  aliases: [...(entry.aliases ?? [])],
  momentRefs: [],
  outboundCount: 0,
  mentions: 0,
  firstSeen: opts.at,
  lastSeen: opts.at,
})

/**
 * The gazetteer rivals for a set of heard surface forms: one synthetic rival per gazetteer entry whose best
 * `nameSimilarity` against any heard form clears the floor. Pure. The resolver RE-SCORES these (fuzzy ×
 * neutral prior) and applies its own band/margin gate, so this pre-filter only decides which entries are
 * worth handing over — it never itself declares a match. Returns `[]` when nothing clears the floor (the
 * common case), so the resolver's behavior is byte-identical to pre-#143 for any non-colliding mention.
 */
export const gazetteerRivals = (
  heardForms: readonly string[],
  doc: GazetteerDocument,
  opts: GazetteerMatchOptions,
): Entity[] => {
  const floor = opts.floor ?? DEFAULT_RESOLVER_CONFIG.provisionalBand
  const forms = heardForms.map((f) => f.trim()).filter((f) => f.length > 0)
  if (forms.length === 0) return []
  const rivals: Entity[] = []
  for (const entry of doc.entries) {
    const entryForms = [entry.name, ...(entry.aliases ?? [])]
    let best = 0
    for (const h of forms) {
      for (const e of entryForms) {
        const sim = nameSimilarity(h, e)
        if (sim > best) best = sim
        if (best >= 1) break
      }
      if (best >= 1) break
    }
    if (best >= floor) rivals.push(syntheticRival(entry, opts))
  }
  return rivals
}
