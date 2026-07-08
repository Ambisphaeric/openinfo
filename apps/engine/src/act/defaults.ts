import type { PromptTemplate } from '@openinfo/contracts'

/**
 * The shipped follow-up-draft prompt template — a document, seeded like the distill/extract
 * templates (no hardcoded prompt presets, the glass mistake left behind). kind `act`: it feeds the
 * Act primitive. Interpolates the resolved voice vector ({{tone}}…{{voice.rules}}) plus the
 * session's accumulated {{summaries}} and {{moments}}. The register vector is exactly what makes
 * the same meeting read differently under boardroom vs sales-floor (Phase-2 exit criterion).
 * Mirrors shared/contracts/examples/promptTemplate.act.json.
 */
export const defaultFollowUpTemplate: PromptTemplate = {
  id: 'tpl-followup-default',
  name: 'followup-default',
  kind: 'act',
  slot: 'llm',
  builtin: true,
  description:
    'follow-up draft: composes a session\'s distillates + moments into a review-ready recap; interpolates the resolved voice vector so the bound register visibly shapes the draft',
  body:
    'You are drafting a follow-up message after a meeting, for the user to review and send THEMSELVES. ' +
    'Do not send it; prepare it only.\n' +
    'Voice: tone {{tone}}/10, warmth {{warmth}}/10, wit {{wit}}/10, charm {{charm}}/10, ' +
    'specificity {{specificity}}/10, brevity {{brevity}}/10.\n' +
    '{{voice.rules}}\n' +
    'Base the draft ONLY on what the summaries and moments below support. Invent no commitments, names, or dates.\n\n' +
    'What was discussed (distilled summaries):\n{{summaries}}\n\n' +
    'Key moments:\n{{moments}}\n\n' +
    'Write the follow-up as markdown — a short greeting, a recap, and clear next steps or commitments. Follow-up draft:',
}

/**
 * The shipped task-extract prompt template — the CONSTRAIN side of the dynamic-to-do loop (P4A slice
 * 4). A document, seeded like the follow-up template. kind `act`: it feeds the Act primitive. Distills
 * a meeting's accumulated {{summaries}} + {{moments}} into a JSON array of follow-up items the engine
 * merges (deduped) into the session's to-do document; a later draft un-constrains them back into prose
 * via {{todo}}. The distinctive "JSON array of follow-up tasks" phrasing keeps small local models on a
 * tight, parseable schema (one `text` field per item; the engine stamps ids/provenance).
 */
export const defaultTaskExtractTemplate: PromptTemplate = {
  id: 'tpl-taskextract-default',
  name: 'taskextract-default',
  kind: 'act',
  slot: 'llm',
  builtin: true,
  description:
    'task-extract: distills a session\'s accumulated distillates + moments into a JSON array of follow-up to-do items (text only); the engine dedupes + stamps provenance, and a draft renders them via {{todo}}',
  body:
    'You extract the concrete FOLLOW-UP TASKS implied by a meeting so far — things the user still has to ' +
    'do after it. Base them ONLY on what the summaries and moments support; invent nothing.\n\n' +
    'What was discussed (distilled summaries):\n{{summaries}}\n\n' +
    'Key moments:\n{{moments}}\n\n' +
    'Return a JSON array of follow-up tasks, each an object with a single "text" field holding one short ' +
    'imperative line (e.g. [{"text": "Send Dana the updated deck"}]). If there are no follow-ups yet, ' +
    'return []. Return ONLY the JSON array, nothing else.',
}
