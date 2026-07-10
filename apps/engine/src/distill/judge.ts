import type { CaptureChunk, Endpoint, Fabric, FieldValue, JudgeReview, PromptTemplate } from '@openinfo/contracts'
import { FabricDocuments, invokeLlm, type InvokeOptions, type LlmMessage, type LlmResult, type LocalRuntimeManager, type SecretResolver } from '../fabric/index.js'
import type { WorkspaceRegistry } from '../store/index.js'
import { interpolateTemplate } from '../voice/index.js'
import { DistillDocuments } from './documents.js'
import { FieldValueStore } from './field-values.js'
import { parseJsonCandidates } from './parse.js'
import { speakerLabel } from './transcribe.js'

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
  /** injectable for tests; defaults to invoking the judge-designated llm endpoint (a sub-fabric of one endpoint). */
  invoke?: LlmInvoke
  resolveKey?: SecretResolver
  runtimeManager?: LocalRuntimeManager
  /** the judge endpoint name; defaults to OPENINFO_JUDGE_ENDPOINT or JUDGE_ENDPOINT_NAME. */
  endpointName?: string
  now?: () => Date
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
  private readonly invoke: LlmInvoke
  private readonly endpointName: string
  private readonly now: () => Date
  private readonly log: (message: string) => void

  constructor(deps: JudgeSchedulerDeps) {
    this.store = deps.store
    this.fabric = deps.fabric
    this.docs = deps.docs
    this.values = deps.values
    this.publish = deps.publish
    this.endpointName = deps.endpointName ?? process.env['OPENINFO_JUDGE_ENDPOINT'] ?? JUDGE_ENDPOINT_NAME
    this.now = deps.now ?? (() => new Date())
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

    // The fast fieldIds a judge may review by default (every fast-tier field) — the fast-result set.
    const fastFieldIds = this.docs
      .fieldTemplates()
      .filter((t) => t.field?.tier === 'fast')
      .map((t) => t.field!.fieldId)

    const produced: FieldValue[] = []
    for (const [sessionId, sessionChunks] of groupBySession(text)) {
      const workspaceId = sessionChunks[0]!.workspaceId
      // The SAME source shape the fast tier saw: speaker-labeled recent transcript window, tail-capped.
      const full = sessionChunks
        .map((chunk) => {
          const label = speakerLabel(chunk.source)
          return label ? `${label}: ${chunk.data}` : chunk.data
        })
        .join('\n')
      const source = full.length > JUDGE_CONTEXT_CHARS ? full.slice(-JUDGE_CONTEXT_CHARS) : full
      const { windowStart, windowEnd } = this.windowSpan(sessionChunks)
      const sessionValues = this.values.list(workspaceId, sessionId)

      for (const judge of judges) {
        const overruled = await this.runOne(judge, {
          workspaceId,
          sessionId,
          source,
          windowStart,
          windowEnd,
          sessionValues,
          fastFieldIds,
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
    let result: LlmResult
    try {
      result = await this.invoke([{ role: 'user', content: prompt }], { maxTokens: JUDGE_MAX_TOKENS })
    } catch (error) {
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
