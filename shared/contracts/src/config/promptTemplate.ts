import { Type, type Static } from '@sinclair/typebox'
import { Id, SlotName } from '../common.js'

/**
 * A fast-field binding (#61) — the append-only extension that turns a prompt template into a
 * COMPOSITION UNIT of the fan-out substrate: it binds the template to a surface field, declares its
 * model tier, and says what triggers it. A template carrying a `field` binding is a FAST-FIELD prompt
 * document; the engine fans out every triggered `fast`-tier binding CONCURRENTLY against the llm slot
 * and lands each result in its bound field (see distill/fields.ts). Templates WITHOUT a binding are the
 * classic distill/extract/act prompts — this stays optional so the existing prompt documents are
 * unchanged.
 *
 * - `fieldId` is the surface field this prompt writes (a `fields` query source renders the field's
 *   latest value with provenance).
 * - `tier` is the model lane: `fast` runs at seconds-scale/event-driven cadence on the high-throughput
 *   small model (the only tier that RUNS in v0); `judge` is reserved for the confirm pass (a later
 *   issue) — a `judge` binding is a valid document but is not scheduled yet.
 * - `trigger.kind: 'transcript'` fires the field on newly transcribed material; `minChars` is the
 *   inexpensive relevance gate — the field is SKIPPED when the new material is shorter than this, so a
 *   field that needs substance does not burn an invoke on a one-word window (routing sophistication is
 *   deliberately minimal in v0 — the workflow engine owns richer routing).
 * - `scope` is where the field value lives: `session` (per live session) or `workspace` (across
 *   sessions, e.g. accumulated domain vocabulary).
 */
export const FastFieldBinding = Type.Object(
  {
    fieldId: Id,
    tier: Type.Union(['fast', 'judge'].map((t) => Type.Literal(t)), {
      description: 'model lane: fast runs event-driven on the small model (the only tier scheduled in v0); judge is the reserved confirm pass',
    }),
    trigger: Type.Object(
      {
        kind: Type.Literal('transcript', { description: 'fire on newly transcribed material (the accumulation seam the distill cadence uses)' }),
        minChars: Type.Optional(
          Type.Integer({ minimum: 0, description: 'the inexpensive relevance gate: skip the field when the new material is shorter than this' }),
        ),
      },
      { additionalProperties: false },
    ),
    scope: Type.Union(['session', 'workspace'].map((s) => Type.Literal(s)), {
      description: 'where the field value lives: per live session, or across sessions for the workspace',
    }),
  },
  { $id: 'FastFieldBinding', additionalProperties: false },
)
export type FastFieldBinding = Static<typeof FastFieldBinding>

/**
 * A prompt template document. Every Distill/Act prompt is a versioned, cloneable record — no
 * hardcoded prompt presets (a glass mistake we deliberately left behind). The template body is
 * interpolated before the local model runs: it receives the raw resolved dial numbers
 * ({{tone}} … {{brevity}}) AND compiled guidance ({{voice.rules}}) so small local models are not
 * asked to interpret "charm 2" cold, plus pass inputs like {{transcript}}. See IMPLEMENTATION.md §1.
 *
 * The `field` binding (#61) makes a template a FAST-FIELD prompt document bound to a surface field —
 * the fan-out substrate's composition unit. It is optional: a template without one is a classic
 * distill/extract/act prompt, unchanged.
 */
export const PromptTemplate = Type.Object(
  {
    id: Id,
    name: Type.String({ minLength: 1 }),
    kind: Type.Union(['distill', 'extract', 'act', 'field'].map((k) => Type.Literal(k)), {
      description:
        'which pipeline stage this template feeds (extract = the extraction stage: typed moments AND entities, distinguished by template id; field = a fast-field prompt bound to a surface field, #61)',
    }),
    slot: Type.Optional(SlotName),
    body: Type.String({ minLength: 1, description: 'template with {{var}} placeholders' }),
    description: Type.Optional(Type.String()),
    builtin: Type.Optional(Type.Boolean()),
    field: Type.Optional(FastFieldBinding),
  },
  { $id: 'PromptTemplate', additionalProperties: false },
)
export type PromptTemplate = Static<typeof PromptTemplate>
