import { Type, type Static } from '@sinclair/typebox'
import { Id, IsoTime, SlotName } from '../common.js'

/** Schema version of the FieldValue record shape — bumped when the persisted shape changes. */
export const FIELD_VALUE_SCHEMA_VERSION = 1

/**
 * The provenance trail of ONE fast-field result (#61) — the inspectable "why" behind a rendered field
 * value (product principle 1). It names the exact prompt document (`templateId`), the fabric slot and
 * endpoint that answered, the model when the endpoint names one, and the capturedAt span of the
 * material window the value was drawn from. A rendered field's why-line (`via <endpoint> · <model> ·
 * <template id>`) is composed entirely from this — no value is ever shown without it.
 */
export const FieldValueProvenance = Type.Object(
  {
    templateId: Id,
    slot: SlotName,
    endpoint: Type.String({ description: 'the fabric endpoint name that produced the value (never a secret value)' }),
    model: Type.Optional(Type.String({ description: 'the model that answered, when the endpoint names one' })),
    windowStart: Type.Optional(IsoTime),
    windowEnd: Type.Optional(IsoTime),
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
        'field micro-state / judge tier (#66) — fast results are `provisional` by definition (the confirm judge is a later issue). Document-configurable vocab per surface; never fabricated.',
    }),
    provenance: FieldValueProvenance,
    updatedAt: IsoTime,
    schemaVersion: Type.Integer({ minimum: 1 }),
  },
  { $id: 'FieldValue', additionalProperties: false },
)
export type FieldValue = Static<typeof FieldValue>
