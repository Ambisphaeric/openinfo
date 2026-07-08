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
  ['mic', 'screen', 'calendar', 'repo', 'camera', 'system-audio'].map((s) => Type.Literal(s)),
  { $id: 'CaptureSource', description: 'mic = the user; system-audio = the far side of a call (loopback) — the free me/them split' },
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

/**
 * The result of compiling a BlockQuery server-side (POST /query). A BlockQuery is "compiled
 * server-side to store calls" (the Phase-0 surface.ts decision), so the client never owns data —
 * every built-in block is an API call against this endpoint. `items` are the hydrated rows; their
 * element shape is keyed by `source` (relevant-now→RelevantEntity, moments→Moment, sessions→
 * Session, entities→Entity, ledger→Commitment, pins→Pin), which is why it is `unknown[]` rather
 * than one over-broad union. `top` echoes the requested cap; `truncated` is true when more rows
 * existed than were returned (the HUD shows top-K, the workbench holds the rest — surface.ts).
 * Sources whose backing store does not exist yet (ledger P4, pins P3) return `[]`, not an error.
 */
export const QueryResult = Type.Object(
  {
    source: Type.Union(
      ['relevant-now', 'moments', 'ledger', 'sessions', 'pins', 'entities'].map((s) => Type.Literal(s)),
    ),
    items: Type.Array(Type.Unknown(), { description: 'hydrated rows; element shape is keyed by `source`' }),
    top: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    truncated: Type.Boolean({ description: 'true when more rows existed than were returned under `top`' }),
  },
  { $id: 'QueryResult', additionalProperties: false },
)
export type QueryResult = Static<typeof QueryResult>

/**
 * The body of POST /sessions — a manual session START request. The caller supplies only what it
 * knows (which workspace, which mode, optionally a register override and a title); the engine
 * stamps id/startedAt/attribution and returns the full Session. A dedicated payload (not a partial
 * Session) so the caller never invents server-owned fields, mirroring RelevantEntity's precedent.
 */
export const StartSessionRequest = Type.Object(
  {
    workspaceId: Id,
    modeId: Id,
    registerId: Type.Optional(Id),
    title: Type.Optional(Type.String()),
  },
  { $id: 'StartSessionRequest', additionalProperties: false },
)
export type StartSessionRequest = Static<typeof StartSessionRequest>

/**
 * The body of `POST /fabric/profiles/:id/clone` — the new profile's id (+ optional name). Cloning is
 * copying a document (ARCHITECTURE §2/§8): the engine reads the source profile, restamps id/name/
 * version, and writes a fresh document. Kept as a route (not client GET+PUT) so a clone is atomic.
 */
export const CloneProfileRequest = Type.Object(
  {
    id: Id,
    name: Type.Optional(Type.String({ minLength: 1 })),
  },
  { $id: 'CloneProfileRequest', additionalProperties: false },
)
export type CloneProfileRequest = Static<typeof CloneProfileRequest>

/**
 * A secret REFERENCE — the ONLY secret-shaped thing that ever leaves the engine. `GET /fabric/secrets`
 * returns these (the refs that have a stored value), and write/delete echo back the ref they touched.
 * It carries NO value field, by design: no route, event, GET response, document, or export ever
 * returns key material (the never-echo-to-UI discipline). The value is set via SecretValue (inbound
 * only) and resolved server-side at invoke time.
 */
export const SecretRef = Type.Object(
  { ref: Type.String({ minLength: 1, description: 'the keyRef an endpoint auth block points at' }) },
  { $id: 'SecretRef', additionalProperties: false },
)
export type SecretRef = Static<typeof SecretRef>

/**
 * The body of `PUT /fabric/secrets/:ref` — the write-only inbound path for a secret value. This is
 * the one schema that carries key material, and it is REQUEST-ONLY: it is never used as a response,
 * never persisted in a document, never echoed. The engine stores the value in the secret store and
 * replies with a bare SecretRef.
 */
export const SecretValue = Type.Object(
  { value: Type.String({ minLength: 1, description: 'the secret value — inbound only, never returned' }) },
  { $id: 'SecretValue', additionalProperties: false },
)
export type SecretValue = Static<typeof SecretValue>

/**
 * The result of a connectivity probe against ONE endpoint (POST /fabric/test) — the setup page's
 * "Test" button backing. It is the existing health check (fabric/health.ts) exposed as a thin,
 * read-only helper: reachable? + latency, with a human `hint` on a failure the user can act on (a
 * 401/403 → set a key and reference it via keyRef; an unresolved keyRef → store its value below).
 * If the endpoint carries a previously MEASURED throughput (tools/bench, on the endpoint doc), it is
 * echoed as `tokPerSec` — this probe pings, it does not itself benchmark generation. Request-shaped
 * body is an Endpoint (the row's current — possibly unsaved — values), so a user can test before saving.
 */
export const EndpointProbe = Type.Object(
  {
    ok: Type.Boolean(),
    latencyMs: Type.Optional(Type.Number({ minimum: 0 })),
    tokPerSec: Type.Optional(Type.Number({ minimum: 0, description: 'last MEASURED tok/s from the endpoint doc — not measured by this probe' })),
    error: Type.Optional(Type.String()),
    hint: Type.Optional(Type.String({ description: 'an actionable next step when the probe fails (e.g. a keyRef hint on 401)' })),
  },
  { $id: 'EndpointProbe', additionalProperties: false },
)
export type EndpointProbe = Static<typeof EndpointProbe>
