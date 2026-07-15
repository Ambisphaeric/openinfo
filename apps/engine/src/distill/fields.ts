import { randomUUID } from 'node:crypto'
import type { CaptureChunk, FieldValue, GuardHold, Mode, PromptTemplate, VoiceBinding } from '@openinfo/contracts'
import { FIELD_VALUE_SCHEMA_VERSION } from '@openinfo/contracts'
import { FabricDocuments, GuardHeldError, invokeLlm, resolveEgress, type GuardOptions, type InvokeOptions, type LlmMessage, type LlmResult, type LocalRuntimeManager, type SecretResolver } from '../fabric/index.js'
import type { GuardDocuments, GuardHoldStore } from '../guard/index.js'
import type { WorkspaceRegistry } from '../store/index.js'
import { VoiceDocuments, compileVoiceVars, interpolateTemplate, resolveVoice } from '../voice/index.js'
import { DistillDocuments } from './documents.js'
import { FieldValueStore } from './field-values.js'
import { captureLaneLabel } from './transcribe.js'

/** Injected llm caller (mirrors distiller.LlmInvoke) — a fake in tests, the fabric llm slot in prod. */
export type LlmInvoke = (messages: LlmMessage[], opts: InvokeOptions) => Promise<LlmResult>

/**
 * How much recent transcript a fast field sees. Fast fields run per accumulation window (~15s of
 * material, the distill cadence), so the whole released batch is normally well under this — the tail cap
 * only bounds a large flushed backlog. v0 uses ONE shared recent-material window per session, gated
 * per-field by `trigger.minChars`; bespoke per-field windows are deferred (disclosed in PHASE4-NOTES).
 */
const CONTEXT_CHARS = 4000

/**
 * ONLY utf8 TEXT chunks feed a field (screen/base64 frames and focus context are excluded) — the SAME
 * hygiene the distiller enforces (distiller.ts::isText), replicated here so the fan-out never sees a
 * transcript it should not. By the time the scheduler runs, audio has already been transcribed to utf8
 * text upstream (the transcribe drain stage), exactly as for the distill pass.
 */
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

export interface FastFieldSchedulerDeps {
  store: WorkspaceRegistry
  voice: VoiceDocuments
  fabric: FabricDocuments
  docs: DistillDocuments
  values: FieldValueStore
  /** publish field.updated so it reaches WS clients; optional (tests may omit). */
  publish?: (value: FieldValue) => void | Promise<void>
  /** injectable for tests; defaults to invoking the fabric llm slot. */
  invoke?: LlmInvoke
  /** resolve an endpoint's auth.keyRef at invoke time (bearer injection); optional. */
  resolveKey?: SecretResolver
  /** manages `local` endpoints' spawned runtimes (tier zero); optional. */
  runtimeManager?: LocalRuntimeManager
  /** Guard policy + held-hop audit wiring (#206). All remain optional for isolated/legacy embedders. */
  guardDocs?: GuardDocuments
  guardHolds?: GuardHoldStore
  guardEnabled?: () => boolean
  publishHold?: (hold: GuardHold) => void | Promise<void>
  now?: () => Date
  /** id minter for the per-pass correlation id (#116); injected only for deterministic tests. */
  newId?: () => string
  log?: (message: string) => void
}

/**
 * The fast-field fan-out scheduler (#61) — the substrate that grows surface fields from prompt
 * documents. On newly transcribed material (the SAME accumulation seam the distill cadence releases to
 * the distiller), it reads every fast-field prompt document, applies the inexpensive per-field relevance
 * gate (`trigger.minChars`), and runs the TRIGGERED bindings CONCURRENTLY against the llm slot
 * (`Promise.all` — the fabric llm lanes support concurrent requests). Each result is ephemeral-then-
 * durable: it publishes `field.updated` immediately (mirroring the #58 transcript.updated pattern) AND
 * persists the field's latest value (FieldValueStore). Results are `provisional` by definition (#66) —
 * the judge that confirms them is a later issue. A per-field invoke failure is caught and logged: no
 * `field.updated`, no persisted value, NO fabricated result — one field's model error never sinks the
 * batch or the other fields.
 *
 * This EXTENDS the distill pass (it does not replace it): the distiller still produces the monolithic
 * distillate/moments/entities; the scheduler adds per-field cadence + per-field prompts on top.
 */
export class FastFieldScheduler {
  private readonly store: WorkspaceRegistry
  private readonly voice: VoiceDocuments
  private readonly fabric: FabricDocuments
  private readonly docs: DistillDocuments
  private readonly values: FieldValueStore
  private readonly publish: ((v: FieldValue) => void | Promise<void>) | undefined
  private readonly invoke: LlmInvoke
  private readonly resolveKey: SecretResolver | undefined
  private readonly guardDocs: GuardDocuments | undefined
  private readonly guardHolds: GuardHoldStore | undefined
  private readonly guardEnabled: () => boolean
  private readonly publishHold: ((hold: GuardHold) => void | Promise<void>) | undefined
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly log: (message: string) => void

  constructor(deps: FastFieldSchedulerDeps) {
    this.store = deps.store
    this.voice = deps.voice
    this.fabric = deps.fabric
    this.docs = deps.docs
    this.values = deps.values
    this.publish = deps.publish
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

  /** Resolve the live #63 policy for an allowed hosted/public call. Local answers ignore this downstream. */
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

  /** A strict/fail-closed guard stop produces no FieldValue, so persist its metadata-only audit record. */
  private async recordHold(
    err: GuardHeldError,
    ctx: { workspaceId: string; sessionId: string; spanId: string; sourceChunks: string[]; fieldId: string },
  ): Promise<void> {
    const hold: GuardHold = {
      id: this.newId(),
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId,
      stage: `field:${ctx.fieldId}`,
      spanId: ctx.spanId,
      sourceChunks: ctx.sourceChunks,
      ...err.holdMetadata(),
      verdict: err.verdict,
      status: 'held',
      createdAt: this.now().toISOString(),
    }
    this.guardHolds?.add(hold)
    await this.publishHold?.(hold)
    this.log(`guard held fast-field pass for session ${ctx.sessionId}: ${err.verdict.reason}`)
  }

  /**
   * Fan out the fast fields over a batch of (already-transcribed) capture chunks. Returns every FieldValue
   * produced this pass (persisted + published). Empty when there is no text, no field document, or nothing
   * cleared its relevance gate — explainable-empty, never an error.
   */
  async runFields(chunks: readonly CaptureChunk[]): Promise<FieldValue[]> {
    const text = chunks.filter(isText)
    if (text.length === 0) return []
    const fields = this.docs.fieldTemplates()
    if (fields.length === 0) return []

    const defaultMode: Mode = this.docs.mode()
    const registers = this.voice.registers()
    const storedBindings = this.voice.bindings()
    const produced: FieldValue[] = []

    for (const [sessionId, sessionChunks] of groupBySession(text)) {
      const workspaceId = sessionChunks[0]!.workspaceId
      // Resolve the session's voice vector exactly as the distiller does, so a field prompt can use the
      // dials/{{voice.rules}} (the shipped defaults are transcript-only, but the seam is first-class).
      const record = this.store.getSession(workspaceId, sessionId)
      const mode: Mode = record ? this.docs.mode(record.modeId) : defaultMode
      const workspaceDenies = this.store.all().find((w) => w.id === workspaceId)?.egress?.deny
      const modeDefault: VoiceBinding[] = mode.registerId !== undefined ? [{ scope: 'mode', targetId: mode.id, registerId: mode.registerId }] : []
      const sessionBinding: VoiceBinding[] = record?.registerId !== undefined ? [{ scope: 'session', targetId: sessionId, registerId: record.registerId }] : []
      const bindings = [...storedBindings, ...sessionBinding, ...modeDefault]
      const resolved = resolveVoice(registers, bindings, { sessionId, workspaceId, modeId: mode.id })

      // ONE shared recent-material window per session (the released batch, tail-capped), physical-lane
      // labeled like the distiller's transcript. Gated per-field by minChars.
      const renderedChunks = sessionChunks.map((chunk) => {
          const label = captureLaneLabel(chunk.source)
          return { chunk, text: label ? `${label}: ${chunk.data}` : chunk.data }
        })
      const full = renderedChunks.map((rendered) => rendered.text).join('\n')
      const recent = full.length > CONTEXT_CHARS ? full.slice(-CONTEXT_CHARS) : full
      const tailStart = Math.max(0, full.length - CONTEXT_CHARS)
      let cursor = 0
      const contributingChunks: CaptureChunk[] = []
      for (const rendered of renderedChunks) {
        const end = cursor + rendered.text.length
        if (end > tailStart) contributingChunks.push(rendered.chunk)
        cursor = end + 1 // join('\n') separator before the next rendered chunk
      }
      // Relevance is about observed material, not our machine-owned label vocabulary. Counting
      // "microphone" vs "system audio" would make a label rename spuriously cross minChars gates.
      const evidenceChars = sessionChunks.map((chunk) => chunk.data).join('\n').length
      const materialChunks = contributingChunks.length > 0 ? contributingChunks : sessionChunks.slice(-1)
      const { windowStart, windowEnd } = this.windowSpan(materialChunks)

      // The inexpensive relevance gate (#61): a field is TRIGGERED only when the recent material meets its
      // trigger. Fast tier only — a `judge`-tier binding has no confirm pass yet, so it is skipped (never
      // fabricated). Skips are logged so a skipped field is visible, not silent.
      const triggered = fields.filter((tpl) => {
        const binding = tpl.field
        if (binding === undefined || binding.tier !== 'fast') return false
        const minChars = binding.trigger.minChars ?? 0
        if (evidenceChars < minChars) {
          this.log(`fast-field ${binding.fieldId} skipped: ${evidenceChars} < ${minChars} observed chars (relevance gate)`)
          return false
        }
        return true
      })
      if (triggered.length === 0) continue

      // Fan out CONCURRENTLY — N triggered prompts → N concurrent llm invokes. A per-field failure is
      // caught below so it never rejects the whole batch (Promise.all short-circuits on reject; each
      // runOne resolves to a FieldValue or undefined instead of throwing).
      // #116: ONE correlation id per (session, batch) fan-out pass, shared by every value it produces, and
      // only the tail-contributing chunk ids as the deterministic parent link. A flushed backlog may be
      // much larger than CONTEXT_CHARS; naming the whole batch would falsely claim omitted material fed
      // the field. These ids therefore match the exact rendered tail the model saw.
      const spanId = this.newId()
      const sourceChunks = materialChunks.map((chunk) => chunk.id)
      const vars = { ...compileVoiceVars(resolved.dials), transcript: recent, windowStart, windowEnd }
      const results = await Promise.all(
        triggered.map((tpl) => this.runOne(tpl, {
          workspaceId,
          sessionId,
          vars,
          windowStart,
          windowEnd,
          spanId,
          sourceChunks,
          ...(mode.egress?.deny !== undefined ? { modeDenies: mode.egress.deny } : {}),
          ...(workspaceDenies !== undefined ? { workspaceDenies } : {}),
        })),
      )
      for (const value of results) if (value !== undefined) produced.push(value)
      this.log(`fast-fields: ${produced.length} field(s) updated for session ${sessionId} (${triggered.length} triggered)`)
    }
    return produced
  }

  /** Run one fast-field prompt: interpolate → invoke → persist latest + publish. Undefined on invoke failure. */
  private async runOne(
    template: PromptTemplate,
    ctx: {
      workspaceId: string
      sessionId: string
      vars: Record<string, string>
      windowStart: string
      windowEnd: string
      spanId: string
      sourceChunks: string[]
      modeDenies?: boolean
      workspaceDenies?: boolean
    },
  ): Promise<FieldValue | undefined> {
    const binding = template.field!
    const prompt = interpolateTemplate(template.body, ctx.vars)
    const messages: LlmMessage[] = [{ role: 'user', content: prompt }]
    const egress = resolveEgress({
      contentClass: 'transcript',
      promptNeverEgress: template.neverEgress,
      modeDenies: ctx.modeDenies,
      workspaceDenies: ctx.workspaceDenies,
    })
    const guard = this.guardOptions()
    let result: LlmResult
    try {
      result = await this.invoke(messages, { maxTokens: 200, egress, ...(guard !== undefined ? { guard } : {}) })
    } catch (error) {
      if (error instanceof GuardHeldError) {
        await this.recordHold(error, { ...ctx, fieldId: binding.fieldId })
        return undefined
      }
      this.log(`fast-field ${binding.fieldId} failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
    const sessionId = binding.scope === 'session' ? ctx.sessionId : undefined
    const value: FieldValue = {
      id: FieldValueStore.idFor(ctx.workspaceId, binding.fieldId, sessionId),
      fieldId: binding.fieldId,
      workspaceId: ctx.workspaceId,
      ...(sessionId !== undefined ? { sessionId } : {}),
      label: template.name,
      value: result.text.trim(),
      state: 'provisional',
      spanId: ctx.spanId,
      provenance: {
        templateId: template.id,
        slot: result.slot,
        endpoint: result.endpoint,
        ...(result.model !== undefined ? { model: result.model } : {}),
        windowStart: ctx.windowStart,
        windowEnd: ctx.windowEnd,
        // #116: the material window's chunk ids — the deterministic parent link a trace walks.
        sourceChunks: ctx.sourceChunks,
        // #65/#116: the invoke's token accounting, when recorded — the field hop's consumption.
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
        // #206: stamp only what the invocation that ACTUALLY answered returned (after endpoint fallback).
        ...(result.egress !== undefined ? { egress: result.egress } : {}),
        ...(result.guard !== undefined ? { guard: result.guard } : {}),
      },
      updatedAt: this.now().toISOString(),
      schemaVersion: FIELD_VALUE_SCHEMA_VERSION,
    }
    this.values.put(value)
    await this.publish?.(value)
    return value
  }

  /** The capturedAt span (min→max) of a session's window — the field value's provenance window. */
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
