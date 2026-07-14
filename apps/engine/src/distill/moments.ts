import { randomUUID } from 'node:crypto'
import type { CaptureSource, Dials, Moment, PromptTemplate } from '@openinfo/contracts'
import { Moment as MomentSchema } from '@openinfo/contracts'
import { Value } from '@sinclair/typebox/value'
import { compileVoiceVars, interpolateTemplate } from '../voice/index.js'
import { parseJsonCandidates } from './parse.js'
import type { LlmInvoke } from './distiller.js'

/**
 * One window's extraction inputs. The extractor is deliberately store-free and bus-free (pure
 * given its deps) so it unit-tests against a canned llm without touching sqlite: the distiller
 * persists + publishes the returned moments.
 */
export interface ExtractInput {
  transcript: string
  /** the distillate summary just produced for this window — extra context for the extractor */
  summary: string
  sessionId: string
  workspaceId: string
  windowStart: string
  windowEnd: string
  source: CaptureSource
  dials: Dials
  /** provenance carried onto every extracted moment */
  distillateId: string
  /** #116: the window pass's correlation id, shared with the distillate — stamped on every moment. */
  spanId?: string
  endpoint: string
  model?: string
  slot: 'llm'
}

export interface ExtractDeps {
  invoke: LlmInvoke
  template: PromptTemplate
  now?: () => Date
  newId?: () => string
  log?: (message: string) => void
  /** bounded in-call re-sample when a response is wholly unparseable (default 2). */
  maxAttempts?: number
  maxTokens?: number
}

export interface ExtractResult {
  moments: Moment[]
  /** candidates that parsed as objects but failed the Moment contract — dropped, not retried. */
  dropped: number
  /** llm calls made (≥1; >1 only when an earlier response was wholly unparseable). */
  attempts: number
}

/** The model-controlled fields we read off each candidate; everything else is server-stamped. */
const MOMENT_KINDS = new Set(['commitment', 'question', 'decision', 'artifact'])

/**
 * Defensively parse an llm response into candidate moment objects (shared parse helper in parse.ts).
 * Unwraps a `{ "moments": [...] }` object; a clean `[]` is a normal zero-moment window, not an error.
 */
export const parseMomentCandidates = (raw: string): { candidates: unknown[]; parsedAnything: boolean } =>
  parseJsonCandidates(raw, 'moments')

/** Build a full Moment from a raw candidate + server-stamped fields, then validate. */
const toMoment = (candidate: unknown, input: ExtractInput, newId: () => string, at: string): Moment | undefined => {
  if (candidate === null || typeof candidate !== 'object') return undefined
  const c = candidate as Record<string, unknown>
  const kind = c['kind']
  if (typeof kind !== 'string' || !MOMENT_KINDS.has(kind)) return undefined
  const text = typeof c['text'] === 'string' ? c['text'].trim() : ''
  if (text.length === 0) return undefined

  const moment: Moment = {
    id: newId(),
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    at,
    kind: kind as Moment['kind'],
    text,
    refs: [],
    source: input.source,
    confidence: typeof c['confidence'] === 'number' ? Math.max(0, Math.min(1, c['confidence'])) : 0.5,
    ...(input.spanId !== undefined ? { spanId: input.spanId } : {}),
    provenance: {
      distillateId: input.distillateId,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      slot: input.slot,
      endpoint: input.endpoint,
      ...(input.model !== undefined ? { model: input.model } : {}),
    },
  }
  if (typeof c['speaker'] === 'string' && c['speaker'].trim().length > 0) moment.speaker = c['speaker'].trim()
  if (kind === 'question' && typeof c['answered'] === 'boolean') moment.answered = c['answered']

  // Validate the FULL record against the contract — the last line of defense; malformed candidates
  // (bad kind, out-of-range confidence, stray fields) are dropped here, never persisted.
  return Value.Check(MomentSchema, moment) ? moment : undefined
}

/**
 * Extract zero or more typed moments from one merge window. Robust to the malformed JSON small
 * local models emit: parse defensively, validate every candidate against the Moment contract, drop
 * the invalid. A wholly unparseable response is re-sampled up to `maxAttempts` times (bounded), then
 * yields []. Transport failures from `invoke` propagate so the distiller's drain re-queues the file
 * for retry-at-idle. Zero valid moments is a normal outcome, not an error.
 */
export const extractMoments = async (input: ExtractInput, deps: ExtractDeps): Promise<ExtractResult> => {
  const newId = deps.newId ?? (() => randomUUID())
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? (() => undefined)
  const maxAttempts = Math.max(1, deps.maxAttempts ?? 2)
  const at = input.windowEnd

  const prompt = interpolateTemplate(deps.template.body, {
    ...compileVoiceVars(input.dials),
    transcript: input.transcript,
    summary: input.summary,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
  })

  let attempts = 0
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt
    const result = await deps.invoke([{ role: 'user', content: prompt }], { maxTokens: deps.maxTokens ?? 700 })
    const { candidates, parsedAnything } = parseMomentCandidates(result.text)
    if (!parsedAnything) {
      if (attempt < maxAttempts) {
        log(`moment extraction: unparseable response on attempt ${attempt}, re-sampling`)
        continue
      }
      log(`moment extraction: unparseable after ${maxAttempts} attempts, dropping window ${input.windowStart}`)
      return { moments: [], dropped: 0, attempts }
    }
    const moments: Moment[] = []
    let dropped = 0
    for (const candidate of candidates) {
      const moment = toMoment(candidate, input, newId, at)
      if (moment) moments.push(moment)
      else dropped += 1
    }
    if (dropped > 0) log(`moment extraction: salvaged ${moments.length}, dropped ${dropped} invalid`)
    return { moments, dropped, attempts }
  }
  return { moments: [], dropped: 0, attempts }
}
