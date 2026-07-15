import { randomUUID } from 'node:crypto'
import type { CaptureChunk, ContentClass, Dials, Distillate, GuardHold, Moment, PromptTemplate, Session, TodoItem, TodoList, VoiceBinding, WorkflowStep } from '@openinfo/contracts'
import { TodoList as TodoListSchema } from '@openinfo/contracts'
import { Value } from '@sinclair/typebox/value'
import { parseJsonCandidates } from '../distill/index.js'
import type { LlmInvoke } from '../distill/index.js'
import { FabricDocuments, GuardHeldError, invokeLlm, resolveEgress, type GuardOptions, type InvokeOptions, type LocalRuntimeManager, type SecretResolver } from '../fabric/index.js'
import type { GuardDocuments, GuardHoldStore } from '../guard/index.js'
import type { WorkspaceRegistry } from '../store/index.js'
import { VoiceDocuments, compileVoiceVars, interpolateTemplate, resolveVoice } from '../voice/index.js'
import type { ActDocuments } from './documents.js'
import { effectiveActContentClass } from './privacy.js'

const TODO_KIND = 'todo-list'

/**
 * The dedupe match key — trim, lowercase, collapse internal whitespace. Deliberately simple, kept
 * identical to store's `normalizeEntityName` / distill's alias normalization. WART (stated honestly):
 * this is normalized-text equality only — no stemming, no paraphrase/semantic dedupe. "Send Dana the
 * deck" and "Send the deck to Dana" are two items. Good enough for v0; a semantic dedupe is deferred.
 */
const normalizeText = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * Render a to-do list into the `{{todo}}` template value — the UN-CONSTRAIN side of the loop. Empty
 * (or all-absent) → EMPTY STRING, so a draft template referencing `{{todo}}` renders an omitted
 * section honestly rather than an empty heading (there is no conditional in the interpolation grammar;
 * the empty-state is expressed by rendering nothing). Non-empty → a titled bullet list; a checked-off
 * item is struck with [x]. This is the one variable "prompt engine v0" resolves; see PHASE4-NOTES for
 * what a fuller engine (conditionals/iteration/partials) would add.
 */
export const renderTodo = (items: readonly TodoItem[]): string => {
  const open = items.filter((i) => i.done !== true)
  const done = items.filter((i) => i.done === true)
  if (open.length === 0 && done.length === 0) return ''
  const lines = [
    ...open.map((i) => `- ${i.text}`),
    ...done.map((i) => `- [x] ${i.text}`),
  ]
  return `Accumulated follow-ups so far (the running to-do for this meeting):\n${lines.join('\n')}`
}

/**
 * Merge freshly-extracted candidate items into a session's existing to-do items — the accumulation
 * step. EXISTING items are preserved verbatim (so a user's edits and `done` checkmarks survive a later
 * drain's re-extraction), and only candidates whose normalized text is not already present — in the
 * existing list OR earlier in this candidate batch — are appended. Returns the merged array.
 */
export const mergeTodoItems = (existing: readonly TodoItem[], candidates: readonly TodoItem[]): TodoItem[] => {
  const seen = new Set(existing.map((i) => normalizeText(i.text)))
  const merged = [...existing]
  for (const candidate of candidates) {
    const key = normalizeText(candidate.text)
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    merged.push(candidate)
  }
  return merged
}

export interface TaskExtractInput {
  sessionId: string
  workspaceId: string
  /** the session's accumulated summaries — extraction reads the whole meeting so far, not one window */
  distillates: readonly Distillate[]
  moments: readonly Moment[]
  dials: Dials
  /** provenance seed stamped onto every extracted item (the most recent distillate links the trail) */
  provenanceDistillateId?: string
  /** Effective origin class of all material actually interpolated into the prompt. */
  contentClass?: ContentClass
}

export interface TaskExtractDeps {
  invoke: LlmInvoke
  template: PromptTemplate
  now?: () => Date
  newId?: () => string
  maxTokens?: number
  /** Layered privacy options resolved by TaskExtractor for this session/template (#206). */
  invokeOptions?: Pick<InvokeOptions, 'egress' | 'guard'>
  /** bounded in-call re-sample when a response is wholly unparseable (default 2). */
  maxAttempts?: number
  log?: (message: string) => void
}

export interface TaskExtractResult {
  /** freshly-extracted candidate items (NOT yet merged/deduped against the stored doc). */
  items: TodoItem[]
  /** candidates that parsed as objects but carried no usable text — dropped. */
  dropped: number
  attempts: number
}

const renderMoments = (moments: readonly Moment[]): string =>
  moments.length === 0 ? '(none)' : moments.map((m) => `- ${m.kind}: ${m.text}`).join('\n')

/** Read the follow-up text off a candidate — a bare string, or `text`/`task`/`item` on an object. */
const candidateText = (candidate: unknown): string => {
  if (typeof candidate === 'string') return candidate.trim()
  if (candidate === null || typeof candidate !== 'object') return ''
  const c = candidate as Record<string, unknown>
  for (const key of ['text', 'task', 'item']) {
    const value = c[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return ''
}

/**
 * The CONSTRAIN side of the loop: distill a session's accumulated distillates + moments into a
 * structured array of follow-up items. Pure and store-free/bus-free (like composeFollowUpDraft /
 * extractMoments) so it unit-tests against a canned llm. Robust to the malformed JSON small local
 * models emit (shared defensive parse); a wholly unparseable response is bounded re-sampled, then
 * yields []. A session with no distillates AND no moments yields [] with no llm call. Transport
 * failures from `invoke` propagate so the caller can decide (the drain-act runner logs; it does NOT
 * re-queue — the batch already distilled, see PHASE4-NOTES).
 */
export const composeTaskExtract = async (input: TaskExtractInput, deps: TaskExtractDeps): Promise<TaskExtractResult> => {
  const newId = deps.newId ?? (() => randomUUID())
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? (() => undefined)
  const maxAttempts = Math.max(1, deps.maxAttempts ?? 2)

  if (input.distillates.length === 0 && input.moments.length === 0) {
    return { items: [], dropped: 0, attempts: 0 }
  }

  const prompt = interpolateTemplate(deps.template.body, {
    ...compileVoiceVars(input.dials),
    summaries: input.distillates.map((d) => `- ${d.text}`).join('\n'),
    moments: renderMoments(input.moments),
  })

  const sourceProvenance =
    input.provenanceDistillateId !== undefined
      ? { sessionId: input.sessionId, distillateId: input.provenanceDistillateId }
      : { sessionId: input.sessionId }

  let attempts = 0
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt
    const result = await deps.invoke(
      [{ role: 'user', content: prompt }],
      { maxTokens: deps.maxTokens ?? 500, ...(deps.invokeOptions ?? {}) },
    )
    const { candidates, parsedAnything } = parseJsonCandidates(result.text, 'tasks')
    if (!parsedAnything) {
      if (attempt < maxAttempts) {
        log(`task-extract: unparseable response on attempt ${attempt}, re-sampling`)
        continue
      }
      log(`task-extract: unparseable after ${maxAttempts} attempts, no items for session ${input.sessionId}`)
      return { items: [], dropped: 0, attempts }
    }
    const items: TodoItem[] = []
    let dropped = 0
    const provenance = {
      ...sourceProvenance,
      templateId: deps.template.id,
      slot: result.slot,
      endpoint: result.endpoint,
      ...(result.model !== undefined ? { model: result.model } : {}),
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
      ...(input.contentClass !== undefined ? { contentClass: input.contentClass } : {}),
      ...(result.egress !== undefined ? { egress: result.egress } : {}),
      ...(result.guard !== undefined ? { guard: result.guard } : {}),
    }
    for (const candidate of candidates) {
      const text = candidateText(candidate)
      if (text.length === 0) {
        dropped += 1
        continue
      }
      items.push({ id: newId(), text, provenance, createdAt: now().toISOString() })
    }
    if (dropped > 0) log(`task-extract: salvaged ${items.length}, dropped ${dropped} textless candidates`)
    return { items, dropped, attempts }
  }
  return { items: [], dropped: 0, attempts }
}

/**
 * Store-backed session to-do documents, consistent with SurfaceDocuments/WorkflowDocuments: versioned
 * `todo-list` records in _meta.db via LayoutStore, keyed by the owning session id. NOT seeded (there is
 * no default to-do list — a session's list is created on first extraction / first user edit). The
 * executor / route read `get(sessionId)` fresh per event (the flags/surfaces hot-edit pattern), so a
 * user's PUT-edited list is what the next draft reads.
 *
 * WART (stated): these documents live in the workspace-GLOBAL _meta.db keyed by session id (globally
 * unique), NOT in the per-workspace record DBs where distillates/moments/drafts live. That matches how
 * every config document (flags/surfaces/modes/workflows) is stored — the to-do list is a document, not
 * a record — and session ids never collide, so the global key is unambiguous.
 */
export class TodoDocuments {
  constructor(private readonly store: WorkspaceRegistry) {}

  /** The stored to-do list for a session, or undefined if none exists yet. */
  get(sessionId: string): TodoList | undefined {
    return this.store.layouts.getLatest<TodoList>(TODO_KIND, sessionId)?.body
  }

  /** Every session's to-do list (latest version of each) — the HUD's enumeration read. */
  list(): TodoList[] {
    return this.store.layouts.latestOfKind<TodoList>(TODO_KIND).map((doc) => doc.body)
  }

  /**
   * Persist a to-do list, stamping `version` = latest stored version + 1 (LayoutStore keeps every
   * prior version — editable history). The body is validated against the contract before write (the
   * last line of defense, mirroring saveMoment/upsertEntity). Used by both the extractor's merge and
   * the PUT /todos route.
   */
  save(list: TodoList): TodoList {
    const current = this.store.layouts.getLatest<TodoList>(TODO_KIND, list.sessionId)
    const next: TodoList = { ...list, id: list.sessionId, version: (current?.body.version ?? 0) + 1 }
    if (!Value.Check(TodoListSchema, next)) {
      throw new Error(`to-do list failed contract validation: session ${list.sessionId}`)
    }
    this.store.layouts.put(TODO_KIND, list.sessionId, next)
    return next
  }

  /**
   * Merge freshly-extracted candidate items into a session's list, creating it if absent. Preserves
   * existing items (and their user edits/done flags); appends only non-duplicate candidates. Returns
   * the saved (version-bumped) document; when there are no new items and no existing doc, returns the
   * newly-created empty doc so a reader always finds a list once extraction has run for the session.
   */
  upsert(sessionId: string, workspaceId: string, candidates: readonly TodoItem[]): TodoList {
    const existing = this.get(sessionId)
    const items = mergeTodoItems(existing?.items ?? [], candidates)
    const list: TodoList = {
      id: sessionId,
      name: existing?.name ?? `to-do — session ${sessionId}`,
      version: existing?.version ?? 1,
      sessionId,
      workspaceId,
      items,
      ...(existing?.description !== undefined ? { description: existing.description } : {}),
    }
    return this.save(list)
  }
}

export interface TaskExtractorDeps {
  store: WorkspaceRegistry
  voice: VoiceDocuments
  fabric: FabricDocuments
  /** the prompt-template store (holds the task-extract template alongside the follow-up one). */
  templates: ActDocuments
  todos: TodoDocuments
  /** resolve the session's mode document (DistillDocuments owns modes); injectable for tests. */
  mode: (id: string) => import('@openinfo/contracts').Mode
  invoke?: LlmInvoke
  resolveKey?: SecretResolver
  runtimeManager?: LocalRuntimeManager
  guardDocs?: GuardDocuments
  guardHolds?: GuardHoldStore
  guardEnabled?: () => boolean
  publishHold?: (hold: GuardHold) => void | Promise<void>
  now?: () => Date
  newId?: () => string
  log?: (message: string) => void
}

/**
 * The task-extract act's orchestrator (Act v0's second node). Rides the DRAIN pass (see PHASE4-NOTES
 * for the drain-vs-session-end decision): after a drain's distill pass persists new distillates/moments,
 * it re-reads each affected session's ACCUMULATED distillates + moments, extracts follow-up items, and
 * MERGES them (deduped, provenance-stamped) into that session's to-do document — so the list grows
 * across the meeting. Store-backed + voice-resolving, a sibling of `Actor`. Best-effort: a throw is the
 * caller's to catch (the drain-act runner logs and continues; it never re-queues the distilled batch).
 */
export class TaskExtractor {
  private readonly store: WorkspaceRegistry
  private readonly voice: VoiceDocuments
  private readonly fabric: FabricDocuments
  private readonly templates: ActDocuments
  private readonly todos: TodoDocuments
  private readonly mode: (id: string) => import('@openinfo/contracts').Mode
  private readonly invoke: LlmInvoke
  private readonly resolveKey: SecretResolver | undefined
  private readonly guardDocs: GuardDocuments | undefined
  private readonly guardHolds: GuardHoldStore | undefined
  private readonly guardEnabled: () => boolean
  private readonly publishHold: ((hold: GuardHold) => void | Promise<void>) | undefined
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly log: (message: string) => void

  constructor(deps: TaskExtractorDeps) {
    this.store = deps.store
    this.voice = deps.voice
    this.fabric = deps.fabric
    this.templates = deps.templates
    this.todos = deps.todos
    this.mode = deps.mode
    this.resolveKey = deps.resolveKey
    this.guardDocs = deps.guardDocs
    this.guardHolds = deps.guardHolds
    this.guardEnabled = deps.guardEnabled ?? (() => false)
    this.publishHold = deps.publishHold
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => randomUUID())
    this.log = deps.log ?? (() => undefined)
    const resolveKey = deps.resolveKey
    const runtimeManager = deps.runtimeManager
    this.invoke =
      deps.invoke ??
      ((messages, opts) =>
        invokeLlm(this.fabric.load(), messages, {
          ...opts,
          ...(resolveKey ? { resolveKey } : {}),
          ...(runtimeManager ? { runtimeManager } : {}),
        }))
  }

  private guardOptions(): GuardOptions | undefined {
    if (!this.guardEnabled() || this.guardDocs === undefined) return undefined
    const policy = this.guardDocs.policy()
    return {
      endpoints: this.fabric.load().slots.guard ?? [],
      behavior: policy.behavior,
      acknowledgeUnguardedEgress: policy.acknowledgeUnguardedEgress,
      ...(this.resolveKey ? { resolveKey: this.resolveKey } : {}),
    }
  }

  private async recordHold(err: GuardHeldError, session: Session, sourceChunks: string[]): Promise<void> {
    const hold: GuardHold = {
      id: this.newId(),
      workspaceId: session.workspaceId,
      sessionId: session.id,
      stage: 'task-extract',
      ...(sourceChunks.length > 0 ? { sourceChunks } : {}),
      ...err.holdMetadata(),
      verdict: err.verdict,
      status: 'held',
      createdAt: this.now().toISOString(),
    }
    this.guardHolds?.add(hold)
    await this.publishHold?.(hold)
    this.log(`guard held task-extract for session ${session.id}: ${err.verdict.reason}`)
  }

  /**
   * Run task-extract for every session touched by a drained batch. Chunks carry their session +
   * workspace, so the affected (workspaceId, sessionId) pairs come straight off the batch — the
   * extractor never needs a live Session passed in. For each pair with a resolvable session and any
   * accumulated distillates/moments, it extracts + merges into the to-do document. `step.templateId`
   * selects the task-extract template (defaults to the shipped one).
   */
  async runOnDrain(chunks: readonly CaptureChunk[], step: WorkflowStep): Promise<void> {
    const pairs = new Map<string, { workspaceId: string; sessionId: string }>()
    for (const chunk of chunks) {
      pairs.set(`${chunk.workspaceId} ${chunk.sessionId}`, { workspaceId: chunk.workspaceId, sessionId: chunk.sessionId })
    }
    for (const { workspaceId, sessionId } of pairs.values()) {
      const session = this.store.getSession(workspaceId, sessionId)
      if (!session) {
        this.log(`task-extract: no session ${sessionId} in ${workspaceId} — skipping`)
        continue
      }
      await this.extractForSession(session, step)
    }
  }

  /** Extract + merge for ONE session (also the session-end path if a future workflow triggers it there). */
  async extractForSession(session: Session, step: WorkflowStep): Promise<TodoList | undefined> {
    const distillates = this.store.listDistillates(session.workspaceId, session.id)
    const moments = this.store.listMoments(session.workspaceId, session.id)
    if (distillates.length === 0 && moments.length === 0) return undefined

    const mode = this.mode(session.modeId)
    const dials = this.resolveDials(session, mode)
    const { template } = this.templates.taskExtractTemplate(step.templateId)
    const workspace = this.store.all().find((candidate) => candidate.id === session.workspaceId)
    const contentClass = effectiveActContentClass({ distillates, moments })
    const egress = resolveEgress({
      contentClass,
      promptNeverEgress: template.neverEgress,
      modeDenies: mode.egress?.deny,
      workspaceDenies: workspace?.egress?.deny,
    })
    const guard = this.guardOptions()
    let items: TodoItem[]
    try {
      ;({ items } = await composeTaskExtract(
        {
          sessionId: session.id,
          workspaceId: session.workspaceId,
          distillates,
          moments,
          dials,
          ...(distillates.length > 0 ? { provenanceDistillateId: distillates[distillates.length - 1]!.id } : {}),
          contentClass,
        },
        {
          invoke: this.invoke,
          template,
          now: this.now,
          newId: this.newId,
          log: this.log,
          invokeOptions: { egress, ...(guard !== undefined ? { guard } : {}) },
        },
      ))
    } catch (error) {
      if (error instanceof GuardHeldError) {
        await this.recordHold(error, session, [...new Set(distillates.flatMap((d) => d.sourceChunks))])
        return undefined
      }
      throw error
    }

    const saved = this.todos.upsert(session.id, session.workspaceId, items)
    this.log(`task-extract: session ${session.id} now has ${saved.items.length} to-do item(s) (+${items.length} extracted this pass)`)
    return saved
  }

  /** Resolve the session's effective dials, mirroring the Actor (session register wins over mode default). */
  private resolveDials(session: Session, mode = this.mode(session.modeId)): Dials {
    const registers = this.voice.registers()
    const storedBindings = this.voice.bindings()
    const modeDefault: VoiceBinding[] =
      mode.registerId !== undefined ? [{ scope: 'mode', targetId: mode.id, registerId: mode.registerId }] : []
    const sessionBinding: VoiceBinding[] =
      session.registerId !== undefined ? [{ scope: 'session', targetId: session.id, registerId: session.registerId }] : []
    const bindings = [...storedBindings, ...sessionBinding, ...modeDefault]
    return resolveVoice(registers, bindings, { sessionId: session.id, workspaceId: session.workspaceId, modeId: mode.id }).dials
  }
}
