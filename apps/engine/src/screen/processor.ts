import { randomUUID } from 'node:crypto'
import type {
  CaptureChunk,
  Distillate,
  OcrInvokeParams,
  OcrResult,
  QueueFailure,
  ScreenContentType,
  ScreenProcessingOutcome,
  ScreenStatus,
  VlmInvokeParams,
  WorkflowStep,
} from '@openinfo/contracts'
import { DISTILLATE_SCHEMA_VERSION, OCR_RESULT_SCHEMA_VERSION } from '@openinfo/contracts'
import {
  FabricDocuments,
  invokeOcr,
  invokeVlm,
  describeInvokeFailure,
  resolveEgress,
  type EgressConsent,
  type LocalRuntimeManager,
  type ScreenInvokeOptions,
  type ScreenTextResult,
  type SecretResolver,
} from '../fabric/index.js'
import type { WorkspaceRegistry } from '../store/index.js'
import { NEUTRAL_DIALS } from '../voice/index.js'

/** The invoke shape the processor drives — injectable so a test can stand in a fake OCR without a server. */
export type ScreenOcrInvoke = (params: OcrInvokeParams, opts: ScreenInvokeOptions) => Promise<ScreenTextResult>

/** The vlm invoke shape (the drain-stage `vlm` step) — injectable so a test can stand in a fake VLM without a server. */
export type ScreenVlmInvoke = (params: VlmInvokeParams, opts: ScreenInvokeOptions) => Promise<ScreenTextResult>

/**
 * The default recognition prompt for a `vlm` drain step (a distinct screen-UNDERSTANDING step, richer than
 * the `ocr` step's verbatim transcription — which invokeOcr already handles, VLM-fallback included). A
 * workflow author overrides it per-step via `step.params.prompt`.
 */
const DEFAULT_SCREEN_VLM_PROMPT =
  'Describe what is shown on this screen, including any visible text and the apparent activity, in a few concise sentences.'

export interface ScreenOcrProcessorDeps {
  store: WorkspaceRegistry
  fabric: FabricDocuments
  /** whether the `screen.ocr` flag is on — read PER FRAME (like the drain's distill flags) so flipping it needs no restart. */
  isEnabled: () => boolean
  /** resolve an endpoint's auth.keyRef to its secret value at invoke time (bearer injection); optional. */
  resolveKey?: SecretResolver
  /** manage `local` endpoints' spawned runtimes; optional (a managed local ocr/vlm runtime is future — falls through). */
  runtimeManager?: LocalRuntimeManager
  /** injectable for tests; defaults to invoking the fabric `ocr` slot over the LIVE fabric (active profile). */
  invoke?: ScreenOcrInvoke
  /** injectable for tests; defaults to invoking the fabric `vlm` slot over the LIVE fabric (the drain `vlm` step). */
  invokeVlm?: ScreenVlmInvoke
  /** publish the created distillate so the standard surfaces (WS distillate.updated, GET /query) see it. */
  publishDistillate?: (distillate: Distillate) => void | Promise<void>
  /** publish the raw OcrResult on the engine-internal bus (ocr.completed); optional. */
  publishOcr?: (result: OcrResult) => void | Promise<void>
  /**
   * Report a metadata-only terminal screen outcome to the live read model. Successful nonblank OCR uses
   * the existing `ocr.completed` path as its one canonical signal; this seam reports only blank/failed.
   */
  reportProcessingOutcome?: (outcome: ScreenProcessingOutcome) => void | Promise<void>
  now?: () => Date
  newId?: () => string
  log?: (message: string) => void
  /** how many recent failures the status ring keeps (default 10). */
  failureRingSize?: number
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Screen-derived content is content-class `screen` — layer 4 of the egress-consent policy (#64), which
 * NEVER egresses. Resolved ONCE (it is a constant for this pipeline): egress-capable endpoints are filtered
 * out of every screen invoke, so recognized screen text can only ever be produced locally. The decision is
 * stamped on both records so the ledger shows the screen pass stayed local BY POLICY, not by accident.
 */
const SCREEN_EGRESS: EgressConsent = resolveEgress({ contentClass: 'screen' })

/**
 * The screen-OCR processor (P4B slice 4). It subscribes to `capture.received` and, gated on the
 * `screen.ocr` flag, recognizes each `source:'screen'` IMAGE frame through the fabric `ocr` slot
 * (paddle-serving, or an openai-compat VLM fallback — invokeOcr already handles slot-filling, so this
 * builds no slot-picking policy of its own). A recognized frame becomes an `OcrResult` (persisted, with
 * region blocks when the runtime is region-aware) AND a `Distillate` (so the STANDARD surfaces see the
 * screen text with no new surface — direct record construction, NO extra llm pass). It runs INDEPENDENTLY
 * of distill.enabled: a screen frame is understood by OCR, not by the transcript distiller.
 *
 * It rides capture INGEST, not the queue drain (which is queue/-owned, off-limits here), so it keeps its
 * OWN health: processed/blank/skipped/failed counters + a bounded ring of classified failures, exposed via
 * GET /screen/status. Empty recognized text is a BLANK frame — the cheapest honest outcome is to persist
 * NEITHER record (nothing to say) but COUNT it, so status still shows blanks were processed.
 *
 * `process()` NEVER throws: an invoke failure (AggregateInvokeError) is recorded in the ring and swallowed,
 * and any other error is logged — a bad frame must not crash the engine or the ingest path (bus.publish
 * awaits its subscribers, so the wiring calls process() fire-and-forget).
 */
export class ScreenOcrProcessor {
  private readonly store: WorkspaceRegistry
  private readonly fabric: FabricDocuments
  private readonly isEnabled: () => boolean
  private readonly resolveKey: SecretResolver | undefined
  private readonly runtimeManager: LocalRuntimeManager | undefined
  private readonly invoke: ScreenOcrInvoke
  private readonly invokeVlmFn: ScreenVlmInvoke
  private readonly publishDistillate: ((d: Distillate) => void | Promise<void>) | undefined
  private readonly publishOcr: ((r: OcrResult) => void | Promise<void>) | undefined
  private readonly reportProcessingOutcome: ((outcome: ScreenProcessingOutcome) => void | Promise<void>) | undefined
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly log: (message: string) => void
  private readonly ringSize: number

  private readonly counts = { processed: 0, blank: 0, skipped: 0, failed: 0 }
  private readonly failures: QueueFailure[] = []

  constructor(deps: ScreenOcrProcessorDeps) {
    this.store = deps.store
    this.fabric = deps.fabric
    this.isEnabled = deps.isEnabled
    this.resolveKey = deps.resolveKey
    this.runtimeManager = deps.runtimeManager
    this.publishDistillate = deps.publishDistillate
    this.publishOcr = deps.publishOcr
    this.reportProcessingOutcome = deps.reportProcessingOutcome
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => randomUUID())
    this.log = deps.log ?? (() => undefined)
    this.ringSize = deps.failureRingSize ?? 10
    this.invoke = deps.invoke ?? ((params, opts) => invokeOcr(this.fabric.load(), params, opts))
    this.invokeVlmFn = deps.invokeVlm ?? ((params, opts) => invokeVlm(this.fabric.load(), params, opts))
  }

  /**
   * Handle one capture chunk. Ignores non-screen chunks entirely (they are not ours); when the flag is
   * OFF a screen chunk is left untouched and uncounted. A companion ScreenFrameMeta chunk (utf8/json,
   * no pixels) is skipped-and-counted; an image chunk is recognized. Never throws.
   */
  async process(chunk: CaptureChunk): Promise<void> {
    try {
      if (chunk.source !== 'screen') return
      if (!this.isEnabled()) return
      // The companion ScreenFrameMeta chunk carries decoded JSON, not pixels (contentType
      // application/json, encoding utf8) — skip it. Only image/* chunks carry a frame to recognize.
      if (!chunk.contentType.startsWith('image/')) {
        this.counts.skipped++
        return
      }
      await this.recognize(chunk)
    } catch (error) {
      // Belt-and-suspenders: a store write or any unexpected throw must not propagate into the ingest path.
      this.counts.failed++
      this.recordFailure(error)
      await this.reportOutcome(chunk, 'failed')
      this.log(`screen ocr processor error on chunk ${chunk.id}: ${message(error)}`)
    }
  }

  /** The processor's health for GET /screen/status (a fresh copy of the ring — callers cannot mutate it). */
  status(): ScreenStatus {
    return {
      enabled: this.isEnabled(),
      processed: this.counts.processed,
      blank: this.counts.blank,
      skipped: this.counts.skipped,
      failed: this.counts.failed,
      lastFailures: [...this.failures],
    }
  }

  private invokeOptions(): ScreenInvokeOptions {
    return {
      ...(this.resolveKey ? { resolveKey: this.resolveKey } : {}),
      ...(this.runtimeManager ? { runtimeManager: this.runtimeManager } : {}),
      egress: SCREEN_EGRESS, // #64: screen content never egresses — filters egress endpoints, stamps the decision
    }
  }

  /**
   * The DRAIN-stage entry (the workflow executor's `ocr`/`vlm` step, P4A×P4B joint slice). Recognizes
   * every `source:'screen'` IMAGE chunk in the drained batch through the fabric slot the STEP names
   * (`ocr` → invokeOcr, `vlm` → invokeVlm with the step's prompt), persisting the SAME OcrResult +
   * Distillate that `process()` builds (via the shared `persist`). Unlike `process()`, a recognition
   * throw PROPAGATES so the queue re-queues the batch (retry-at-idle) and classifies the failure onto
   * GET /queue — screen understanding is REAL drain work, not a best-effort derived act. Blank frames and
   * the companion meta chunk are skipped-and-counted, exactly as on the ingest path. Counters feed
   * GET /screen/status for the workflow path too; a propagated failure is NOT ringed here (the queue owns
   * drain-failure health, mirroring distill/transcribe). Double-processing with the ingest path is avoided
   * upstream: the ingest subscription (screen/index.ts) defers while `workflow.enabled` is ON.
   */
  async runOnDrain(chunks: readonly CaptureChunk[], step: WorkflowStep): Promise<void> {
    // Honor the step's `slot` when set (ocr|vlm), else derive it from the step KIND — they align in the
    // seeded default (an `ocr` step names the `ocr` slot). A `vlm` step optionally carries its prompt.
    const slot = step.slot === 'vlm' || step.slot === 'ocr' ? step.slot : step.kind === 'vlm' ? 'vlm' : 'ocr'
    const promptParam = step.params?.['prompt']
    const prompt = typeof promptParam === 'string' && promptParam.trim() !== '' ? promptParam : DEFAULT_SCREEN_VLM_PROMPT
    for (const chunk of chunks) {
      if (chunk.source !== 'screen') continue
      if (!chunk.contentType.startsWith('image/')) {
        this.counts.skipped++
        continue
      }
      try {
        const result = await this.invokeSlot(slot, chunk, prompt) // throws PROPAGATE → the drain re-queues
        if (result.text.trim() === '') {
          this.counts.blank++
          await this.reportOutcome(chunk, 'blank')
          this.log(`screen frame ${chunk.id} recognized as blank (no text) [${slot}]`)
          continue
        }
        await this.persist(chunk, result)
        this.counts.processed++
        this.log(`screen frame ${chunk.id} → ${slot} (${result.text.length} chars) via ${result.endpoint} on the drain`)
      } catch (error) {
        // This is real workflow work: record the safe terminal metadata, then preserve the queue's exact
        // original rejection so retry/classification semantics remain unchanged. Reporter errors are
        // swallowed inside reportOutcome and therefore can never replace this error.
        this.counts.failed++
        await this.reportOutcome(chunk, 'failed')
        throw error
      }
    }
  }

  /** Invoke the named screen slot for one frame: `vlm` → invokeVlm (with a prompt), else the `ocr` slot. */
  private invokeSlot(slot: 'ocr' | 'vlm', chunk: CaptureChunk, prompt: string): Promise<ScreenTextResult> {
    const opts = this.invokeOptions()
    if (slot === 'vlm') {
      const params: VlmInvokeParams = { image: chunk.data, contentType: chunk.contentType as ScreenContentType, prompt }
      return this.invokeVlmFn(params, opts)
    }
    return this.invoke({ image: chunk.data, contentType: chunk.contentType as ScreenContentType }, opts)
  }

  private async recognize(chunk: CaptureChunk): Promise<void> {
    let result: ScreenTextResult
    try {
      result = await this.invoke({ image: chunk.data, contentType: chunk.contentType as ScreenContentType }, this.invokeOptions())
    } catch (error) {
      this.counts.failed++
      this.recordFailure(error)
      await this.reportOutcome(chunk, 'failed')
      this.log(`screen ocr failed on frame ${chunk.id}: ${message(error)}`)
      return
    }

    // A blank frame (no recognized text) is a normal outcome, not an error — persist NEITHER record
    // (nothing to say) but count it so status is honest about how many frames were seen.
    if (result.text.trim() === '') {
      this.counts.blank++
      await this.reportOutcome(chunk, 'blank')
      this.log(`screen frame ${chunk.id} recognized as blank (no text)`)
      return
    }

    await this.persist(chunk, result)
    this.counts.processed++
    this.log(`screen frame ${chunk.id} → ocr (${result.text.length} chars) via ${result.endpoint} [${result.slot}]`)
  }

  /**
   * Send only the closed correlation/timing record. This helper deliberately cannot accept extracted
   * text, pixels, endpoint/model provenance, or exception strings. Reporting is observational: a broken
   * tracker/bus must never change whether legacy OCR resolves or workflow OCR throws its original error.
   */
  private async reportOutcome(chunk: CaptureChunk, outcome: 'blank' | 'failed'): Promise<void> {
    if (!this.reportProcessingOutcome) return
    const report: ScreenProcessingOutcome = {
      workspaceId: chunk.workspaceId,
      sessionId: chunk.sessionId,
      outcome,
      capture: { id: chunk.id, capturedAt: chunk.capturedAt },
      completedAt: this.now().toISOString(),
    }
    try {
      await this.reportProcessingOutcome(report)
    } catch {
      // Do not interpolate the thrown value: arbitrary reporter/server text is not safe telemetry.
      this.log(`screen processing outcome reporter failed for frame ${chunk.id}`)
    }
  }

  /**
   * Build + persist + publish the two records a recognized frame becomes — shared by the ingest
   * (`recognize`) and drain (`runOnDrain`) paths so both produce byte-identical records. An OcrResult
   * (persisted, with region blocks when the runtime is region-aware) AND a Distillate so the STANDARD
   * surfaces read the screen text (GET /query, distillate.updated) with no new surface — a direct record
   * construction, NO extra llm pass. A single frame is captured at one instant, so
   * windowStart == windowEnd == the frame's capturedAt; no voice/register pass runs over recognized text
   * (transcription, not rewriting), so the honest voice vector is global scope + neutral dials.
   */
  private async persist(chunk: CaptureChunk, result: ScreenTextResult): Promise<void> {
    const createdAt = this.now().toISOString()
    const provenance = {
      slot: result.slot,
      endpoint: result.endpoint,
      ...(result.model !== undefined ? { model: result.model } : {}),
      // #65: carry the invoke's token accounting (estimated for a screen invoke — see invoke.ts) onto both
      // the OcrResult and the mirror Distillate so the audit ledger renders this screen pass's consumption.
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
      // #64: carry the egress decision (always reach:'local'/decidedBy:'content-class' for screen) onto both
      // records so the ledger shows this screen pass stayed local by policy.
      ...(result.egress !== undefined ? { egress: result.egress } : {}),
    }
    const ocr: OcrResult = {
      id: this.newId(),
      sessionId: chunk.sessionId,
      workspaceId: chunk.workspaceId,
      sourceChunks: [chunk.id],
      text: result.text,
      ...(result.blocks !== undefined ? { blocks: result.blocks } : {}),
      provenance,
      schemaVersion: OCR_RESULT_SCHEMA_VERSION,
      createdAt,
      // #102 keep-time: carry the frame's TRUE capture instant onto the record itself, not just the mirror
      // Distillate's windowStart/End — so a direct OcrResult consumer can never present delayed OCR as
      // real-time. A single frame is captured at one instant, so this is exactly the Distillate window.
      capturedAt: chunk.capturedAt,
    }
    this.store.saveOcrResult(ocr)
    await this.publishOcr?.(ocr)

    const distillate: Distillate = {
      id: this.newId(),
      sessionId: chunk.sessionId,
      workspaceId: chunk.workspaceId,
      windowStart: chunk.capturedAt,
      windowEnd: chunk.capturedAt,
      sourceChunks: [chunk.id],
      text: result.text.trim(),
      voice: { scope: 'global', dials: NEUTRAL_DIALS },
      provenance,
      schemaVersion: DISTILLATE_SCHEMA_VERSION,
      createdAt,
    }
    this.store.saveDistillate(distillate)
    await this.publishDistillate?.(distillate)
  }

  /** Record a classified invoke failure in the bounded ring (newest last). A non-invoke error is logged, not faked into a class. */
  private recordFailure(error: unknown): void {
    const classified = describeInvokeFailure(error)
    if (!classified) return
    const failure: QueueFailure = {
      class: classified.class,
      endpoint: classified.endpoint,
      ...(classified.model !== undefined ? { model: classified.model } : {}),
      ...(classified.keyRef !== undefined ? { keyRef: classified.keyRef } : {}),
      ...(classified.serverMessage !== undefined ? { serverMessage: classified.serverMessage } : {}),
      hint: classified.hint,
      at: this.now().toISOString(),
    }
    this.failures.push(failure)
    if (this.failures.length > this.ringSize) this.failures.shift()
  }
}
