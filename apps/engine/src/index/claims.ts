import { createHash } from 'node:crypto'
import type { Claim, ClaimEvidenceRef, ContextPacket, Entity, Moment } from '@openinfo/contracts'
import { CLAIM_SCHEMA_VERSION } from '@openinfo/contracts'

/**
 * The deterministic Claim builder (#178 slice 1) — engine-side CO-OCCURRENCE correlation over
 * ALREADY-STORED evidence, extending the #74 correlator and the #176 ContextPacket from a converged window
 * to a durable RELATIONSHIP. Like every module in index/, the core is a PURE function of its inputs: no DB,
 * no model, no clock beyond the injectable `now` — so it is fixture-testable, and replaying the same
 * evidence yields byte-identical claims (the #32 record/replay guarantee).
 *
 * WHAT IT DERIVES (and, honestly, what it does NOT): the ONLY relationship co-occurrence evidence can
 * assert without a model is `co-occurs-with` — two entities were OBSERVED TOGETHER. It reads that from the
 * evidence the substrate already converged:
 *   - a ContextPacket whose `candidates` name BOTH entities in one window (#176 already did the cross-source
 *     correlation work — the claim builder lifts it from a window to a durable pair), and
 *   - a moment whose `refs` name BOTH entities in one extracted moment.
 * The SEMANTIC kinds (works-on / belongs-to / authored / member-of / relates-to) require judgment; they are
 * a later JUDGE-ENRICHMENT slice (a proposal per #189) and sovereign user corrections — NOT this slice. So
 * this builder emits exactly one relation kind, and never invents a reading of HOW two entities relate.
 *
 * EVIDENCE IS MANDATORY (honest degradation): a pair with NO co-occurrence evidence yields NO claim — a
 * relationship is never fabricated. `evidenceCount` (distinct evidence refs) is the RECORDED DERIVATION
 * behind `confidence`: repeated co-occurrence strengthens a claim only through a NEW revision that records
 * the higher count, never a silent mutation (#178 AC).
 *
 * SOURCE IDENTITY / REFS-ONLY: nothing is copied out of an evidence record beyond its id + instant; the
 * claim points at immutable records, so every assertion stays traceable to source observations.
 *
 * SUPERSESSION is append-only: when a rebuild sees MORE evidence for a (subject, object, relation) that
 * already has a derived claim, it appends a NEW claim with `revision + 1` and `supersedes` naming the prior
 * — the prior is never mutated. When the evidence set is UNCHANGED the existing claim is kept untouched
 * (idempotence): ids are content-derived, so "same evidence in ⇒ same claim out" holds bit-for-bit. The
 * builder reads and writes ONLY `source:'derived'` claims; sovereign user corrections are resolved OVER the
 * derived chain at read time (the store's `resolveClaimHeads`), so re-deriving a corrected pair can never
 * defeat the correction.
 */

export interface ClaimBuilderConfig {
  /** Max distinct entities considered per evidence record, so a pathological moment/packet cannot emit O(n^2) pairs. */
  maxEntitiesPerRecord: number
}

export const DEFAULT_CLAIM_BUILDER_CONFIG: ClaimBuilderConfig = {
  maxEntitiesPerRecord: 24,
}

/**
 * Deterministic co-occurrence confidence from the count of DISTINCT evidence refs backing the pair — each
 * additional independent observation corroborates the relationship (the #74/#176 design rule, lifted to a
 * durable claim). A fixed, inspectable map, CAPPED below 1.0: a derived claim is a proposal, never certain
 * — 1.0 is reserved for a sovereign user confirmation. Never a model score, never fabricated.
 */
const COOCCURRENCE_CONFIDENCE: Record<number, number> = { 1: 0.4, 2: 0.6, 3: 0.75, 4: 0.82 }
const COOCCURRENCE_CONFIDENCE_CAP = 0.85
const cooccurrenceConfidence = (evidenceCount: number): number =>
  evidenceCount <= 0 ? 0 : (COOCCURRENCE_CONFIDENCE[evidenceCount] ?? COOCCURRENCE_CONFIDENCE_CAP)

export interface ClaimBuildInput {
  workspaceId: string
  sessionId: string
  /** The session's live ContextPacket heads — a packet whose candidates name two entities is co-occurrence evidence. */
  packets: readonly ContextPacket[]
  /** The session's moments — a moment whose refs name two entities is co-occurrence evidence. */
  moments: readonly Moment[]
  /** Workspace entities — a candidate/ref id with no entity record is a dangling ref, never claimed. */
  entities: readonly Entity[]
  /** The session's existing DERIVED claim chain — idempotence and supersession are decided against it. */
  existing: readonly Claim[]
  config?: ClaimBuilderConfig
  /** Injectable clock for `createdAt` on NEWLY appended claims (fixture replay hands in the replay clock). */
  now?: () => Date
}

export interface ClaimBuildResult {
  /** Claims this run APPENDED (new relationships + new supersession revisions). Empty ⇒ idempotent no-op. */
  created: Claim[]
  /** Existing derived heads whose evidence rebuilt identical — kept untouched, byte-for-byte. */
  unchanged: Claim[]
}

/** JSON with code-point-sorted object keys — the canonical form the content-derived claim id hashes. */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Everything id/chain-position/creation-time are derived FROM — the comparable content of one relationship. */
interface ClaimContent {
  workspaceId: string
  subject: string
  object: string
  relation: 'co-occurs-with'
  evidence: ClaimEvidenceRef[]
  confidence: number
  source: 'derived'
  state: 'provisional'
  provenance: { builder: 'deterministic-cooccurrence'; evidenceCount: number }
  sessionId: string
  firstObserved: string
  lastObserved: string
  schemaVersion: number
}

/** Content-derived claim id: a hash over the canonical relationship content + chain position. */
const claimId = (content: ClaimContent, revision: number, supersedes: string | undefined): string =>
  `clm-${createHash('sha256')
    .update(canonicalJson({ ...content, revision, ...(supersedes !== undefined ? { supersedes } : {}) }))
    .digest('hex')
    .slice(0, 32)}`

/** Deterministic evidence order: by instant, then record, then id — so claim bytes never depend on read order. */
const byEvidence = (a: ClaimEvidenceRef, b: ClaimEvidenceRef): number =>
  a.at < b.at ? -1 : a.at > b.at ? 1 : a.record < b.record ? -1 : a.record > b.record ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0

/** The pair key a relationship's supersession chain is keyed by — subject|object|relation. */
const pairKey = (subject: string, object: string, relation: string): string => `${subject}\u0000${object}\u0000${relation}`

/** The latest (not-superseded) DERIVED claim per pair key among a session's existing chain. */
const latestByPair = (existing: readonly Claim[]): Map<string, Claim> => {
  const derived = existing.filter((c) => c.source === 'derived')
  const superseded = new Set(derived.map((c) => c.supersedes).filter((id): id is string => id !== undefined))
  const latest = new Map<string, Claim>()
  for (const claim of derived) {
    if (superseded.has(claim.id)) continue
    const key = pairKey(claim.subject, claim.object, claim.relation)
    const prior = latest.get(key)
    if (prior === undefined || claim.revision > prior.revision) latest.set(key, claim)
  }
  return latest
}

/** Distinct entity ids named by an evidence record, bounded and sorted — the co-occurrence participants. */
const participants = (ids: readonly string[], known: ReadonlySet<string>, cap: number): string[] =>
  [...new Set(ids.filter((id) => known.has(id)))].sort().slice(0, cap)

/**
 * Build (or converge) the session's co-occurrence Claims from its stored evidence. Pure — the caller does
 * all reads and writes. Returns only appended + kept claims; it never mutates `existing` members.
 */
export const buildClaims = (input: ClaimBuildInput): ClaimBuildResult => {
  const config = input.config ?? DEFAULT_CLAIM_BUILDER_CONFIG
  const now = input.now ?? (() => new Date())
  const known = new Set(input.entities.map((e) => e.id))

  // 1) Gather co-occurrence evidence per unordered entity pair, keyed by subject|object (subject = min id).
  const evidenceByPair = new Map<string, Map<string, ClaimEvidenceRef>>()
  const addPair = (a: string, b: string, ref: ClaimEvidenceRef): void => {
    const [subject, object] = a < b ? [a, b] : [b, a]
    const key = pairKey(subject, object, 'co-occurs-with')
    const refs = evidenceByPair.get(key) ?? new Map<string, ClaimEvidenceRef>()
    refs.set(`${ref.record}\u0000${ref.id}`, ref) // dedup by (record, id): one evidence record backs a pair once
    evidenceByPair.set(key, refs)
  }
  const emitPairs = (ids: string[], ref: ClaimEvidenceRef): void => {
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) addPair(ids[i]!, ids[j]!, ref)
  }

  for (const moment of input.moments) {
    if (moment.sessionId !== input.sessionId) continue
    emitPairs(participants(moment.refs, known, config.maxEntitiesPerRecord), { record: 'moment', id: moment.id, at: moment.at })
  }
  for (const packet of input.packets) {
    if (packet.sessionId !== input.sessionId) continue
    emitPairs(
      participants(packet.candidates.map((c) => c.entityId), known, config.maxEntitiesPerRecord),
      { record: 'context-packet', id: packet.id, at: packet.windowStart },
    )
  }

  // 2) Build a claim per pair with evidence; decide idempotence / append-only supersession vs the chain head.
  const latest = latestByPair(input.existing)
  const created: Claim[] = []
  const unchanged: Claim[] = []

  for (const key of [...evidenceByPair.keys()].sort()) {
    const [subject, object] = key.split('\u0000') as [string, string]
    const evidence = [...evidenceByPair.get(key)!.values()].sort(byEvidence)
    const firstObserved = evidence[0]!.at
    const lastObserved = evidence[evidence.length - 1]!.at
    const content: ClaimContent = {
      workspaceId: input.workspaceId,
      subject,
      object,
      relation: 'co-occurs-with',
      evidence,
      confidence: cooccurrenceConfidence(evidence.length),
      source: 'derived',
      state: 'provisional',
      provenance: { builder: 'deterministic-cooccurrence', evidenceCount: evidence.length },
      sessionId: input.sessionId,
      firstObserved,
      lastObserved,
      schemaVersion: CLAIM_SCHEMA_VERSION,
    }

    const head = latest.get(pairKey(subject, object, 'co-occurs-with'))
    if (head !== undefined) {
      const { id: _i, revision: _r, supersedes: _s, createdAt: _c, ...headContent } = head
      if (canonicalJson(headContent) === canonicalJson(content)) {
        unchanged.push(head)
        continue
      }
    }
    const revision = head === undefined ? 1 : head.revision + 1
    const supersedes = head?.id
    created.push({
      id: claimId(content, revision, supersedes),
      ...content,
      revision,
      ...(supersedes !== undefined ? { supersedes } : {}),
      createdAt: now().toISOString(),
    })
  }

  return { created, unchanged }
}
