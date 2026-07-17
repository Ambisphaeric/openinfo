import { randomUUID } from 'node:crypto'
import type { CaptureChunk, Endpoint, Fabric, FieldValue, GuardHold, JudgeReview, Mode, PromptTemplate, Session, SessionAnnotation, SessionTitling } from '@openinfo/contracts'
import { SESSION_ANNOTATION_SCHEMA_VERSION, SESSION_TITLING_SCHEMA_VERSION } from '@openinfo/contracts'
import { deriveEpisodeTitle } from './episode-title.js'
import { FabricDocuments, GuardHeldError, invokeLlm, resolveEgress, type GuardOptions, type InvokeOptions, type LlmMessage, type LlmResult, type LocalRuntimeManager, type SecretResolver } from '../fabric/index.js'
import type { GuardDocuments, GuardHoldStore } from '../guard/index.js'
import type { WorkspaceRegistry } from '../store/index.js'
import { interpolateTemplate } from '../voice/index.js'
import { DistillDocuments } from './documents.js'
import { FieldValueStore } from './field-values.js'
import { parseJsonCandidates } from './parse.js'
import { captureLaneLabel } from './transcribe.js'

/** Injected llm caller (mirrors fields.LlmInvoke) — a fake in tests, the judge endpoint in prod. */
export type LlmInvoke = (messages: LlmMessage[], opts: InvokeOptions) => Promise<LlmResult>

/**
 * The fabric endpoint name that DESIGNATES the judge lane (#62). The judge runs a LARGER model at a
 * LOWER cadence than the fast fields, so it needs a distinct endpoint from the fast one — named by the
 * `llm.<tier>` convention the mode's `use: 'llm.fast'` already established. Tier-gating is honest and
 * explicit: only an `llm` endpoint carrying this name is treated as judge-capable; with none configured
 * the judge never schedules and fields stay provisional. `OPENINFO_JUDGE_ENDPOINT` overrides the name.
 */
export const JUDGE_ENDPOINT_NAME = 'llm.judge'

/**
 * The judge sees a LARGER source window than a fast field (it reviews a lower-cadence batch), so its
 * transcript tail cap is wider. Still bounded so a big flushed backlog cannot blow the context budget.
 */
const JUDGE_CONTEXT_CHARS = 8000

/** Default judge maxTokens — a review of several fields with corrections needs more room than a fast field. */
const JUDGE_MAX_TOKENS = 600

/** LayoutStore kind for the per-session orientation annotation (#131) — a config-shaped doc, like field-value. */
const SESSION_ANNOTATION_KIND = 'session-annotation'

/** Engine cap on the topic taxonomy — the model never controls counts (#131); a long list is truncated, never trusted. */
const MAX_ORIENTATION_TOPICS = 5

/**
 * How the orientation classification is APPLIED to the pipeline (#131) — the gate-ready seam. Production
 * (classify the source) is decoupled from APPLICATION (this switch), funneled through the single
 * `applyAnnotation` method:
 *   - `annotate` (default, shipped): persist the SessionAnnotation + emit `orientation.updated`; the
 *     pipeline's records are NOT held — the classification rides alongside them (annotate-and-correct).
 *   - `gate` (future config flip, NOT enforced yet): the SAME classification would HOLD downstream writes
 *     until a session is classified. The seam is that only this application step changes — production,
 *     the record shape, and the event are all unchanged — so flipping requires no re-architecture. Today
 *     the `gate` branch annotates + logs that the hold is not yet enforced (honest: no half-built gate).
 * See PHASE4-NOTES for the full seam note.
 */
export type OrientationDisposition = 'annotate' | 'gate'

/** The verdicts a judge may return — the dual-input review outcomes (#62). */
type Verdict = 'confirm' | 'correct' | 'flag'
const VERDICTS: readonly Verdict[] = ['confirm', 'correct', 'flag']

/** The field state each verdict moves a value to (the #66 micro-state the dot renders). */
const STATE_FOR: Record<Verdict, string> = { confirm: 'confirmed', correct: 'corrected', flag: 'flagged' }

/** ONE parsed per-field verdict from the judge's JSON output. */
interface FieldVerdict {
  fieldId: string
  verdict: Verdict
  value?: string
  note?: string
}

/** Same capture-chunk text hygiene the fast fan-out and the distiller enforce (utf8 text, no frames/JSON/focus). */
const isText = (chunk: CaptureChunk): boolean =>
  chunk.encoding === 'utf8' && chunk.source !== 'focus' && chunk.contentType !== 'application/json'

const groupBySession = (chunks: readonly CaptureChunk[]): Map<string, CaptureChunk[]> => {
  const groups = new Map<string, CaptureChunk[]>()
  for (const chunk of chunks) {
    const bucket = groups.get(chunk.sessionId) ?? []
    bucket.push(chunk)
    groups.set(chunk.sessionId, bucket)
  }
  return groups
}

export interface JudgeSchedulerDeps {
  store: WorkspaceRegistry
  fabric: FabricDocuments
  docs: DistillDocuments
  values: FieldValueStore
  /** publish the overruled field value (field.updated) so the transition reaches WS clients; optional in tests. */
  publish?: (value: FieldValue) => void | Promise<void>
  /** publish the orientation annotation (orientation.updated) so the classification reaches WS clients (#131); optional in tests. */
  publishAnnotation?: (annotation: SessionAnnotation) => void | Promise<void>
  /** publish the session with its materialised episode title (session.titled) when a derived title lands (#211); optional in tests. */
  publishTitled?: (session: Session) => void | Promise<void>
  /** how the orientation classification is applied — the gate-ready seam (#131). Defaults to 'annotate'. */
  orientationDisposition?: OrientationDisposition
  /** injectable for tests; defaults to invoking the judge-designated llm endpoint (a sub-fabric of one endpoint). */
  invoke?: LlmInvoke
  resolveKey?: SecretResolver
  runtimeManager?: LocalRuntimeManager
  /** Guard policy + held-hop audit wiring (#206). All remain optional for isolated/legacy embedders. */
  guardDocs?: GuardDocuments
  guardHolds?: GuardHoldStore
  guardEnabled?: () => boolean
  publishHold?: (hold: GuardHold) => void | Promise<void>
  /** the judge endpoint name; defaults to OPENINFO_JUDGE_ENDPOINT or JUDGE_ENDPOINT_NAME. */
  endpointName?: string
  now?: () => Date
  /** id minter for the per-pass correlation id (#116); injected only for deterministic tests. */
  newId?: () => string
  log?: (message: string) => void
}

/**
 * The judge stage (#62) — the dual-input review pass that lifts fast fields off `provisional`. On a
 * lower-cadence batch (wired through its own cadence gate, decoupled from the fast fan-out), it reads
 * every judge prompt document (`docs.judgeTemplates()`), and for each one judges the fast-result set it
 * `reviews` AGAINST the SAME source the fast tier saw (the recent transcript window) — the standardized
 * `{source, results}` template contract. The judge returns a per-field verdict:
 *   - confirm → the value stands (state → `confirmed`)
 *   - correct → the value is OVERRULED in place (state → `corrected`, new value from the judge)
 *   - flag    → the value is questionable / a topic shift or missed implication (state → `flagged`)
 * Each overrule persists a NEW version of the SAME FieldValue (deterministic id, so it replaces the
 * latest in place) stamped with the JudgeReview provenance — which judge template, which endpoint/model,
 * the verdict, and (on a correct) the overruled priorValue — then republishes `field.updated` so the
 * #66 dot re-renders. Nothing is fabricated: a verdict for an unknown field, or a `correct` with no
 * replacement value, is skipped-with-log, never invented.
 *
 * TIER-GATED on fabric contents: with no judge-designated endpoint (`llm.judge`) the pass is a logged
 * no-op and the fields simply stay provisional — degradation, not failure. A judge invoke failure is
 * caught per judge document so one model error never sinks the batch or the other judges.
 */
export class JudgeScheduler {
  private readonly store: WorkspaceRegistry
  private readonly fabric: FabricDocuments
  private readonly docs: DistillDocuments
  private readonly values: FieldValueStore
  private readonly publish: ((v: FieldValue) => void | Promise<void>) | undefined
  private readonly publishAnnotation: ((a: SessionAnnotation) => void | Promise<void>) | undefined
  private readonly publishTitled: ((s: Session) => void | Promise<void>) | undefined
  private readonly orientationDisposition: OrientationDisposition
  private readonly invoke: LlmInvoke
  private readonly resolveKey: SecretResolver | undefined
  private readonly guardDocs: GuardDocuments | undefined
  private readonly guardHolds: GuardHoldStore | undefined
  private readonly guardEnabled: () => boolean
  private readonly publishHold: ((hold: GuardHold) => void | Promise<void>) | undefined
  private readonly endpointName: string
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly log: (message: string) => void

  constructor(deps: JudgeSchedulerDeps) {
    this.store = deps.store
    this.fabric = deps.fabric
    this.docs = deps.docs
    this.values = deps.values
    this.publish = deps.publish
    this.publishAnnotation = deps.publishAnnotation
    this.publishTitled = deps.publishTitled
    this.orientationDisposition = deps.orientationDisposition ?? 'annotate'
    this.resolveKey = deps.resolveKey
    this.guardDocs = deps.guardDocs
    this.guardHolds = deps.guardHolds
    this.guardEnabled = deps.guardEnabled ?? (() => false)
    this.publishHold = deps.publishHold
    this.endpointName = deps.endpointName ?? process.env['OPENINFO_JUDGE_ENDPOINT'] ?? JUDGE_ENDPOINT_NAME
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => randomUUID())
    this.log = deps.log ?? (() => undefined)
    const resolveKey = deps.resolveKey
    const runtimeManager = deps.runtimeManager
    this.invoke =
      deps.invoke ??
      ((messages, opts) => {
        // Route to the JUDGE endpoint specifically — a sub-fabric of exactly the judge-designated llm
        // endpoint, so invokeLlm's fallback order can never spill the judge onto the fast endpoint.
        const fabric = this.fabric.load()
        const endpoint = this.judgeEndpoint(fabric)
        if (endpoint === undefined) throw new Error('no judge endpoint configured (llm.judge)')
        const judgeFabric: Fabric = { ...fabric, slots: { ...fabric.slots, llm: [endpoint] } }
        return invokeLlm(judgeFabric, messages, {
          ...opts,
          ...(resolveKey ? { resolveKey } : {}),
          ...(runtimeManager ? { runtimeManager } : {}),
        })
      })
  }

  /** Resolve the live #63 policy for an allowed hosted/public judge call. Local answers ignore it. */
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

  /** A strict/fail-closed stop emits no review/annotation, so preserve its metadata-only verdict instead. */
  private async recordHold(
    err: GuardHeldError,
    ctx: { workspaceId: string; sessionId: string; spanId: string; sourceChunks: string[]; stage: string },
  ): Promise<void> {
    const hold: GuardHold = {
      id: this.newId(),
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId,
      stage: ctx.stage,
      spanId: ctx.spanId,
      sourceChunks: ctx.sourceChunks,
      ...err.holdMetadata(),
      verdict: err.verdict,
      status: 'held',
      createdAt: this.now().toISOString(),
    }
    this.guardHolds?.add(hold)
    await this.publishHold?.(hold)
    this.log(`guard held judge pass for session ${ctx.sessionId}: ${err.verdict.reason}`)
  }

  /** The judge-designated llm endpoint in the fabric, or undefined — the tier-gate primitive. */
  private judgeEndpoint(fabric: Fabric): Endpoint | undefined {
    return fabric.slots.llm.find((e) => e.name === this.endpointName)
  }

  /** True when a judge-capable endpoint is configured — the honest gate the wiring reads before scheduling. */
  hasJudgeEndpoint(): boolean {
    return this.judgeEndpoint(this.fabric.load()) !== undefined
  }

  /**
   * Review the fast-field result set for every session with material in this batch. Returns every
   * FieldValue the judge overruled (persisted + published). Explainable-empty — [] — when there is no
   * judge document, no judge endpoint (logged degradation), no text, or nothing to review; never an error.
   *
   * A judge document whose binding `produces: 'orientation'` (#131) is routed to the orientation path
   * instead: it classifies the session and lands a SessionAnnotation (persisted + `orientation.updated`),
   * which is NOT part of the returned FieldValue set — read it via `latestAnnotation`.
   */
  async runJudge(chunks: readonly CaptureChunk[]): Promise<FieldValue[]> {
    const judges = this.docs.judgeTemplates()
    if (judges.length === 0) return []
    // Tier-gate: no judge-capable endpoint ⇒ the fields stay provisional. Honest + visible, not an error.
    if (!this.hasJudgeEndpoint()) {
      this.log(`judge skipped: no judge endpoint "${this.endpointName}" in the fabric — fields stay provisional (tier-gated)`)
      return []
    }
    const text = chunks.filter(isText)
    if (text.length === 0) return []
    const defaultMode: Mode = this.docs.mode()

    // The fast fieldIds a judge may review by default (every fast-tier field) — the fast-result set.
    const fastFieldIds = this.docs
      .fieldTemplates()
      .filter((t) => t.field?.tier === 'fast')
      .map((t) => t.field!.fieldId)

    const produced: FieldValue[] = []
    for (const [sessionId, sessionChunks] of groupBySession(text)) {
      const workspaceId = sessionChunks[0]!.workspaceId
      const record = this.store.getSession(workspaceId, sessionId)
      const mode = record ? this.docs.mode(record.modeId) : defaultMode
      const workspaceDenies = this.store.all().find((w) => w.id === workspaceId)?.egress?.deny
      // #116: ONE correlation id per (session, batch) judge pass — every review it stamps shares it.
      const spanId = this.newId()
      // The SAME source shape the fast tier saw: physical-lane-labeled recent transcript window, tail-capped.
      const renderedChunks = sessionChunks.map((chunk) => {
          const label = captureLaneLabel(chunk.source)
          return { chunk, text: label ? `${label}: ${chunk.data}` : chunk.data }
        })
      const full = renderedChunks.map((rendered) => rendered.text).join('\n')
      const source = full.length > JUDGE_CONTEXT_CHARS ? full.slice(-JUDGE_CONTEXT_CHARS) : full
      const tailStart = Math.max(0, full.length - JUDGE_CONTEXT_CHARS)
      let cursor = 0
      const contributingChunks: CaptureChunk[] = []
      for (const rendered of renderedChunks) {
        const end = cursor + rendered.text.length
        if (end > tailStart) contributingChunks.push(rendered.chunk)
        cursor = end + 1
      }
      const materialChunks = contributingChunks.length > 0 ? contributingChunks : sessionChunks.slice(-1)
      const { windowStart, windowEnd } = this.windowSpan(materialChunks)
      const sessionValues = this.values.list(workspaceId, sessionId)
      const sourceChunks = materialChunks.map((chunk) => chunk.id)

      for (const judge of judges) {
        // #131: an orientation judge document classifies the session (nature/direction/topics) and lands a
        // SessionAnnotation — a DIFFERENT output than the #62 per-field verdict path. Routed by `produces`.
        if (judge.field?.produces === 'orientation') {
          await this.runOrientation(judge, {
            workspaceId,
            sessionId,
            source,
            windowStart,
            windowEnd,
            spanId,
            sourceChunks,
            ...(mode.egress?.deny !== undefined ? { modeDenies: mode.egress.deny } : {}),
            ...(workspaceDenies !== undefined ? { workspaceDenies } : {}),
          })
          continue
        }
        const overruled = await this.runOne(judge, {
          workspaceId,
          sessionId,
          source,
          windowStart,
          windowEnd,
          sessionValues,
          fastFieldIds,
          spanId,
          sourceChunks,
          ...(mode.egress?.deny !== undefined ? { modeDenies: mode.egress.deny } : {}),
          ...(workspaceDenies !== undefined ? { workspaceDenies } : {}),
        })
        produced.push(...overruled)
      }
    }
    if (produced.length > 0) this.log(`judge: ${produced.length} field(s) reviewed/overruled`)
    return produced
  }

  /** Run one judge document over its reviewed field set; return the overruled FieldValues. */
  private async runOne(
    template: PromptTemplate,
    ctx: {
      workspaceId: string
      sessionId: string
      source: string
      windowStart: string
      windowEnd: string
      sessionValues: FieldValue[]
      fastFieldIds: string[]
      spanId: string
      sourceChunks: string[]
      modeDenies?: boolean
      workspaceDenies?: boolean
    },
  ): Promise<FieldValue[]> {
    const binding = template.field!
    const reviewedIds = binding.reviews ?? ctx.fastFieldIds
    const results = ctx.sessionValues.filter((v) => reviewedIds.includes(v.fieldId))
    if (results.length === 0) {
      this.log(`judge ${template.id} skipped: nothing to review in session ${ctx.sessionId}`)
      return []
    }
    const prompt = interpolateTemplate(template.body, {
      source: ctx.source,
      results: this.renderResults(results),
      windowStart: ctx.windowStart,
      windowEnd: ctx.windowEnd,
    })
    const egress = resolveEgress({
      contentClass: 'transcript',
      promptNeverEgress: template.neverEgress,
      modeDenies: ctx.modeDenies,
      workspaceDenies: ctx.workspaceDenies,
    })
    const guard = this.guardOptions()
    let result: LlmResult
    try {
      result = await this.invoke([{ role: 'user', content: prompt }], {
        maxTokens: JUDGE_MAX_TOKENS,
        egress,
        ...(guard !== undefined ? { guard } : {}),
      })
    } catch (error) {
      if (error instanceof GuardHeldError) {
        await this.recordHold(error, { ...ctx, stage: `judge:${template.id}` })
        return []
      }
      this.log(`judge ${template.id} failed: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
    const byId = new Map(results.map((v) => [v.fieldId, v]))
    const judgedAt = this.now().toISOString()
    const overruled: FieldValue[] = []
    for (const verdict of this.parseVerdicts(result.text)) {
      const current = byId.get(verdict.fieldId)
      if (current === undefined) {
        this.log(`judge ${template.id}: verdict for unreviewed field "${verdict.fieldId}" ignored`)
        continue
      }
      const review: JudgeReview = {
        templateId: template.id,
        endpoint: result.endpoint,
        ...(result.model !== undefined ? { model: result.model } : {}),
        verdict: verdict.verdict,
        priorState: current.state,
        judgedAt,
        // #116: the judge pass's correlation id; #65: the judge invoke's token accounting when recorded.
        spanId: ctx.spanId,
        windowStart: ctx.windowStart,
        windowEnd: ctx.windowEnd,
        sourceChunks: ctx.sourceChunks,
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
        // #206: completed-invoke privacy truth from the endpoint that actually answered.
        ...(result.egress !== undefined ? { egress: result.egress } : {}),
        ...(result.guard !== undefined ? { guard: result.guard } : {}),
      }
      let value = current.value
      if (verdict.verdict === 'correct') {
        const fixed = verdict.value?.trim()
        if (fixed === undefined || fixed === '') {
          // A "correct" with no replacement value cannot be applied without fabricating one — skip honestly.
          this.log(`judge ${template.id}: "correct" for "${verdict.fieldId}" carried no value — left unchanged`)
          continue
        }
        review.priorValue = current.value
        value = fixed
      }
      if (verdict.note !== undefined && verdict.note.trim() !== '') review.note = verdict.note.trim()
      const next: FieldValue = {
        ...current,
        value,
        state: STATE_FOR[verdict.verdict],
        provenance: { ...current.provenance, judge: review },
        updatedAt: judgedAt,
      }
      this.values.put(next)
      await this.publish?.(next)
      overruled.push(next)
    }
    return overruled
  }

  /**
   * Run one ORIENTATION judge document (#131) over a session's source window: classify the session's
   * nature/direction/topics, stamp a SessionAnnotation (engine owns ids/session/provenance/timestamps; the
   * model controls only the classification text — never ids or counts), then APPLY it through the gate-ready
   * seam. Honest degradation: an invoke failure or an unparseable response is skipped-with-log — no
   * fabricated classification, and any earlier annotation is left in place (annotate-and-correct).
   */
  private async runOrientation(
    template: PromptTemplate,
    ctx: {
      workspaceId: string
      sessionId: string
      source: string
      windowStart: string
      windowEnd: string
      spanId: string
      sourceChunks: string[]
      modeDenies?: boolean
      workspaceDenies?: boolean
    },
  ): Promise<SessionAnnotation | undefined> {
    // Orientation is a SINGLE-input classification: it takes only {{source}} (the same window the tiers saw)
    // plus the window bounds — no {{results}} set (that is the #62 verdict contract, not this one).
    const prompt = interpolateTemplate(template.body, {
      source: ctx.source,
      windowStart: ctx.windowStart,
      windowEnd: ctx.windowEnd,
    })
    const egress = resolveEgress({
      contentClass: 'transcript',
      promptNeverEgress: template.neverEgress,
      modeDenies: ctx.modeDenies,
      workspaceDenies: ctx.workspaceDenies,
    })
    const guard = this.guardOptions()
    let result: LlmResult
    try {
      result = await this.invoke([{ role: 'user', content: prompt }], {
        maxTokens: JUDGE_MAX_TOKENS,
        egress,
        ...(guard !== undefined ? { guard } : {}),
      })
    } catch (error) {
      if (error instanceof GuardHeldError) {
        await this.recordHold(error, { ...ctx, stage: `orientation:${template.id}` })
        return undefined
      }
      this.log(`orientation ${template.id} failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
    const parsed = this.parseOrientation(result.text)
    if (parsed === undefined) {
      this.log(`orientation ${template.id}: no parseable classification in session ${ctx.sessionId} — left unchanged`)
      return undefined
    }
    const classifiedAt = this.now().toISOString()
    // Engine STAMPS everything but the classification text (the model output is never trusted for ids/counts).
    // The id is deterministic per session ⇒ annotate-and-correct: a later pass persists a new version in place.
    const annotation: SessionAnnotation = {
      id: JudgeScheduler.annotationId(ctx.workspaceId, ctx.sessionId),
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId,
      nature: parsed.nature,
      direction: parsed.direction,
      topics: parsed.topics,
      provenance: {
        templateId: template.id,
        endpoint: result.endpoint,
        ...(result.model !== undefined ? { model: result.model } : {}),
        windowStart: ctx.windowStart,
        windowEnd: ctx.windowEnd,
        sourceChunks: ctx.sourceChunks,
        classifiedAt,
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
        ...(result.egress !== undefined ? { egress: result.egress } : {}),
        ...(result.guard !== undefined ? { guard: result.guard } : {}),
      },
      updatedAt: classifiedAt,
      schemaVersion: SESSION_ANNOTATION_SCHEMA_VERSION,
    }
    return this.applyAnnotation(annotation)
  }

  /**
   * Apply an orientation classification — the GATE-READY SEAM (#131). Production (classify) is already done;
   * this is the SINGLE point that decides what to DO with the reading, switched on `orientationDisposition`.
   * Flipping annotate→gate later changes ONLY this method (plus the drain's hold/release) — production, the
   * SessionAnnotation shape, and the `orientation.updated` event are all untouched, so no re-architecture is
   * needed. See PHASE4-NOTES. Returns the applied annotation.
   */
  private async applyAnnotation(annotation: SessionAnnotation): Promise<SessionAnnotation> {
    if (this.orientationDisposition === 'gate') {
      // FUTURE FLIP: hold the session's pending records until it is classified, then release. NOT enforced
      // yet — we annotate honestly so there is no half-built gate. The hold/release lands here + in the drain.
      this.log(`orientation: 'gate' disposition set but not yet enforced — annotating session ${annotation.sessionId}`)
    }
    this.store.layouts.put<SessionAnnotation>(SESSION_ANNOTATION_KIND, annotation.id, annotation)
    await this.publishAnnotation?.(annotation)
    this.log(`orientation: session ${annotation.sessionId} → ${annotation.nature}/${annotation.direction} (${annotation.topics.length} topic(s))`)
    await this.deriveTitle(annotation)
    return annotation
  }

  /**
   * Derive an episode title from the orientation classification and APPEND it (#211). The model output
   * (the annotation) is the PROPOSAL; the title is a deterministic transform of it (`deriveEpisodeTitle`),
   * so no second invoke is spent and nothing is fabricated. APPEND-ONLY + deduped: a new derived titling is
   * appended ONLY when the derived name CHANGES (a re-derivation with the same name is a no-op — otherwise
   * every judge pass would spam an identical row). A too-thin classification yields no title (honest — the
   * session keeps its start-time fallback). A user rename is never touched here: the store's resolution
   * keeps a `user` titling sovereign over any `derived` one. Best-effort: never sinks the orientation pass.
   */
  private async deriveTitle(annotation: SessionAnnotation): Promise<void> {
    const title = deriveEpisodeTitle(annotation)
    if (title === undefined) return
    if (this.store.latestDerivedTitle(annotation.workspaceId, annotation.sessionId) === title) return
    const titling: SessionTitling = {
      id: `ot:${annotation.workspaceId}:${annotation.sessionId}:${this.newId()}`,
      workspaceId: annotation.workspaceId,
      sessionId: annotation.sessionId,
      title,
      source: 'derived',
      provenance: {
        annotationId: annotation.id,
        templateId: annotation.provenance.templateId,
        endpoint: annotation.provenance.endpoint,
        ...(annotation.provenance.model !== undefined ? { model: annotation.provenance.model } : {}),
        classifiedAt: annotation.provenance.classifiedAt,
        nature: annotation.nature,
        direction: annotation.direction,
        topics: annotation.topics,
      },
      createdAt: this.now().toISOString(),
      schemaVersion: SESSION_TITLING_SCHEMA_VERSION,
    }
    const updated = this.store.recordSessionTitling(titling)
    this.log(`orientation: session ${annotation.sessionId} titled "${title}" (derived)`)
    if (updated !== undefined) await this.publishTitled?.(updated)
  }

  /** The deterministic annotation-document id for a session (#131) — the id IS the SessionAnnotation.id. */
  static annotationId(workspaceId: string, sessionId: string): string {
    return `oa:${workspaceId}:${sessionId}`
  }

  /** The current orientation annotation for a session (latest version), or undefined if never classified (#131). */
  latestAnnotation(workspaceId: string, sessionId: string): SessionAnnotation | undefined {
    return this.store.layouts.getLatest<SessionAnnotation>(SESSION_ANNOTATION_KIND, JudgeScheduler.annotationId(workspaceId, sessionId))?.body
  }

  /**
   * Parse the orientation model output into a well-formed classification (#131); defensive, never throws.
   * Takes the first object-shaped candidate; a blank/absent nature or direction defaults to the honest
   * "unclear" (never an invented value), and topics are trimmed, de-blanked, and engine-capped (never
   * count-inflated). Returns undefined only when nothing object-shaped could be recovered at all.
   */
  private parseOrientation(raw: string): { nature: string; direction: string; topics: string[] } | undefined {
    const { candidates } = parseJsonCandidates(raw)
    const obj = candidates.find((c): c is Record<string, unknown> => c !== null && typeof c === 'object' && !Array.isArray(c))
    if (obj === undefined) return undefined
    const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback)
    const rawTopics = Array.isArray(obj['topics']) ? obj['topics'] : []
    const topics = rawTopics
      .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
      .map((t) => t.trim())
      .slice(0, MAX_ORIENTATION_TOPICS)
    return { nature: str(obj['nature'], 'unclear'), direction: str(obj['direction'], 'unclear'), topics }
  }

  /** Render the fast-result set into the `{{results}}` block the judge reviews — labeled, fieldId-keyed. */
  private renderResults(values: readonly FieldValue[]): string {
    return values
      .map((v) => `- fieldId: ${v.fieldId}\n  label: ${v.label}\n  state: ${v.state}\n  value: ${v.value}`)
      .join('\n')
  }

  /** Parse the judge's JSON output into well-formed per-field verdicts (defensive; never throws). */
  private parseVerdicts(raw: string): FieldVerdict[] {
    const { candidates } = parseJsonCandidates(raw, 'verdicts')
    const out: FieldVerdict[] = []
    for (const candidate of candidates) {
      if (candidate === null || typeof candidate !== 'object') continue
      const c = candidate as Record<string, unknown>
      const fieldId = c['fieldId']
      const verdict = c['verdict']
      if (typeof fieldId !== 'string' || fieldId === '') continue
      if (typeof verdict !== 'string' || !VERDICTS.includes(verdict as Verdict)) continue
      const parsed: FieldVerdict = { fieldId, verdict: verdict as Verdict }
      if (typeof c['value'] === 'string') parsed.value = c['value'] as string
      if (typeof c['note'] === 'string') parsed.note = c['note'] as string
      out.push(parsed)
    }
    return out
  }

  /** The capturedAt span (min→max) of a session's window — the judge's source window bounds. */
  private windowSpan(chunks: readonly CaptureChunk[]): { windowStart: string; windowEnd: string } {
    let start = chunks[0]!.capturedAt
    let end = chunks[0]!.capturedAt
    for (const chunk of chunks) {
      if (chunk.capturedAt < start) start = chunk.capturedAt
      if (chunk.capturedAt > end) end = chunk.capturedAt
    }
    return { windowStart: start, windowEnd: end }
  }
}
