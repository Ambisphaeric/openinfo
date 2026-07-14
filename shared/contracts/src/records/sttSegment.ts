import { Type, type Static } from '@sinclair/typebox'
import { Id, IsoTime } from '../common.js'
import { EgressDecision } from '../config/egress.js'

/** Schema version of the SttSegment record shape — bumped when the persisted shape changes. */
export const STT_SEGMENT_SCHEMA_VERSION = 1

/**
 * The provenance of ONE transcription invoke (#116) — which stt endpoint answered, the model when the
 * endpoint names one, how long the invoke took, and the egress decision it ran under (#64) when consent
 * was resolved. Endpoint NAMES only, never a url or secret — the same rule every other provenance block
 * follows.
 */
export const SttSegmentProvenance = Type.Object(
  {
    slot: Type.Literal('stt'),
    endpoint: Type.String({ minLength: 1, description: 'fabric endpoint name that transcribed this segment — never a url/secret' }),
    model: Type.Optional(Type.String({ description: 'the stt model that answered, when the endpoint names one' })),
    durationMs: Type.Optional(Type.Integer({ minimum: 0, description: 'wall-clock duration of the transcription invoke in ms' })),
    egress: Type.Optional(EgressDecision),
  },
  { additionalProperties: false },
)
export type SttSegmentProvenance = Static<typeof SttSegmentProvenance>

/**
 * The persisted provenance of ONE transcribed audio segment (#116) — the ROOT a pipeline trace walks
 * from. Before this record, STT invokes persisted no provenance row (the disclosed #65 gap): an
 * utterance had no ledger identity, so "which endpoint transcribed this?" was unanswerable after the
 * fact. One record per successfully-transcribed capture chunk, engine-stamped at the transcribe drain.
 *
 * It deliberately does NOT carry the transcript text: raw transcript chunks are the ephemeral fast-path
 * and expire once distilled (the durable text stream is the Distillate). `textChars` records the SIZE of
 * what was heard — enough to audit, never the content. The parent link is `chunkId`: the same capture
 * chunk id lands in `Distillate.sourceChunks` downstream, so a trace joins segment → summary → moment/
 * field deterministically, and `spanId` groups every record of the same pipeline pass.
 */
export const SttSegment = Type.Object(
  {
    id: Id,
    workspaceId: Id,
    sessionId: Id,
    chunkId: Id,
    // #116: the transcribe pass this segment was produced in — the shared correlation id. Optional so the
    // shape stays additive-friendly, but the engine always stamps it on new records.
    spanId: Type.Optional(Id),
    source: Type.Union(['mic', 'screen', 'calendar', 'repo', 'camera', 'system-audio'].map((s) => Type.Literal(s)), {
      description: 'the physical capture lane of the source chunk — a stream, never a speaker identity',
    }),
    capturedAt: IsoTime,
    processedAt: IsoTime,
    textChars: Type.Integer({ minimum: 0, description: 'transcript length in characters — a size for auditing, never the content' }),
    provenance: SttSegmentProvenance,
    schemaVersion: Type.Integer({ minimum: 1 }),
    createdAt: IsoTime,
  },
  { $id: 'SttSegment', additionalProperties: false },
)
export type SttSegment = Static<typeof SttSegment>
