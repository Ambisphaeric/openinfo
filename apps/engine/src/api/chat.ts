import type { ChatBudget, ChatCitation, ChatReply, ChatRequest, Entity, Fabric, PinChunk, RelevantEntity } from '@openinfo/contracts'
import {
  invokeLlm,
  resolveEgress,
  egressDecision,
  type EgressConsent,
  type GuardOptions,
  type LlmMessage,
  type LocalRuntimeManager,
  type SecretResolver,
} from '../fabric/index.js'

/**
 * The below-HUD chat shell's engine seam (#134). The chat is answered by the LLM slot WITH THE CORPUS IN
 * HAND — relevant entities plus cited pin chunks when a document is attached — not a vanilla completion.
 * Every design pressure the owner named lives here:
 *  - context enters DISTILLED/CHUNKED (cited excerpts up to a char cap), never raw-stuffed, because small
 *    local models get only a few useful turns against a big document;
 *  - the turn/context budget is HONEST and VISIBLE (disclosed truncation, an estimated turns-remaining),
 *    never a silent trim;
 *  - the hop is egress-gated like every other invoke (resolveEgress + the #63 guard);
 *  - a failure is NOT smoothed over — runChat throws, and the route paints the reason as visible text.
 *
 * The pure pieces (assembleContext / computeBudget) are unit-tested without a live model; runChat wires
 * them to the store reads + invoke over a narrow ChatDeps the route builds from its HandlerContext.
 */

/** Cheap, honest token estimate (chars/4, the widely-used heuristic) — MARKED as an estimate by the budget note. */
export const estimateTokens = (text: string): number => (text.length === 0 ? 0 : Math.ceil(text.length / 4))

/** Cap on the assembled pin-chunk context (chars). ~6k chars ≈ ~1.5k tokens — room for a big doc's cited excerpts without drowning a small model. */
export const MAX_CONTEXT_CHARS = 6000
/** Per-chunk excerpt cap (chars) — proof-of-source, not the whole chunk. */
const EXCERPT_CHARS = 320
/** Conservative small-model context window (tokens) the honest budget is estimated against; disclosed as an estimate in the note. */
export const ASSUMED_CONTEXT_WINDOW = 8192
/** Max output tokens per chat invoke. */
export const CHAT_MAX_TOKENS = 512
/** How many relevant entities to name in the corpus context. */
const MAX_ENTITIES = 8

const cite = (chunk: PinChunk): string => (chunk.page !== undefined ? `p.${chunk.page}` : `#${chunk.ordinal}`)

const clip = (text: string, max: number): string => {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

export interface AssembledContext {
  /** the corpus block spliced into the system prompt (entities + cited excerpts), '' when nothing is known */
  contextText: string
  citations: ChatCitation[]
  /** true ⇒ the attached pin had more chunks than the char budget allowed — disclosed, never silent */
  truncated: boolean
  /** how many of the pin's chunks were cited (0 ⇒ none / no pin) */
  citedChunks: number
  /** the pin's total chunk count (0 ⇒ no pin) */
  totalChunks: number
}

/**
 * Assemble the corpus context (PURE). Names the top relevant entities, then packs the attached pin's chunks
 * in ordinal order until the char budget is hit — each packed chunk becomes a labeled, citable excerpt AND a
 * ChatCitation. When chunks are left over, `truncated` is set so the budget note can disclose exactly what
 * was dropped. No pin ⇒ entities-only context; nothing known ⇒ '' (the caller still answers, honestly bare).
 */
export const assembleContext = (input: {
  entities: readonly RelevantEntity[]
  pinTitle?: string | undefined
  pinId?: string | undefined
  chunks: readonly PinChunk[]
  maxContextChars?: number
}): AssembledContext => {
  const budget = input.maxContextChars ?? MAX_CONTEXT_CHARS
  const parts: string[] = []
  const citations: ChatCitation[] = []

  const entities = input.entities.slice(0, MAX_ENTITIES)
  if (entities.length > 0) {
    const lines = entities.map((r: RelevantEntity) => {
      const e: Entity = r.entity
      const recent = r.moments[0]?.text
      return recent ? `- ${e.name} (${e.kind}) — ${clip(recent, 120)}` : `- ${e.name} (${e.kind})`
    })
    parts.push(`Known in this session:\n${lines.join('\n')}`)
  }

  let citedChunks = 0
  const totalChunks = input.chunks.length
  if (input.pinId !== undefined && totalChunks > 0) {
    const excerptLines: string[] = []
    let used = 0
    for (const chunk of input.chunks) {
      const excerpt = clip(chunk.text, EXCERPT_CHARS)
      if (used > 0 && used + excerpt.length > budget) break // keep at least one excerpt even if it alone exceeds the cap
      excerptLines.push(`[${cite(chunk)}] ${excerpt}`)
      citations.push({
        pinId: input.pinId,
        ...(input.pinTitle !== undefined ? { pinTitle: input.pinTitle } : {}),
        ordinal: chunk.ordinal,
        ...(chunk.page !== undefined ? { page: chunk.page } : {}),
        excerpt,
      })
      used += excerpt.length
      citedChunks += 1
    }
    const title = input.pinTitle ?? 'the attached document'
    parts.push(`Excerpts from ${title} (cite the [p.N] / [#N] tags in your answer):\n${excerptLines.join('\n')}`)
  }

  return {
    contextText: parts.join('\n\n'),
    citations,
    truncated: citedChunks < totalChunks,
    citedChunks,
    totalChunks,
  }
}

/**
 * Compute the HONEST turn/context budget (PURE). `contextTokens` is the estimated size of the corpus +
 * history the model re-reads each turn; `turnsRemaining` estimates how many more turns fit before the
 * assumed window fills (each turn costs the re-sent context plus one answer). The `note` is a single
 * human line — safe to surface — that discloses the truncation (when any) and the turns estimate.
 */
export const computeBudget = (input: {
  contextTokens: number
  historyTokens: number
  maxTokens?: number
  window?: number
  truncated: boolean
  citedChunks: number
  totalChunks: number
}): ChatBudget => {
  const maxTokens = input.maxTokens ?? CHAT_MAX_TOKENS
  const window = input.window ?? ASSUMED_CONTEXT_WINDOW
  const contextTokens = input.contextTokens + input.historyTokens
  const perTurn = Math.max(1, input.contextTokens + maxTokens) // context is re-sent each turn + the answer
  const turnsRemaining = Math.max(0, Math.floor((window - contextTokens - maxTokens) / perTurn))

  const truncNote = input.truncated
    ? `Attached doc is large — cited ${input.citedChunks} of ${input.totalChunks} chunks; ask a narrower question to reach the rest. `
    : ''
  const note = `${truncNote}~${turnsRemaining} useful turn${turnsRemaining === 1 ? '' : 's'} left (est. against a ${window}-token window; token counts are estimates).`

  return { contextTokens, maxTokens, turnsRemaining, truncated: input.truncated, note }
}

/** The narrow dependency surface runChat needs — the route builds it from its HandlerContext. */
export interface ChatDeps {
  fabric: Fabric
  relevant(workspaceId: string): RelevantEntity[]
  pinTitle(workspaceId: string, pinId: string): string | undefined
  pinChunks(workspaceId: string, pinId: string): PinChunk[]
  workspaceDeniesEgress(workspaceId: string): boolean
  guard?: GuardOptions | undefined
  resolveKey: SecretResolver
  runtimeManager: LocalRuntimeManager
}

const SYSTEM_PREAMBLE =
  'You are the openinfo assistant. Answer the user using ONLY the context provided below when it is relevant; ' +
  'if the context does not cover the question, say so plainly rather than inventing. When you use an excerpt, ' +
  'cite its [p.N] or [#N] tag inline. Be concise.'

/**
 * Run one chat turn. Reads the corpus (relevant entities + the attached pin's chunks) from the store,
 * assembles the distilled/chunked context, resolves egress consent (content is user-`typed`), and invokes
 * the llm slot with the #63 guard when configured. Returns the answer + citations + honest budget, or
 * THROWS (empty llm slot, guard hold, transport failure) so the route surfaces the reason as visible text.
 */
export const runChat = async (deps: ChatDeps, request: ChatRequest): Promise<ChatReply> => {
  const workspaceId = request.workspace ?? 'default'
  const entities = deps.relevant(workspaceId)
  const chunks = request.pinId !== undefined ? deps.pinChunks(workspaceId, request.pinId) : []
  const pinTitle = request.pinId !== undefined ? deps.pinTitle(workspaceId, request.pinId) : undefined

  const assembled = assembleContext({
    entities,
    ...(request.pinId !== undefined ? { pinId: request.pinId } : {}),
    ...(pinTitle !== undefined ? { pinTitle } : {}),
    chunks,
  })

  const system = assembled.contextText === '' ? SYSTEM_PREAMBLE : `${SYSTEM_PREAMBLE}\n\n${assembled.contextText}`
  const history: LlmMessage[] = (request.history ?? []).map((t) => ({ role: t.role, content: t.content }))
  const messages: LlmMessage[] = [{ role: 'system', content: system }, ...history, { role: 'user', content: request.message }]

  // Every hop is egress-gated (#64): the chat message is user-`typed` content, which MAY egress unless the
  // workspace denies. The #63 guard rides alongside when configured — an allowed egress hop is filtered
  // (redact / hold) before any bytes leave; a hold throws out of invokeLlm and the route surfaces it.
  const consent: EgressConsent = resolveEgress({ contentClass: 'typed', workspaceDenies: deps.workspaceDeniesEgress(workspaceId) })

  const result = await invokeLlm(deps.fabric, messages, {
    maxTokens: CHAT_MAX_TOKENS,
    timeoutMs: 30_000,
    resolveKey: deps.resolveKey,
    runtimeManager: deps.runtimeManager,
    egress: consent,
    ...(deps.guard !== undefined ? { guard: deps.guard } : {}),
  })

  const historyTokens = history.reduce((n, m) => n + estimateTokens(m.content), 0)
  const budget = computeBudget({
    contextTokens: estimateTokens(system),
    historyTokens,
    truncated: assembled.truncated,
    citedChunks: assembled.citedChunks,
    totalChunks: assembled.totalChunks,
  })

  const reply: ChatReply = { answer: result.text, citations: assembled.citations, budget }
  if (result.endpoint !== undefined) reply.endpoint = result.endpoint
  reply.egress = result.egress ?? egressDecision('local', consent)
  return reply
}
