import { randomUUID } from 'node:crypto'
import type { CaptureChunk, Distillate, Entity, EntityProvenance, GuardHold, Moment, Mode, PromptTemplate, VoiceBinding } from '@openinfo/contracts'
import { DISTILLATE_SCHEMA_VERSION } from '@openinfo/contracts'
import { FabricDocuments, GuardHeldError, invokeLlm, resolveEgress, type GuardOptions, type InvokeOptions, type LlmMessage, type LlmResult, type LocalRuntimeManager, type SecretResolver } from '../fabric/index.js'
import type { GuardDocuments, GuardHoldStore } from '../guard/documents.js'
import { correlateWindow, entityMentioned, extractEntities } from '../index/index.js'
import type { PresetDocuments } from '../presets/index.js'
import type { WorkspaceRegistry } from '../store/index.js'
import { VoiceDocuments, compileVoiceVars, interpolateTemplate, resolveVoice } from '../voice/index.js'
import { bucketIntoWindows } from './merge.js'
import { DistillDocuments } from './documents.js'
import { extractMoments, type ExtractInput } from './moments.js'
import { captureLaneLabel } from './transcribe.js'

export type LlmInvoke = (messages: LlmMessage[], opts: InvokeOptions) => Promise<LlmResult>

/** Per-pass toggles the wiring reads from flags (distill.enabled gates the pass itself). */
export interface DistillOptions {
  /** run typed-moment extraction as a second call per window (gated on distill.moments). */
  extractMoments?: boolean
  /** run entity extraction + index upsert as a third call per window (gated on distill.index). */
  extractEntities?: boolean
}

export interface DistillerDeps {
  store: WorkspaceRegistry
  voice: VoiceDocuments
  fabric: FabricDocuments
  docs: DistillDocuments
  /**
   * The workspace context-preset resolver (pill P2). When present, each window resolves the window's
   * workspace's ACTIVE preset and PREPENDS its body to the distill summary prompt. Absent (or no preset
   * selected) ⇒ NO injection: the prompt is byte-identical to today (the regression guard). Optional so
   * every existing Distiller construction is unchanged.
   */
  presets?: PresetDocuments
  /** publish distillate.updated so it reaches WS clients; optional (tests may omit) */
  publish?: (distillate: Distillate) => void | Promise<void>
  /** publish moment.created per extracted moment; optional (tests may omit) */
  publishMoment?: (moment: Moment) => void | Promise<void>
  /** publish entity.updated per resolved entity upsert; optional (tests may omit) */
  publishEntity?: (entity: Entity) => void | Promise<void>
  /** injectable for tests; defaults to invoking the fabric llm slot */
  invoke?: LlmInvoke
  /** resolve an endpoint's auth.keyRef at invoke time (bearer token injection); optional. */
  resolveKey?: SecretResolver
  /** manages `local` endpoints' spawned runtimes (tier zero); optional. */
  runtimeManager?: LocalRuntimeManager
  /** the guard policy documents (#63) — absent ⇒ the guard does not run (no egress interception). */
  guardDocs?: GuardDocuments
  /** the held-hops audit store (#63) — where a suspended egress hop lands with its verdict. */
  guardHolds?: GuardHoldStore
  /** whether the egress guard is enabled (the guard.egress flag) — absent ⇒ off (pre-#63 behavior). */
  guardEnabled?: () => boolean
  /** publish guard.hold.updated when a hop is suspended; optional (tests may omit). */
  publishHold?: (hold: GuardHold) => void | Promise<void>
  now?: () => Date
  newId?: () => string
  log?: (message: string) => void
}

/**
 * Only utf8 TEXT chunks distill in v0; screen/base64 frames defer to OCR (P3). Focus chunks are ALSO
 * utf8 (source 'focus', contentType application/json) but are foreground CONTEXT for the router, never
 * speech — they are excluded explicitly (by source AND contentType) so they can never leak into a
 * transcript, moment, or entity. Distill hygiene is enforced HERE (the transcript-builder path) in
 * addition to the drain routing focus to the detector — belt and suspenders (see PHASE3-NOTES).
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

/**
 * The rolling-merge distiller (Distill v0). Consumes raw capture chunks, buckets them into merge
 * windows (size from the mode document), resolves the effective voice vector, interpolates it into
 * the prompt template, calls the fabric `llm` slot, persists the distillate to the session's
 * workspace DB via store/, and publishes distillate.updated on the bus.
 */
export class Distiller {
  private readonly store: WorkspaceRegistry
  private readonly voice: VoiceDocuments
  private readonly fabric: FabricDocuments
  private readonly docs: DistillDocuments
  private readonly presets: PresetDocuments | undefined
  private readonly publish: ((d: Distillate) => void | Promise<void>) | undefined
  private readonly publishMoment: ((m: Moment) => void | Promise<void>) | undefined
  private readonly publishEntity: ((e: Entity) => void | Promise<void>) | undefined
  private readonly invoke: LlmInvoke
  private readonly resolveKey: SecretResolver | undefined
  private readonly guardDocs: GuardDocuments | undefined
  private readonly guardHolds: GuardHoldStore | undefined
  private readonly guardEnabled: () => boolean
  private readonly publishHold: ((hold: GuardHold) => void | Promise<void>) | undefined
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly log: (message: string) => void

  constructor(deps: DistillerDeps) {
    this.store = deps.store
    this.voice = deps.voice
    this.fabric = deps.fabric
    this.docs = deps.docs
    this.presets = deps.presets
    this.publish = deps.publish
    this.publishMoment = deps.publishMoment
    this.publishEntity = deps.publishEntity
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

  /**
   * Build the egress-guard config (#63) for this pass, or undefined when the guard is off. When the
   * guard.egress flag is on and the policy docs are wired, EVERY invoke this pass makes carries it — so an
   * allowed egress hop is filtered before any bytes leave (redact / hold per policy), and a local hop
   * ignores it (no egress ⇒ no filter). An empty guard slot is the fail-closed edge the policy governs.
   */
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

  /**
   * Persist a SUSPENDED egress hop as a durable audit record (#63) and surface it. The verdict carries span
   * descriptors (kind/start/length), NEVER the raw flagged value; the raw content is not retained (fail
   * closed — nothing leaked). The subsequent moment/entity calls in the same window inherit this verdict
   * (same transcript + policy), so a strict hold on the summary suspends the whole window before them.
   */
  private async recordHold(err: GuardHeldError, ctx: { sessionId: string; workspaceId: string; stage: string; windowStart: string; windowEnd: string }): Promise<void> {
    const hold: GuardHold = {
      id: this.newId(),
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId,
      stage: ctx.stage,
      verdict: err.verdict,
      status: 'held',
      createdAt: this.now().toISOString(),
    }
    this.guardHolds?.add(hold)
    await this.publishHold?.(hold)
    this.log(`guard held ${ctx.stage} window ${ctx.windowStart}→${ctx.windowEnd}: ${err.verdict.reason}`)
  }

  async distillChunks(chunks: readonly CaptureChunk[], opts: DistillOptions = {}): Promise<Distillate[]> {
    const text = chunks.filter(isText)
    if (text.length === 0) return []
    const defaultMode: Mode = this.docs.mode()
    const template: PromptTemplate = this.docs.template()
    const extractTemplate: PromptTemplate = this.docs.extractTemplate()
    const entitiesTemplate: PromptTemplate = this.docs.entitiesTemplate()
    const registers = this.voice.registers()
    const storedBindings = this.voice.bindings()
    const produced: Distillate[] = []

    for (const [sessionId, sessionChunks] of groupBySession(text)) {
      // Close the distill loop (see PHASE2-NOTES): if a real session record exists for this chunk's
      // sessionId, use ITS modeId (for merge window/token budget + mode-default register) and its
      // registerId (as a session-scope binding that wins the resolution). No record ⇒ fall back to
      // the default meeting mode — capture may spool before/without a started session.
      const sessionWorkspaceId = sessionChunks[0]!.workspaceId
      const record = this.store.getSession(sessionWorkspaceId, sessionId)
      const mode: Mode = record ? this.docs.mode(record.modeId) : defaultMode
      // A mode's registerId IS its mode-scope default binding (IMPLEMENTATION §1: "a mode declares a
      // default"). A session's registerId is a session-scope binding (session > mode precedence).
      // Stored bindings come first so an explicit stored binding still wins over these synthesized ones.
      const modeDefault: VoiceBinding[] =
        mode.registerId !== undefined ? [{ scope: 'mode', targetId: mode.id, registerId: mode.registerId }] : []
      const sessionBinding: VoiceBinding[] =
        record?.registerId !== undefined ? [{ scope: 'session', targetId: sessionId, registerId: record.registerId }] : []
      const bindings = [...storedBindings, ...sessionBinding, ...modeDefault]

      const windows = bucketIntoWindows(sessionChunks, mode.distill.mergeWindow)
      for (const window of windows) {
        const workspaceId = window.chunks[0]!.workspaceId
        const resolved = resolveVoice(registers, bindings, { sessionId, workspaceId, modeId: mode.id })
        // Resolve layered egress consent (#64) for THIS window's transcript content. A distill window is
        // transcript-class content (mic/system audio), which MAY egress — unless the prompt is declared
        // never-egress, or the mode/workspace denies. The resolved consent rides EVERY invoke for this
        // window (summary + moments + entities) so a denial filters egress endpoints uniformly; the
        // returned decision is stamped on provenance for the audit ledger. Most-specific denial wins.
        const workspace = this.store.all().find((w) => w.id === workspaceId)
        const egress = resolveEgress({
          contentClass: 'transcript',
          promptNeverEgress: template.neverEgress,
          modeDenies: mode.egress?.deny,
          workspaceDenies: workspace?.egress?.deny,
        })
        // #63: the egress guard rides EVERY invoke for this window alongside the #64 consent — so an
        // allowed egress hop is filtered (redact / hold) before any bytes leave, and a local hop ignores
        // it. Built once per window; undefined ⇒ the guard is off (pre-#63 behavior).
        const guard = this.guardOptions()
        const egressInvoke: LlmInvoke = (messages, opts) => this.invoke(messages, { ...opts, egress, ...(guard !== undefined ? { guard } : {}) })
        // Physical source attribution (see transcribe.ts::captureLaneLabel): microphone/system audio.
        // Prefixing the transcript line carries the lane into summary and extraction without claiming
        // person identity (same-mic diarization is #137). Non-audio sources are left bare.
        const transcript = window.chunks
          .map((chunk) => {
            const label = captureLaneLabel(chunk.source)
            return label ? `${label}: ${chunk.data}` : chunk.data
          })
          .join('\n')
        const basePrompt = interpolateTemplate(template.body, {
          ...compileVoiceVars(resolved.dials),
          transcript,
          windowStart: window.start,
          windowEnd: window.end,
        })
        // pill P2 — ACTUAL preset injection: resolve THIS window's workspace's active context preset and
        // PREPEND its body as leading context to the distill summary prompt. This is the one right
        // interpolation site (where the final prompt string is composed), and prepending here — rather than
        // requiring a {{preset}} placeholder in the template body — means the active preset applies to
        // WHATEVER distill template is in force, including a user-authored one, and the byte-identical
        // guarantee is exact: no preset ⇒ prompt === basePrompt (today's behavior). Only the distill
        // summary pass is steered; the moments/entities passes below (strict-JSON grammars) are left bare.
        const activePreset = this.presets?.resolveActive(workspaceId)
        const prompt = activePreset ? `${activePreset.body}\n\n${basePrompt}` : basePrompt
        const messages: LlmMessage[] = [{ role: 'user', content: prompt }]
        // #63: a guard HOLD (strict flagged content, or a fail-closed empty slot) throws GuardHeldError out
        // of the invoke — a HARD STOP for this window. We record the held hop as a durable audit record
        // (verdict + span descriptors, never the raw value), surface it, and SKIP the window (fail closed —
        // nothing left the machine). A clean/redacted/unguarded verdict rides result.guard onto provenance.
        let result: LlmResult
        try {
          result = await egressInvoke(messages, { maxTokens: mode.distill.tokenBudget })
        } catch (err) {
          if (err instanceof GuardHeldError) {
            await this.recordHold(err, { sessionId, workspaceId, stage: 'distill', windowStart: window.start, windowEnd: window.end })
            continue
          }
          throw err
        }

        const distillate: Distillate = {
          id: this.newId(),
          sessionId,
          workspaceId,
          windowStart: window.start,
          windowEnd: window.end,
          sourceChunks: window.chunks.map((chunk) => chunk.id),
          text: result.text.trim(),
          voice: {
            scope: resolved.scope,
            dials: resolved.dials,
            ...(resolved.registerId !== undefined ? { registerId: resolved.registerId } : {}),
          },
          provenance: {
            slot: result.slot,
            endpoint: result.endpoint,
            ...(result.model !== undefined ? { model: result.model } : {}),
            // #65: the invoke layer stamps token accounting (measured from the API, or estimated + marked);
            // carry it verbatim so the audit ledger can render this pass's consumption. Optional — a result
            // without usage (older path) still persists a valid distillate.
            ...(result.usage !== undefined ? { usage: result.usage } : {}),
            // #64: carry the resolved egress decision (endpoint reach + which layer decided) so the ledger's
            // egress column renders from real data — "local", or "egress" when content actually left.
            ...(result.egress !== undefined ? { egress: result.egress } : {}),
            // #63: the guard verdict when this pass ran through an egress hop with the guard active
            // (clean / redacted with span descriptors / unguarded) — lights up the ledger's guard column.
            ...(result.guard !== undefined ? { guard: result.guard } : {}),
            // pill P2: name the active preset whose body was prepended to THIS pass, so the why-record is
            // honest — a summary shaped by the Sales preset says so in the System/Ledger register. Absent
            // when no preset was active (today's behavior), never fabricated.
            ...(activePreset !== undefined ? { presetId: activePreset.id } : {}),
          },
          schemaVersion: DISTILLATE_SCHEMA_VERSION,
          createdAt: this.now().toISOString(),
        }
        this.store.saveDistillate(distillate)
        await this.publish?.(distillate)
        this.log(`distilled window ${window.start}→${window.end} (${window.chunks.length} chunks) via ${result.endpoint}`)
        produced.push(distillate)

        // Typed-moment extraction rides the same window as a SECOND tight call (see PHASE2-NOTES:
        // one job per call beats summary+JSON on small local models). Gated on distill.moments.
        // Transport failures propagate → the drain re-queues the file for retry-at-idle, matching
        // the distill seam; malformed JSON is bounded-retried then dropped inside extractMoments.
        // Moments are held until entity extraction (below) so same-pass refs linking lands on the
        // moment BEFORE it is persisted/published — moment.created always carries final refs.
        const windowMoments: Moment[] = []
        if (opts.extractMoments) {
          const input: ExtractInput = {
            transcript,
            summary: distillate.text,
            sessionId,
            workspaceId,
            windowStart: window.start,
            windowEnd: window.end,
            source: window.chunks[0]!.source,
            dials: resolved.dials,
            distillateId: distillate.id,
            endpoint: result.endpoint,
            slot: 'llm',
            ...(result.model !== undefined ? { model: result.model } : {}),
          }
          const extraction = await extractMoments(input, {
            invoke: egressInvoke,
            template: extractTemplate,
            now: this.now,
            newId: this.newId,
            log: this.log,
            maxTokens: mode.distill.tokenBudget,
          })
          windowMoments.push(...extraction.moments)
          this.log(`extracted ${extraction.moments.length} moment(s) (dropped ${extraction.dropped}) from window ${window.start}→${window.end}`)
        }

        // Entity extraction (Index v0) rides the same window as a THIRD tight call, gated on
        // distill.index — same rationale and same malformed-output policy as moments. Candidates
        // resolve through store.upsertEntity (one record per kind+normalized name); Moment.refs
        // links this window's moments to this window's resolved entities by name match (same-pass
        // linking only — already-persisted moments from earlier passes are never rewritten).
        if (opts.extractEntities) {
          const extraction = await extractEntities(
            { transcript, summary: distillate.text, windowStart: window.start, windowEnd: window.end, dials: resolved.dials },
            { invoke: egressInvoke, template: entitiesTemplate, log: this.log, maxTokens: mode.distill.tokenBudget },
          )
          const provenance: EntityProvenance = {
            distillateId: distillate.id,
            windowStart: window.start,
            windowEnd: window.end,
            slot: 'llm',
            endpoint: result.endpoint,
            ...(result.model !== undefined ? { model: result.model } : {}),
          }
          // #74: the screen-understanding stream this session persisted, read once per window so the
          // correlator can notice a heard mention that was ALSO seen on screen in the same window. It
          // consumes the persisted OcrResult stream (not the HTTP drain) — pure timestamp correlation, so a
          // late-arriving OCR pass simply corroborates a later window rather than racing this one.
          const sessionOcr = this.store.listOcrResults(workspaceId, sessionId)
          for (const candidate of extraction.entities) {
            const mentionedBy = windowMoments.filter((m) => entityMentioned(m.text, candidate.name, candidate.aliases))
            // #74: correlate this heard mention against same-window OCR. A match feeds the resolver's
            // crossSourceCorroboration multiplier AND supplies a `seen` sighting — so a corroborated mention
            // auto-links (the multiplier lifts the score through the resolver's own band decision), the
            // record is promoted to confirmed, and the ASR-mangled surface form is taught as a heardAs alias,
            // all with no user ask. Neutral (multiplier 1.0, no seen sighting) when nothing on screen agreed.
            const corr = correlateWindow({
              heard: { name: candidate.name, aliases: candidate.aliases },
              window: { start: window.start, end: window.end },
              ocr: sessionOcr,
            })
            // Contract v2 (#73) evidence, populated from the signals we genuinely have HERE: this window
            // came from the transcript, so the mention is a `heard` sighting tied to the distillate, and
            // the extracted surface form is a `stt` heardAs variant. Per-variant ASR confidence is NOT
            // surfaced by the pipeline today, so it is left undefined (disclosed) rather than fabricated.
            const entity = this.store.upsertEntity({
              workspaceId,
              kind: candidate.kind,
              name: candidate.name,
              aliases: candidate.aliases,
              seenAt: window.end,
              provenance,
              momentRefs: mentionedBy.map((m) => m.id),
              sighting: { via: 'heard', at: window.end, distillateId: distillate.id },
              heardAs: { text: candidate.name, source: 'stt', at: window.end },
              ...(corr.corroborated && corr.sighting !== undefined
                ? { signals: { crossSourceCorroboration: corr.multiplier }, crossSighting: corr.sighting }
                : {}),
            })
            for (const moment of mentionedBy) {
              if (!moment.refs.includes(entity.id)) moment.refs.push(entity.id)
            }
            await this.publishEntity?.(entity)
          }
          this.log(`resolved ${extraction.entities.length} entit(y/ies) (dropped ${extraction.dropped}) from window ${window.start}→${window.end}`)
        }

        for (const moment of windowMoments) {
          this.store.saveMoment(moment)
          await this.publishMoment?.(moment)
        }
      }
    }
    return produced
  }
}
