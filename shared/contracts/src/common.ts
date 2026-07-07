import { Type } from '@sinclair/typebox'

export const Id = Type.String({ minLength: 1, description: 'opaque identifier' })
export const IsoTime = Type.String({ format: 'date-time', description: 'ISO-8601 timestamp' })
export const Confidence = Type.Number({ minimum: 0, maximum: 1 })
export const SlotName = Type.Union(
  ['stt', 'tts', 'llm', 'vlm', 'ocr', 'embed'].map((s) => Type.Literal(s)),
  { description: 'fabric capability slot' },
)
