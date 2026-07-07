import { Type, type Static } from '@sinclair/typebox'
import { Id, IsoTime, SlotName } from '../common.js'
import { Dials } from '../config/voice.js'

/**
 * A merge-window summary — the output of one Distill pass over a rolling window of raw capture.
 * Persisted to the session's workspace DB; raw chunks expire once distilled.
 * Carries the resolved voice vector and model/endpoint provenance so every summary is inspectable
 * (product principle 1: nothing surfaces without a one-line why).
 */
export const DISTILLATE_SCHEMA_VERSION = 1

export const Distillate = Type.Object(
  {
    id: Id,
    sessionId: Id,
    workspaceId: Id,
    windowStart: IsoTime,
    windowEnd: IsoTime,
    sourceChunks: Type.Array(Id, { description: 'capture chunk ids merged into this window' }),
    text: Type.String({ description: 'the distilled summary text' }),
    voice: Type.Object(
      {
        registerId: Type.Optional(Id),
        scope: Type.Union(['global', 'mode', 'workspace', 'session'].map((s) => Type.Literal(s)), {
          description: 'which binding scope won resolution',
        }),
        dials: Dials,
      },
      { additionalProperties: false, description: 'the resolved voice vector this pass ran with' },
    ),
    provenance: Type.Object(
      {
        slot: SlotName,
        endpoint: Type.String({ minLength: 1, description: 'fabric endpoint name that produced this' }),
        model: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    schemaVersion: Type.Integer({ minimum: 1 }),
    createdAt: IsoTime,
  },
  { $id: 'Distillate', additionalProperties: false },
)
export type Distillate = Static<typeof Distillate>
