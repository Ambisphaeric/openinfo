import type { Mode, PromptTemplate, Summary, SummaryChild, SummaryLevel } from '@openinfo/contracts'
import {
  FabricDocuments,
  GuardHeldError,
  invokeLlm,
  resolveEgress,
  type GuardOptions,
  type InvokeOptions,
  type LlmMessage,
  type LlmResult,
  type LocalRuntimeManager,
  type SecretResolver,
} from '../fabric/index.js'
import type { GuardDocuments, GuardHoldStore } from '../guard/index.js'
import type { WorkspaceRegistry } from '../store/index.js'
import { interpolateTemplate } from '../voice/index.js'
import {
  assembleSummaries,
  buildSummary,
  type SummaryInput,
  type SummaryLevelConfig,
  type SummaryProse,
} from './summaries.js'

/**
 * The LIVE hierarchical-summary producer (#177) — the impure runtime seam that wires the pure assembler
 * (`summaries.ts`) to the store + the fabric invoke chain, so summaries materialize at the drain/distill
 * cadence points and at session end WITHOUT anyone calling the on-demand route. Like `produce-packets.ts`,
 * this is a store-touching index/ seam: it reads a session's lower-level inputs, assembles the bounded
 * plan, asks the summarizer for prose through the guard/egress-enforced fabric chain, persists ONLY what it
 * appends, and records the attempt so a failure is VISIBLE — never silently swallowed.
 *
 * CONTAINED FAILURE (non-negotiable): building a summary is derived best-effort work — it must never block
 * or fail the capture/distill/session-end path. So `materializeSummaries` NEVER throws: any error is caught,
 * recorded on the build log with its reason, and returned in the outcome. HONEST DEGRADATION: when the
 * summarizing model is unavailable (empty slot, invoke failure, or a guard hold), NO prose is fabricated —
 * the summary is persisted with an explicit `degraded.reason` and its (deterministic) children/derivation
 * path intact, and a later pass upgrades it in place once a model answers.
 */

export type LlmInvoke = (messages: LlmMessage[], opts: InvokeOptions) => Promise<LlmResult>

/** The request the producer hands the summarizer for ONE window — the bounded prose inputs + prompt document. */
export interface SummarizeRequest {
  workspaceId: string
  /** the session this level is scoped to; ABSENT for a cross-session `project` summary (no mode layer to read). */
  sessionId?: string
  level: SummaryLevel
  template: PromptTemplate
  windowStart: string
  windowEnd: string
  /** the bounded child texts (chronological) — the summary is derived from ONLY these. */
  childTexts: string[]
  /** the bounded evidence texts (chronological). */
  evidenceTexts: string[]
}

/** Turns a bounded window request into prose (a model proposal) or an honest degraded reason. Never throws. */
export type Summarizer = (req: SummarizeRequest) => Promise<SummaryProse>

/** The canonical finest→coarsest order — a call producing several levels always runs a child before its parent. */
export const SUMMARY_LEVEL_ORDER: readonly SummaryLevel[] = ['rolling', 'episode', 'five-minute', 'session', 'project']

/**
 * The session-scoped levels the live loop produces (rolling/episode/five-minute at the drain cadence,
 * session flushed at session end). `project` is DELIBERATELY absent: it is a CROSS-SESSION level (no single
 * sessionId) produced explicitly at session end so a new session's result is folded into a superseding
 * project revision without losing the prior ones — see materializeLevel's cross-session branch.
 */
export const LIVE_SUMMARY_LEVELS: readonly SummaryLevel[] = ['rolling', 'episode', 'five-minute', 'session']

/** The cross-session levels — a `project` summary spans every session's session summary and carries no sessionId. */
export const CROSS_SESSION_SUMMARY_LEVELS: ReadonlySet<SummaryLevel> = new Set<SummaryLevel>(['project'])

/** What triggered a build attempt — the drain cadence, session end, or the on-demand route. */
export type SummaryBuildTrigger = 'drain' | 'session-end' | 'on-demand'

/**
 * One recorded build attempt per (workspace, session, level) — the diagnostics "last update" signal.
 * `error` present ⇒ the attempt failed (created/unchanged 0). `degraded` counts summaries persisted WITHOUT
 * prose (model unavailable) — an honest, visible state, distinct from a hard failure. Process-scoped.
 */
export interface SummaryBuildAttempt {
  workspaceId: string
  sessionId: string
  level: SummaryLevel
  trigger: SummaryBuildTrigger
  at: string
  created: number
  unchanged: number
  degraded: number
  error?: string
}

/** The latest build attempt per (workspace, session, level), in memory — bounded, latest-only (mirrors PacketBuildLog). */
export class SummaryBuildLog {
  private readonly latest = new Map<string, SummaryBuildAttempt>()
  private key(workspaceId: string, sessionId: string, level: SummaryLevel): string {
    return `${workspaceId} ${sessionId} ${level}`
  }
  record(attempt: SummaryBuildAttempt): void {
    this.latest.set(this.key(attempt.workspaceId, attempt.sessionId, attempt.level), attempt)
  }
  latestFor(workspaceId: string, sessionId: string, level: SummaryLevel): SummaryBuildAttempt | undefined {
    return this.latest.get(this.key(workspaceId, sessionId, level))
  }
  recentForWorkspace(workspaceId: string): SummaryBuildAttempt[] {
    return [...this.latest.values()]
      .filter((a) => a.workspaceId === workspaceId)
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  }
}

export interface MaterializeSummariesScope {
  workspaceId: string
  sessionId: string
  trigger: SummaryBuildTrigger
  /** the levels to produce (finest→coarsest is enforced); absent ⇒ every live-loop level. */
  levels?: readonly SummaryLevel[]
}

export interface MaterializeSummariesDeps {
  store: WorkspaceRegistry
  /** the summary prompt documents (per-level config + prompt) — from DistillDocuments.summaryTemplate. */
  summaryTemplate: (level: SummaryLevel) => PromptTemplate | undefined
  /** the model summarizer — the fabric-backed one in prod, a fake loopback in tests. */
  summarize: Summarizer
  /** the diagnostics build log to record attempts on (optional so the seam is testable without one). */
  log?: SummaryBuildLog
  /** injectable clock for attempt time + appended summaries' createdAt (fixture replay hands in the replay clock). */
  now?: () => Date
  logLine?: (message: string) => void
}

export interface MaterializeSummariesOutcome {
  /** summaries appended/replaced this run (new windows, new revisions, in-place degraded upgrades). */
  created: Summary[]
  /** window heads that rebuilt identical and were kept untouched. */
  unchanged: number
  /** summaries persisted WITHOUT prose this run (model unavailable) — honest degraded count. */
  degraded: number
  error?: string
}

/** True ⇒ this level spans sessions (`project`): it gathers workspace-wide and its summary carries no sessionId. */
const isCrossSession = (level: SummaryLevel): boolean => CROSS_SESSION_SUMMARY_LEVELS.has(level)

/** The level's config resolved from its summary prompt document's binding — never hardcoded. `templateScope` is
 *  the which-scope-won audit (#177 slice 2): the binding's declared scope, absent ⇒ workspace-global. */
const levelConfig = (template: PromptTemplate): SummaryLevelConfig => {
  const binding = template.summary!
  return {
    level: binding.level,
    windowMs: binding.windowMs,
    ...(binding.childLevel !== undefined ? { childLevel: binding.childLevel } : {}),
    maxChildren: binding.maxChildren,
    maxEvidence: binding.maxEvidence ?? 0,
    templateId: template.id,
    ...(binding.scope !== undefined ? { templateScope: binding.scope } : {}),
  }
}

/**
 * Gather a level's role:'child' inputs: distillates for the base level, else the lower level's live summary
 * heads. A CROSS-SESSION level (`project`) gathers its child summaries across the WHOLE workspace (every
 * session's session summary), so a new session's result becomes a child of the next project revision; a
 * session-scoped level reads only its own session's inputs.
 */
const gatherChildren = (store: WorkspaceRegistry, workspaceId: string, sessionId: string, config: SummaryLevelConfig): SummaryInput[] => {
  if (config.childLevel === undefined) {
    return store.listDistillates(workspaceId, sessionId).map((d) => ({
      ref: { record: 'distillate', id: d.id, at: d.windowStart, role: 'child' } satisfies SummaryChild,
      windowStart: d.windowStart,
      windowEnd: d.windowEnd,
      text: d.text,
    }))
  }
  const childLevel = config.childLevel
  const heads = isCrossSession(config.level)
    ? store.listSummaries(workspaceId, { level: childLevel })
    : store.listSummaries(workspaceId, { sessionId, level: childLevel })
  return heads.map((s) => ({
    ref: { record: 'summary', id: s.id, at: s.windowStart, role: 'child', level: childLevel } satisfies SummaryChild,
    windowStart: s.windowStart,
    windowEnd: s.windowEnd,
    ...(s.text !== undefined ? { text: s.text } : {}),
  }))
}

/** Gather a level's role:'evidence' inputs: ContextPackets for the base level, else moments (bounded downstream). */
const gatherEvidence = (store: WorkspaceRegistry, workspaceId: string, sessionId: string, config: SummaryLevelConfig): SummaryInput[] => {
  if (config.maxEvidence <= 0) return []
  if (config.childLevel === undefined) {
    return store.listContextPackets(workspaceId, { sessionId }).map((p) => ({
      ref: { record: 'context-packet', id: p.id, at: p.windowStart, role: 'evidence' } satisfies SummaryChild,
      windowStart: p.windowStart,
      windowEnd: p.windowEnd,
    }))
  }
  const moments = isCrossSession(config.level) ? store.listMoments(workspaceId) : store.listMoments(workspaceId, sessionId)
  return moments.map((m) => ({
    ref: { record: 'moment', id: m.id, at: m.at, role: 'evidence' } satisfies SummaryChild,
    windowStart: m.at,
    windowEnd: m.at,
    text: m.text,
  }))
}

/** Produce (or converge) ONE level's summaries for a session. Reads/writes scoped to the workspace. Never throws. */
const materializeLevel = async (
  deps: MaterializeSummariesDeps,
  scope: { workspaceId: string; sessionId: string; trigger: SummaryBuildTrigger },
  template: PromptTemplate,
  now: () => Date,
): Promise<MaterializeSummariesOutcome> => {
  const config = levelConfig(template)
  const created: Summary[] = []
  let degraded = 0
  // CROSS-SESSION (`project`): gathered workspace-wide and the summary carries NO sessionId; every other
  // level is scoped to the ending session. levelSessionId threads that distinction through assemble/build.
  const crossSession = isCrossSession(config.level)
  const levelSessionId = crossSession ? undefined : scope.sessionId
  const sessionScope = levelSessionId !== undefined ? { sessionId: levelSessionId } : {}
  try {
    const children = gatherChildren(deps.store, scope.workspaceId, scope.sessionId, config)
    const evidence = gatherEvidence(deps.store, scope.workspaceId, scope.sessionId, config)
    const existing = deps.store.listSummaries(scope.workspaceId, { ...sessionScope, level: config.level, includeSuperseded: true })
    const { plan, unchanged } = assembleSummaries({ workspaceId: scope.workspaceId, ...sessionScope, config, children, evidence, existing })

    // NEW / CHANGED windows: summarize the bounded inputs and append. A window with no summarizable text
    // (its lower-level children are all degraded) is degraded honestly rather than fed an empty prompt.
    for (const item of plan) {
      const prose = await summarizeOrDegrade(deps.summarize, {
        workspaceId: scope.workspaceId, ...sessionScope, level: config.level, template,
        windowStart: item.windowStart, windowEnd: item.windowEnd, childTexts: item.childTexts, evidenceTexts: item.evidenceTexts,
      })
      const createdAt = now().toISOString()
      const summary = buildSummary(item, { workspaceId: scope.workspaceId, ...sessionScope, level: config.level }, prose, createdAt)
      deps.store.saveSummary(summary)
      if ('degraded' in prose) degraded++
      created.push(summary)
    }

    // Idempotent no-ops — kept untouched, EXCEPT a degraded head we can now upgrade IN PLACE (same id/revision/
    // createdAt, prose filled). The upgrade only writes on SUCCESS, so a still-degraded retry is a true no-op.
    for (const { head, childTexts, evidenceTexts } of unchanged) {
      if (head.text !== undefined || head.degraded === undefined) continue
      const prose = await summarizeOrDegrade(deps.summarize, {
        workspaceId: scope.workspaceId, ...sessionScope, level: config.level, template,
        windowStart: head.windowStart, windowEnd: head.windowEnd, childTexts, evidenceTexts,
      })
      if ('degraded' in prose) continue // still no model — leave the honest degraded head untouched (idempotent)
      const upgraded = buildSummary(
        { id: head.id, windowStart: head.windowStart, windowEnd: head.windowEnd, refs: head.children, bound: head.bound, confidence: head.confidence, revision: head.revision, supersedes: head.supersedes, windowMs: head.provenance.windowMs, childLevel: head.provenance.childLevel, templateId: head.provenance.templateId, templateScope: head.provenance.templateScope, childTexts, evidenceTexts },
        { workspaceId: scope.workspaceId, ...sessionScope, level: config.level },
        prose,
        head.createdAt,
      )
      deps.store.saveSummary(upgraded)
      created.push(upgraded)
    }

    const outcome: MaterializeSummariesOutcome = { created, unchanged: unchanged.length, degraded }
    deps.log?.record({ workspaceId: scope.workspaceId, sessionId: scope.sessionId, level: config.level, trigger: scope.trigger, at: now().toISOString(), created: created.length, unchanged: unchanged.length, degraded })
    return outcome
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    deps.log?.record({ workspaceId: scope.workspaceId, sessionId: scope.sessionId, level: config.level, trigger: scope.trigger, at: now().toISOString(), created: 0, unchanged: 0, degraded: 0, error: message })
    return { created: [], unchanged: 0, degraded: 0, error: message }
  }
}

/** Call the summarizer over the bounded inputs; empty inputs (all lower-level children degraded) degrade honestly. */
const summarizeOrDegrade = async (summarize: Summarizer, req: SummarizeRequest): Promise<SummaryProse> => {
  if (req.childTexts.length === 0 && req.evidenceTexts.length === 0) {
    return { degraded: 'no summarizable input text (lower-level inputs are degraded or empty)' }
  }
  return summarize(req)
}

/**
 * Produce (or converge) a session's summaries across the requested levels, finest→coarsest so a parent level
 * reads its just-produced children. Aggregates per-level outcomes; a per-level failure is CONTAINED (recorded,
 * returned) and never stops the other levels. A missing level template is skipped (that level simply does not run).
 */
export const materializeSummaries = async (deps: MaterializeSummariesDeps, scope: MaterializeSummariesScope): Promise<MaterializeSummariesOutcome> => {
  const now = deps.now ?? (() => new Date())
  const requested = scope.levels ?? LIVE_SUMMARY_LEVELS
  const ordered = SUMMARY_LEVEL_ORDER.filter((l) => requested.includes(l))
  const created: Summary[] = []
  let unchanged = 0
  let degraded = 0
  const errors: string[] = []
  for (const level of ordered) {
    const template = deps.summaryTemplate(level)
    if (template === undefined || template.summary === undefined) continue
    const outcome = await materializeLevel(deps, { workspaceId: scope.workspaceId, sessionId: scope.sessionId, trigger: scope.trigger }, template, now)
    created.push(...outcome.created)
    unchanged += outcome.unchanged
    degraded += outcome.degraded
    if (outcome.error !== undefined) {
      errors.push(`${level}: ${outcome.error}`)
      deps.logLine?.(`summaries: ${level} build failed for ${scope.sessionId}: ${outcome.error}`)
    }
  }
  return { created, unchanged, degraded, ...(errors.length > 0 ? { error: errors.join('; ') } : {}) }
}

export interface FabricSummarizerDeps {
  store: WorkspaceRegistry
  fabric: FabricDocuments
  resolveKey?: SecretResolver
  runtimeManager?: LocalRuntimeManager
  guardDocs?: GuardDocuments
  guardHolds?: GuardHoldStore
  guardEnabled?: () => boolean
  /**
   * Resolve a mode document by id (e.g. `distillDocs.mode`). Used to read the session's mode `egress.deny`
   * so the summarizer enforces LAYER 3 of the #64 four-layer consent exactly as the distiller does — a
   * mode that denies egress for distillation must equally deny it for summary prose. Absent ⇒ the mode
   * layer is skipped (the workspace/prompt layers still apply).
   */
  mode?: (id: string) => Mode
  /** override the model call (tests); defaults to the fabric llm slot. */
  invoke?: LlmInvoke
  maxTokens?: number
}

/** Default summarizer token budget — a level summary is short; bounded so a big child set cannot blow the budget. */
const SUMMARY_MAX_TOKENS = 500

/**
 * Build the production Summarizer: it interpolates the level's prompt document with the BOUNDED child/evidence
 * texts and the window bounds, then invokes the fabric `llm` slot under the SAME #64 egress consent + #63
 * guard the distiller enforces (a summary is derived transcript content). SUCCESS ⇒ a model-proposal prose
 * with full invoke provenance. A guard HOLD, an empty slot, or any invoke failure ⇒ an honest degraded reason
 * (no fabricated prose) — so the pipeline stays contained and the state stays truthful.
 */
export const createFabricSummarizer = (deps: FabricSummarizerDeps): Summarizer => {
  const guardEnabled = deps.guardEnabled ?? (() => false)
  const invoke: LlmInvoke =
    deps.invoke ??
    ((messages, opts) =>
      invokeLlm(deps.fabric.load(), messages, {
        ...opts,
        ...(deps.resolveKey ? { resolveKey: deps.resolveKey } : {}),
        ...(deps.runtimeManager ? { runtimeManager: deps.runtimeManager } : {}),
      }))
  const guardOptions = (template: PromptTemplate): GuardOptions | undefined => {
    if (!guardEnabled() || deps.guardDocs === undefined) return undefined
    const policy = deps.guardDocs.policy()
    return {
      endpoints: deps.fabric.load().slots.guard ?? [],
      behavior: policy.behavior,
      acknowledgeUnguardedEgress: policy.acknowledgeUnguardedEgress,
      ...(deps.resolveKey ? { resolveKey: deps.resolveKey } : {}),
    }
  }
  return async (req) => {
    const bullet = (lines: string[]): string => (lines.length > 0 ? lines.map((l) => `- ${l}`).join('\n') : '(none)')
    const prompt = interpolateTemplate(req.template.body, {
      children: bullet(req.childTexts),
      evidence: bullet(req.evidenceTexts),
      windowStart: req.windowStart,
      windowEnd: req.windowEnd,
      level: req.level,
    })
    const workspace = deps.store.all().find((w) => w.id === req.workspaceId)
    // #64 LAYER 3 (mode): read the session's mode egress deny exactly as the distiller does
    // (store.getSession → record.modeId → docs.mode), so a mode that denies egress for distillation
    // equally denies summary-prose egress. No session/mode resolver ⇒ the layer is simply absent.
    const session = req.sessionId !== undefined ? deps.store.getSession(req.workspaceId, req.sessionId) : undefined
    const mode = session !== undefined && deps.mode !== undefined ? deps.mode(session.modeId) : undefined
    const egress = resolveEgress({
      contentClass: 'transcript',
      promptNeverEgress: req.template.neverEgress,
      ...(mode?.egress?.deny !== undefined ? { modeDenies: mode.egress.deny } : {}),
      ...(workspace?.egress?.deny !== undefined ? { workspaceDenies: workspace.egress.deny } : {}),
    })
    const guard = guardOptions(req.template)
    try {
      const result = await invoke([{ role: 'user', content: prompt }], { maxTokens: deps.maxTokens ?? SUMMARY_MAX_TOKENS, egress, ...(guard !== undefined ? { guard } : {}) })
      const text = result.text.trim()
      if (text === '') return { degraded: 'summarizer returned empty prose' }
      return {
        text,
        slot: result.slot,
        endpoint: result.endpoint,
        ...(result.model !== undefined ? { model: result.model } : {}),
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
        ...(result.egress !== undefined ? { egress: result.egress } : {}),
        ...(result.guard !== undefined ? { guard: result.guard } : {}),
      }
    } catch (error) {
      if (error instanceof GuardHeldError) return { degraded: `guard held summary egress: ${error.verdict.reason}` }
      return { degraded: error instanceof Error ? error.message : String(error) }
    }
  }
}
