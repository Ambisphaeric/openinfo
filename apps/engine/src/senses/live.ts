import type {
  CaptureChunk,
  OcrResult,
  PhysicalSenseSource,
  ScreenCaptureObservation,
  ScreenProcessingOutcome,
  SenseLaneCapture,
  SenseLaneProcessing,
  SenseLaneSnapshot,
  SenseLaneSnapshotSet,
  Session,
  TranscriptUpdate,
} from '@openinfo/contracts'

/** Canonical HUD order. This is deliberately narrower than CaptureSource. */
export const PHYSICAL_SENSE_SOURCES = ['mic', 'system-audio', 'screen'] as const satisfies readonly PhysicalSenseSource[]

/**
 * The two gate-derived blockers a lane can carry (#192). `disabled` = a feature toggle the user can flip
 * back on; `configuration-blocked` = required configuration is missing (an empty slot, a missing workflow
 * screen step/document). Deliberately a closed subset of SenseLaneReason: `permission-denied` is NOT a
 * gate overlay — it arrives as client-observed capture truth through recordScreenCaptureObservation.
 */
export type SenseLaneGateReason = 'disabled' | 'configuration-blocked'

/** Engine-global gate verdict per physical lane: absent = that lane's engine-side gates are all open. */
export type SenseLaneGateState = Partial<Record<PhysicalSenseSource, SenseLaneGateReason>>

export interface SenseLaneTrackerOptions {
  now?: () => Date
}

interface CaptureRef extends SenseLaneCapture {
  sequence: number
}

interface LaneState {
  snapshot: SenseLaneSnapshot
  captures: Map<string, CaptureRef>
  processedCaptureIds: Set<string>
  screenOutcomes: Map<string, ScreenProcessingOutcome['outcome']>
  screenProcessingAtMs: Map<string, number>
  screenObservationIds: Set<string>
  latestCapture?: CaptureRef
  latestScreenEvent?: ScreenEventRef
}

interface ScreenEventRef {
  kind: 'capture' | 'observation'
  id: string
  occurredAt: string
  occurredAtMs: number
}

interface SessionState {
  workspaceId: string
  sessionId: string
  startedAtMs: number
  ended: boolean
  lanes: Record<PhysicalSenseSource, LaneState>
}

const keyFor = (workspaceId: string, sessionId: string): string => `${workspaceId}\u0000${sessionId}`
const timeMs = (value: string): number | undefined => {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const compareCapture = (a: CaptureRef, b: CaptureRef): number => {
  const aAt = timeMs(a.capturedAt) ?? 0
  const bAt = timeMs(b.capturedAt) ?? 0
  // sequence is source-local and authoritative inside this already session+lane-scoped reducer. Wall
  // time can jump backwards; it is evidence for lag/ranges, never the primary same-lane ordering clock.
  return a.sequence - b.sequence || aAt - bAt || a.id.localeCompare(b.id)
}

const cloneLane = (lane: SenseLaneSnapshot): SenseLaneSnapshot => ({
  ...lane,
  ...(lane.latestCapture ? { latestCapture: { ...lane.latestCapture } } : {}),
  ...(lane.latestProcessing ? { latestProcessing: { ...lane.latestProcessing } } : {}),
  ...(lane.source === 'screen' && lane.latestObservation
    ? { latestObservation: { ...lane.latestObservation } }
    : {}),
}) as SenseLaneSnapshot

const clearScreenObservation = (lane: SenseLaneSnapshot): SenseLaneSnapshot => {
  if (lane.source !== 'screen') return lane
  const { latestObservation: _latestObservation, ...withoutObservation } = lane
  return withoutObservation as SenseLaneSnapshot
}

const makeLane = (
  source: PhysicalSenseSource,
  workspaceId: string,
  updatedAt: string,
  sessionId?: string,
): SenseLaneSnapshot => ({
  workspaceId,
  ...(sessionId ? { sessionId } : {}),
  source,
  disposition: sessionId ? 'waiting' : 'stopped',
  health: 'unknown',
  reason: sessionId ? 'awaiting-capture' : 'no-session',
  updatedAt,
}) as SenseLaneSnapshot

/**
 * Process-local, metadata-only live read model for the three physical senses. It retains capture ids,
 * source timestamps, completion timestamps, and fixed-basis lag only. Captured bytes/text, OCR output,
 * endpoint provenance, and arbitrary errors never enter this object. #192: real gate verdicts overlay the
 * projection per source (applyGates), so an off lane names its true blocker — disabled or
 * configuration-blocked — instead of reading idle, and reopening the gate restores truth without restart.
 */
export class SenseLaneTracker {
  private readonly now: () => Date
  private readonly sessions = new Map<string, SessionState>()
  private readonly currentByWorkspace = new Map<string, string>()
  /** Retained after end so a delayed older session.started can never reactivate stale capture. */
  private readonly startWatermarkByWorkspace = new Map<string, number>()
  private readonly coldByWorkspace = new Map<string, Record<PhysicalSenseSource, SenseLaneSnapshot>>()
  /**
   * The engine-global gate overlay (#192): flags/fabric/workflow gates are engine-wide, so one verdict per
   * physical source. It is applied at PROJECTION time over an untouched underlying reducer state, so
   * reopening a gate restores the lane's exact prior truth without restart, and gate churn can never
   * corrupt capture/processing evidence or ordering.
   */
  private gates: SenseLaneGateState = {}

  constructor(options: SenseLaneTrackerOptions = {}) {
    this.now = options.now ?? (() => new Date())
  }

  /** Start one session. Replaying session.started/session.switched for the same id is a strict no-op. */
  startSession(session: Session): SenseLaneSnapshot[] {
    const key = keyFor(session.workspaceId, session.id)
    if (this.sessions.has(key)) return []
    const startedAtMs = timeMs(session.startedAt)
    if (startedAtMs === undefined) return []
    const currentKey = this.currentByWorkspace.get(session.workspaceId)
    const current = currentKey ? this.sessions.get(currentKey) : undefined
    if (current && !current.ended) return []
    if (startedAtMs < (this.startWatermarkByWorkspace.get(session.workspaceId) ?? -Infinity)) return []

    const updatedAt = this.now().toISOString()
    const lanes = Object.fromEntries(
      PHYSICAL_SENSE_SOURCES.map((source) => [source, {
        snapshot: makeLane(source, session.workspaceId, updatedAt, session.id),
        captures: new Map<string, CaptureRef>(),
        processedCaptureIds: new Set<string>(),
        screenOutcomes: new Map<string, ScreenProcessingOutcome['outcome']>(),
        screenProcessingAtMs: new Map<string, number>(),
        screenObservationIds: new Set<string>(),
      }]),
    ) as Record<PhysicalSenseSource, LaneState>
    const state: SessionState = { workspaceId: session.workspaceId, sessionId: session.id, startedAtMs, ended: false, lanes }
    this.sessions.set(key, state)
    this.currentByWorkspace.set(session.workspaceId, key)
    this.startWatermarkByWorkspace.set(
      session.workspaceId,
      Math.max(startedAtMs, this.startWatermarkByWorkspace.get(session.workspaceId) ?? -Infinity),
    )
    return PHYSICAL_SENSE_SOURCES.map((source) => this.projectLane(state, source))
  }

  /** End exactly the named session. Late capture/processing work is ignored and cannot reopen it. */
  endSession(session: Session): SenseLaneSnapshot[] {
    const state = this.sessions.get(keyFor(session.workspaceId, session.id))
    if (!state || state.ended) return []
    state.ended = true
    const key = keyFor(session.workspaceId, session.id)
    if (this.currentByWorkspace.get(session.workspaceId) === key) this.currentByWorkspace.delete(session.workspaceId)
    const updatedAt = this.now().toISOString()
    for (const source of PHYSICAL_SENSE_SOURCES) {
      const snapshotBase = source === 'screen'
        ? clearScreenObservation(state.lanes[source].snapshot)
        : state.lanes[source].snapshot
      state.lanes[source].snapshot = {
        ...snapshotBase,
        disposition: 'stopped',
        health: 'unknown',
        reason: 'session-ended',
        updatedAt,
      } as SenseLaneSnapshot
    }
    // Ended lanes are never gate-overlaid: with no live run the truthful blocker is the ended session.
    return PHYSICAL_SENSE_SOURCES.map((source) => this.projectLane(state, source))
  }

  /** Record only physical media: audio/* for mic/system-audio and image/* for screen. */
  recordCapture(chunk: CaptureChunk): SenseLaneSnapshot | undefined {
    if (!this.isPhysicalMedia(chunk)) return undefined
    const state = this.activeSession(chunk.workspaceId, chunk.sessionId)
    if (!state) return undefined
    const lane = state.lanes[chunk.source as PhysicalSenseSource]
    if (lane.captures.has(chunk.id) || timeMs(chunk.capturedAt) === undefined) return undefined

    const capture: CaptureRef = { id: chunk.id, capturedAt: chunk.capturedAt, sequence: chunk.sequence }
    lane.captures.set(capture.id, capture)
    if (lane.latestCapture && compareCapture(capture, lane.latestCapture) <= 0) return undefined

    lane.latestCapture = capture
    const screenVisibleAdvances = chunk.source !== 'screen' || lane.latestScreenEvent === undefined ||
      lane.latestScreenEvent.kind === 'capture' || timeMs(capture.capturedAt)! > lane.latestScreenEvent.occurredAtMs
    if (chunk.source === 'screen' && screenVisibleAdvances) {
      lane.latestScreenEvent = {
        kind: 'capture', id: capture.id, occurredAt: capture.capturedAt,
        occurredAtMs: timeMs(capture.capturedAt)!,
      }
    }
    const snapshotBase = chunk.source === 'screen' && screenVisibleAdvances
      ? clearScreenObservation(lane.snapshot)
      : lane.snapshot
    lane.snapshot = {
      ...snapshotBase,
      latestCapture: { id: capture.id, capturedAt: capture.capturedAt },
      ...(screenVisibleAdvances ? {
        disposition: 'queued',
        // A queued capture proves receipt, not processing health. A prior completion is the only evidence
        // that lets a later queue retain healthy rather than returning to unknown.
        health: lane.snapshot.latestProcessing?.outcome === 'processed' || lane.snapshot.latestProcessing?.outcome === 'blank'
          ? 'healthy'
          : 'unknown',
        reason: 'awaiting-processing',
      } : {}),
      updatedAt: this.now().toISOString(),
    } as SenseLaneSnapshot
    return this.projectLane(state, chunk.source as PhysicalSenseSource)
  }

  /**
   * Apply client-observable screen capture truth. A queued report may only confirm an exact physical
   * image already accepted through recordCapture; this endpoint cannot manufacture queue state.
   */
  recordScreenCaptureObservation(observation: ScreenCaptureObservation): SenseLaneSnapshot | undefined {
    const state = this.activeSession(observation.workspaceId, observation.sessionId)
    if (!state) return undefined
    const lane = state.lanes.screen

    if (observation.outcome === 'queued') {
      const capture = lane.captures.get(observation.capture.id)
      if (
        !capture || capture.capturedAt !== observation.capture.capturedAt ||
        lane.latestCapture?.id !== capture.id ||
        lane.latestScreenEvent?.kind !== 'capture' || lane.latestScreenEvent.id !== capture.id
      ) return undefined
      // Direct OCR/process reporting can win the race against this redundant acknowledgement. Never
      // turn any terminal result back into a queue, even when it names the same capture.
      if (lane.snapshot.disposition !== 'queued') return undefined
      if (lane.snapshot.health === 'healthy' && lane.snapshot.reason === 'awaiting-processing') return undefined
      lane.snapshot = {
        ...lane.snapshot,
        disposition: 'queued',
        health: 'healthy',
        reason: 'awaiting-processing',
        updatedAt: this.now().toISOString(),
      } as SenseLaneSnapshot
      return this.projectLane(state, 'screen')
    }

    const occurredAtMs = timeMs(observation.occurredAt)
    if (occurredAtMs === undefined || lane.screenObservationIds.has(observation.observationId)) return undefined
    // Consume a valid active-session attempt id even when it is stale. A retry cannot alter occurredAt
    // to manufacture a newer ordering position for an already-observed attempt.
    lane.screenObservationIds.add(observation.observationId)
    if (!this.screenObservationAdvances(lane, occurredAtMs)) return undefined
    lane.latestScreenEvent = {
      kind: 'observation', id: observation.observationId,
      occurredAt: observation.occurredAt, occurredAtMs,
    }
    lane.snapshot = {
      ...lane.snapshot,
      // permission-denied is a structural blocker, not a transient capture fault: the OS refused this
      // run's screen capture. It reads blocked with its true reason; the next accepted physical capture
      // (permission granted again) restores queued truth through the ordinary advance rules.
      ...(observation.outcome === 'delta-skipped'
        ? { disposition: 'delta-skipped', health: 'healthy', reason: 'delta-skipped' }
        : observation.outcome === 'permission-denied'
          ? { disposition: 'failed', health: 'blocked', reason: 'permission-denied' }
          : { disposition: 'failed', health: 'failed', reason: 'capture-failed' }),
      latestObservation: {
        id: observation.observationId,
        occurredAt: observation.occurredAt,
        outcome: observation.outcome,
      },
      updatedAt: this.now().toISOString(),
    } as SenseLaneSnapshot
    return this.projectLane(state, 'screen')
  }

  /** Apply one exact, metadata-only screen processor result with retry-safe terminal ordering. */
  recordScreenProcessingOutcome(outcome: ScreenProcessingOutcome): SenseLaneSnapshot | undefined {
    if (outcome.outcome !== 'processed' && outcome.outcome !== 'blank' && outcome.outcome !== 'failed') return undefined
    const state = this.activeSession(outcome.workspaceId, outcome.sessionId)
    if (!state) return undefined
    const lane = state.lanes.screen
    const capture = lane.captures.get(outcome.capture.id)
    if (!capture || capture.capturedAt !== outcome.capture.capturedAt) return undefined
    return this.recordProcessing(state, lane, [capture], capture, outcome.completedAt, outcome.outcome)
  }

  /** Complete an audio lane only when every claimed source id resolves to that exact lane/session. */
  recordTranscript(update: TranscriptUpdate): SenseLaneSnapshot | undefined {
    if (update.source !== 'mic' && update.source !== 'system-audio') return undefined
    const state = this.findActiveSessionById(update.sessionId)
    if (!state) return undefined
    const lane = state.lanes[update.source]
    if (new Set(update.sourceChunkIds).size !== update.sourceChunkIds.length) return undefined
    const captures = update.sourceChunkIds.map((id) => lane.captures.get(id))
    if (captures.some((capture) => capture === undefined)) return undefined
    const exact = captures as CaptureRef[]
    if (exact.length === 0) return undefined
    const ordered = [...exact].sort(compareCapture)
    if (ordered.some((capture, index) => capture.id !== exact[index]?.id)) return undefined
    const first = ordered[0]!
    const last = ordered.at(-1)!
    const capturedTimes = [...exact]
      .sort((left, right) => (timeMs(left.capturedAt) ?? 0) - (timeMs(right.capturedAt) ?? 0))
      .map((capture) => capture.capturedAt)
    if (
      capturedTimes[0] !== update.capturedAtRange.start ||
      capturedTimes.at(-1) !== update.capturedAtRange.end ||
      first.sequence !== update.sourceSequenceRange.start ||
      last.sequence !== update.sourceSequenceRange.end
    ) return undefined
    return this.recordProcessing(state, lane, exact, last, update.processedAt)
  }

  /** Complete the screen lane only through exact sourceChunks → captured frame correlation. */
  recordOcr(result: OcrResult): SenseLaneSnapshot | undefined {
    const state = this.activeSession(result.workspaceId, result.sessionId)
    if (!state || result.sourceChunks.length === 0 || new Set(result.sourceChunks).size !== result.sourceChunks.length) return undefined
    const lane = state.lanes.screen
    const captures = result.sourceChunks.map((id) => lane.captures.get(id))
    if (captures.some((capture) => capture === undefined)) return undefined
    const exact = captures as CaptureRef[]
    const ordered = [...exact].sort(compareCapture)
    if (ordered.some((capture, index) => capture.id !== exact[index]?.id)) return undefined
    const capture = ordered.at(-1)!
    if (result.capturedAt !== undefined && result.capturedAt !== capture.capturedAt) return undefined
    return this.recordProcessing(state, lane, exact, capture, result.createdAt, 'processed')
  }

  /**
   * Update the engine-global gate overlay from real gate evaluation (#192). Returns the projected rows of
   * every affected lane in currently-active sessions — exactly the rows a caller must publish. Idempotent:
   * an unchanged verdict returns []. Only the two gate reasons are legal; anything else fails closed to
   * "no gate block" so a widened caller can never invent a new public reason through this seam.
   */
  applyGates(next: SenseLaneGateState): SenseLaneSnapshot[] {
    const sanitized: SenseLaneGateState = {}
    for (const source of PHYSICAL_SENSE_SOURCES) {
      const reason = next[source]
      if (reason === 'disabled' || reason === 'configuration-blocked') sanitized[source] = reason
    }
    const changed = PHYSICAL_SENSE_SOURCES.filter((source) => this.gates[source] !== sanitized[source])
    this.gates = sanitized
    if (changed.length === 0) return []
    const updatedAt = this.now().toISOString()
    const rows: SenseLaneSnapshot[] = []
    for (const key of this.currentByWorkspace.values()) {
      const state = this.sessions.get(key)
      if (!state || state.ended) continue
      for (const source of changed) {
        // The visible row genuinely changed, so its updatedAt advances; capture/processing evidence and
        // the underlying disposition/health/reason truth are deliberately untouched.
        state.lanes[source].snapshot = { ...state.lanes[source].snapshot, updatedAt } as SenseLaneSnapshot
        rows.push(this.projectLane(state, source))
      }
    }
    return rows
  }

  /**
   * The RUNTIME-current session id for a workspace (#210), or undefined when no session is live this
   * process. This is the SAME authority that scopes the live sense lanes (`currentByWorkspace`, set on
   * session.started and cleared on session.ended) — deliberately NOT store.liveSession's persisted most-
   * recent-unended session. Engine sessions outlive the client, so on a fresh process a stale unended
   * session from a prior run must NOT read as current: exposing this lets the record-query resolver and the
   * HUD's live-session listing bind `session: 'current'` to the same honest truth the lanes already use, so
   * record blocks read empty rather than a previous session's content. A defensive `!ended` guard keeps a
   * late/ended state from ever being reported current even if its key lingered.
   */
  currentSessionId(workspaceId: string): string | undefined {
    const key = this.currentByWorkspace.get(workspaceId)
    const state = key ? this.sessions.get(key) : undefined
    return state && !state.ended ? state.sessionId : undefined
  }

  /** Hydration snapshot: exactly mic, system-audio, screen, in that order. */
  snapshotSet(workspaceId: string, sessionId?: string): SenseLaneSnapshotSet {
    const key = sessionId ? keyFor(workspaceId, sessionId) : this.currentByWorkspace.get(workspaceId)
    const state = key ? this.sessions.get(key) : undefined
    if (state) {
      return {
        workspaceId,
        sessionId: state.sessionId,
        lanes: PHYSICAL_SENSE_SOURCES.map((source) => this.projectLane(state, source)) as SenseLaneSnapshotSet['lanes'],
      }
    }
    let cold = this.coldByWorkspace.get(workspaceId)
    if (!cold) {
      const updatedAt = this.now().toISOString()
      cold = Object.fromEntries(PHYSICAL_SENSE_SOURCES.map((source) => [source, makeLane(source, workspaceId, updatedAt)])) as Record<PhysicalSenseSource, SenseLaneSnapshot>
      this.coldByWorkspace.set(workspaceId, cold)
    }
    const lanes = PHYSICAL_SENSE_SOURCES.map((source) => ({
      ...cloneLane(cold![source]),
      ...(sessionId !== undefined ? { sessionId } : {}),
    })) as SenseLaneSnapshotSet['lanes']
    return { workspaceId, ...(sessionId !== undefined ? { sessionId } : {}), lanes }
  }

  private recordProcessing(
    state: SessionState,
    lane: LaneState,
    correlatedCaptures: readonly CaptureRef[],
    capture: CaptureRef,
    completedAt: string,
    screenOutcome?: ScreenProcessingOutcome['outcome'],
  ): SenseLaneSnapshot | undefined {
    const capturedMs = timeMs(capture.capturedAt)
    const completedMs = timeMs(completedAt)
    if (capturedMs === undefined || completedMs === undefined) return undefined
    if (state.ended) return undefined
    const isScreen = lane.snapshot.source === 'screen'
    let anchorSemanticUpgrade = false
    if (isScreen) {
      const desired = screenOutcome ?? 'processed'
      if (correlatedCaptures.some((item) => {
        const previous = lane.screenOutcomes.get(item.id)
        const priorCompletedMs = lane.screenProcessingAtMs.get(item.id)
        return this.screenOutcomeAdvances(previous, desired) && priorCompletedMs !== undefined && completedMs < priorCompletedMs
      })) return undefined
      const advancing = correlatedCaptures.filter((item) => {
        const previous = lane.screenOutcomes.get(item.id)
        if (!this.screenOutcomeAdvances(previous, desired)) return false
        const priorCompletedMs = lane.screenProcessingAtMs.get(item.id)
        // A retry cannot claim a semantic upgrade with an older completion time than the result it
        // supersedes. Equal-time upgrades are accepted below and atomically replace same-capture evidence.
        return priorCompletedMs === undefined || completedMs >= priorCompletedMs
      })
      if (advancing.length === 0) {
        return undefined
      }
      for (const item of advancing) {
        if (item.id === capture.id && lane.screenOutcomes.get(item.id) !== undefined) anchorSemanticUpgrade = true
        lane.screenOutcomes.set(item.id, desired)
        lane.screenProcessingAtMs.set(item.id, completedMs)
        if (desired !== 'failed') lane.processedCaptureIds.add(item.id)
      }
    } else if (correlatedCaptures.every((item) => lane.processedCaptureIds.has(item.id))) {
      return undefined
    }
    // Completion is atomic across the correlated source set. The canonical last capture anchors the
    // public evidence. Successful constituents become terminal against regrouped retries; a failed
    // screen frame remains eligible for a later successful workflow retry.
    if (!isScreen) for (const item of correlatedCaptures) lane.processedCaptureIds.add(item.id)

    const prior = lane.snapshot.latestProcessing
    const priorCompletedMs = prior === undefined ? undefined : timeMs(prior.completedAt)
    const evidenceAdvances = prior === undefined || priorCompletedMs === undefined || completedMs > priorCompletedMs || (
      completedMs === priorCompletedMs && (
        (isScreen && anchorSemanticUpgrade && prior.captureId === capture.id) ||
        lane.captures.get(prior.captureId) === undefined || compareCapture(capture, lane.captures.get(prior.captureId)!) > 0
      )
    )
    const isLatestCapture = lane.latestCapture?.id === capture.id
    const desiredDisposition = screenOutcome ?? 'processed'
    const visibleAdvances = isLatestCapture && (
      !isScreen
        ? lane.snapshot.disposition !== 'processed'
        : lane.latestScreenEvent?.kind === 'capture' && lane.latestScreenEvent.id === capture.id && (
          lane.snapshot.disposition !== desiredDisposition ||
          lane.snapshot.health !== (desiredDisposition === 'failed' ? 'failed' : 'healthy') ||
          lane.snapshot.reason !== (desiredDisposition === 'failed' ? 'processing-failed' : desiredDisposition)
        )
    )
    if (!evidenceAdvances && !visibleAdvances) return undefined

    const processing: SenseLaneProcessing = {
      captureId: capture.id,
      capturedAt: capture.capturedAt,
      completedAt,
      outcome: desiredDisposition,
      lagMs: Math.max(0, completedMs - capturedMs),
      basis: 'capture-to-processing-completion',
    }
    lane.snapshot = {
      ...lane.snapshot,
      ...(evidenceAdvances ? { latestProcessing: processing } : {}),
      ...(visibleAdvances ? {
        disposition: desiredDisposition,
        health: desiredDisposition === 'failed' ? 'failed' : 'healthy',
        reason: desiredDisposition === 'failed' ? 'processing-failed' : desiredDisposition,
      } : {}),
      updatedAt: this.now().toISOString(),
    } as SenseLaneSnapshot
    return this.projectLane(state, lane.snapshot.source)
  }

  /**
   * The one public projection: clone the lane, then overlay the engine-global gate verdict when the lane
   * belongs to a live session. Only health/reason are masked — disposition, capture, and processing
   * evidence stay the reducer's truth, so clearing the gate restores the exact underlying state.
   */
  private projectLane(state: SessionState, source: PhysicalSenseSource): SenseLaneSnapshot {
    const clone = cloneLane(state.lanes[source].snapshot)
    const gate = state.ended ? undefined : this.gates[source]
    return gate === undefined ? clone : { ...clone, health: 'blocked', reason: gate } as SenseLaneSnapshot
  }

  private screenObservationAdvances(lane: LaneState, occurredAtMs: number): boolean {
    const current = lane.latestScreenEvent
    if (!current) return true
    if (occurredAtMs > current.occurredAtMs) return true
    // Equal wall times from different attempts are ambiguous; fail closed instead of inventing order.
    return false
  }

  private screenOutcomeAdvances(
    previous: ScreenProcessingOutcome['outcome'] | undefined,
    next: ScreenProcessingOutcome['outcome'],
  ): boolean {
    if (previous === undefined) return true
    if (previous === 'processed') return false
    if (previous === 'blank') return next === 'processed'
    return next !== 'failed' // a failed frame may succeed on a workflow retry
  }

  private activeSession(workspaceId: string, sessionId: string): SessionState | undefined {
    const key = keyFor(workspaceId, sessionId)
    if (this.currentByWorkspace.get(workspaceId) !== key) return undefined
    const state = this.sessions.get(key)
    return state !== undefined && !state.ended ? state : undefined
  }

  private findActiveSessionById(sessionId: string): SessionState | undefined {
    let found: SessionState | undefined
    for (const [workspaceId, key] of this.currentByWorkspace) {
      const state = this.sessions.get(key)
      if (!state || state.ended || state.workspaceId !== workspaceId || state.sessionId !== sessionId) continue
      if (found) return undefined // ambiguous across workspaces: never guess ownership
      found = state
    }
    return found
  }

  private isPhysicalMedia(chunk: CaptureChunk): boolean {
    if (chunk.encoding !== 'base64') return false
    const contentType = chunk.contentType.toLowerCase()
    if (chunk.source === 'mic' || chunk.source === 'system-audio') return contentType.startsWith('audio/')
    return chunk.source === 'screen' && contentType.startsWith('image/')
  }
}
