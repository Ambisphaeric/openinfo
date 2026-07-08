import { randomUUID } from 'node:crypto'
import type {
  CaptureChunk,
  Distillate,
  OcrInvokeParams,
  OcrResult,
  QueueFailure,
  ScreenContentType,
  ScreenStatus,
} from '@openinfo/contracts'
import { DISTILLATE_SCHEMA_VERSION, OCR_RESULT_SCHEMA_VERSION } from '@openinfo/contracts'
import {
  FabricDocuments,
  invokeOcr,
  describeInvokeFailure,
  type LocalRuntimeManager,
  type ScreenInvokeOptions,
  type ScreenTextResult,
  type SecretResolver,
} from '../fabric/index.js'
import type { WorkspaceRegistry } from '../store/index.js'
import { NEUTRAL_DIALS } from '../voice/index.js'

/** The invoke shape the processor drives — injectable so a test can stand in a fake OCR without a server. */
export type ScreenOcrInvoke = (params: OcrInvokeParams, opts: ScreenInvokeOptions) => Promise<ScreenTextResult>

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
  /** publish the created distillate so the standard surfaces (WS distillate.updated, GET /query) see it. */
  publishDistillate?: (distillate: Distillate) => void | Promise<void>
  /** publish the raw OcrResult on the engine-internal bus (ocr.completed); optional. */
  publishOcr?: (result: OcrResult) => void | Promise<void>
  now?: () => Date
  newId?: () => string
  log?: (message: string) => void
  /** how many recent failures the status ring keeps (default 10). */
  failureRingSize?: number
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

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
  private readonly publishDistillate: ((d: Distillate) => void | Promise<void>) | undefined
  private readonly publishOcr: ((r: OcrResult) => void | Promise<void>) | undefined
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
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => randomUUID())
    this.log = deps.log ?? (() => undefined)
    this.ringSize = deps.failureRingSize ?? 10
    this.invoke = deps.invoke ?? ((params, opts) => invokeOcr(this.fabric.load(), params, opts))
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
    }
  }

  private async recognize(chunk: CaptureChunk): Promise<void> {
    const params: OcrInvokeParams = { image: chunk.data, contentType: chunk.contentType as ScreenContentType }
    let result: ScreenTextResult
    try {
      result = await this.invoke(params, this.invokeOptions())
    } catch (error) {
      this.counts.failed++
      this.recordFailure(error)
      this.log(`screen ocr failed on frame ${chunk.id}: ${message(error)}`)
      return
    }

    // A blank frame (no recognized text) is a normal outcome, not an error — persist NEITHER record
    // (nothing to say) but count it so status is honest about how many frames were seen.
    if (result.text.trim() === '') {
      this.counts.blank++
      this.log(`screen frame ${chunk.id} recognized as blank (no text)`)
      return
    }

    const createdAt = this.now().toISOString()
    const ocr: OcrResult = {
      id: this.newId(),
      sessionId: chunk.sessionId,
      workspaceId: chunk.workspaceId,
      sourceChunks: [chunk.id],
      text: result.text,
      ...(result.blocks !== undefined ? { blocks: result.blocks } : {}),
      provenance: {
        slot: result.slot,
        endpoint: result.endpoint,
        ...(result.model !== undefined ? { model: result.model } : {}),
      },
      schemaVersion: OCR_RESULT_SCHEMA_VERSION,
      createdAt,
    }
    this.store.saveOcrResult(ocr)
    await this.publishOcr?.(ocr)

    // Turn the recognized text into a Distillate so the STANDARD surfaces read it (GET /query,
    // distillate.updated) with no new surface. A single frame is captured at one instant, so
    // windowStart == windowEnd == the frame's capturedAt. No voice/register pass runs over OCR text
    // (it is transcription, not rewriting), so the honest voice vector is global scope + neutral dials.
    const distillate: Distillate = {
      id: this.newId(),
      sessionId: chunk.sessionId,
      workspaceId: chunk.workspaceId,
      windowStart: chunk.capturedAt,
      windowEnd: chunk.capturedAt,
      sourceChunks: [chunk.id],
      text: result.text.trim(),
      voice: { scope: 'global', dials: NEUTRAL_DIALS },
      provenance: {
        slot: result.slot,
        endpoint: result.endpoint,
        ...(result.model !== undefined ? { model: result.model } : {}),
      },
      schemaVersion: DISTILLATE_SCHEMA_VERSION,
      createdAt,
    }
    this.store.saveDistillate(distillate)
    await this.publishDistillate?.(distillate)

    this.counts.processed++
    this.log(`screen frame ${chunk.id} → ocr (${result.text.length} chars) via ${result.endpoint} [${result.slot}]`)
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
