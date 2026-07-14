import type { PhysicalSenseSource } from '@openinfo/contracts'
import type { CaptureSense, SenseGateChain } from '../surfaces/settings/sense-gates.js'
import type { SenseLaneGateReason, SenseLaneGateState } from './live.js'

/**
 * #192 — turn the REAL per-sense gate-chain verdict (surfaces/settings/sense-gates.ts, the one existing
 * evaluation of flags/slots/workflow ownership) into the lane tracker's closed gate overlay. This is the
 * only bridge between the diagnostic chain and the public metadata read model, so the classification is
 * closed here: a chain's first blocking gate becomes either `disabled` (a feature toggle the user turned
 * off) or `configuration-blocked` (required configuration is missing), never a free-form code. Health
 * gates (`*-health`) are deliberately NOT overlaid — a transiently failing endpoint already surfaces as
 * the lane's own failed/processing-failed truth and the queue's classified failure; the overlay stays a
 * deterministic function of configuration so it can be re-evaluated on every flag/fabric/workflow edit
 * without probing anything.
 */

/** The chain speaks the client capture-status sense ids; the lane contract speaks physical sources. */
const SOURCE_FOR_SENSE: Record<CaptureSense, PhysicalSenseSource> = {
  mic: 'mic',
  'sys-audio': 'system-audio',
  screen: 'screen',
}

/**
 * Gates whose closure means required configuration is missing, by their stable ids: an empty stt/ocr/vlm
 * slot, or workflow screen ownership with no usable document/step. Every OTHER non-health blocking gate is
 * flag-shaped (distill.enabled, distill.transcribe, screen.ocr, or a workflow step's own flag key) — a
 * deliberate off switch, so it reads `disabled`.
 */
const CONFIGURATION_GATE_IDS = new Set(['stt', 'ocr', 'vlm', 'workflow.active', 'workflow.screen'])

const reasonForGateId = (id: string): SenseLaneGateReason | undefined => {
  if (CONFIGURATION_GATE_IDS.has(id)) return 'configuration-blocked'
  if (id.endsWith('-health')) return undefined // runtime health is not a configuration gate — see header
  return 'disabled'
}

/** Project the evaluated chains into the tracker's closed per-source overlay (absent = lane clear). */
export const senseLaneGateState = (chains: readonly SenseGateChain[]): SenseLaneGateState => {
  const state: SenseLaneGateState = {}
  for (const chain of chains) {
    const source = SOURCE_FOR_SENSE[chain.sense]
    if (source === undefined || chain.blocking === undefined) continue
    const reason = reasonForGateId(chain.blocking.id)
    if (reason !== undefined) state[source] = reason
  }
  return state
}
