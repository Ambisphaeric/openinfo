import { createHash } from 'node:crypto'
import type { Summary, SummaryChild, SummaryInputBound, SummaryLevel, SummaryScope } from '@openinfo/contracts'
import { SUMMARY_SCHEMA_VERSION } from '@openinfo/contracts'

/**
 * The PURE hierarchical-summary assembler (#177) — the deterministic half of the summary producer, split
 * out of the impure store/model seam (`produce-summaries.ts`) exactly as `packets.ts` is split from
 * `produce-packets.ts`. Given a level's config + its lower-level inputs + the level's existing chain, it
 * decides window membership, BOUNDS the inputs (the non-negotiable acceptance criterion), computes a
 * deterministic content-derived id + append-only revision/supersedes, and returns a PLAN of windows that
 * need (re)summarizing plus the windows that are idempotently unchanged. It never touches a DB, a clock, or
 * a model — so replaying the same inputs yields byte-identical skeletons (the #32 guarantee), and the model
 * prose the producer layers on top is deliberately EXCLUDED from the id so a prose re-roll over the SAME
 * bounded child set does not churn a new revision.
 */

/** One lower-level input reduced to what assembly needs — the ref, its window, and (when it has one) its text. */
export interface SummaryInput {
  /** the ref this input contributes (record/id/at/role/level) — carried verbatim onto the summary's children. */
  ref: SummaryChild
  /** the input's window start (child.at for a point record) — buckets the input and bounds the window. */
  windowStart: string
  /** the input's window end (child.at for a point record). */
  windowEnd: string
  /** the prose the summarizer reads for this input; absent ⇒ the input contributes a ref but no prose (e.g. a packet). */
  text?: string
}

/** A level's cadence/bound configuration, resolved from its summary prompt DOCUMENT (never hardcoded). */
export interface SummaryLevelConfig {
  level: SummaryLevel
  /** interval bucket size (ms); ignored for whole-session levels. */
  windowMs: number
  /** the lower summary level consumed as children; absent ⇒ this level consumes distillates directly. */
  childLevel?: SummaryLevel
  /** HARD BOUND on children fed to the summarizer (newest kept). */
  maxChildren: number
  /** bound on selectively-retrieved evidence (0 ⇒ none). */
  maxEvidence: number
  /** the summary prompt document id shaping the prose — stamped into provenance. */
  templateId: string
  /** which config scope resolved this level's template (#177 slice 2) — the which-scope-won audit; absent ⇒ workspace-global. */
  templateScope?: SummaryScope
}

/** The deterministic skeleton of one window that needs (re)summarizing — everything but the model prose. */
export interface SummaryPlanItem {
  windowStart: string
  windowEnd: string
  /** the bounded, deterministically-ordered child + evidence refs (role-tagged) — refs only. */
  refs: SummaryChild[]
  bound: SummaryInputBound
  confidence: number
  revision: number
  supersedes: string | undefined
  /** content-derived id (prose EXCLUDED) — replaying the same inputs reproduces it. */
  id: string
  windowMs: number
  childLevel: SummaryLevel | undefined
  templateId: string
  templateScope: SummaryScope | undefined
  /** bounded child texts (chronological) the summarizer prompt reads. */
  childTexts: string[]
  /** bounded evidence texts (chronological) the summarizer prompt reads. */
  evidenceTexts: string[]
}

export interface AssembleSummariesInput {
  workspaceId: string
  /** the session this level is scoped to; ABSENT for a cross-session `project` level (its summary carries no sessionId). */
  sessionId?: string
  config: SummaryLevelConfig
  /** the role:'child' inputs (lower-level summaries or distillates), already scoped to this session/level. */
  children: readonly SummaryInput[]
  /** the role:'evidence' inputs (selectively-retrieved corroborating records). */
  evidence: readonly SummaryInput[]
  /** the level's existing chain (includeSuperseded) — supersession + idempotence are decided against it. */
  existing: readonly Summary[]
}

/** A window whose bounded content is byte-identical to its existing head — an idempotent no-op. The bounded
 *  prose inputs are carried so the producer can UPGRADE a degraded head in place if a model is now available. */
export interface UnchangedSummary {
  head: Summary
  childTexts: string[]
  evidenceTexts: string[]
}

export interface AssembleSummariesResult {
  /** windows that are NEW or whose bounded child set CHANGED — each needs a fresh prose pass. */
  plan: SummaryPlanItem[]
  /** window heads whose bounded content is byte-identical — kept untouched (a degraded head may be upgraded). */
  unchanged: UnchangedSummary[]
}

/** JSON with code-point-sorted object keys — the canonical form the content-derived id hashes (mirrors packets.ts). */
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

/** Parse an instant; NaN (unparseable) reads as undefined — an input is never guessed into a window. */
const instant = (iso: string): number | undefined => {
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? t : undefined
}

/**
 * Deterministic summary confidence from the count of INDEPENDENT children consumed — more corroborating
 * lower-level inputs raise it, capped at 0.9. A fixed, inspectable band map — never a model score, never
 * fabricated. A degraded (prose-less) summary keeps this structural confidence: the STRUCTURE is real.
 */
const summaryConfidence = (childrenConsumed: number): number =>
  childrenConsumed <= 0 ? 0.2 : childrenConsumed === 1 ? 0.4 : childrenConsumed === 2 ? 0.6 : childrenConsumed <= 4 ? 0.8 : 0.9

/** Deterministic ref order: by instant, then record, then id — so summary bytes never depend on read order. */
const byAtRecordId = (a: SummaryChild, b: SummaryChild): number =>
  a.at < b.at ? -1 : a.at > b.at ? 1 : a.record < b.record ? -1 : a.record > b.record ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0

/** Chronological input order (at, then ref id) — bounding keeps the NEWEST, prose stays chronological. */
const byInputChrono = (a: SummaryInput, b: SummaryInput): number =>
  a.windowStart < b.windowStart ? -1 : a.windowStart > b.windowStart ? 1 : a.ref.id < b.ref.id ? -1 : a.ref.id > b.ref.id ? 1 : 0

/** The latest (not-superseded) head per window key among a level's existing chain. */
const latestByWindow = (existing: readonly Summary[]): Map<string, Summary> => {
  const superseded = new Set(existing.map((s) => s.supersedes).filter((id): id is string => id !== undefined))
  const latest = new Map<string, Summary>()
  for (const summary of existing) {
    if (superseded.has(summary.id)) continue
    const key = `${summary.windowStart}|${summary.windowEnd}`
    const prior = latest.get(key)
    if (prior === undefined || summary.revision > prior.revision) latest.set(key, summary)
  }
  return latest
}

/**
 * The single live head of a WHOLE-scope level (`session`/`project`) — its highest-revision non-superseded
 * summary, regardless of window bounds. A whole level is a singleton chain within its scope (one session, or
 * one workspace for the cross-session project), and its window SPAN grows as more children arrive — so
 * window-keyed matching would wrongly read a grown revision as a NEW window. Keying the head by scope instead
 * lets a later child set correctly SUPERSEDE the prior revision rather than fork a parallel head.
 */
const latestOverall = (existing: readonly Summary[]): Summary | undefined => {
  const superseded = new Set(existing.map((s) => s.supersedes).filter((id): id is string => id !== undefined))
  let head: Summary | undefined
  for (const summary of existing) {
    if (superseded.has(summary.id)) continue
    if (head === undefined || summary.revision > head.revision) head = summary
  }
  return head
}

/** The deterministic content of one window (id + idempotence hash over it), prose EXCLUDED. */
interface WindowContent {
  workspaceId: string
  sessionId?: string
  level: SummaryLevel
  windowStart: string
  windowEnd: string
  refs: SummaryChild[]
  bound: SummaryInputBound
  confidence: number
  builder: 'bounded-hierarchical-summary'
  windowMs: number
  childLevel?: SummaryLevel
  templateId: string
}

const summaryId = (content: WindowContent, revision: number, supersedes: string | undefined): string =>
  `sum-${createHash('sha256')
    .update(canonicalJson({ ...content, revision, ...(supersedes !== undefined ? { supersedes } : {}) }))
    .digest('hex')
    .slice(0, 32)}`

/** The deterministic content an existing head presents for the idempotence comparison (prose/provenance-model excluded). */
const headContent = (head: Summary): WindowContent => ({
  workspaceId: head.workspaceId,
  ...(head.sessionId !== undefined ? { sessionId: head.sessionId } : {}),
  level: head.level,
  windowStart: head.windowStart,
  windowEnd: head.windowEnd,
  refs: head.children,
  bound: head.bound,
  confidence: head.confidence,
  builder: 'bounded-hierarchical-summary',
  windowMs: head.provenance.windowMs,
  ...(head.provenance.childLevel !== undefined ? { childLevel: head.provenance.childLevel } : {}),
  templateId: head.provenance.templateId,
})

/**
 * Assemble a level's summary PLAN from its lower-level inputs. Pure: the caller does all reads/writes and
 * supplies the prose. A window enters the plan only when it is new or its bounded child set changed; an
 * identical window is returned as `unchanged` (idempotent). Bounding is explicit and recorded on `bound`.
 */
export const assembleSummaries = (input: AssembleSummariesInput): AssembleSummariesResult => {
  const { config } = input
  const whole = config.level === 'session' || config.level === 'project'

  // 1) Bucket children by window. Whole-session levels use ONE bucket (window = children's min→max span);
  //    windowed levels bucket into epoch-aligned windows of windowMs (mirrors the packet correlator).
  const buckets = new Map<number, SummaryInput[]>()
  for (const child of input.children) {
    const t = instant(child.windowStart)
    if (t === undefined) continue // never guess an input into a window
    const key = whole ? 0 : Math.floor(t / config.windowMs) * config.windowMs
    buckets.set(key, [...(buckets.get(key) ?? []), child])
  }

  const latest = latestByWindow(input.existing)
  // A whole-scope level is a singleton chain: match the head by scope (highest revision), not by window key,
  // since its span grows with each new child set. A windowed level keeps per-window matching.
  const wholeHead = whole ? latestOverall(input.existing) : undefined
  const plan: SummaryPlanItem[] = []
  const unchanged: UnchangedSummary[] = []

  for (const bucketKey of [...buckets.keys()].sort((a, b) => a - b)) {
    const members = buckets.get(bucketKey)!.slice().sort(byInputChrono)

    // Window bounds: whole ⇒ children's actual min→max span; windowed ⇒ the epoch-aligned window.
    const windowStart = whole ? members[0]!.windowStart : new Date(bucketKey).toISOString()
    const windowEnd = whole
      ? members.reduce((m, c) => (c.windowEnd > m ? c.windowEnd : m), members[0]!.windowEnd)
      : new Date(bucketKey + config.windowMs).toISOString()

    // 2) BOUND the children: keep the newest maxChildren (chronological order preserved). available > consumed
    //    ⇒ the input was truncated to the cap — the bound is recorded, never silently exceeded.
    const childrenAvailable = members.length
    const consumedChildren = members.slice(Math.max(0, members.length - config.maxChildren))

    // 3) Selectively retrieve evidence in-window, BOUND to maxEvidence (newest kept). 0 ⇒ no evidence pulled.
    const inWindowEvidence = input.evidence
      .filter((e) => {
        const t = instant(e.windowStart)
        return t !== undefined && e.windowStart >= windowStart && e.windowStart < windowEnd
      })
      .sort(byInputChrono)
    const evidenceAvailable = inWindowEvidence.length
    const consumedEvidence = config.maxEvidence > 0 ? inWindowEvidence.slice(Math.max(0, inWindowEvidence.length - config.maxEvidence)) : []

    const bound: SummaryInputBound = {
      childrenAvailable,
      childrenConsumed: consumedChildren.length,
      evidenceAvailable,
      evidenceConsumed: consumedEvidence.length,
    }
    const refs: SummaryChild[] = [...consumedChildren.map((c) => c.ref), ...consumedEvidence.map((e) => e.ref)].sort(byAtRecordId)
    const confidence = summaryConfidence(consumedChildren.length)

    const content: WindowContent = {
      workspaceId: input.workspaceId,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      level: config.level,
      windowStart,
      windowEnd,
      refs,
      bound,
      confidence,
      builder: 'bounded-hierarchical-summary',
      windowMs: whole ? 0 : config.windowMs,
      ...(config.childLevel !== undefined ? { childLevel: config.childLevel } : {}),
      templateId: config.templateId,
    }

    const childTexts = consumedChildren.map((c) => c.text).filter((t): t is string => t !== undefined && t.trim() !== '')
    const evidenceTexts = consumedEvidence.map((e) => e.text).filter((t): t is string => t !== undefined && t.trim() !== '')

    // 4) Idempotence / append-only supersession against the window's existing head. A byte-identical head is
    //    an idempotent no-op (kept untouched — the producer may still upgrade a degraded head in place, which
    //    is why the bounded texts ride along); a changed child set appends a NEW revision superseding the prior.
    const head = whole ? wholeHead : latest.get(`${windowStart}|${windowEnd}`)
    if (head !== undefined && canonicalJson(headContent(head)) === canonicalJson(content)) {
      unchanged.push({ head, childTexts, evidenceTexts })
      continue
    }
    const revision = head === undefined ? 1 : head.revision + 1
    const supersedes = head?.id
    plan.push({
      windowStart,
      windowEnd,
      refs,
      bound,
      confidence,
      revision,
      supersedes,
      id: summaryId(content, revision, supersedes),
      windowMs: content.windowMs,
      childLevel: config.childLevel,
      templateId: config.templateId,
      templateScope: config.templateScope,
      childTexts,
      evidenceTexts,
    })
  }

  return { plan, unchanged }
}

/** The prose outcome the producer supplies per plan item — a model proposal, or an honest degraded reason. */
export type SummaryProse =
  | { text: string; slot: string; endpoint: string; model?: string; usage?: Summary['provenance']['usage']; egress?: Summary['provenance']['egress']; guard?: Summary['provenance']['guard'] }
  | { degraded: string }

/**
 * Fold a plan item + its prose outcome into a complete, contract-shaped Summary. Prose present ⇒ a model
 * PROPOSAL with full invoke provenance; degraded ⇒ NO text, an explicit reason, and no fabricated invoke
 * fields. `id`/`revision`/`supersedes` come straight from the (prose-excluding) plan, so a degraded→prose
 * upgrade over the SAME children reuses the id and replaces in place — an honest fill-in, not a rewrite.
 */
export const buildSummary = (
  item: SummaryPlanItem,
  scope: { workspaceId: string; sessionId?: string; level: SummaryLevel },
  prose: SummaryProse,
  createdAt: string,
): Summary => {
  const provenance: Summary['provenance'] = {
    builder: 'bounded-hierarchical-summary',
    windowMs: item.windowMs,
    ...(item.childLevel !== undefined ? { childLevel: item.childLevel } : {}),
    templateId: item.templateId,
    ...(item.templateScope !== undefined ? { templateScope: item.templateScope } : {}),
    ...('text' in prose
      ? {
          slot: prose.slot as NonNullable<Summary['provenance']['slot']>,
          endpoint: prose.endpoint,
          ...(prose.model !== undefined ? { model: prose.model } : {}),
          ...(prose.usage !== undefined ? { usage: prose.usage } : {}),
          ...(prose.egress !== undefined ? { egress: prose.egress } : {}),
          ...(prose.guard !== undefined ? { guard: prose.guard } : {}),
        }
      : {}),
  }
  return {
    id: item.id,
    workspaceId: scope.workspaceId,
    ...(scope.sessionId !== undefined ? { sessionId: scope.sessionId } : {}),
    level: scope.level,
    windowStart: item.windowStart,
    windowEnd: item.windowEnd,
    children: item.refs,
    bound: item.bound,
    ...('text' in prose ? { text: prose.text } : { degraded: { reason: prose.degraded } }),
    proposal: true,
    confidence: item.confidence,
    provenance,
    revision: item.revision,
    ...(item.supersedes !== undefined ? { supersedes: item.supersedes } : {}),
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    createdAt,
  }
}
