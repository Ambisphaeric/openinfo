import { Type, type Static } from '@sinclair/typebox'

export const Id = Type.String({ minLength: 1, description: 'opaque identifier' })
export const IsoTime = Type.String({ format: 'date-time', description: 'ISO-8601 timestamp' })
export const Confidence = Type.Number({ minimum: 0, maximum: 1 })
export const SlotName = Type.Union(
  ['stt', 'tts', 'llm', 'vlm', 'ocr', 'embed'].map((s) => Type.Literal(s)),
  { description: 'fabric capability slot' },
)

/**
 * Token accounting for ONE invoke (#65) — the consumption half of provenance, so a user can audit each
 * prompt's cost and every hop's size (product principle 1: transparency). Captured from the OpenAI-compat
 * `usage` block WHERE THE SERVER OFFERS IT (`estimated:false`); estimated as chars/4 and MARKED
 * (`estimated:true`) otherwise — an estimate is never passed off as a measurement. Every field beyond
 * `estimated` is optional because servers vary (some report only a total; audio invokes have no prompt
 * token count). Appended to the provenance already stamped on records — append-only, so existing records
 * without it still validate.
 */
export const InvokeUsage = Type.Object(
  {
    promptTokens: Type.Optional(Type.Integer({ minimum: 0, description: 'input tokens (prompt), when known' })),
    completionTokens: Type.Optional(Type.Integer({ minimum: 0, description: 'output tokens (generated), when known' })),
    totalTokens: Type.Optional(Type.Integer({ minimum: 0, description: 'prompt + completion, when the server reports it or both halves are known' })),
    estimated: Type.Boolean({ description: 'true ⇒ counts are chars/4 estimates (the server reported no usage); false ⇒ measured from the API' }),
    durationMs: Type.Optional(Type.Integer({ minimum: 0, description: 'wall-clock duration of the invoke in ms' })),
  },
  { $id: 'InvokeUsage', additionalProperties: false },
)
export type InvokeUsage = Static<typeof InvokeUsage>
