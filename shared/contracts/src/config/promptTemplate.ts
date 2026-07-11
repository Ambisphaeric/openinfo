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
 *   small model; `judge` (#62) is the dual-input review pass — it runs on a LARGER model at a LOWER
 *   cadence, receives the SAME source the fast tier saw PLUS the fast result set, and confirms/corrects/
 *   flags each reviewed field in place. A judge binding is tier-gated on fabric contents: with no
 *   judge-capable endpoint configured it never schedules and the fields simply stay provisional.
 * - `trigger.kind: 'transcript'` fires the field on newly transcribed material; `minChars` is the
 *   inexpensive relevance gate — the field is SKIPPED when the new material is shorter than this, so a
 *   field that needs substance does not burn an invoke on a one-word window (routing sophistication is
 *   deliberately minimal in v0 — the workflow engine owns richer routing).
 * - `scope` is where the field value lives: `session` (per live session) or `workspace` (across
 *   sessions, e.g. accumulated domain vocabulary).
 * - `reviews` (judge tier only, #62) names the fast fieldIds this judge reviews — the fast-result set it
 *   judges against the source. Absent ⇒ it reviews every `fast`-tier field in its scope. Ignored for a
 *   `fast` binding (which writes its own `fieldId`).
 * - `cadenceMs` (judge tier only, #62) is the judge's minimum re-review interval — its cadence is
 *   DECOUPLED from the fast fan-out (which runs every distill batch). Absent ⇒ the engine's judge
 *   cadence default. Ignored for a `fast` binding.
 * - `produces` (judge tier only, #131) says WHAT OUTPUT this judge document produces: `verdict` (the
 *   default #62 dual-input review — per-field confirm/correct/flag over the fast-result set) or
 *   `orientation` (the occasional global classification of the session's nature/direction/topics, landed
 *   as a `SessionAnnotation`). Absent ⇒ `verdict`, so every existing judge document is unchanged.
 */
export const FastFieldBinding = Type.Object(
  {
    fieldId: Id,
    tier: Type.Union(['fast', 'judge'].map((t) => Type.Literal(t)), {
      description: 'model lane: fast runs event-driven on the small model; judge (#62) is the dual-input review pass on a larger model at a lower cadence',
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
    reviews: Type.Optional(
      Type.Array(Id, {
        description: 'judge tier only (#62): the fast fieldIds this judge reviews; absent ⇒ every fast field in scope',
      }),
    ),
    cadenceMs: Type.Optional(
      Type.Integer({ minimum: 0, description: 'judge tier only (#62): minimum re-review interval, decoupled from the fast fan-out; absent ⇒ engine default' }),
    ),
    produces: Type.Optional(
      Type.Union(['verdict', 'orientation'].map((p) => Type.Literal(p)), {
        description: "judge tier only (#131): output shape — 'verdict' (default, #62 per-field review) or 'orientation' (session-nature classification landed as a SessionAnnotation)",
      }),
    ),
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
    // Layer 2 of the egress-consent policy (#64): a prompt document may declare it NEVER uses
    // egress-capable endpoints — its content stays local regardless of mode/workspace posture. Append-only/
    // optional: absent ⇒ the prompt does not deny (it defers to the other layers).
    neverEgress: Type.Optional(
      Type.Boolean({ description: '#64 layer 2: true ⇒ this prompt never uses egress-capable endpoints' }),
    ),
  },
  { $id: 'PromptTemplate', additionalProperties: false },
)
export type PromptTemplate = Static<typeof PromptTemplate>
