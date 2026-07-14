import { Type, type Static } from '@sinclair/typebox'
import { Id, IsoTime, SlotName, InvokeUsage } from '../common.js'

/** Schema version of the FieldValue record shape — bumped when the persisted shape changes. */
export const FIELD_VALUE_SCHEMA_VERSION = 1

/**
 * The provenance trail of ONE fast-field result (#61) — the inspectable "why" behind a rendered field
 * value (product principle 1). It names the exact prompt document (`templateId`), the fabric slot and
 * endpoint that answered, the model when the endpoint names one, and the capturedAt span of the
 * material window the value was drawn from. A rendered field's why-line (`via <endpoint> · <model> ·
 * <template id>`) is composed entirely from this — no value is ever shown without it.
 */
/**
 * The judge's overrule stamp (#62) — the append-only record of ONE dual-input review that confirmed,
 * corrected, or flagged a fast-field value. It is the "which judge, which template, what changed"
 * provenance the judge stage must carry: the judge prompt DOCUMENT (`templateId`), the fabric endpoint
 * and model that judged (never a secret value), the `verdict`, and — on a `correct` — the `priorValue`
 * it overruled plus the `priorState` it moved the field off of (so "what changed" is inspectable). It
 * lives ALONGSIDE the top-level FieldValueProvenance, which keeps naming the field's ORIGINAL fast
 * producer — the judge annotates lineage, it does not erase it. `note` carries the judge's rationale
 * (required-ish for a `flag`, optional otherwise). A rendered field's why-line reads
 * `via <fast endpoint> · <verdict> by <judge model>` when this is present.
 */
export const JudgeReview = Type.Object(
  {
    templateId: Id,
    endpoint: Type.String({ description: 'the fabric endpoint name that judged (never a secret value)' }),
    model: Type.Optional(Type.String({ description: 'the judge model that answered, when the endpoint names one' })),
    verdict: Type.Union(['confirm', 'correct', 'flag'].map((v) => Type.Literal(v)), {
      description: 'confirm: value stands; correct: value overruled in place (see priorValue); flag: questionable/too thin to judge',
    }),
    priorValue: Type.Optional(Type.String({ description: 'the fast value the judge overruled — present on a `correct`, so "what changed" is inspectable' })),
    priorState: Type.Optional(Type.String({ description: 'the field state the review moved off of (e.g. provisional)' })),
    note: Type.Optional(Type.String({ description: "the judge's rationale — the flag reason, or why a value was corrected" })),
    judgedAt: IsoTime,
    // #116: the correlation id of the judge pass this review ran in — one per reviewed session batch, so
    // the audit trail can group a batch's verdicts. Append-only/optional: reviews predating #116 omit it.
    spanId: Type.Optional(Id),
    // #65/#116: token accounting for the judge invoke, when the invoke layer recorded it — completes the
    // ledger's consumption picture for the judge hop. Append-only/optional.
    usage: Type.Optional(InvokeUsage),
  },
  { $id: 'JudgeReview', additionalProperties: false },
)
export type JudgeReview = Static<typeof JudgeReview>

export const FieldValueProvenance = Type.Object(
  {
    templateId: Id,
    slot: SlotName,
    endpoint: Type.String({ description: 'the fabric endpoint name that produced the value (never a secret value)' }),
    model: Type.Optional(Type.String({ description: 'the model that answered, when the endpoint names one' })),
    windowStart: Type.Optional(IsoTime),
    windowEnd: Type.Optional(IsoTime),
    // #116: the capture chunk ids of the material window this value was drawn from — the deterministic
    // parent link a trace walks (the same ids land in Distillate.sourceChunks and SttSegment.chunkId),
    // replacing fuzzy time-linkage. Append-only/optional: values predating #116 omit it.
    sourceChunks: Type.Optional(Type.Array(Id, { description: 'capture chunk ids of the material window this value was drawn from' })),
    // #65/#116: token accounting for the fast invoke, when the invoke layer recorded it. Append-only/optional.
    usage: Type.Optional(InvokeUsage),
    // The judge's overrule stamp (#62), present once a judge has reviewed this value — the fast producer
    // above is untouched (lineage is preserved); this annotates it with the confirm/correct/flag verdict
    // and, on a correct, the overruled priorValue. Absent ⇒ the value is still provisional (unjudged).
    judge: Type.Optional(JudgeReview),
  },
  { $id: 'FieldValueProvenance', additionalProperties: false },
)
export type FieldValueProvenance = Static<typeof FieldValueProvenance>

/**
 * The LATEST value of one fast field (#61) — the durable half of the ephemeral-then-durable substrate.
 * A fast-field prompt document (`PromptTemplate` with a `field` binding) fans out concurrently against
 * the llm slot; each result publishes a `field.updated` event immediately AND persists as this record,
 * one per (workspace, session?, fieldId). It is a small config-shaped DOCUMENT (homed in _meta.db via
 * LayoutStore, keyed by a deterministic id so the newest version IS the field's current value), NOT a
 * per-workspace record — cheapest honest store shape for "the current value of a field."
 *
 * `state` is the #66 micro-state carrier: fast results are `provisional` by definition (the judge that
 * confirms them is a later issue), so the scheduler stamps `provisional` — a real signal, never faked.
 * Ids, timestamps and provenance are engine-stamped; the model controls only `value` (its text output).
 */
export const FieldValue = Type.Object(
  {
    id: Id,
    fieldId: Id,
    workspaceId: Id,
    sessionId: Type.Optional(Id),
    label: Type.String({ minLength: 1, description: 'the display name of the field (the prompt document name)' }),
    value: Type.String({ description: 'the model output text for this field — the current value' }),
    state: Type.String({
      description:
        'field micro-state / judge tier (#66) — a fast result is `provisional`; a judge review (#62) moves it to `confirmed` (value stands), `corrected` (value overruled in place), or `flagged` (questionable). Document-configurable vocab per surface; never fabricated.',
    }),
    // #116: the correlation id of the fast-field pass that produced this value — one per (session, batch)
    // fan-out, shared across the batch's field values. Append-only/optional: values predating #116 omit it.
    spanId: Type.Optional(Id),
    provenance: FieldValueProvenance,
    updatedAt: IsoTime,
    schemaVersion: Type.Integer({ minimum: 1 }),
  },
  { $id: 'FieldValue', additionalProperties: false },
)
export type FieldValue = Static<typeof FieldValue>
