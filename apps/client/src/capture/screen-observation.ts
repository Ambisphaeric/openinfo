import { randomUUID } from 'node:crypto'
import type { CaptureChunk, ScreenCaptureObservation } from '@openinfo/contracts'
import type { CaptureContext } from './chunk.js'

/**
 * The result of the privacy-heavy part of one screen tick. The Electron shell owns the actual desktop
 * grab and delta gate; this small result keeps the attempt lifecycle pure and headless-testable.
 * `accepted` means the image POST succeeded OR EngineLink durably accepted it into the offline spool.
 */
export type ScreenCaptureAttemptResult =
  | { outcome: 'accepted'; capture: Pick<CaptureChunk, 'id' | 'capturedAt' | 'sessionId' | 'workspaceId'> }
  | { outcome: 'delta-skipped' }
  | undefined

export interface ScreenCaptureAttemptDeps {
  context: CaptureContext
  /** Run the grab/gate/durable-capture edge using this attempt's one canonical wall-clock + id. */
  capture: (attempt: { observationId: string; occurredAt: string }) => Promise<ScreenCaptureAttemptResult>
  /** Metadata-only, ephemeral control-plane report. It must never be put into the capture spool. */
  observe: (observation: ScreenCaptureObservation) => Promise<unknown>
  now?: () => string
  newId?: () => string
  log?: (message: string) => void
}

/**
 * Run one honest screen attempt and report exactly one metadata-only outcome.
 *
 * A single `occurredAt` and `observationId` are minted before the grab and reused through every branch.
 * An accepted image reports `queued` only after the durable capture call resolves, using the exact image
 * chunk id/time returned by CaptureController. Empty grabs, thrown grabs, and durable-capture failures
 * report `grab-failed`; a delta rejection reports `delta-skipped`. Observation transport is deliberately
 * best-effort and detached: a slow/hung reporting request cannot break or pause the physical cadence.
 */
export const runScreenCaptureAttempt = async (deps: ScreenCaptureAttemptDeps): Promise<ScreenCaptureObservation> => {
  const occurredAt = (deps.now ?? (() => new Date().toISOString()))()
  const observationId = (deps.newId ?? (() => `screen-observation-${randomUUID()}`))()

  let result: ScreenCaptureAttemptResult
  try {
    result = await deps.capture({ observationId, occurredAt })
  } catch (error) {
    deps.log?.(`[screen] frame grab/capture failed: ${String(error)}`)
    result = undefined
  }

  const observation: ScreenCaptureObservation = result?.outcome === 'accepted'
    ? {
        // The controller's exact generated chunk is the authority if a session flips during the async
        // grab/send. Never pair a capture from run A with the attempt-start context from run B.
        workspaceId: result.capture.workspaceId,
        sessionId: result.capture.sessionId,
        outcome: 'queued',
        capture: { id: result.capture.id, capturedAt: result.capture.capturedAt },
      }
    : {
        workspaceId: deps.context.workspaceId,
        sessionId: deps.context.sessionId,
        outcome: result?.outcome === 'delta-skipped' ? 'delta-skipped' : 'grab-failed',
        observationId,
        occurredAt,
      }

  const reportDropped = (error: unknown): void => {
    // Observation state is replaceable metadata, unlike captured pixels. Never spool it and never let a
    // control-plane/reporting outage stop the next frame; the following tick truthfully re-announces state.
    deps.log?.(`[screen] observation report dropped: ${String(error)}`)
  }
  try {
    // Intentionally DO NOT await. A control-plane fetch can hang independently of the durable pixel path;
    // holding this attempt open would keep the shell's serialization guard set and silently stop sensing.
    void deps.observe(observation).catch(reportDropped)
  } catch (error) {
    // A dependency can still throw before returning its promised result. Contain that edge as well.
    reportDropped(error)
  }
  return observation
}
