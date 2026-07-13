import { Type } from '@sinclair/typebox'

export const FIXTURE_FORMAT = 'openinfo.pipeline-fixture'
export const FIXTURE_FORMAT_VERSION = 1

const IsoTime = Type.String({ minLength: 1 })
const Id = Type.String({ minLength: 1 })
const Lane = Type.Union([Type.Literal('mic'), Type.Literal('system-audio'), Type.Literal('screen')])

const CaptureChunk = Type.Object(
  {
    id: Id,
    sessionId: Id,
    workspaceId: Id,
    source: Lane,
    sequence: Type.Integer({ minimum: 0 }),
    capturedAt: IsoTime,
    contentType: Type.String({ minLength: 1 }),
    encoding: Type.Union([Type.Literal('utf8'), Type.Literal('base64')]),
    data: Type.String(),
  },
  { additionalProperties: true },
)

const Usage = Type.Object(
  {
    promptTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    completionTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    totalTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    estimated: Type.Boolean(),
    durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: true },
)

const Egress = Type.Object(
  {
    reach: Type.String({ minLength: 1 }),
    allowed: Type.Boolean(),
    decidedBy: Type.String({ minLength: 1 }),
    reason: Type.String({ minLength: 1 }),
  },
  { additionalProperties: true },
)

const TranscriptSegment = Type.Object(
  {
    text: Type.String(),
    startSec: Type.Optional(Type.Number({ minimum: 0 })),
    endSec: Type.Optional(Type.Number({ minimum: 0 })),
    noSpeechProb: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  },
  { additionalProperties: true },
)

const SttOutput = Type.Object(
  {
    slot: Type.Literal('stt'),
    text: Type.String(),
    endpoint: Type.String({ minLength: 1 }),
    model: Type.Optional(Type.String()),
    language: Type.Optional(Type.String()),
    durationSec: Type.Optional(Type.Number({ minimum: 0 })),
    segments: Type.Optional(Type.Array(TranscriptSegment)),
    egress: Type.Optional(Egress),
  },
  { additionalProperties: true },
)

const ScreenBlock = Type.Object(
  {
    text: Type.String(),
    confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    region: Type.Optional(
      Type.Object(
        {
          x: Type.Integer({ minimum: 0 }),
          y: Type.Integer({ minimum: 0 }),
          width: Type.Integer({ minimum: 1 }),
          height: Type.Integer({ minimum: 1 }),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
)

const ScreenOutput = Type.Object(
  {
    slot: Type.Union([Type.Literal('ocr'), Type.Literal('vlm')]),
    text: Type.String(),
    endpoint: Type.String({ minLength: 1 }),
    model: Type.Optional(Type.String()),
    blocks: Type.Optional(Type.Array(ScreenBlock)),
    usage: Type.Optional(Usage),
    egress: Type.Optional(Egress),
  },
  { additionalProperties: true },
)

const EntryBase = {
  ordinal: Type.Integer({ minimum: 0 }),
  id: Id,
  lane: Lane,
  at: IsoTime,
}

const CaptureEntry = Type.Object(
  {
    ...EntryBase,
    kind: Type.Literal('capture'),
    media: Type.Union([Type.Literal('text'), Type.Literal('synthetic'), Type.Literal('redacted'), Type.Literal('raw')]),
    value: CaptureChunk,
  },
  { additionalProperties: true },
)

const StageEntry = (kind, output) => Type.Object(
  {
    ...EntryBase,
    kind: Type.Literal(kind),
    inputIds: Type.Array(Id, { minItems: 1, maxItems: 1 }),
    output,
  },
  { additionalProperties: true },
)

export const FixtureEnvelopeSchema = Type.Object(
  {
    format: Type.Literal(FIXTURE_FORMAT),
    formatVersion: Type.Integer({ minimum: 1 }),
    fixtureId: Id,
    recordedAt: IsoTime,
    privacy: Type.Object(
      {
        classification: Type.Union([Type.Literal('synthetic'), Type.Literal('sanitized'), Type.Literal('sensitive')]),
        rawMedia: Type.Boolean(),
        containsPersonalData: Type.Boolean(),
        notice: Type.String({ minLength: 1 }),
      },
      { additionalProperties: true },
    ),
    replay: Type.Object(
      { at: IsoTime },
      { additionalProperties: true },
    ),
    entries: Type.Array(
      Type.Union([
        CaptureEntry,
        StageEntry('stt', SttOutput),
        StageEntry('ocr', ScreenOutput),
        StageEntry('vlm', ScreenOutput),
      ]),
      { minItems: 1 },
    ),
    digest: Type.String({ pattern: '^sha256:[0-9a-f]{64}$' }),
  },
  {
    $id: 'OpeninfoPipelineFixtureV1',
    additionalProperties: true,
    description: 'Versioned record/replay envelope for normalized openinfo capture and model-boundary data.',
  },
)
