import { Type, type Static } from '@sinclair/typebox'
import { Id, IsoTime } from '../common.js'

/** The three physical senses shown side-by-side. This is intentionally narrower than CaptureSource. */
export const PhysicalSenseSource = Type.Union(
  [Type.Literal('mic'), Type.Literal('system-audio'), Type.Literal('screen')],
  { $id: 'PhysicalSenseSource', description: 'a physical live-sense lane; never a speaker identity' },
)
export type PhysicalSenseSource = Static<typeof PhysicalSenseSource>

/** Closed visible outcomes. Slice B produces the first four; the remainder are reserved for screen truth. */
export const SenseLaneDisposition = Type.Union(
  ['stopped', 'waiting', 'queued', 'processed', 'delta-skipped', 'blank', 'failed'].map((value) => Type.Literal(value)),
  { $id: 'SenseLaneDisposition' },
)
export type SenseLaneDisposition = Static<typeof SenseLaneDisposition>

export const SenseLaneHealth = Type.Union(
  ['unknown', 'healthy', 'blocked', 'failed'].map((value) => Type.Literal(value)),
  { $id: 'SenseLaneHealth' },
)
export type SenseLaneHealth = Static<typeof SenseLaneHealth>

/**
 * Public explanations are closed codes, never exception/server/model text. A surface translates these
 * codes into copy; captured content and unsanitized errors cannot enter the live-state event by accident.
 */
export const SenseLaneReason = Type.Union(
  [
    'no-session',
    'awaiting-capture',
    'awaiting-processing',
    'processed',
    'session-ended',
    'delta-skipped',
    'blank',
    'capture-failed',
    'processing-failed',
    'disabled',
    'permission-denied',
    'configuration-blocked',
  ].map((value) => Type.Literal(value)),
  { $id: 'SenseLaneReason' },
)
export type SenseLaneReason = Static<typeof SenseLaneReason>

/** lagMs is always completion time minus the correlated source capture time. */
export const SenseLaneLagBasis = Type.Literal('capture-to-processing-completion', {
  $id: 'SenseLaneLagBasis',
  description: 'latestProcessing.lagMs = max(0, latestProcessing.completedAt - latestProcessing.capturedAt)',
})
export type SenseLaneLagBasis = Static<typeof SenseLaneLagBasis>

export const SenseLaneCapture = Type.Object(
  { id: Id, capturedAt: IsoTime },
  { $id: 'SenseLaneCapture', additionalProperties: false },
)
export type SenseLaneCapture = Static<typeof SenseLaneCapture>

/**
 * A client report about one screen-capture attempt. This deliberately carries only correlation and
 * time metadata: pixels, extracted text, image hashes/previews, display details, delta scores, and
 * exception strings are not legal at this control-plane boundary.
 */
export const ScreenCaptureObservation = Type.Union(
  [
    Type.Object(
      {
        workspaceId: Id,
        sessionId: Id,
        outcome: Type.Literal('queued'),
        capture: SenseLaneCapture,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        workspaceId: Id,
        sessionId: Id,
        outcome: Type.Literal('delta-skipped'),
        observationId: Id,
        occurredAt: IsoTime,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        workspaceId: Id,
        sessionId: Id,
        // permission-denied is the client's honest "the OS refused screen capture for this run" report —
        // still a closed code with attempt correlation only; the refusing API/error text never rides it.
        outcome: Type.Union([Type.Literal('grab-failed'), Type.Literal('permission-denied')]),
        observationId: Id,
        occurredAt: IsoTime,
      },
      { additionalProperties: false },
    ),
  ],
  { $id: 'ScreenCaptureObservation', description: 'metadata-only outcome of one screen capture attempt' },
)
export type ScreenCaptureObservation = Static<typeof ScreenCaptureObservation>

/** Exact client-attempt provenance retained when screen state comes from a non-capture observation. */
export const ScreenLaneObservation = Type.Object(
  {
    id: Id,
    occurredAt: IsoTime,
    outcome: Type.Union([
      Type.Literal('delta-skipped'),
      Type.Literal('grab-failed'),
      Type.Literal('permission-denied'),
    ]),
  },
  {
    $id: 'ScreenLaneObservation',
    additionalProperties: false,
    description: 'metadata-only derivation evidence for a visible screen delta-skip, failed grab, or refused capture permission',
  },
)
export type ScreenLaneObservation = Static<typeof ScreenLaneObservation>

/** Internal processor-to-read-model evidence. Failure details remain in private logs, never here. */
export const ScreenProcessingOutcome = Type.Object(
  {
    workspaceId: Id,
    sessionId: Id,
    outcome: Type.Union(
      [Type.Literal('processed'), Type.Literal('blank'), Type.Literal('failed')],
    ),
    capture: SenseLaneCapture,
    completedAt: IsoTime,
  },
  {
    $id: 'ScreenProcessingOutcome',
    additionalProperties: false,
    description: 'metadata-only terminal result for one correlated screen frame',
  },
)
export type ScreenProcessingOutcome = Static<typeof ScreenProcessingOutcome>

export const SenseLaneProcessing = Type.Object(
  {
    captureId: Id,
    capturedAt: IsoTime,
    completedAt: IsoTime,
    outcome: Type.Union(
      [Type.Literal('processed'), Type.Literal('blank'), Type.Literal('failed')],
      { description: 'the terminal result supported by this exact processing evidence' },
    ),
    lagMs: Type.Integer({ minimum: 0 }),
    basis: SenseLaneLagBasis,
  },
  { $id: 'SenseLaneProcessing', additionalProperties: false },
)
export type SenseLaneProcessing = Static<typeof SenseLaneProcessing>

/**
 * One metadata-only lane row. `latestProcessing.captureId + capturedAt + outcome` make result and lag
 * provenance unambiguous when an older capture finishes after a newer capture has queued. No captured
 * text/bytes/preview/hash/model output or arbitrary error string is legal in this closed object.
 */
const laneSnapshotProperties = <Source extends PhysicalSenseSource>(source: Source) => ({
    workspaceId: Id,
    sessionId: Type.Optional(Id),
    source: Type.Literal(source),
    disposition: SenseLaneDisposition,
    health: SenseLaneHealth,
    reason: SenseLaneReason,
    updatedAt: IsoTime,
    latestCapture: Type.Optional(SenseLaneCapture),
    latestProcessing: Type.Optional(SenseLaneProcessing),
})

const MicSenseLaneSnapshot = Type.Object(laneSnapshotProperties('mic'), { additionalProperties: false })
const SystemAudioSenseLaneSnapshot = Type.Object(laneSnapshotProperties('system-audio'), { additionalProperties: false })
const ScreenSenseLaneSnapshot = Type.Object(
  {
    ...laneSnapshotProperties('screen'),
    /** Present only while the visible value was derived from delta-skipped/grab-failed/permission-denied attempt metadata. */
    latestObservation: Type.Optional(ScreenLaneObservation),
  },
  { additionalProperties: false },
)

export const SenseLaneSnapshot = Type.Union(
  [MicSenseLaneSnapshot, SystemAudioSenseLaneSnapshot, ScreenSenseLaneSnapshot],
  { $id: 'SenseLaneSnapshot', description: 'metadata-only live state for one physical sense' },
)
export type SenseLaneSnapshot = Static<typeof SenseLaneSnapshot>

/** A hydration-safe set: exactly one row for each physical source, in canonical display order. */
export const SenseLaneSnapshotSet = Type.Object(
  {
    workspaceId: Id,
    sessionId: Type.Optional(Id),
    lanes: Type.Tuple([MicSenseLaneSnapshot, SystemAudioSenseLaneSnapshot, ScreenSenseLaneSnapshot]),
  },
  { $id: 'SenseLaneSnapshotSet', additionalProperties: false },
)
export type SenseLaneSnapshotSet = Static<typeof SenseLaneSnapshotSet>
