import { randomUUID } from 'node:crypto'
import type { CaptureChunk, Distillate, Moment, Mode, PromptTemplate, VoiceBinding } from '@openinfo/contracts'
import { DISTILLATE_SCHEMA_VERSION } from '@openinfo/contracts'
import { FabricDocuments, invokeLlm, type InvokeOptions, type LlmMessage, type LlmResult } from '../fabric/index.js'
import type { WorkspaceRegistry } from '../store/index.js'
import { VoiceDocuments, compileVoiceVars, interpolateTemplate, resolveVoice } from '../voice/index.js'
import { bucketIntoWindows } from './merge.js'
import { DistillDocuments } from './documents.js'
import { extractMoments, type ExtractInput } from './moments.js'

export type LlmInvoke = (messages: LlmMessage[], opts: InvokeOptions) => Promise<LlmResult>

/** Per-pass toggles the wiring reads from flags (distill.enabled gates the pass itself). */
export interface DistillOptions {
  /** run typed-moment extraction as a second call per window (gated on distill.moments). */
  extractMoments?: boolean
}

export interface DistillerDeps {
  store: WorkspaceRegistry
  voice: VoiceDocuments
  fabric: FabricDocuments
  docs: DistillDocuments
  /** publish distillate.updated so it reaches WS clients; optional (tests may omit) */
  publish?: (distillate: Distillate) => void | Promise<void>
  /** publish moment.created per extracted moment; optional (tests may omit) */
  publishMoment?: (moment: Moment) => void | Promise<void>
  /** injectable for tests; defaults to invoking the fabric llm slot */
  invoke?: LlmInvoke
  now?: () => Date
  newId?: () => string
  log?: (message: string) => void
}

/** Only utf8 text chunks distill in v0; screen/base64 frames defer to OCR (P3). */
const isText = (chunk: CaptureChunk): boolean => chunk.encoding === 'utf8'

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
  private readonly publish: ((d: Distillate) => void | Promise<void>) | undefined
  private readonly publishMoment: ((m: Moment) => void | Promise<void>) | undefined
  private readonly invoke: LlmInvoke
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly log: (message: string) => void

  constructor(deps: DistillerDeps) {
    this.store = deps.store
    this.voice = deps.voice
    this.fabric = deps.fabric
    this.docs = deps.docs
    this.publish = deps.publish
    this.publishMoment = deps.publishMoment
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => randomUUID())
    this.log = deps.log ?? (() => undefined)
    this.invoke = deps.invoke ?? ((messages, opts) => invokeLlm(this.fabric.load(), messages, opts))
  }

  async distillChunks(chunks: readonly CaptureChunk[], opts: DistillOptions = {}): Promise<Distillate[]> {
    const text = chunks.filter(isText)
    if (text.length === 0) return []
    const mode: Mode = this.docs.mode()
    const template: PromptTemplate = this.docs.template()
    const extractTemplate: PromptTemplate = this.docs.extractTemplate()
    const registers = this.voice.registers()
    // A mode's registerId IS its mode-scope default binding (IMPLEMENTATION §1: "a mode declares a
    // default"). Explicit stored bindings come first so they win the mode scope over this default.
    const modeDefault: VoiceBinding[] =
      mode.registerId !== undefined ? [{ scope: 'mode', targetId: mode.id, registerId: mode.registerId }] : []
    const bindings = [...this.voice.bindings(), ...modeDefault]
    const produced: Distillate[] = []

    for (const [sessionId, sessionChunks] of groupBySession(text)) {
      const windows = bucketIntoWindows(sessionChunks, mode.distill.mergeWindow)
      for (const window of windows) {
        const workspaceId = window.chunks[0]!.workspaceId
        const resolved = resolveVoice(registers, bindings, { sessionId, workspaceId, modeId: mode.id })
        const transcript = window.chunks.map((chunk) => chunk.data).join('\n')
        const prompt = interpolateTemplate(template.body, {
          ...compileVoiceVars(resolved.dials),
          transcript,
          windowStart: window.start,
          windowEnd: window.end,
        })
        const messages: LlmMessage[] = [{ role: 'user', content: prompt }]
        const result = await this.invoke(messages, { maxTokens: mode.distill.tokenBudget })

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
            invoke: this.invoke,
            template: extractTemplate,
            now: this.now,
            newId: this.newId,
            log: this.log,
            maxTokens: mode.distill.tokenBudget,
          })
          for (const moment of extraction.moments) {
            this.store.saveMoment(moment)
            await this.publishMoment?.(moment)
          }
          this.log(`extracted ${extraction.moments.length} moment(s) (dropped ${extraction.dropped}) from window ${window.start}→${window.end}`)
        }
      }
    }
    return produced
  }
}
