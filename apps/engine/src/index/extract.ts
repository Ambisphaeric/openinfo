import type { Dials, Entity, PromptTemplate } from '@openinfo/contracts'
import { parseJsonCandidates } from '../distill/parse.js'
import type { LlmInvoke } from '../distill/distiller.js'
import type { LlmResult } from '../fabric/index.js'
import { compileVoiceVars, interpolateTemplate } from '../voice/index.js'

/**
 * One window's entity-extraction inputs. Like the moment extractor, this is store-free and bus-free
 * (pure given its injected deps) so it unit-tests against a canned llm without sqlite: the distiller
 * resolves/upserts the returned candidates into persisted Entity records (store owns ids + merge).
 */
export interface ExtractEntitiesInput {
  transcript: string
  /** the distillate summary just produced for this window — extra context for the extractor */
  summary: string
  windowStart: string
  windowEnd: string
  dials: Dials
}

export interface ExtractEntitiesDeps {
  invoke: LlmInvoke
  template: PromptTemplate
  log?: (message: string) => void
  /** bounded in-call re-sample when a response is wholly unparseable (default 2). */
  maxAttempts?: number
  maxTokens?: number
}

/**
 * A resolved-name-normalized entity candidate as read off the model, before the store merges it
 * into a canonical record. `kind`/`name` are validated here; ids, timestamps, mention counts and
 * provenance are all store-stamped, never trusted from the model.
 */
export interface EntityCandidate {
  kind: Entity['kind']
  name: string
  aliases: string[]
}

export interface ExtractEntitiesResult {
  entities: EntityCandidate[]
  /** candidates that parsed as objects but failed the shape check — dropped, not retried. */
  dropped: number
  /** llm calls made (≥1; >1 only when an earlier response was wholly unparseable). */
  attempts: number
  /** The ACTUAL completion that produced this candidate set (safe invoke metadata + model text in-memory
   * only). Distiller persists only its endpoint/model/usage/egress/guard fields, never the raw response. */
  invokeResult?: LlmResult
}

const ENTITY_KINDS = new Set<Entity['kind']>(['person', 'artifact', 'topic'])

/** Normalize a name for matching/dedup: trim, lowercase, collapse internal whitespace. */
export const normalizeName = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, ' ')

const toCandidate = (raw: unknown): EntityCandidate | undefined => {
  if (raw === null || typeof raw !== 'object') return undefined
  const c = raw as Record<string, unknown>
  const kind = c['kind']
  if (typeof kind !== 'string' || !ENTITY_KINDS.has(kind as Entity['kind'])) return undefined
  const name = typeof c['name'] === 'string' ? c['name'].trim() : ''
  if (name.length === 0) return undefined
  const rawAliases = Array.isArray(c['aliases']) ? c['aliases'] : []
  const aliases = Array.from(
    new Set(
      rawAliases
        .filter((a): a is string => typeof a === 'string')
        .map((a) => a.trim())
        .filter((a) => a.length > 0 && normalizeName(a) !== normalizeName(name)),
    ),
  )
  return { kind: kind as Entity['kind'], name, aliases }
}

/** Escape a string for use inside a RegExp. */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Post-hoc name matching for Moment.refs linking (v0): does `text` mention this entity by its name
 * or any alias, at a word boundary (case-insensitive)? Deliberately simple — no coreference, no
 * pronoun resolution, no fuzzy matching (documented weakness in PHASE2-NOTES).
 */
export const entityMentioned = (text: string, name: string, aliases: readonly string[] = []): boolean => {
  for (const term of [name, ...aliases]) {
    const trimmed = term.trim()
    if (trimmed.length === 0) continue
    if (new RegExp(`\\b${escapeRegExp(trimmed)}\\b`, 'i').test(text)) return true
  }
  return false
}

/**
 * Extract zero or more entity candidates from one merge window. Same malformed-output policy as the
 * moment extractor (parse defensively, validate every candidate's shape, drop invalid, bounded
 * re-sample on a wholly unparseable response, transport failures propagate to the drain re-queue).
 * Zero entities is a normal outcome. Entity extraction is a THIRD tight call per window (see
 * PHASE2-NOTES: one job/one grammar per call beats a compound response on 3–8B local models).
 */
export const extractEntities = async (
  input: ExtractEntitiesInput,
  deps: ExtractEntitiesDeps,
): Promise<ExtractEntitiesResult> => {
  const log = deps.log ?? (() => undefined)
  const maxAttempts = Math.max(1, deps.maxAttempts ?? 2)

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
    const result = await deps.invoke([{ role: 'user', content: prompt }], { maxTokens: deps.maxTokens ?? 500 })
    const { candidates, parsedAnything } = parseJsonCandidates(result.text, 'entities')
    if (!parsedAnything) {
      if (attempt < maxAttempts) {
        log(`entity extraction: unparseable response on attempt ${attempt}, re-sampling`)
        continue
      }
      log(`entity extraction: unparseable after ${maxAttempts} attempts, dropping window ${input.windowStart}`)
      return { entities: [], dropped: 0, attempts, invokeResult: result }
    }
    const entities: EntityCandidate[] = []
    let dropped = 0
    for (const candidate of candidates) {
      const entity = toCandidate(candidate)
      if (entity) entities.push(entity)
      else dropped += 1
    }
    if (dropped > 0) log(`entity extraction: kept ${entities.length}, dropped ${dropped} invalid`)
    return { entities, dropped, attempts, invokeResult: result }
  }
  return { entities: [], dropped: 0, attempts }
}
