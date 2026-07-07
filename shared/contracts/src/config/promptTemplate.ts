import { Type, type Static } from '@sinclair/typebox'
import { Id, SlotName } from '../common.js'

/**
 * A prompt template document. Every Distill/Act prompt is a versioned, cloneable record — no
 * hardcoded prompt presets (a glass mistake we deliberately left behind). The template body is
 * interpolated before the local model runs: it receives the raw resolved dial numbers
 * ({{tone}} … {{brevity}}) AND compiled guidance ({{voice.rules}}) so small local models are not
 * asked to interpret "charm 2" cold, plus pass inputs like {{transcript}}. See IMPLEMENTATION.md §1.
 */
export const PromptTemplate = Type.Object(
  {
    id: Id,
    name: Type.String({ minLength: 1 }),
    kind: Type.Union(['distill', 'extract', 'act'].map((k) => Type.Literal(k)), {
      description: 'which pipeline stage this template feeds (extract = typed-moment extraction)',
    }),
    slot: Type.Optional(SlotName),
    body: Type.String({ minLength: 1, description: 'template with {{var}} placeholders' }),
    description: Type.Optional(Type.String()),
    builtin: Type.Optional(Type.Boolean()),
  },
  { $id: 'PromptTemplate', additionalProperties: false },
)
export type PromptTemplate = Static<typeof PromptTemplate>
