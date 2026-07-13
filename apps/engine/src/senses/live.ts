import type {
  CaptureChunk,
  OcrResult,
  PhysicalSenseSource,
  SenseLaneCapture,
  SenseLaneProcessing,
  SenseLaneSnapshot,
  SenseLaneSnapshotSet,
  Session,
  TranscriptUpdate,
} from '@openinfo/contracts'

/** Canonical HUD order. This is deliberately narrower than CaptureSource. */
export const PHYSICAL_SENSE_SOURCES = ['mic', 'system-audio', 'screen'] as const satisfies readonly PhysicalSenseSource[]

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
  latestCapture?: CaptureRef
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
}) as SenseLaneSnapshot

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
 * endpoint provenance, and arbitrary errors never enter this object.
 */
export class SenseLaneTracker {
  private readonly now: () => Date
  private readonly sessions = new Map<string, SessionState>()
  private readonly currentByWorkspace = new Map<string, string>()
  /** Retained after end so a delayed older session.started can never reactivate stale capture. */
  private readonly startWatermarkByWorkspace = new Map<string, number>()
  private readonly coldByWorkspace = new Map<string, Record<PhysicalSenseSource, SenseLaneSnapshot>>()

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
      }]),
    ) as Record<PhysicalSenseSource, LaneState>
    this.sessions.set(key, { workspaceId: session.workspaceId, sessionId: session.id, startedAtMs, ended: false, lanes })
    this.currentByWorkspace.set(session.workspaceId, key)
    this.startWatermarkByWorkspace.set(
      session.workspaceId,
      Math.max(startedAtMs, this.startWatermarkByWorkspace.get(session.workspaceId) ?? -Infinity),
    )
    return PHYSICAL_SENSE_SOURCES.map((source) => cloneLane(lanes[source].snapshot))
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
      state.lanes[source].snapshot = {
        ...state.lanes[source].snapshot,
        disposition: 'stopped',
        health: 'unknown',
        reason: 'session-ended',
        updatedAt,
      } as SenseLaneSnapshot
    }
    return PHYSICAL_SENSE_SOURCES.map((source) => cloneLane(state.lanes[source].snapshot))
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
    lane.snapshot = {
      ...lane.snapshot,
      latestCapture: { id: capture.id, capturedAt: capture.capturedAt },
      disposition: 'queued',
      // A queued capture proves receipt, not processing health. A prior completion is the only evidence
      // that lets a later queue retain healthy rather than returning to unknown.
      health: lane.snapshot.latestProcessing === undefined ? 'unknown' : 'healthy',
      reason: 'awaiting-processing',
      updatedAt: this.now().toISOString(),
    } as SenseLaneSnapshot
    return cloneLane(lane.snapshot)
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
    return this.recordProcessing(state, lane, exact, capture, result.createdAt)
  }

  /** Hydration snapshot: exactly mic, system-audio, screen, in that order. */
  snapshotSet(workspaceId: string, sessionId?: string): SenseLaneSnapshotSet {
    const key = sessionId ? keyFor(workspaceId, sessionId) : this.currentByWorkspace.get(workspaceId)
    const state = key ? this.sessions.get(key) : undefined
    if (state) {
      return {
        workspaceId,
        sessionId: state.sessionId,
        lanes: PHYSICAL_SENSE_SOURCES.map((source) => cloneLane(state.lanes[source].snapshot)) as SenseLaneSnapshotSet['lanes'],
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
  ): SenseLaneSnapshot | undefined {
    const capturedMs = timeMs(capture.capturedAt)
    const completedMs = timeMs(completedAt)
    if (capturedMs === undefined || completedMs === undefined) return undefined
    if (state.ended || correlatedCaptures.every((item) => lane.processedCaptureIds.has(item.id))) return undefined
    // Completion is atomic across the correlated source set. The canonical last capture anchors the
    // public evidence, while every constituent id becomes terminal so regrouped/subset retries cannot
    // manufacture a second transition.
    for (const item of correlatedCaptures) lane.processedCaptureIds.add(item.id)

    const prior = lane.snapshot.latestProcessing
    const priorCompletedMs = prior === undefined ? undefined : timeMs(prior.completedAt)
    const evidenceAdvances = prior === undefined || priorCompletedMs === undefined || completedMs > priorCompletedMs || (
      completedMs === priorCompletedMs && (
        lane.captures.get(prior.captureId) === undefined || compareCapture(capture, lane.captures.get(prior.captureId)!) > 0
      )
    )
    const isLatestCapture = lane.latestCapture?.id === capture.id
    const visibleAdvances = isLatestCapture && lane.snapshot.disposition !== 'processed'
    if (!evidenceAdvances && !visibleAdvances) return undefined

    const processing: SenseLaneProcessing = {
      captureId: capture.id,
      capturedAt: capture.capturedAt,
      completedAt,
      lagMs: Math.max(0, completedMs - capturedMs),
      basis: 'capture-to-processing-completion',
    }
    lane.snapshot = {
      ...lane.snapshot,
      ...(evidenceAdvances ? { latestProcessing: processing } : {}),
      ...(visibleAdvances ? { disposition: 'processed', health: 'healthy', reason: 'processed' } : {}),
      updatedAt: this.now().toISOString(),
    } as SenseLaneSnapshot
    return cloneLane(lane.snapshot)
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
