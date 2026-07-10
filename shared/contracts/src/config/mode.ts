import { Type, type Static } from '@sinclair/typebox'
import { Id } from '../common.js'
import { DriftConfig } from './voice.js'
import { EgressPolicy } from './egress.js'

export const SourceConfig = Type.Object(
  {
    kind: Type.Union(['mic', 'screen', 'calendar', 'repo', 'camera'].map((k) => Type.Literal(k))),
    enabled: Type.Boolean(),
    cadence: Type.Optional(
      Type.Object(
        {
          shotEverySec: Type.Optional(Type.Integer({ minimum: 1 })),
          deltaGatePct: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
        },
        { additionalProperties: false },
      ),
    ),
    params: Type.Record(Type.String(), Type.Unknown(), { default: {} }),
  },
  { additionalProperties: false },
)

export const Mode = Type.Object(
  {
    id: Id,
    name: Type.String({ minLength: 1 }),
    description: Type.Optional(Type.String()),
    sources: Type.Array(SourceConfig, { minItems: 1 }),
    distill: Type.Object(
      {
        mergeWindow: Type.Object(
          { shortSec: Type.Integer({ minimum: 5 }), longSec: Type.Integer({ minimum: 30 }) },
          { additionalProperties: false },
        ),
        tokenBudget: Type.Integer({ minimum: 50, maximum: 4000, description: 'per pass — high-compression, low-token by design' }),
        use: Type.String({ description: 'fabric endpoint name or slot tier, e.g. "llm.fast"' }),
        screenUnderstanding: Type.Optional(
          Type.Union(['ocr', 'vlm'].map((s) => Type.Literal(s)), { description: 'paddle-class OCR vs vision model — user\'s fork' }),
        ),
      },
      { additionalProperties: false },
    ),
    overflow: Type.Union(['queue', 'degrade', 'drop'].map((o) => Type.Literal(o)), {
      description: 'what happens when the mode exceeds measured hardware',
    }),
    registerId: Type.Optional(Id),
    drift: Type.Optional(DriftConfig),
    acts: Type.Array(
      Type.Object(
        {
          kind: Type.Union(['follow-up-draft', 'task-extract', 'nudge'].map((k) => Type.Literal(k))),
          params: Type.Record(Type.String(), Type.Unknown(), { default: {} }),
        },
        { additionalProperties: false },
      ),
      { default: [] },
    ),
    minTier: Type.Optional(
      Type.Union(['T0', 'T1', 'T2', 'T3'].map((t) => Type.Literal(t)), {
        description: 'capability-ladder floor (docs/DESIGN-CRITIQUE.md §1)',
      }),
    ),
    // Layer 3 of the egress-consent policy (#64): a mode may deny egress wholesale. Append-only/optional —
    // absent ⇒ the mode does not deny (it defers to the other layers).
    egress: Type.Optional(EgressPolicy),
  },
  { $id: 'Mode', additionalProperties: false },
)
export type Mode = Static<typeof Mode>
