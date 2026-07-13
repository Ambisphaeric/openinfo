import type { ChatBudget, ChatContextSource, ChatReply, ChatRequest, ChatScreenshot, ChatTurn, Fabric, PinChunk, RelevantEntity, TranscriptUpdate } from '@openinfo/contracts'
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
import {
  assembleChatContext,
  describeAssembly,
  estimateTokens,
  type ActivePresetRef,
  type GatheredContext,
} from './context-assembly.js'

/**
 * The below-HUD chat shell's engine seam (#134), now reading the DECLARATION (pill P1). The chat is answered
 * by the LLM slot WITH THE CORPUS IN HAND, but WHAT enters the corpus and under what caps is no longer
 * hard-coded here — it is the governing bundle's `chat.contextAssembly`, an ordered list of the seven
 * declared sources with honest budgets. runChat gathers each source's data (impure store reads via ChatDeps)
 * and hands it, with the declared sources, to the PURE assembler in context-assembly.ts. Change the
 * declaration (PUT /bundles) and assembly changes with NO code change — context assembly is DATA, NOT CODE.
 *
 * Every design pressure the owner named still lives here:
 *  - context enters DISTILLED/CHUNKED under each source's DECLARED cap, never raw-stuffed;
 *  - the turn/context budget is HONEST and VISIBLE — the note now names what each source contributed and what
 *    was omitted and WHY (empty / unavailable / capped), never a silent trim;
 *  - the hop is egress-gated like every other invoke (resolveEgress + the #63 guard);
 *  - a failure is NOT smoothed over — runChat throws, and the route paints the reason as visible text.
 */

// estimateTokens lives with the pure assembler; re-exported so its existing importers keep working.
export { estimateTokens } from './context-assembly.js'

/** Conservative small-model context window (tokens) the honest budget is estimated against; disclosed as an estimate in the note. */
export const ASSUMED_CONTEXT_WINDOW = 8192
/** Max output tokens per chat invoke. */
export const CHAT_MAX_TOKENS = 512

/**
 * The bundle's own chat priming prompt. The Standard App carries no custom prompt document yet, so its
 * priming IS this shipped engine default (the persona + the cite-your-tags instruction). It is delivered
 * through the DECLARED `bundle-prompt` source, so a bundle that omits that source runs without priming —
 * a declaration choice, disclosed in the accounting, not a code path. A future custom-prompt bundle field
 * would feed this same source (additive, a later slice).
 */
export const BUNDLE_PROMPT =
  'You are the openinfo assistant. Answer the user using ONLY the context provided below when it is relevant; ' +
  'if the context does not cover the question, say so plainly rather than inventing. When you use an excerpt, ' +
  'cite its [p.N] or [#N] tag inline. Be concise.'

/**
 * Compute the HONEST turn/context budget (PURE). `contextTokens` is the estimated size of the corpus +
 * history the model re-reads each turn; `turnsRemaining` estimates how many more turns fit before the
 * assumed window fills (each turn costs the re-sent context plus one answer). The `note` prepends the
 * per-source assembly disclosure (what entered, what was omitted and why) to the turns estimate — one
 * human line, safe to surface, that never hides a truncation.
 */
export const computeBudget = (input: {
  contextTokens: number
  historyTokens: number
  maxTokens?: number
  window?: number
  truncated: boolean
  assemblyNote: string
}): ChatBudget => {
  const maxTokens = input.maxTokens ?? CHAT_MAX_TOKENS
  const window = input.window ?? ASSUMED_CONTEXT_WINDOW
  const contextTokens = input.contextTokens + input.historyTokens
  const perTurn = Math.max(1, input.contextTokens + maxTokens) // context is re-sent each turn + the answer
  const turnsRemaining = Math.max(0, Math.floor((window - contextTokens - maxTokens) / perTurn))

  const note = `${input.assemblyNote} ~${turnsRemaining} useful turn${turnsRemaining === 1 ? '' : 's'} left (est. against a ${window}-token window; token counts are estimates).`

  return { contextTokens, maxTokens, turnsRemaining, truncated: input.truncated, note }
}

/**
 * The narrow dependency surface runChat needs — the route builds it from its HandlerContext. `contextSources`
 * is the governing bundle's DECLARED assembly plan (the route resolves the bundle); the gatherers do the
 * impure per-source store reads the pure assembler consumes. `resolveActivePreset` is the OPTIONAL P2-owned
 * preset read-seam — omit it and the `active-preset` source degrades honestly to `unavailable`.
 */
export interface ChatDeps {
  fabric: Fabric
  contextSources: readonly ChatContextSource[]
  bundlePrompt: string
  relevant(workspaceId: string): RelevantEntity[]
  /** Ephemeral source-tagged transcript records for sessions owned by this workspace. */
  transcript(workspaceId: string): TranscriptUpdate[]
  insights(workspaceId: string): string[]
  pinTitle(workspaceId: string, pinId: string): string | undefined
  pinChunks(workspaceId: string, pinId: string): PinChunk[]
  resolveActivePreset?: ((workspaceId: string) => ActivePresetRef | undefined) | undefined
  workspaceDeniesEgress(workspaceId: string): boolean
  guard?: GuardOptions | undefined
  resolveKey: SecretResolver
  runtimeManager: LocalRuntimeManager
  /**
   * Read the request's screenshot into TEXT (the Ask face `screen` source): the route runs the frame
   * through the screen-understanding path (ocr slot, VLM fallback) under content-class `screen` egress
   * consent — the frame can never leave the machine; only its derived text enters the (guarded) chat hop.
   * OPTIONAL seam: absent while a frame shipped ⇒ the source degrades honestly to `unavailable`.
   */
  screenText?: ((workspaceId: string, screenshot: ChatScreenshot) => Promise<string>) | undefined
  /**
   * The workspace's PERSISTED chat thread (ask-history) — the store-backed truth the `recent-turns`
   * source prefers over the request's client-supplied `history`. OPTIONAL seam: absent ⇒ request.history
   * (the pre-persistence behavior); present-but-empty with a non-empty request.history ⇒ the request's
   * turns still count (a client mid-conversation against a fresh store is not amnesiac).
   */
  recentTurns?: ((workspaceId: string) => ChatTurn[]) | undefined
  /**
   * Streaming seam (the Ask face): forwarded to the llm invoke — each answer chunk lands here as the
   * model emits it (the route publishes them as ephemeral `chat.delta` events). Absent ⇒ buffered invoke,
   * byte-for-byte the legacy request. The returned ChatReply remains the authoritative answer either way.
   */
  onDelta?: ((text: string) => void) | undefined
}

/**
 * Run one chat turn. Gathers each declared source's data from the store, assembles the context by iterating
 * the DECLARED sources in order (honoring each source's cap), resolves egress consent (content is user-`typed`),
 * and invokes the llm slot with the #63 guard when configured. Returns the answer + citations + honest budget
 * (whose note discloses the per-source assembly), or THROWS (empty llm slot, guard hold, transport failure) so
 * the route surfaces the reason as visible text.
 */
export const runChat = async (deps: ChatDeps, request: ChatRequest): Promise<ChatReply> => {
  const workspaceId = request.workspace ?? 'default'

  // Ask face `screen` source: read the shipped frame into text through the seam (ocr/vlm under `screen`
  // consent, route-owned). Three honest states for the assembler — no frame / unreadable / text in hand.
  // A read failure NEVER fails the turn: the send proceeds without the screen and the note says so.
  const screen: GatheredContext['screen'] =
    request.screenshot === undefined
      ? { attempted: false }
      : deps.screenText === undefined
        ? { attempted: true, failure: 'no screen-understanding path wired' }
        : await deps
            .screenText(workspaceId, request.screenshot)
            .then((text): GatheredContext['screen'] => ({ attempted: true, text }))
            .catch((error: unknown): GatheredContext['screen'] => ({ attempted: true, failure: error instanceof Error ? error.message : String(error) }))

  // Ask-history: the persisted per-workspace thread is the truth when the seam is wired; the request's
  // client-supplied history still counts against a fresh/empty store (never amnesiac mid-conversation).
  const persistedTurns = deps.recentTurns?.(workspaceId) ?? []
  const recentTurns = persistedTurns.length > 0 ? persistedTurns : (request.history ?? [])

  const gathered: GatheredContext = {
    bundlePrompt: deps.bundlePrompt,
    activePreset:
      deps.resolveActivePreset === undefined
        ? { available: false }
        : { available: true, ref: deps.resolveActivePreset(workspaceId) },
    transcript: deps.transcript(workspaceId),
    insights: deps.insights(workspaceId),
    entities: deps.relevant(workspaceId),
    attachedDocs:
      request.pinId !== undefined
        ? { pinId: request.pinId, pinTitle: deps.pinTitle(workspaceId, request.pinId), chunks: deps.pinChunks(workspaceId, request.pinId) }
        : { chunks: [] },
    recentTurns,
    screen,
  }

  const assembled = assembleChatContext(deps.contextSources, gathered)

  const messages: LlmMessage[] = []
  if (assembled.contextText !== '') messages.push({ role: 'system', content: assembled.contextText })
  for (const turn of assembled.historyTurns) messages.push({ role: turn.role, content: turn.content })
  messages.push({ role: 'user', content: request.message })

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
    ...(deps.onDelta !== undefined ? { onDelta: deps.onDelta } : {}),
  })

  const historyTokens = assembled.historyTurns.reduce((n, turn) => n + estimateTokens(turn.content), 0)
  const budget = computeBudget({
    contextTokens: estimateTokens(assembled.contextText),
    historyTokens,
    truncated: assembled.truncated,
    assemblyNote: describeAssembly(assembled.reports),
  })

  const reply: ChatReply = { answer: result.text, citations: assembled.citations, budget }
  if (result.endpoint !== undefined) reply.endpoint = result.endpoint
  reply.egress = result.egress ?? egressDecision('local', consent)
  return reply
}
