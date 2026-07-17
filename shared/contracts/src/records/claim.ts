import { Type, type Static } from '@sinclair/typebox'
import { Id, IsoTime, Confidence } from '../common.js'

/** Schema version of the Claim record shape — bumped when the persisted shape changes. */
export const CLAIM_SCHEMA_VERSION = 1

/**
 * The relationship kinds a Claim can assert (#178). CLOSED starter union — the honest extensibility
 * decision.
 *
 * The union is CLOSED (not an open string) for the same reason MomentKind / EntityKind / SummaryLevel are:
 * a claim's relation is a QUERY axis (and, later, a UI/semantic axis), so an open string invites
 * un-queryable drift — a typo'd or free-text kind that nothing can index and no surface can render (the
 * recurring "un-sane default" failure). A closed union keeps every kind inspectable and routable, and the
 * generic `relates-to` member is the deliberate escape valve so the union never has to force a wrong-fit
 * kind onto a genuine association it cannot yet classify. Extending BEYOND these is a reviewed contract
 * change (a new literal + `CLAIM_SCHEMA_VERSION` bump + regenerated schema) — deliberate, not accidental.
 *
 * PRODUCTION IN SLICE 1 (#178 s1): the deterministic builder emits ONLY `co-occurs-with`. Co-occurrence
 * (two entities named together in the same converged evidence — a ContextPacket window or one moment) is
 * the ONLY relation that is TRUE BY CONSTRUCTION from the evidence, with no model in the loop: it asserts
 * "these were observed together", never a semantic reading of HOW they relate. The SEMANTIC kinds
 * (`works-on` person→project/repo · `belongs-to` repo→application · `authored` person→document/PR ·
 * `member-of` person→organization · `relates-to` generic) are the roadmap's named relationships; deriving
 * them requires judgment, so they are reserved for the JUDGE-ENRICHMENT slice (a later pass; its output is
 * a proposal per #189) and for SOVEREIGN USER corrections. The enum is COMPLETE now — all kinds are typed
 * even though slice 1 produces one — exactly as SummaryLevel typed all five levels while slice 1 produced
 * three.
 *
 * `co-occurs-with` is SYMMETRIC; the semantic kinds are DIRECTIONAL (subject → object). For a symmetric
 * relation the builder canonically orders the endpoint pair by entity id, so (A,B) and (B,A) collapse to a
 * single claim rather than two mirror claims.
 */
export const ClaimRelation = Type.Union(
  ['co-occurs-with', 'works-on', 'belongs-to', 'authored', 'member-of', 'relates-to'].map((r) => Type.Literal(r)),
  {
    $id: 'ClaimRelation',
    description:
      'the relationship kind: co-occurs-with (symmetric; the only kind the slice-1 deterministic builder emits) · works-on/belongs-to/authored/member-of (directional semantic kinds — judge-enrichment slice + user corrections) · relates-to (generic fallback)',
  },
)
export type ClaimRelation = Static<typeof ClaimRelation>

/**
 * One reference to a stored evidence record that backs a claim (#178). A claim NEVER copies observation
 * content — it points at the immutable record by id, so every assertion it makes stays traceable to source
 * observations and no ambient content is duplicated into a second table. The record set is the closed set
 * of evidence a relationship claim can rest on: a converged `context-packet` (whose candidates named both
 * entities in one window), a `moment` (whose refs named both entities in one extracted moment), or a
 * `distillate` (a window's derived text — reserved for the judge-enrichment slice). `at` is the evidence
 * instant, carried so a reader can see WHEN the co-occurrence was witnessed without loading the record.
 */
export const ClaimEvidenceRef = Type.Object(
  {
    record: Type.Union(['context-packet', 'moment', 'distillate'].map((r) => Type.Literal(r)), {
      description: 'which record table the id names — the closed set of claim evidence sources',
    }),
    id: Id,
    at: IsoTime,
  },
  { $id: 'ClaimEvidenceRef', additionalProperties: false },
)
export type ClaimEvidenceRef = Static<typeof ClaimEvidenceRef>

/**
 * How a DERIVED claim was built (#178). Slice 1 has exactly one builder — the deterministic engine-side
 * co-occurrence builder (`index/claims.ts`): pure structural correlation over already-stored evidence, no
 * model in the loop. The literal keeps that inspectable — a future JUDGE-ENRICHMENT builder must declare
 * itself as a NEW literal (fast-model output is a proposal, not truth — #189), it can never impersonate the
 * deterministic one. `evidenceCount` is the number of distinct evidence refs the claim rests on: it is the
 * RECORDED DERIVATION behind `confidence`, so repeated evidence strengthens a claim only through a NEW
 * revision that records a higher count — never a silent in-place mutation of the number (#178 AC).
 *
 * Present ONLY on a `source:'derived'` claim; a `source:'user'` correction carries `correction` instead
 * (a human decision has no builder), so a reader can never mistake a sovereign correction for a derivation.
 */
export const ClaimProvenance = Type.Object(
  {
    builder: Type.Literal('deterministic-cooccurrence'),
    evidenceCount: Type.Integer({ minimum: 1, description: 'distinct evidence refs backing this claim — the recorded derivation behind confidence' }),
  },
  { $id: 'ClaimProvenance', additionalProperties: false },
)
export type ClaimProvenance = Static<typeof ClaimProvenance>

/**
 * A SOVEREIGN user correction stamp (#178) — recorded as first-class, append-only data that OUTRANKS any
 * derived claim (the product invariant: human decisions create append-only sovereign corrections, and they
 * never delete the original inference or its evidence — the titling-sovereignty pattern from #211/#232).
 * `verdict` is the human's judgment on the claim it `corrects`:
 *   - `confirm` — this relationship is real (the resolved head becomes the confirmed claim, confidence 1);
 *   - `reject`  — this is NOT a relationship (the pair drops out of the live relationship view; the derived
 *                 claim and its evidence are retained, retrievable as history — never deleted);
 *   - `correct` — the relationship is different (the user asserts a corrected relation/object; the original
 *                 inference is preserved and superseded by the user's assertion).
 * `by` is the actor (the user — never a machine, since a correction is by definition a human decision).
 *
 * Present ONLY on a `source:'user'` claim; a `source:'derived'` claim carries `provenance` instead.
 */
export const ClaimCorrection = Type.Object(
  {
    verdict: Type.Union(['confirm', 'reject', 'correct'].map((v) => Type.Literal(v)), {
      description: 'the human judgment: confirm (real) · reject (not a relationship) · correct (a different relationship)',
    }),
    at: IsoTime,
    by: Type.Optional(Type.String({ description: 'who made the correction — the user' })),
    note: Type.Optional(Type.String({ description: "the correction's rationale (never a secret value)" })),
  },
  { $id: 'ClaimCorrection', additionalProperties: false },
)
export type ClaimCorrection = Static<typeof ClaimCorrection>

/**
 * A durable, append-only assertion about a relationship between two entities (#178) — subject `relation`
 * object — grounded in EVIDENCE refs and never in copied content. A claim is a DERIVED runtime unit built
 * ONLY from references to stored evidence records; it never replaces, copies, or rewrites the observations
 * it points at.
 *
 * PROPOSAL, NOT TRUTH: a `source:'derived'` claim is a PROPOSAL (`state:'provisional'`) — confidence is
 * framed as a proposal, deterministically derived from the evidence count (never a model score, never
 * fabricated), and a human correction supersedes it. A `source:'user'` claim is a SOVEREIGN correction
 * (the roadmap invariant): it outranks any derived claim and is never overwritten by a later derivation.
 *
 * EVIDENCE IS MANDATORY: `evidence` is `minItems:1`, so a claim with no evidence refs is UNREPRESENTABLE —
 * every claim, derived or user, is traceable to source observations (a user correction carries the same
 * evidence refs as the claim it corrects, so it stays traceable to the same observations it reinterprets).
 *
 * SUPERSESSION is append-only: when a rebuild sees MORE evidence for a (session, subject, object, relation)
 * a NEW claim supersedes the prior (`revision + 1`, `supersedes` naming it) — the prior is never mutated or
 * deleted, so the chain stays walkable and the strengthened `confidence` is a recorded derivation. `id` is
 * content-derived (a hash over the claim's evidence-derived content + chain position), so rebuilding the
 * same evidence is idempotent: byte-identical claim, same id, no new revision. User corrections are resolved
 * OVER the derived chain at read time (see the store's `resolveClaimHeads`): a corrected/rejected pair never
 * reappears merely because the builder re-derived it.
 *
 * `firstObserved`/`lastObserved` are the earliest/latest evidence instants — the claim's honest valid-time
 * span, derived from the evidence, never guessed. `sessionId` names the session the derivation ran over
 * (present on derived claims and on corrections of them); the relationship graph is queried WORKSPACE-wide
 * (across sessions) and aggregated at read time — indexes are rebuildable projections, not the truth store.
 */
export const Claim = Type.Object(
  {
    id: Id,
    workspaceId: Id,
    subject: Id,
    object: Id,
    relation: ClaimRelation,
    evidence: Type.Array(ClaimEvidenceRef, { minItems: 1, description: 'refs to the evidence records backing this claim — a claim with no evidence is unrepresentable' }),
    confidence: Confidence,
    source: Type.Union(['derived', 'user'].map((s) => Type.Literal(s)), {
      description: 'derived (deterministic builder proposal) · user (sovereign human correction, outranks derived)',
    }),
    state: Type.Union(['provisional', 'confirmed', 'corrected', 'rejected', 'superseded'].map((s) => Type.Literal(s)), {
      description: 'provisional (derived proposal) · confirmed/corrected/rejected (user verdicts) · superseded (an older revision a newer one replaced)',
    }),
    provenance: Type.Optional(ClaimProvenance),
    correction: Type.Optional(ClaimCorrection),
    corrects: Type.Optional(Id),
    sessionId: Type.Optional(Id),
    firstObserved: IsoTime,
    lastObserved: IsoTime,
    revision: Type.Integer({ minimum: 1, description: 'position in this relationship’s append-only supersession chain' }),
    supersedes: Type.Optional(Id),
    schemaVersion: Type.Integer({ minimum: 1 }),
    createdAt: IsoTime,
  },
  { $id: 'Claim', additionalProperties: false },
)
export type Claim = Static<typeof Claim>
