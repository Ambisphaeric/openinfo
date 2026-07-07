import { Type, type Static } from '@sinclair/typebox'
import { Id, IsoTime } from '../common.js'

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
