import type { Register, VoiceBinding } from '@openinfo/contracts'

/**
 * The shipped register set (IMPLEMENTATION.md §1). Registers are documents, so users clone and
 * tweak these; we only SEED them if absent (see VoiceDocuments.ensureDefaults). boardroom,
 * sales-floor and warm-counsel mirror shared/contracts/examples.
 */
export const builtinRegisters: readonly Register[] = [
  { id: 'reg-boardroom', name: 'boardroom', builtin: true,
    description: 'SOC 2 profile: low-but-not-no charm, cite the page, keep it tight',
    dials: { tone: 3, warmth: 4, wit: 2, charm: 2, specificity: 9, brevity: 8 } },
  { id: 'reg-collegial', name: 'collegial', builtin: true,
    description: 'peers talking shop: warm, plain, unfussy',
    dials: { tone: 6, warmth: 7, wit: 4, charm: 5, specificity: 6, brevity: 6 } },
  { id: 'reg-warm-counsel', name: 'warm-counsel', builtin: true,
    description: 'serious but softer — the second way back',
    dials: { tone: 6, warmth: 7, wit: 3, charm: 4, specificity: 8, brevity: 6 } },
  { id: 'reg-sales-floor', name: 'sales-floor', builtin: true,
    description: 'high charm, softer tone, more flexibility',
    dials: { tone: 7, warmth: 8, wit: 6, charm: 8, specificity: 5, brevity: 4 } },
  { id: 'reg-playful', name: 'playful', builtin: true,
    description: 'loose and lively — banter welcome',
    dials: { tone: 8, warmth: 8, wit: 8, charm: 7, specificity: 4, brevity: 5 } },
]

/** No global default binding ships bound: an unbound context resolves to the neutral vector. */
export const defaultBindings: readonly VoiceBinding[] = []
