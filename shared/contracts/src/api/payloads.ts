import { Type, type Static } from '@sinclair/typebox'
import { Id, IsoTime } from '../common.js'
import { Entity } from '../records/entity.js'
import { Moment } from '../records/moment.js'

export const Health = Type.Object(
  {
    ok: Type.Boolean(),
    phase: Type.Integer({ minimum: 0, maximum: 7 }),
    uptimeMs: Type.Number({ minimum: 0 }),
    checkedAt: IsoTime,
  },
  { $id: 'Health', additionalProperties: false },
)
export type Health = Static<typeof Health>

export const JsonSchema = Type.Record(Type.String(), Type.Unknown(), { $id: 'JsonSchema' })
export type JsonSchema = Static<typeof JsonSchema>

export const CaptureSource = Type.Union(
  ['mic', 'screen', 'calendar', 'repo', 'camera'].map((s) => Type.Literal(s)),
  { $id: 'CaptureSource' },
)
export type CaptureSource = Static<typeof CaptureSource>

export const CaptureChunk = Type.Object(
  {
    id: Id,
    sessionId: Id,
    workspaceId: Id,
    source: CaptureSource,
    sequence: Type.Integer({ minimum: 0 }),
    capturedAt: IsoTime,
    contentType: Type.String({ minLength: 1 }),
    encoding: Type.Union([Type.Literal('utf8'), Type.Literal('base64')]),
    data: Type.String(),
  },
  { $id: 'CaptureChunk', additionalProperties: false },
)
export type CaptureChunk = Static<typeof CaptureChunk>

export const Ack = Type.Object(
  {
    ok: Type.Boolean(),
    chunkId: Id,
    sequence: Type.Integer({ minimum: 0 }),
    receivedAt: IsoTime,
  },
  { $id: 'Ack', additionalProperties: false },
)
export type Ack = Static<typeof Ack>

export const QueueStatus = Type.Object(
  {
    pendingFiles: Type.Integer({ minimum: 0 }),
    pendingBytes: Type.Integer({ minimum: 0 }),
    drainedFiles: Type.Integer({ minimum: 0 }),
    updatedAt: IsoTime,
  },
  { $id: 'QueueStatus', additionalProperties: false },
)
export type QueueStatus = Static<typeof QueueStatus>

/**
 * One row of the relevant-now join (Index v0): a ranked entity together with the recent moments
 * that reference it. The score is the recency×frequency rank at query time; the joined moments
 * carry their own provenance so a surfaced entity's relevance is inspectable (product principle 1).
 * Served by GET /relevant.
 */
export const RelevantEntity = Type.Object(
  {
    entity: Entity,
    score: Type.Number({ minimum: 0, description: 'recency×frequency rank score at query time' }),
    moments: Type.Array(Moment, { description: 'recent moments referencing this entity — the inspectable join' }),
  },
  { $id: 'RelevantEntity', additionalProperties: false },
)
export type RelevantEntity = Static<typeof RelevantEntity>
