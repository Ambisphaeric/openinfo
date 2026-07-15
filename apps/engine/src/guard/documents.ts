import type { GuardHold, GuardPolicy } from '@openinfo/contracts'
import { GuardHold as GuardHoldSchema, GuardPolicy as GuardPolicySchema } from '@openinfo/contracts'
import { Value } from '@sinclair/typebox/value'
import type { WorkspaceRegistry } from '../store/index.js'

const POLICY_KIND = 'config'
const POLICY_KEY = 'guard-policy'
const HOLDS_KIND = 'guard-holds'

/**
 * The seeded default guard POLICY (#63): redact-and-continue, NOT acknowledged. So the fail-closed edges
 * are the honest starting posture — an empty guard slot in default mode HOLDS egress until the user either
 * adds a guard endpoint or explicitly acknowledges unguarded egress; strict mode always holds an empty slot.
 * Seeded only when absent (a user's edit is never clobbered), exactly like the fabric/distill config docs.
 */
export const defaultGuardPolicy: GuardPolicy = {
  id: POLICY_KEY,
  version: 1,
  behavior: 'redact-and-continue',
  acknowledgeUnguardedEgress: false,
  description:
    'The egress guard policy (#63). behavior: redact-and-continue masks flagged spans and proceeds; hold-and-surface (strict) suspends the hop for release/deny. acknowledgeUnguardedEgress: with an EMPTY guard slot in default mode, true lets egress proceed unguarded (recorded as such), false HOLDS it — never silently unguarded.',
}

/**
 * Store-backed guard config docs, consistent with FabricDocuments/DistillDocuments: the GuardPolicy is a
 * versioned `config` document; a GuardHold is an append-only per-workspace document (the ItemSignalStore
 * pattern — a held hop is a config-shaped fact, and the workspace record DB need not exist). Verdicts carry
 * span-level detail (kind/start/length), NEVER the raw flagged value.
 */
export class GuardDocuments {
  constructor(private readonly store: WorkspaceRegistry) {}

  ensureDefaults(): void {
    if (!this.store.layouts.getLatest<GuardPolicy>(POLICY_KIND, POLICY_KEY)) {
      this.store.layouts.put(POLICY_KIND, POLICY_KEY, defaultGuardPolicy)
    }
  }

  /** The live guard policy (latest version), or the seeded default against an unseeded store. */
  policy(): GuardPolicy {
    return this.store.layouts.getLatest<GuardPolicy>(POLICY_KIND, POLICY_KEY)?.body ?? defaultGuardPolicy
  }

  /** Persist an edited policy (version-bumped, append-only), validated against the contract before write. */
  savePolicy(policy: GuardPolicy): GuardPolicy {
    if (!Value.Check(GuardPolicySchema, policy)) throw new Error('guard policy failed contract validation')
    this.store.layouts.put(POLICY_KIND, POLICY_KEY, policy)
    return policy
  }
}

/** The stored held-hops document body: one per workspace, the append-only log of suspended egress hops. */
interface HoldsDoc {
  workspaceId: string
  holds: GuardHold[]
}

/**
 * Store-backed held-hops (#63) — the durable audit of every SUSPENDED egress hop, so a held verdict IS in
 * the audit trail (surfaced in the ledger with an approve/deny affordance). One document per workspace via
 * LayoutStore (the ItemSignalStore pattern), each hold contract-validated before write. The verdict carries
 * span descriptors, never the raw value; the raw content is not retained (fail-closed: nothing leaked).
 */
export class GuardHoldStore {
  constructor(private readonly store: WorkspaceRegistry) {}

  /** Every hold recorded for a workspace (latest version), newest first. */
  list(workspaceId: string): GuardHold[] {
    const holds = this.store.layouts.getLatest<HoldsDoc>(HOLDS_KIND, workspaceId)?.body.holds ?? []
    return [...holds].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
  }

  /** Record a new held hop. Validated against the contract before persisting; returns the stored hold. */
  add(hold: GuardHold): GuardHold {
    const { id } = hold
    if (!Value.Check(GuardHoldSchema, hold)) throw new Error(`guard hold failed contract validation: ${id}`)
    const current = this.store.layouts.getLatest<HoldsDoc>(HOLDS_KIND, hold.workspaceId)?.body.holds ?? []
    this.store.layouts.put<HoldsDoc>(HOLDS_KIND, hold.workspaceId, { workspaceId: hold.workspaceId, holds: [...current, hold] })
    return hold
  }

  /**
   * Resolve a held hop — record approval (`released`, the compatibility wire value) or denial. Approval
   * does not replay the original pass because raw content is deliberately not retained. Idempotent:
   * resolving an already-resolved hold returns it unchanged. Stamps `resolvedAt`.
   */
  resolve(workspaceId: string, id: string, status: 'released' | 'denied', at: string): GuardHold | undefined {
    const current = this.store.layouts.getLatest<HoldsDoc>(HOLDS_KIND, workspaceId)?.body.holds ?? []
    const target = current.find((h) => h.id === id)
    if (target === undefined) return undefined
    if (target.status !== 'held') return target
    const updated: GuardHold = { ...target, status, resolvedAt: at }
    const holds = current.map((h) => (h.id === id ? updated : h))
    this.store.layouts.put<HoldsDoc>(HOLDS_KIND, workspaceId, { workspaceId, holds })
    return updated
  }
}
