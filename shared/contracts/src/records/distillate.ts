import { Type, type Static } from '@sinclair/typebox'
import { Id, IsoTime, SlotName, InvokeUsage } from '../common.js'
import { Dials } from '../config/voice.js'
import { EgressDecision } from '../config/egress.js'
import { GuardVerdict } from '../config/guard.js'

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
    // #116: the correlation id of the pipeline pass that produced this record — every record of the same
    // window pass (distillate + its moments + entity mentions + a guard hold) shares it, so an audit trail
    // joins them without fuzzy time-linkage. Append-only/optional: records predating #116 omit it.
    spanId: Type.Optional(Id),
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
        usage: Type.Optional(InvokeUsage),
        // #64: the resolved egress decision this pass ran under (endpoint reach + which layer decided).
        // Append-only/optional — records predating #64 omit it and the ledger renders the local default.
        egress: Type.Optional(EgressDecision),
        // #63: the egress GUARD verdict when this pass ran through an egress hop with the guard active —
        // clean / redacted (span-level detail, never the raw value) / unguarded. Append-only/optional: a
        // local pass (no egress) and records predating #63 omit it and the ledger renders "— no guard".
        guard: Type.Optional(GuardVerdict),
        // pill P2: the id of the workspace's ACTIVE context preset when its body was prepended to this
        // distill pass (see distill/distiller.ts). Append-only/optional — absent ⇒ NO preset was active
        // (today's behavior, byte-identical), so the why-record honestly names the preset that shaped a
        // summary WITHOUT fabricating one when none did. A technical id: it renders only in the System /
        // Ledger register, never on a HUD-tier row.
        presetId: Type.Optional(Id),
      },
      { additionalProperties: false },
    ),
    schemaVersion: Type.Integer({ minimum: 1 }),
    createdAt: IsoTime,
  },
  { $id: 'Distillate', additionalProperties: false },
)
export type Distillate = Static<typeof Distillate>
