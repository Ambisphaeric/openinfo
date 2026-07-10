import { Type, type Static } from '@sinclair/typebox'
import { Id, IsoTime } from '../common.js'

/** Schema version of the SessionAnnotation record shape — bumped when the persisted shape changes. */
export const SESSION_ANNOTATION_SCHEMA_VERSION = 1

/**
 * The provenance of ONE orientation classification (#131) — the inspectable "which pass produced this
 * reading". It mirrors FieldValueProvenance/JudgeReview: the judge prompt DOCUMENT (`templateId`), the
 * fabric endpoint and model that classified (never a secret value), and the capturedAt span of the
 * source window the reading was drawn from. Engine-stamped in full — the model controls only the
 * classification text, never the ids, span, or timestamps.
 */
export const OrientationProvenance = Type.Object(
  {
    templateId: Id,
    endpoint: Type.String({ description: 'the fabric endpoint name that classified (never a secret value)' }),
    model: Type.Optional(Type.String({ description: 'the model that answered, when the endpoint names one' })),
    windowStart: Type.Optional(IsoTime),
    windowEnd: Type.Optional(IsoTime),
    classifiedAt: IsoTime,
  },
  { $id: 'OrientationProvenance', additionalProperties: false },
)
export type OrientationProvenance = Static<typeof OrientationProvenance>

/**
 * The current orientation/nature classification of a session (#131) — the occasional, global judge-tier
 * reading of "what kind of session is this?" that the fast per-window prompts should NOT each re-derive.
 * A judge-tier prompt document (`PromptTemplate` with a `field` binding whose `produces: 'orientation'`)
 * classifies the recent source window on the judge cadence and lands the result here as an ENGINE-STAMPED
 * ANNOTATION on the session — ADDITIVE to Session (a separate record keyed by session, so the Session
 * schema is untouched). It is a small config-shaped DOCUMENT (homed in _meta.db via LayoutStore, keyed by
 * a deterministic id so the newest version IS the session's current orientation), NOT a per-workspace
 * record.
 *
 * ANNOTATE-AND-CORRECT (the judge overrule pattern, #62): each classification persists a NEW version of
 * the SAME id (deterministic ⇒ replaces the latest in place), so a later pass may revise an earlier
 * reading without erasing the history. The `direction` vocabulary follows the learn/teach canon; `nature`
 * and `direction` are OPEN strings (document-configurable vocab, like `FieldValue.state`) so the taxonomy
 * can be tuned without a contract change. A value the source cannot support is `"unclear"`, never invented.
 *
 * GATE-READY SEAM: this annotation is APPLIED to the pipeline through a single application funnel
 * (JudgeScheduler.applyAnnotation), whose disposition is `annotate` today. A future config can flip that
 * disposition to `gate` (records held until classified) WITHOUT re-architecting production — the shape of
 * this record is unchanged either way; only the application step gains a hold/release. See PHASE4-NOTES.
 */
export const SessionAnnotation = Type.Object(
  {
    id: Id,
    workspaceId: Id,
    sessionId: Id,
    nature: Type.String({
      description:
        'the shape of the session — seeded vocab "meeting" | "call" | "solo-work", plus "unclear" when the source is too thin. Open/document-configurable; never fabricated.',
    }),
    direction: Type.String({
      description:
        'the teach-vs-learn direction per the learn/teach canon — seeded vocab "teach" | "learn" | "mixed", plus "unclear". Open/document-configurable; never fabricated.',
    }),
    topics: Type.Array(Type.String({ minLength: 1 }), {
      description: 'the topic taxonomy — short subject phrases the source supports, most salient first; engine-capped, never count-inflated. Empty when unclear.',
    }),
    provenance: OrientationProvenance,
    updatedAt: IsoTime,
    schemaVersion: Type.Integer({ minimum: 1 }),
  },
  { $id: 'SessionAnnotation', additionalProperties: false },
)
export type SessionAnnotation = Static<typeof SessionAnnotation>
