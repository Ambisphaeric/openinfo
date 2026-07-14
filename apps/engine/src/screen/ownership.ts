import type { CaptureChunk, WorkflowSpec, WorkflowStep } from '@openinfo/contracts'
import { isFlagEnabled } from '../flags/read.js'
import type { WorkspaceRegistry } from '../store/index.js'
import { WorkflowDocuments } from '../workflow/index.js'

/** The two fabric capabilities a drain-stage screen-recognition step can invoke. */
export type ScreenRecognitionSlot = 'ocr' | 'vlm'

/**
 * Engine-owned queue metadata. This is deliberately NOT part of the public CaptureChunk contract: the
 * control-plane validates the client payload first, then stamps this field before the chunk is durably
 * appended. Keeping the latch in the JSONL row means a queued frame retains its owner across flag flips
 * and engine restarts; public capture receipts continue to project only the closed CaptureReceipt shape.
 */
const SCREEN_OWNER_FIELD = '__openinfoScreenOwner' as const
export type ScreenRecognitionOwner = 'legacy-ingest' | 'workflow-drain'
type LatchedScreenChunk = CaptureChunk & { [SCREEN_OWNER_FIELD]?: ScreenRecognitionOwner }

/** Stamp one immutable owner onto a validated screen chunk before durable queue append. */
export const latchScreenRecognitionOwner = (
  chunk: CaptureChunk,
  workflowEnabled: boolean,
): CaptureChunk => {
  if (chunk.source !== 'screen') return chunk
  const current = screenRecognitionOwner(chunk)
  if (current !== undefined) return chunk
  return {
    ...chunk,
    [SCREEN_OWNER_FIELD]: workflowEnabled ? 'workflow-drain' : 'legacy-ingest',
  } as CaptureChunk
}

/** Read the engine-stamped owner; undefined supports queue rows written before the latch shipped. */
export const screenRecognitionOwner = (chunk: CaptureChunk): ScreenRecognitionOwner | undefined => {
  const value = (chunk as LatchedScreenChunk)[SCREEN_OWNER_FIELD]
  return value === 'legacy-ingest' || value === 'workflow-drain' ? value : undefined
}

/**
 * Whether the workflow drain may recognize this chunk. Pre-latch rows retain the historical behavior and
 * are accepted by the active workflow; explicitly legacy-owned rows are never claimed by the drain.
 */
export const workflowOwnsScreenChunk = (chunk: CaptureChunk): boolean =>
  chunk.source === 'screen' && screenRecognitionOwner(chunk) !== 'legacy-ingest'

/** Match WorkflowExecutor's default-drain rule exactly. */
const isDrainScreenStep = (step: WorkflowStep): boolean =>
  (step.trigger ?? 'drain') === 'drain' && (step.kind === 'ocr' || step.kind === 'vlm')

/** Match ScreenOcrProcessor's explicit-slot override exactly. */
export const screenSlotForStep = (step: WorkflowStep): ScreenRecognitionSlot =>
  step.slot === 'ocr' || step.slot === 'vlm' ? step.slot : step.kind === 'vlm' ? 'vlm' : 'ocr'

export interface WorkflowScreenPlan {
  candidates: WorkflowStep[]
  enabled: WorkflowStep[]
  slots: ScreenRecognitionSlot[]
}

/**
 * Resolve the active workflow's screen work using the executor's trigger/kind/when decisions and the
 * processor's slot override. The flag reader is injected so store-backed callers can honor arbitrary
 * workflow flag keys while pure diagnostic tests can supply an in-memory flag document list.
 */
export const workflowScreenPlan = (
  activeWorkflow: WorkflowSpec | undefined,
  flagOn: (key: string) => boolean,
): WorkflowScreenPlan => {
  const candidates = activeWorkflow?.steps.filter(isDrainScreenStep) ?? []
  const enabled = candidates.filter((step) => step.when === undefined || flagOn(step.when.flag))
  const seen = new Set<ScreenRecognitionSlot>()
  const slots: ScreenRecognitionSlot[] = []
  for (const step of enabled) {
    const slot = screenSlotForStep(step)
    if (seen.has(slot)) continue
    seen.add(slot)
    slots.push(slot)
  }
  return { candidates, enabled, slots }
}

/**
 * The live meaning of ScreenStatus.enabled. Legacy ingest is owned by screen.ocr. With workflow.enabled
 * on, the executor owns recognition and it is enabled iff the active document has at least one enabled
 * drain OCR/VLM step (including ungated steps and steps gated by a non-default/custom flag key).
 */
export const screenRecognitionEnabledForStore = (store: WorkspaceRegistry): boolean => {
  if (!isFlagEnabled(store, 'workflow.enabled')) return isFlagEnabled(store, 'screen.ocr')
  const activeWorkflow = new WorkflowDocuments(store).active()
  return workflowScreenPlan(activeWorkflow, (key) => isFlagEnabled(store, key)).enabled.length > 0
}
