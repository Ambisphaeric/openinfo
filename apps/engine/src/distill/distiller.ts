import { randomUUID } from 'node:crypto'
import type { CaptureChunk, Distillate, Entity, EntityProvenance, Moment, Mode, PromptTemplate, VoiceBinding } from '@openinfo/contracts'
import { DISTILLATE_SCHEMA_VERSION } from '@openinfo/contracts'
import { FabricDocuments, invokeLlm, type InvokeOptions, type LlmMessage, type LlmResult } from '../fabric/index.js'
import { entityMentioned, extractEntities } from '../index/index.js'
import type { WorkspaceRegistry } from '../store/index.js'
import { VoiceDocuments, compileVoiceVars, interpolateTemplate, resolveVoice } from '../voice/index.js'
import { bucketIntoWindows } from './merge.js'
import { DistillDocuments } from './documents.js'
import { extractMoments, type ExtractInput } from './moments.js'
import { speakerLabel } from './transcribe.js'

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
  /** publish distillate.updated so it reaches WS clients; optional (tests may omit) */
  publish?: (distillate: Distillate) => void | Promise<void>
  /** publish moment.created per extracted moment; optional (tests may omit) */
  publishMoment?: (moment: Moment) => void | Promise<void>
  /** publish entity.updated per resolved entity upsert; optional (tests may omit) */
  publishEntity?: (entity: Entity) => void | Promise<void>
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
  private readonly publishEntity: ((e: Entity) => void | Promise<void>) | undefined
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
    this.publishEntity = deps.publishEntity
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => randomUUID())
    this.log = deps.log ?? (() => undefined)
    this.invoke = deps.invoke ?? ((messages, opts) => invokeLlm(this.fabric.load(), messages, opts))
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
        // Speaker attribution for free (see transcribe.ts::speakerLabel): mic → "me", system-audio →
        // "them". Prefixing the transcript line is the least-invasive carry — it flows unchanged into
        // {{transcript}} for the summary AND the moment/entity extraction prompts, so the model can
        // attribute speakers (echoed into Moment.speaker) without a diarizer. Sources with no speaker
        // (screen/calendar/repo/camera) are left bare.
        const transcript = window.chunks
          .map((chunk) => {
            const label = speakerLabel(chunk.source)
            return label ? `${label}: ${chunk.data}` : chunk.data
          })
          .join('\n')
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
            invoke: this.invoke,
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
            { invoke: this.invoke, template: entitiesTemplate, log: this.log, maxTokens: mode.distill.tokenBudget },
          )
          const provenance: EntityProvenance = {
            distillateId: distillate.id,
            windowStart: window.start,
            windowEnd: window.end,
            slot: 'llm',
            endpoint: result.endpoint,
            ...(result.model !== undefined ? { model: result.model } : {}),
          }
          for (const candidate of extraction.entities) {
            const mentionedBy = windowMoments.filter((m) => entityMentioned(m.text, candidate.name, candidate.aliases))
            const entity = this.store.upsertEntity({
              workspaceId,
              kind: candidate.kind,
              name: candidate.name,
              aliases: candidate.aliases,
              seenAt: window.end,
              provenance,
              momentRefs: mentionedBy.map((m) => m.id),
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
