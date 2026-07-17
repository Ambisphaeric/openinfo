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
 * The shipped judge-tier ORIENTATION prompt document (#131) — the occasional, global classification of
 * the session's nature that the fast per-window prompts should NOT each re-derive. It is a `field`-kind
 * PromptTemplate with a `judge`-tier binding whose `produces: 'orientation'` routes it to the orientation
 * path (not the #62 per-field verdict path), so it seeds and edits over the SAME GET/PUT /templates routes
 * and rides the SAME judge cadence + tier-gate as the verdict judge (no judge endpoint ⇒ logged no-op).
 *
 * The body is NEUTRAL (#130): a factual classification job over the single `{{source}}` input (the same
 * transcript window the tiers see), emitting ONE strict JSON object — nature (meeting/call/solo-work),
 * direction (teach/learn per the learn/teach canon), topics (the taxonomy). No persona, no dials. The
 * engine stamps the SessionAnnotation ids/session/provenance/timestamps; the model controls only the
 * classification text, and "unclear" is the honest answer when the source is too thin — invent nothing.
 */
/**
 * The Ask face's default question (the empty-send "explain my screen" — owner canon 2026-07-11: an EMPTY
 * send with a captured frame IS an ask). A shipped DOCUMENT, not a string buried in client code (#130
 * posture): the client resolves this body over the existing GET /templates/:id read and sends it as the
 * turn's message, so editing the default ask is a plain PUT /templates edit — no rebuild, no new UI.
 * Neutral and SHORT by the same #130 discipline the window templates follow; no persona, no voice. No
 * `slot`: it feeds no pipeline stage — it is the question itself.
 */
export const defaultAskTemplate: PromptTemplate = {
  id: 'tpl-ask-default',
  name: 'Explain my screen',
  kind: 'ask',
  builtin: true,
  description: 'the Ask face default: the question an empty send with a captured screen asks',
  body: 'Explain what is on my screen right now, briefly and in plain terms.',
}

export const defaultOrientationTemplate: PromptTemplate = {
  id: 'tpl-judge-orientation',
  name: 'judge-orientation',
  kind: 'field',
  slot: 'llm',
  builtin: true,
  description: 'judge (#131): occasional global classification of the session orientation — nature/direction/topics — landed as a SessionAnnotation',
  field: { fieldId: 'orientation', tier: 'judge', trigger: { kind: 'transcript', minChars: 80 }, scope: 'session', cadenceMs: 60_000, produces: 'orientation' },
  body:
    'You classify the current orientation of a work session from the recent transcript window below. ' +
    'Return ONLY a JSON object, no prose, no code fences. Fields:\n' +
    '{"nature": one of "meeting"|"call"|"solo-work"|"unclear", ' +
    '"direction": one of "teach"|"learn"|"mixed"|"unclear", ' +
    '"topics": string[] (up to 5 short subject phrases, most salient first)}.\n' +
    '- nature: the shape of the session — a multi-party meeting, a one-to-one call, or solo work.\n' +
    '- direction: whether the user is mainly explaining to others (teach) or being informed (learn); "mixed" if both, "unclear" if neither is evident.\n' +
    '- topics: the subjects under discussion, as short phrases.\n' +
    'Classify only what the source supports; if it is too thin to tell, use "unclear" and an empty topics array. Invent nothing.\n\n' +
    'SOURCE (transcript window {{windowStart}} -> {{windowEnd}}):\n{{source}}\n\n' +
    'JSON object:',
}

/**
 * The shipped hierarchical-summary prompt documents (#177) — one per live-loop level, each a `summary`-kind
 * PromptTemplate whose `summary` binding declares the level, the interval it buckets over, the lower level it
 * consumes, and — the non-negotiable — the EXPLICIT input bounds. Cadence, prompt, and retention are thereby
 * CONFIGURATION: they seed like the distill trio and edit over the SAME GET/PUT /templates routes, so
 * changing `windowMs`/`maxChildren`/the body changes the produced summaries with no rebuild (read-fresh).
 * The bodies are NEUTRAL (#130): factual, invent-nothing, no baked voice; the prose they yield is a MODEL
 * PROPOSAL (#189). Every level summarizes its BOUNDED lower inputs, never unbounded raw history.
 *
 * The finest level (`rolling`) has NO childLevel: it consumes the existing distillates directly and pulls a
 * few ContextPackets as corroborating evidence. `five-minute` consumes rolling summaries; `session` consumes
 * five-minute summaries at session end. Both pull a bounded selection of moments as evidence.
 */
export const defaultRollingSummaryTemplate: PromptTemplate = {
  id: 'tpl-summary-rolling',
  name: 'summary-rolling',
  kind: 'summary',
  slot: 'llm',
  builtin: true,
  description: 'hierarchical summary (#177): a rolling window over the existing distillates (+ packets as evidence)',
  summary: { level: 'rolling', windowMs: 60_000, maxChildren: 6, maxEvidence: 3, cadenceMs: 60_000 },
  body:
    'You are writing a short rolling summary of a work session from the window summaries below. ' +
    'Summarize only what they support; invent nothing. One or two tight sentences.\n\n' +
    'Window summaries ({{windowStart}} -> {{windowEnd}}):\n{{children}}\n\nRolling summary:',
}

export const defaultFiveMinuteSummaryTemplate: PromptTemplate = {
  id: 'tpl-summary-five-minute',
  name: 'summary-five-minute',
  kind: 'summary',
  slot: 'llm',
  builtin: true,
  description: 'hierarchical summary (#177): the concise five-minute view, over the window\'s rolling summaries plus a bounded selection of moments',
  summary: { level: 'five-minute', windowMs: 300_000, childLevel: 'rolling', maxChildren: 5, maxEvidence: 5, cadenceMs: 300_000 },
  body:
    'You are writing a concise five-minute view of a work session from the lower-level summaries below. ' +
    'Summarize only what they support; invent nothing. Keep it tight.\n\n' +
    'Lower-level summaries (window {{windowStart}} -> {{windowEnd}}):\n{{children}}\n\n' +
    'Corroborating moments:\n{{evidence}}\n\nFive-minute summary:',
}

export const defaultSessionSummaryTemplate: PromptTemplate = {
  id: 'tpl-summary-session',
  name: 'summary-session',
  kind: 'summary',
  slot: 'llm',
  builtin: true,
  description: 'hierarchical summary (#177): the durable end-of-session result, over the session\'s five-minute summaries plus a bounded selection of moments',
  summary: { level: 'session', windowMs: 300_000, childLevel: 'five-minute', maxChildren: 12, maxEvidence: 8 },
  body:
    'You are writing the durable result of a whole work session from the five-minute summaries below. ' +
    'Summarize only what they support; invent nothing. Lead with the outcome, then the key points.\n\n' +
    'Five-minute summaries (session {{windowStart}} -> {{windowEnd}}):\n{{children}}\n\n' +
    'Corroborating moments:\n{{evidence}}\n\nSession summary:',
}

/** The shipped summary prompt bundle, finest→coarsest (the live-loop levels slice 1 produces). */
export const defaultSummaryTemplates: readonly PromptTemplate[] = [
  defaultRollingSummaryTemplate,
  defaultFiveMinuteSummaryTemplate,
  defaultSessionSummaryTemplate,
]

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
