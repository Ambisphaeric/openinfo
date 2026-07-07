import type { Dials } from '@openinfo/contracts'

/**
 * Compile a dial vector into guidance snippets. Template authors get the raw numbers AND these
 * rules ({{voice.rules}}) so small local models are not asked to interpret "charm 2" cold
 * (IMPLEMENTATION.md §1). Thresholds are deliberately coarse — this is guidance, not a grammar.
 */
export const compileVoiceRules = (dials: Dials): string => {
  const rules: string[] = []
  if (dials.charm <= 3) rules.push('Avoid humor and banter entirely; stay clinical.')
  else if (dials.charm >= 8) rules.push('Be personable and charismatic.')
  if (dials.wit <= 2) rules.push('Be literal; no wordplay.')
  else if (dials.wit >= 8) rules.push('Playful phrasing is welcome.')
  if (dials.specificity >= 8) rules.push('Cite specifics — names, dates, sources by page.')
  else if (dials.specificity <= 2) rules.push('Stay gestural; omit fine detail.')
  if (dials.brevity >= 8) rules.push('Be terse: one or two sentences, no preamble.')
  else if (dials.brevity <= 2) rules.push('Expansive detail is acceptable.')
  if (dials.tone <= 3) rules.push('Keep the tone firm and direct.')
  else if (dials.tone >= 8) rules.push('Keep the tone soft and gentle.')
  if (dials.warmth >= 8) rules.push('Be warm and encouraging.')
  else if (dials.warmth <= 2) rules.push('Stay cool and reserved.')
  return rules.join(' ')
}

/**
 * The variable map a distill/act template interpolates against: each dial by name, plus the
 * compiled `voice.rules` snippet. Caller merges in pass inputs like transcript/windowStart.
 */
export const compileVoiceVars = (dials: Dials): Record<string, string> => ({
  tone: String(dials.tone),
  warmth: String(dials.warmth),
  wit: String(dials.wit),
  charm: String(dials.charm),
  specificity: String(dials.specificity),
  brevity: String(dials.brevity),
  'voice.rules': compileVoiceRules(dials),
})

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g

/** Replace {{var}} / {{voice.rules}} with values; unknown placeholders resolve to empty string. */
export const interpolateTemplate = (template: string, vars: Record<string, string>): string =>
  template.replace(PLACEHOLDER, (_match, key: string) => vars[key] ?? '')
