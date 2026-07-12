import type { PromptTemplate } from '@openinfo/contracts'

/**
 * The five shipped CONTEXT presets — the pill's glass-parity "five prompts", made ACTUAL documents.
 * Upstream glass seeded five editable context presets (School / Meetings / Sales / Recruiting / Customer
 * Support) but never injected them into the live prompt path — the vestigial gap this slice closes. Here
 * they are `preset`-kind PromptTemplate DOCUMENTS: they seed into the SAME prompt-template substrate as
 * the distill/extract/field templates and edit over the EXISTING GET/PUT /templates routes (owner canon:
 * "defaults are just documents we ship" — no new doc kind, no new editing UI).
 *
 * Bodies ship SIMPLE (owner canon, #130): a single neutral sentence naming the domain and what a summary
 * of it should emphasize — endlessly tweakable, but NOT come tweaked. No persona, no voice dials, no
 * voice-vector bloat (the class #130/#141 stripped). The distiller PREPENDS the active preset's body to
 * the distill pass as leading context (see distill/distiller.ts); an unset workspace injects nothing.
 * No `slot`: a preset feeds no single pipeline stage via a slot — it is an overlay the distiller applies.
 */
export const defaultSchoolPreset: PromptTemplate = {
  id: 'preset-school',
  name: 'School',
  kind: 'preset',
  builtin: true,
  description: 'context preset: an educational session — favor the concepts, definitions, and examples being taught',
  body: 'Context: this is an educational session — a class, lecture, or study discussion. Favor the concepts, definitions, and worked examples being taught.',
}

export const defaultMeetingsPreset: PromptTemplate = {
  id: 'preset-meetings',
  name: 'Meetings',
  kind: 'preset',
  builtin: true,
  description: 'context preset: a work meeting — favor decisions, action items, owners, and deadlines',
  body: 'Context: this is a work meeting. Favor decisions made, action items with their owners, and deadlines.',
}

export const defaultSalesPreset: PromptTemplate = {
  id: 'preset-sales',
  name: 'Sales',
  kind: 'preset',
  builtin: true,
  description: 'context preset: a sales conversation — favor needs, objections, pricing, and next steps',
  body: "Context: this is a sales conversation. Favor the prospect's stated needs, objections, any pricing discussed, and the agreed next steps.",
}

export const defaultRecruitingPreset: PromptTemplate = {
  id: 'preset-recruiting',
  name: 'Recruiting',
  kind: 'preset',
  builtin: true,
  description: 'context preset: a recruiting conversation — favor experience, skills, and mutual fit',
  body: "Context: this is a recruiting conversation. Favor the candidate's experience, skills, and signals of mutual fit.",
}

export const defaultSupportPreset: PromptTemplate = {
  id: 'preset-support',
  name: 'Customer Support',
  kind: 'preset',
  builtin: true,
  description: 'context preset: a customer support conversation — favor the problem, steps tried, and resolution',
  body: 'Context: this is a customer support conversation. Favor the reported problem, the steps already tried, and the resolution.',
}

/** The five shipped presets, in seed/display order — the glass-parity set. */
export const defaultPresets: readonly PromptTemplate[] = [
  defaultSchoolPreset,
  defaultMeetingsPreset,
  defaultSalesPreset,
  defaultRecruitingPreset,
  defaultSupportPreset,
]
