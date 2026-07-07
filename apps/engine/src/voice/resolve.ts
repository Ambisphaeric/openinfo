import type { Dials, Register, VoiceBinding } from '@openinfo/contracts'

export type VoiceScope = 'session' | 'workspace' | 'mode' | 'global'

/** Resolution precedence, highest first. IMPLEMENTATION.md §1: session > workspace > mode > global. */
const PRECEDENCE: readonly VoiceScope[] = ['session', 'workspace', 'mode', 'global']

export interface ScopeContext {
  sessionId?: string
  workspaceId?: string
  modeId?: string
}

export interface ResolvedVoice {
  registerId?: string
  scope: VoiceScope
  dials: Dials
  /** true when no binding matched and the neutral fallback vector was used */
  fallback: boolean
}

/** Neutral 5/10 vector — the floor when nothing is bound, so a template always interpolates. */
export const NEUTRAL_DIALS: Dials = { tone: 5, warmth: 5, wit: 5, charm: 5, specificity: 5, brevity: 5 }

const targetForScope = (scope: VoiceScope, ctx: ScopeContext): string | undefined => {
  if (scope === 'session') return ctx.sessionId
  if (scope === 'workspace') return ctx.workspaceId
  if (scope === 'mode') return ctx.modeId
  return undefined // global
}

const matches = (binding: VoiceBinding, ctx: ScopeContext): boolean => {
  const scope = binding.scope as VoiceScope
  if (scope === 'global') return true
  const target = targetForScope(scope, ctx)
  return target !== undefined && binding.targetId === target
}

/**
 * Resolve the effective register/dial vector for a context. Pure: it reads only the documents it
 * is handed (registers + bindings are _meta.db config docs, loaded by voice/documents.ts). Walks
 * precedence high→low, takes the first matching binding, applies its register's dials then any
 * per-binding dialOverrides.
 */
export const resolveVoice = (
  registers: readonly Register[],
  bindings: readonly VoiceBinding[],
  ctx: ScopeContext,
): ResolvedVoice => {
  const byId = new Map(registers.map((r) => [r.id, r]))
  for (const scope of PRECEDENCE) {
    const binding = bindings.find((b) => b.scope === scope && matches(b, ctx))
    if (!binding) continue
    const register = byId.get(binding.registerId)
    if (!register) continue // dangling binding: fall through to the next scope
    const dials: Dials = { ...register.dials, ...(binding.dialOverrides ?? {}) }
    return { registerId: register.id, scope, dials, fallback: false }
  }
  return { scope: 'global', dials: { ...NEUTRAL_DIALS }, fallback: true }
}
