import { Type, type Static } from '@sinclair/typebox'
import { Confidence, Id, IsoTime, SlotName, InvokeUsage } from '../common.js'
import { EgressDecision } from '../config/egress.js'
import { GuardVerdict } from '../config/guard.js'

export const EntityKind = Type.Union(['person', 'artifact', 'topic'].map((k) => Type.Literal(k)))

/**
 * Entity contract v2 (#73) — the additive evidence-and-resolution surface the resolver (#72, not yet
 * built) and its UX require. Every field added below is OPTIONAL with a store-supplied default, so
 * existing Phase-0/v1 entity rows keep validating and loading untouched (migration-safe by omission —
 * the record body is stored as JSON, so an absent field simply reads as absent). Resolution quality
 * compounds only if evidence accumulates ON the record, and user corrections must be durable and
 * sovereign — hence sightings/heardAs (evidence) and overrides (sovereign correction) are first-class,
 * append-only data, never derived-and-forgotten.
 */

/**
 * One typed piece of evidence that this entity was encountered — the append-only evidence trail the
 * resolver scores over and the UX can inspect. `via` is the sense that produced it: `heard` (an ASR
 * transcript window named it — the only live producer today, via the distill pipeline), `seen` (a
 * screen-understanding pass recognized it — awaiting the screen→entity path), or `calendar` (a calendar
 * signal named it — awaiting the calendar→entity path). `at` is when it was sighted. `distillateId`
 * (when `heard`) ties the sighting back to the exact window, so the trail is inspectable to source.
 */
export const Sighting = Type.Object(
  {
    via: Type.Union(['heard', 'seen', 'calendar'].map((v) => Type.Literal(v)), {
      description: 'the sense that produced this sighting: heard (ASR), seen (screen), or calendar',
    }),
    at: IsoTime,
    distillateId: Type.Optional(Id),
    detail: Type.Optional(Type.String({ description: 'optional human-readable note about the sighting (never a secret value)' })),
  },
  { $id: 'Sighting', additionalProperties: false },
)
export type Sighting = Static<typeof Sighting>

/**
 * A source- and confidence-typed surface form (ASR variant) that SUCCESSFULLY RESOLVED to this entity —
 * the accumulating "we have heard this name these ways" record the resolver uses to match future noisy
 * mentions. `text` is the surface form as produced; `source` is the slot that produced it (`stt` today —
 * the distill pipeline's transcript). `confidence` is the per-variant ASR confidence WHERE THE PIPELINE
 * SURFACES IT — today the STT stage does not expose a per-variant score, so it is left undefined rather
 * than fabricated (disclosed limitation; the resolver #72 populates it once the pipeline carries it).
 * `at` is when the variant was last heard.
 */
export const HeardAs = Type.Object(
  {
    text: Type.String({ minLength: 1, description: 'the surface form (ASR variant) that resolved to this entity' }),
    source: Type.Optional(SlotName),
    confidence: Type.Optional(Confidence),
    at: Type.Optional(IsoTime),
  },
  { $id: 'HeardAs', additionalProperties: false },
)
export type HeardAs = Static<typeof HeardAs>

/**
 * A user correction, recorded as FIRST-CLASS, APPEND-ONLY data that OUTRANKS any score (product
 * principle: user overrides are sovereign and durable). When the user pins a mention to this entity,
 * `pinnedName` records the surface form they pinned — future mentions of that form resolve HERE
 * (store `findEntity` honors it deterministically over any rival). When the correction was made against
 * a plausible rival, `rejectedRivalId`/`rejectedRivalName` name it, so the resolver (#72) can
 * short-circuit — never re-ask about, nor re-score against, the rejected rival. `at`/`by` stamp the
 * correction's provenance (`by` is the actor — "the user"; never a machine, since an override is by
 * definition a human decision). `note` is the optional rationale.
 */
export const EntityOverride = Type.Object(
  {
    at: IsoTime,
    by: Type.Optional(Type.String({ description: 'who made the correction — the user' })),
    pinnedName: Type.Optional(Type.String({ description: 'surface form pinned to this entity — future mentions of it resolve here' })),
    rejectedRivalId: Type.Optional(Id),
    rejectedRivalName: Type.Optional(Type.String()),
    note: Type.Optional(Type.String({ description: "the correction's rationale (never a secret value)" })),
  },
  { $id: 'EntityOverride', additionalProperties: false },
)
export type EntityOverride = Static<typeof EntityOverride>

/**
 * A plausible-rival marker (#73) — set when resolution was NOT clean: another entity was a credible
 * match. It is the "this could also be …" the UX surfaces so a user can correct it. `rivalId`/
 * `rivalName` name the rival; `margin` is the score gap over it (small ⇒ genuinely ambiguous), where the
 * resolver reports it. Cleared (absent) once a user override settles the question. Populated by the
 * resolver (#72); left absent by plain extraction today (nothing scores rivals yet).
 */
export const EntityAmbiguity = Type.Object(
  {
    rivalId: Type.Optional(Id),
    rivalName: Type.Optional(Type.String()),
    margin: Type.Optional(Type.Number({ description: 'score margin of this entity over the rival — small ⇒ genuinely ambiguous' })),
    note: Type.Optional(Type.String()),
  },
  { $id: 'EntityAmbiguity', additionalProperties: false },
)
export type EntityAmbiguity = Static<typeof EntityAmbiguity>

/**
 * Optional linkage to an identity in an EXTERNAL system (e.g. a code-host repo, a CRM record) — the
 * hook by which an entity can be tied to a durable external id without the resolver owning that
 * system's schema. `system` names it (e.g. `github`), `ref` is the opaque external identifier (e.g.
 * `owner/repo`), `url` is an optional canonical link. Never populated automatically today (no external
 * linker exists yet); shipped so a future linker and the resolver have a stable contract to write to.
 */
export const EntityExternal = Type.Object(
  {
    system: Type.String({ minLength: 1, description: 'external system name, e.g. github' }),
    ref: Type.String({ minLength: 1, description: 'opaque external identifier, e.g. owner/repo' }),
    url: Type.Optional(Type.String()),
  },
  { $id: 'EntityExternal', additionalProperties: false },
)
export type EntityExternal = Static<typeof EntityExternal>

/**
 * Where an entity mention came from — the distillate/window it was resolved over and the
 * endpoint/model that produced it. One entry per window that mentioned the entity, so a surfaced
 * entity carries an inspectable trail back to every window and model that named it (product
 * principle 1). Additive, backward-compatible; Phase-0 entities without provenance still validate.
 */
export const EntityProvenance = Type.Object(
  {
    distillateId: Type.Optional(Id),
    windowStart: Type.Optional(IsoTime),
    windowEnd: Type.Optional(IsoTime),
    slot: SlotName,
    endpoint: Type.String({ minLength: 1, description: 'fabric endpoint name that produced this mention' }),
    model: Type.Optional(Type.String()),
    usage: Type.Optional(InvokeUsage),
    egress: Type.Optional(EgressDecision),
    guard: Type.Optional(GuardVerdict),
    // #116: the correlation id of the pipeline pass this mention was extracted in — shared with the
    // window's distillate and moments. Append-only/optional: entries predating #116 omit it.
    spanId: Type.Optional(Id),
  },
  { additionalProperties: false },
)
export type EntityProvenance = Static<typeof EntityProvenance>

/**
 * One append-only resolution decision (#72) — the scored resolver's inspectable stamp for a single heard
 * mention that resolved (or failed to resolve) to this entity. It is the "why did this mention land here,
 * and how sure were we" trail the ambient-entity story needs: `score` is the final blended score, `band`
 * the decision it fell into (`auto` ≥ the auto threshold ⇒ silent link · `provisional` ⇒ a reviewable
 * provisional link · `new` ⇒ nothing crossed the link floor, so this record was CREATED for the mention),
 * and the four multiplicands are recorded verbatim so the score is reproducible: `phoneticFuzzy` (double-
 * metaphone + edit + token/substring similarity over name/aliases/heardAs), `corpusPrior` (how established
 * this entity is — sighting count × recency), `crossSourceCorroboration` and `personAffinity` (INPUT
 * multipliers — #74's correlator and a real entity graph will feed them; both default to the neutral 1.0
 * today, honestly disclosed, never fabricated). When a plausible RIVAL scored within a small Δ of the
 * winner the resolution is `ambiguous` (a silent auto-link is downgraded to reviewable): `rivalId`/
 * `rivalName`/`rivalScore` name it and `margin` is the gap over it — this is what the clarify affordance
 * (#75) keys off. `override:true` marks a resolution that bypassed scoring because a SOVEREIGN user
 * override pinned the surface form (overrides outrank scores, always). `heard` is the surface form
 * resolved. Append-only: a record accretes one entry per mention, never rewritten.
 */
export const EntityResolution = Type.Object(
  {
    at: IsoTime,
    heard: Type.String({ minLength: 1, description: 'the surface form (heard/extracted mention) this decision resolved' }),
    score: Confidence,
    band: Type.Union(['auto', 'provisional', 'new'].map((b) => Type.Literal(b)), {
      description: 'auto (≥ auto threshold, silent link) · provisional (reviewable link) · new (created a fresh provisional entity)',
    }),
    phoneticFuzzy: Confidence,
    corpusPrior: Type.Number({ minimum: 0, description: 'establishment multiplier (sighting count × recency); neutral 1.0 for a fresh entity, only boosts' }),
    crossSourceCorroboration: Type.Number({ minimum: 0, description: 'INPUT multiplier (#74 correlator) — defaults to neutral 1.0; no producer feeds it yet' }),
    personAffinity: Type.Number({ minimum: 0, description: 'INPUT multiplier (speaker/participant adjacency in the entity graph) — defaults to neutral 1.0; no producer yet' }),
    rivalId: Type.Optional(Id),
    rivalName: Type.Optional(Type.String()),
    rivalScore: Type.Optional(Confidence),
    margin: Type.Optional(Type.Number({ description: 'winner score minus rival score — small ⇒ ambiguous' })),
    ambiguous: Type.Optional(Type.Boolean({ description: 'true ⇒ a plausible rival scored within Δ; a silent auto-link was downgraded to reviewable' })),
    override: Type.Optional(Type.Boolean({ description: 'true ⇒ resolved by a sovereign user override (pinned surface form), bypassing the score' })),
  },
  { $id: 'EntityResolution', additionalProperties: false },
)
export type EntityResolution = Static<typeof EntityResolution>

export const Entity = Type.Object(
  {
    id: Id,
    workspaceId: Id,
    kind: EntityKind,
    name: Type.String({ minLength: 1 }),
    aliases: Type.Array(Type.String(), { default: [] }),
    canonicalOf: Type.Optional(Type.Array(Id, { description: 'entity ids merged into this one' })),
    pinId: Type.Optional(Id),
    momentRefs: Type.Array(Id, { default: [] }),
    outboundCount: Type.Integer({ minimum: 0, default: 0, description: 'times SENT to someone — strongest canon signal' }),
    mentions: Type.Optional(
      Type.Integer({
        minimum: 0,
        default: 0,
        description: 'windows/distillates that mentioned this entity — the frequency signal for recency×frequency ranking',
      }),
    ),
    provenance: Type.Optional(
      Type.Array(EntityProvenance, {
        description: 'per-window trail: which distillate/window/model mentioned this entity (noise is inspectable)',
      }),
    ),
    firstSeen: IsoTime,
    lastSeen: IsoTime,
    // ── Contract v2 (#73): confidence, resolution state, evidence, sovereign overrides. All optional
    // and append-only — existing rows without them still validate; the resolver (#72) and its UX
    // populate/read them. State/confidence are LEFT ABSENT by plain extraction today (no resolver
    // scores them yet); they are stamped by a user override (confirmed) and, later, by the resolver.
    confidence: Type.Optional(
      Confidence,
    ),
    state: Type.Optional(
      Type.String({
        description:
          'resolution/micro-state (#66/#73): a user override stamps `confirmed`; the resolver (#72) will stamp `provisional`/`confirmed`/`corrected`. Read by the #66 micro-state dot — absent ⇒ no dot (nothing pretends to be resolved). Document-configurable vocab per surface; never fabricated.',
      }),
    ),
    ambiguity: Type.Optional(EntityAmbiguity),
    resolutions: Type.Optional(
      Type.Array(EntityResolution, {
        description:
          'append-only per-mention resolution trail (#72): the scored resolver stamps score+band+components (+rival, if any) for every mention that resolved to (or created) this entity. Absent on records that predate the resolver.',
      }),
    ),
    heardAs: Type.Optional(
      Type.Array(HeardAs, { description: 'source-/confidence-typed ASR variants that resolved to this entity (accumulates as evidence)' }),
    ),
    sightings: Type.Optional(
      Type.Array(Sighting, { description: 'typed, append-only evidence trail: heard/seen/calendar sightings with timestamps' }),
    ),
    overrides: Type.Optional(
      Type.Array(EntityOverride, { description: 'user corrections as first-class, append-only data that outrank scores (sovereign)' }),
    ),
    external: Type.Optional(EntityExternal),
  },
  { $id: 'Entity', additionalProperties: false },
)
export type Entity = Static<typeof Entity>
