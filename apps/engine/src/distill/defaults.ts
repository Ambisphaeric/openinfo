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
 * The shipped typed-moment extraction template — a document, seeded like the distill template.
 * Extraction is a SECOND, tighter call per window (see PHASE2-NOTES: one tight job per call beats
 * one call doing summary + JSON on 3–8B local models). The body demands a strict JSON array and
 * interpolates the resolved voice vector plus the window {{transcript}} and {{summary}} (the
 * just-produced distillate text). Mirrors shared/contracts/examples/promptTemplate.extract.json.
 */
export const defaultExtractTemplate: PromptTemplate = {
  id: 'tpl-extract-default',
  name: 'extract-default',
  kind: 'extract',
  slot: 'llm',
  builtin: true,
  description: 'typed-moment extraction; one tight job per call, emits a strict JSON array of typed moments',
  body:
    'You extract typed moments from a meeting transcript. Return ONLY a JSON array, no prose, no code fences.\n' +
    'Each element: {"kind": one of "commitment"|"question"|"decision"|"artifact", "text": string, ' +
    '"speaker": string (optional), "confidence": number 0..1 (optional), "answered": boolean (only for kind "question")}.\n' +
    '- commitment (●): someone promised to do something.\n' +
    '- question (◆): a question directed at the user awaiting an answer.\n' +
    '- decision (▲): a choice the group settled on.\n' +
    '- artifact (✱): a document, link, or file referenced or to produce.\n' +
    'Extract only what the transcript supports; invent nothing. If there are no moments, return [].\n' +
    'Voice: specificity {{specificity}}/10, brevity {{brevity}}/10. {{voice.rules}}\n\n' +
    'Summary of the window: {{summary}}\n\n' +
    'Transcript (merge window {{windowStart}} → {{windowEnd}}):\n{{transcript}}\n\nJSON array:',
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
