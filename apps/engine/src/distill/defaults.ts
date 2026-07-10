import type { Mode, PromptTemplate } from '@openinfo/contracts'

/**
 * The shipped distill prompt template — a document, not a hardcoded preset (glass mistake left
 * behind). The FACTORY default is neutral (#130): a short, factual rolling-merge summary that keeps
 * only the load-bearing parts (output grammar, invent-nothing rule, {{transcript}}/{{windowStart}}/
 * {{windowEnd}} window interpolation) and bakes NO persona/voice dials. The voice-vector machinery
 * (compileVoiceVars → {{tone}}…{{voice.rules}}) is still live for a user-authored/edited template —
 * it is simply not pre-tweaked into the shipped body. Mirrors
 * shared/contracts/examples/promptTemplate.distill.json.
 */
export const defaultDistillTemplate: PromptTemplate = {
  id: 'tpl-distill-default',
  name: 'distill-default',
  kind: 'distill',
  slot: 'llm',
  builtin: true,
  description: 'rolling-merge summary; neutral factual default (no baked voice vector — dials remain available to edited templates)',
  body:
    'You are distilling a live meeting into a tight, factual summary of what just happened.\n' +
    'Summarize only what the transcript supports. Do not invent commitments or names.\n\n' +
    'Transcript (merge window {{windowStart}} → {{windowEnd}}):\n{{transcript}}\n\nSummary:',
}

/**
 * The shipped typed-moment extraction template — a document, seeded like the distill template.
 * Extraction is a SECOND, tighter call per window (see PHASE2-NOTES: one tight job per call beats
 * one call doing summary + JSON on 3–8B local models). The FACTORY default is neutral (#130): it
 * keeps the load-bearing output grammar (strict JSON array, the typed-moment schema, invent-nothing)
 * and the window {{transcript}}/{{summary}} interpolation, and bakes NO voice dials. Mirrors
 * shared/contracts/examples/promptTemplate.extract.json.
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
    'Extract only what the transcript supports; invent nothing. If there are no moments, return [].\n\n' +
    'Summary of the window: {{summary}}\n\n' +
    'Transcript (merge window {{windowStart}} → {{windowEnd}}):\n{{transcript}}\n\nJSON array:',
}

/**
 * The shipped entity-extraction template — a document, seeded like the distill/extract templates.
 * Entity extraction is a THIRD tight call per window (see PHASE2-NOTES: one job / one output grammar
 * per call beats a compound moments+entities response on 3–8B local models). The body demands a
 * strict JSON array of {name, kind, aliases}, keeps the window {{transcript}}/{{summary}}
 * interpolation, and — as the neutral factory default (#130) — bakes NO voice dials. Mirrors
 * shared/contracts/examples/promptTemplate.entities.json.
 */
export const defaultEntitiesTemplate: PromptTemplate = {
  id: 'tpl-entities-default',
  name: 'entities-default',
  kind: 'extract',
  slot: 'llm',
  builtin: true,
  description: 'entity extraction; one tight job per call, emits a strict JSON array of named entities',
  body:
    'You extract the named entities discussed in a meeting transcript — the people, artifacts, and topics that matter.\n' +
    'Return ONLY a JSON array of entities, no prose, no code fences.\n' +
    'Each element: {"name": string, "kind": one of "person"|"artifact"|"topic", "aliases": string[] (optional other names for the same thing)}.\n' +
    '- person: a human named or clearly referred to.\n' +
    '- artifact (✱): a document, file, link, system, or deliverable.\n' +
    '- topic: a subject, project, or theme under discussion.\n' +
    'Extract only entities the transcript supports; invent nothing. Merge obvious aliases of one thing into a single entity. If there are none, return [].\n\n' +
    'Summary of the window: {{summary}}\n\n' +
    'Transcript (merge window {{windowStart}} → {{windowEnd}}):\n{{transcript}}\n\nJSON array of entities:',
}

/**
 * The PREVIOUS shipped bodies of the three window templates — the voice-baked bodies that shipped
 * before #130 made the factory defaults neutral. The one-time builtin-body refresh
 * (DistillDocuments.ensureDefaults) uses these to detect an UNEDITED builtin on an existing install:
 * seeds are seed-if-absent, so an upgrader keeps its old baked body forever otherwise. A stored
 * builtin is treated as unedited — and refreshed to the new neutral body — ONLY when it is still at
 * version 1 AND its body is byte-for-byte one of these previous bodies. Any user edit bumps the
 * version off 1 (LayoutStore.put) and/or diverges the body, so an edited document is NEVER clobbered.
 * Keyed by template id. Keep in lockstep with the bodies above: a refresh compares against these,
 * never against the current body.
 */
export const PREVIOUS_BUILTIN_BODIES: Readonly<Record<string, string>> = {
  [defaultDistillTemplate.id]:
    'You are distilling a live meeting into a tight, factual summary of what just happened.\n' +
    'Voice: tone {{tone}}/10, warmth {{warmth}}/10, wit {{wit}}/10, charm {{charm}}/10, ' +
    'specificity {{specificity}}/10, brevity {{brevity}}/10.\n' +
    '{{voice.rules}}\n' +
    'Summarize only what the transcript supports. Do not invent commitments or names.\n\n' +
    'Transcript (merge window {{windowStart}} → {{windowEnd}}):\n{{transcript}}\n\nSummary:',
  [defaultExtractTemplate.id]:
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
  [defaultEntitiesTemplate.id]:
    'You extract the named entities discussed in a meeting transcript — the people, artifacts, and topics that matter.\n' +
    'Return ONLY a JSON array of entities, no prose, no code fences.\n' +
    'Each element: {"name": string, "kind": one of "person"|"artifact"|"topic", "aliases": string[] (optional other names for the same thing)}.\n' +
    '- person: a human named or clearly referred to.\n' +
    '- artifact (✱): a document, file, link, system, or deliverable.\n' +
    '- topic: a subject, project, or theme under discussion.\n' +
    'Extract only entities the transcript supports; invent nothing. Merge obvious aliases of one thing into a single entity. If there are none, return [].\n' +
    'Voice: specificity {{specificity}}/10, brevity {{brevity}}/10. {{voice.rules}}\n\n' +
    'Summary of the window: {{summary}}\n\n' +
    'Transcript (merge window {{windowStart}} → {{windowEnd}}):\n{{transcript}}\n\nJSON array of entities:',
}

/**
 * The shipped fast-field prompt bundle (#61) — three small, specialized prompt DOCUMENTS, each bound to
 * a surface field via `field`. They are the composition units of the fan-out substrate: on newly
 * transcribed material the scheduler runs every triggered `fast`-tier binding CONCURRENTLY against the
 * llm slot (distill/fields.ts) and lands each result in its bound field, published as `field.updated`
 * AND persisted as the field's latest value. Prompts are deliberately TINY (one job, tight output) —
 * fast fields run at seconds-scale on a small model. Each carries a `trigger.minChars` relevance gate so
 * a sub-threshold window skips the field rather than burning an invoke. Adapted from the distill/entities
 * prompt content so the defaults read as a coherent family. Mirrors shared/contracts/examples/
 * promptTemplate.field.json.
 */
export const defaultTopicField: PromptTemplate = {
  id: 'tpl-field-topic',
  name: 'topic',
  kind: 'field',
  slot: 'llm',
  builtin: true,
  description: 'fast field: the current topic of discussion, in one short phrase',
  field: { fieldId: 'field-topic', tier: 'fast', trigger: { kind: 'transcript', minChars: 40 }, scope: 'session' },
  body:
    'In ONE short phrase (max ~8 words), name the current topic of discussion in the recent meeting transcript below. ' +
    'No sentence, no preamble. If the transcript is too thin to tell, reply exactly "unclear".\n\n' +
    'Transcript:\n{{transcript}}\n\nTopic:',
}

export const defaultEntitiesField: PromptTemplate = {
  id: 'tpl-field-entities',
  name: 'entities-mentioned',
  kind: 'field',
  slot: 'llm',
  builtin: true,
  description: 'fast field: the people, artifacts, and topics named in the recent transcript',
  field: { fieldId: 'field-entities', tier: 'fast', trigger: { kind: 'transcript', minChars: 60 }, scope: 'session' },
  body:
    'List the named entities — people, artifacts, and topics — mentioned in the recent meeting transcript below, ' +
    'as a short comma-separated list. Name only what the transcript supports; invent nothing. ' +
    'If none are named, reply exactly "none yet". No preamble.\n\n' +
    'Transcript:\n{{transcript}}\n\nEntities:',
}

export const defaultWorkItemsField: PromptTemplate = {
  id: 'tpl-field-work-items',
  name: 'work-items',
  kind: 'field',
  slot: 'llm',
  builtin: true,
  description: 'fast field: the concrete work items / action items mentioned in the recent transcript',
  field: { fieldId: 'field-work-items', tier: 'fast', trigger: { kind: 'transcript', minChars: 80 }, scope: 'session' },
  body:
    'From the recent meeting transcript below, list the concrete work items or action items mentioned — one per line, ' +
    'short imperative phrases. If none are mentioned, reply exactly "none yet". No preamble.\n\n' +
    'Transcript:\n{{transcript}}\n\nWork items:',
}

/** The shipped fast-field bundle, in seed order — ≥3 concurrent fields (#61 default document bundle). */
export const defaultFieldTemplates: readonly PromptTemplate[] = [defaultTopicField, defaultEntitiesField, defaultWorkItemsField]

/**
 * The shipped judge prompt document (#62) — the dual-input review the larger-model, lower-cadence judge
 * tier runs. It is a `field`-kind PromptTemplate with a `judge`-tier binding (the append-only #61
 * extension), so it seeds and edits over the SAME GET/PUT /templates routes the fast documents do.
 *
 * The body is the STANDARDIZED dual-input contract: every judge prompt takes `{{source}}` (the same
 * transcript window the fast tier saw) and `{{results}}` (the fast tier's current field values), and
 * emits a strict JSON array of per-field verdicts — confirm / correct (value overruled in place) /
 * flag. `reviews` is omitted, so it reviews every fast-tier field in its scope; `cadenceMs` sets its
 * re-review floor decoupled from the fast fan-out. It ALSO carries the orientation duty (topic shift /
 * missed implication) into a flag. Deliberately demands only what the source supports — the judge is a
 * corrector, never a fabricator.
 */
export const defaultJudgeTemplate: PromptTemplate = {
  id: 'tpl-judge-default',
  name: 'judge-default',
  kind: 'field',
  slot: 'llm',
  builtin: true,
  description: 'judge (#62): dual-input review of the fast-field result set against the source transcript window — confirm/correct/flag with overrule in place',
  field: { fieldId: 'judge-default', tier: 'judge', trigger: { kind: 'transcript', minChars: 80 }, scope: 'session', cadenceMs: 60_000 },
  body:
    'You are a JUDGE reviewing a fast, shallow tier that watched the same meeting you are about to see. ' +
    "The fast tier is quick but can misread specialized content — your job is to catch what it missed.\n" +
    'You receive TWO inputs: the SOURCE (the transcript window the fast tier saw) and RESULTS (the fast ' +
    "tier's current field values). For EACH result field, judge its value against the source and return a verdict:\n" +
    '- "confirm": the value is correct and supported by the source.\n' +
    '- "correct": the value is wrong or imprecise — supply the fixed value in "value".\n' +
    '- "flag": the value is questionable, or the source shifted topic / carries an implication the value missed — explain in "note".\n' +
    'Return ONLY a JSON array, no prose, no code fences. Each element: ' +
    '{"fieldId": string, "verdict": "confirm"|"correct"|"flag", "value": string (REQUIRED for correct), "note": string (optional)}.\n' +
    'Judge only what the source supports; invent nothing. Omit a field you cannot judge from the source.\n\n' +
    'SOURCE (transcript window {{windowStart}} -> {{windowEnd}}):\n{{source}}\n\n' +
    'RESULTS (the fast tier\'s current fields):\n{{results}}\n\nJSON array of verdicts:',
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
