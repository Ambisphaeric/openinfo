import { Type, type Static } from '@sinclair/typebox'
import { Id, IsoTime, SlotName } from '../common.js'
import { Dials } from '../config/voice.js'

/**
 * A prepared artifact — the output of an Act pass (the fifth processing primitive). v0 ships the
 * follow-up draft: a prose recap composed from a session's accumulated distillates + moments after
 * the call ends. It is PREPARED, never sent — the app prepares, the human executes (ARCHITECTURE
 * §1). Carries the resolved voice vector that shaped it and full provenance (which template ran,
 * which endpoint/model, and the exact source distillates/moments) so every draft is inspectable
 * back to what it was built from (product principle 1).
 */
export const DRAFT_SCHEMA_VERSION = 1

export const Draft = Type.Object(
  {
    id: Id,
    sessionId: Id,
    workspaceId: Id,
    actKind: Type.Union(['follow-up-draft', 'task-extract', 'nudge'].map((k) => Type.Literal(k)), {
      description: 'which Act node produced this (mirrors Mode.acts[].kind); only follow-up-draft is implemented in P2',
    }),
    body: Type.String({ description: 'the prepared draft, markdown prose' }),
    status: Type.Union([Type.Literal('prepared')], {
      description: 'always "prepared": the app prepares, it never sends/commits/replies outward (ARCHITECTURE §1) — the enum has one member by design',
    }),
    voice: Type.Object(
      {
        registerId: Type.Optional(Id),
        scope: Type.Union(['global', 'mode', 'workspace', 'session'].map((s) => Type.Literal(s)), {
          description: 'which binding scope won resolution — a session register wins over the mode default',
        }),
        dials: Dials,
      },
      { additionalProperties: false, description: 'the resolved voice vector this draft was composed under' },
    ),
    provenance: Type.Object(
      {
        templateId: Id,
        templateVersion: Type.Optional(Type.Integer({ minimum: 1 })),
        slot: SlotName,
        endpoint: Type.String({ minLength: 1, description: 'fabric endpoint name that produced this' }),
        model: Type.Optional(Type.String()),
        sourceDistillates: Type.Array(Id, { description: 'distillate ids the draft was composed from' }),
        sourceMoments: Type.Array(Id, { description: 'moment ids the draft was composed from' }),
      },
      { additionalProperties: false },
    ),
    schemaVersion: Type.Integer({ minimum: 1 }),
    createdAt: IsoTime,
  },
  { $id: 'Draft', additionalProperties: false },
)
export type Draft = Static<typeof Draft>
