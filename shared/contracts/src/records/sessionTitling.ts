import { Type, type Static } from '@sinclair/typebox'
import { Id, IsoTime } from '../common.js'

/** Schema version of the SessionTitling record shape — bumped when the persisted shape changes. */
export const SESSION_TITLING_SCHEMA_VERSION = 1

/**
 * The provenance of ONE DERIVED episode title (#211) — the inspectable "which pass, and on what
 * evidence, produced this name". A derived title is a DETERMINISTIC transform of an orientation
 * classification (a `SessionAnnotation`, #131): the model output is the proposal, the title is a pure
 * function of it. So the provenance references the exact orientation pass (`annotationId` + the judge
 * `templateId`/`endpoint` that classified) AND records the classification EVIDENCE the title was drawn
 * from (`nature`/`direction`/`topics`) — enough to explain the name without re-reading the annotation.
 * Absent on a USER title (a rename carries no orientation evidence — the user IS the authority).
 */
export const TitlingProvenance = Type.Object(
  {
    annotationId: Id,
    templateId: Id,
    endpoint: Type.String({ description: 'the fabric endpoint that classified (never a secret value)' }),
    model: Type.Optional(Type.String({ description: 'the model that answered, when the endpoint names one' })),
    classifiedAt: IsoTime,
    nature: Type.String({ description: 'the orientation nature the title drew from (evidence, not fabricated)' }),
    direction: Type.String({ description: 'the orientation direction the title drew from' }),
    topics: Type.Array(Type.String({ minLength: 1 }), { description: 'the orientation topics the title drew from' }),
  },
  { $id: 'TitlingProvenance', additionalProperties: false },
)
export type TitlingProvenance = Static<typeof TitlingProvenance>

/**
 * The provenance of ONE DETERMINISTIC-FLOOR episode title (#226) — the zero-model naming rung that fills
 * the gap BEFORE (or in place of) a judge derivation. A floor title is NOT a model output: it is a pure,
 * deterministic transform of signals that ALREADY exist for the session (its ranked entities), so this
 * provenance honestly names the deterministic PRODUCER and the SUBJECTS the name drew from — never an
 * endpoint, model, or orientation annotation (it must not impersonate the judge). `producer` is the
 * deterministic source (e.g. `session-entities`); `subjects` are the ranked signal values the title was
 * built from; `derivedAt` is when the floor ran. Distinct from `TitlingProvenance` so a reader can always
 * tell a model-classified name apart from a model-free floor.
 */
export const FloorTitlingProvenance = Type.Object(
  {
    producer: Type.String({ minLength: 1, description: 'the deterministic producer that built this floor title, e.g. "session-entities" — never a model' }),
    subjects: Type.Array(Type.String({ minLength: 1 }), { description: 'the ranked signal values the floor name drew from (evidence, not fabricated)' }),
    derivedAt: IsoTime,
  },
  { $id: 'FloorTitlingProvenance', additionalProperties: false },
)
export type FloorTitlingProvenance = Static<typeof FloorTitlingProvenance>

/**
 * ONE episode titling of a session (#211) — the APPEND-ONLY record of a name a session was given, plus
 * where the name came from. Sessions never demand an up-front title: a derived title is minted from the
 * orientation classification (#131) once the source supports one, and a user may rename at any time.
 *
 * APPEND-ONLY WITH PROVENANCE: each titling is a NEW immutable record (unique `id`), never a mutation of
 * a prior one — a re-derivation with a different name appends a fresh `derived` titling, a deterministic
 * re-run appends a fresh `floor` titling, and a rename appends a fresh `user` titling. The effective title
 * of a session is RESOLVED across its titlings by the precedence LADDER (#226): latest `user` wins
 * (sovereign — a machine never clobbers a human's name), else latest `derived` (a judge/orientation
 * classification), else latest `floor` (the zero-model deterministic rung), else an honest start-time
 * fallback (never a raw id). `source` is a closed union: `derived` carries the orientation `provenance`;
 * `floor` carries the deterministic-producer `provenance` (never impersonating the judge); `user` omits it
 * (the user is the authority — no model evidence to cite).
 */
export const SessionTitling = Type.Object(
  {
    id: Id,
    workspaceId: Id,
    sessionId: Id,
    title: Type.String({ minLength: 1, description: 'the human-meaningful episode name — never a raw id' }),
    source: Type.Union([Type.Literal('derived'), Type.Literal('floor'), Type.Literal('user')], {
      description: 'derived (a judge/orientation pass), floor (a deterministic zero-model producer, #226), or user (a sovereign rename)',
    }),
    provenance: Type.Optional(Type.Union([TitlingProvenance, FloorTitlingProvenance])),
    createdAt: IsoTime,
    schemaVersion: Type.Integer({ minimum: 1 }),
  },
  { $id: 'SessionTitling', additionalProperties: false },
)
export type SessionTitling = Static<typeof SessionTitling>
