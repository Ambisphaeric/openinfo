import type { Mode, PromptTemplate } from '@openinfo/contracts'

/**
 * The shipped distill prompt template — a document, not a hardcoded preset (glass mistake left
 * behind). Interpolates the resolved voice vector ({{tone}}…{{voice.rules}}) plus the merge
 * window's {{transcript}} before the local model runs. Mirrors
 * shared/contracts/examples/promptTemplate.distill.json.
 */
export const defaultDistillTemplate: PromptTemplate = {
  id: 'tpl-distill-default',
  name: 'distill-default',
  kind: 'distill',
  slot: 'llm',
  builtin: true,
  description: 'rolling-merge summary; interpolates the resolved voice vector before the local model runs',
  body:
    'You are distilling a live meeting into a tight, factual summary of what just happened.\n' +
    'Voice: tone {{tone}}/10, warmth {{warmth}}/10, wit {{wit}}/10, charm {{charm}}/10, ' +
    'specificity {{specificity}}/10, brevity {{brevity}}/10.\n' +
    '{{voice.rules}}\n' +
    'Summarize only what the transcript supports. Do not invent commitments or names.\n\n' +
    'Transcript (merge window {{windowStart}} → {{windowEnd}}):\n{{transcript}}\n\nSummary:',
}

/**
 * The default meeting mode — window config lives here (mode document owns merge windows, per
 * ARCHITECTURE §7). Mirrors shared/contracts/examples/mode.meeting.json; the distiller reads only
 * distill.mergeWindow + distill.tokenBudget from it in this slice.
 */
export const defaultMeetingMode: Mode = {
  id: 'mode-meeting',
  name: 'meeting',
  minTier: 'T0',
  description: 'the launch-anchor mode',
  sources: [
    { kind: 'mic', enabled: true, params: {} },
    { kind: 'screen', enabled: true, cadence: { shotEverySec: 10, deltaGatePct: 4 }, params: {} },
    { kind: 'calendar', enabled: false, params: {} },
  ],
  distill: { mergeWindow: { shortSec: 30, longSec: 120 }, tokenBudget: 700, use: 'llm.fast', screenUnderstanding: 'ocr' },
  overflow: 'queue',
  registerId: 'reg-boardroom',
  acts: [
    { kind: 'follow-up-draft', params: { latencySecPostSession: 60 } },
    { kind: 'task-extract', params: {} },
  ],
}
