import type { EgressDecision, EgressDestination, EgressReach, Endpoint, Fabric, GuardVerdict, InvokeUsage, OcrInvokeParams, VlmInvokeParams } from '@openinfo/contracts'
import type { SecretResolver } from './secrets.js'
import type { LocalEndpoint, LocalRuntimeManager, RuntimeSpec } from './endpoints/local.js'
import { selectSttAdapter, type SttAdapter, type TranscriptResult } from './stt-adapters.js'
import { classifyDestination, classifyEndpoint, egressDecision, mayReceiveRawFrames, type EgressConsent } from './egress.js'
import { GuardHeldError, runEgressGuard, type GuardOptions } from './guard.js'
import {
  AggregateInvokeError,
  InvokeError,
  classifyFetchError,
  classifyHttpResponse,
  type ClassifiedFailure,
  type InvokeCtx,
} from './invoke-error.js'

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

type HttpEndpoint = Extract<Endpoint, { kind: 'http' }>

/**
 * A `local` endpoint is served by a runtime the engine SPAWNS (ARCHITECTURE §8 tier zero). Given the
 * manager, we ensure its runtime is running and get a localhost url — then speak the SAME OpenAI-compat
 * http the http kind speaks (a spawned runtime IS an http server; the difference is the engine owns its
 * lifecycle). Returns a synthetic http endpoint so the existing http call paths are reused verbatim.
 * Throws (never crashes) when there is no manager or the runtime can't start — the caller falls through.
 */
const resolveLocal = async (
  endpoint: LocalEndpoint,
  manager: LocalRuntimeManager | undefined,
): Promise<{ http: HttpEndpoint; spec: RuntimeSpec }> => {
  if (!manager) throw new Error('local runtime not managed here (no runtime manager)')
  const { url, spec } = await manager.ensureRunning(endpoint)
  const http: HttpEndpoint = { kind: 'http', name: endpoint.name, url, api: 'openai-compat' }
  if (endpoint.model !== '') http.model = endpoint.model
  // A managed-local runtime may still require a bearer (omlx does, even on localhost) — carry the local
  // endpoint's keyRef onto the synthetic http endpoint so authHeaders injects it exactly like the http
  // path. The value is resolved from the secret store at call time; only the ref rides in the document.
  if (endpoint.auth !== undefined) http.auth = endpoint.auth
  return { http, spec }
}

/** The endpoint identity a failure is classified against — name/url/model/keyRef, never a secret value. */
const ctxOf = (endpoint: HttpEndpoint, redactUrlInHint = false): InvokeCtx => ({
  endpoint: endpoint.name,
  url: endpoint.url,
  ...(redactUrlInHint ? { redactUrlInHint: true } : {}),
  ...(endpoint.model !== undefined && endpoint.model !== '' ? { model: endpoint.model } : {}),
  ...(endpoint.auth?.keyRef !== undefined ? { keyRef: endpoint.auth.keyRef } : {}),
})

/** A classification context for ANY endpoint kind (the egress gate runs before an endpoint is resolved to
 * http) — a pseudo-url names a cloud provider / a spawned-local runtime so a skip line stays informative. */
const ctxForGate = (endpoint: Endpoint): InvokeCtx =>
  endpoint.kind === 'http'
    ? { endpoint: endpoint.name, url: endpoint.url, ...(endpoint.model !== undefined && endpoint.model !== '' ? { model: endpoint.model } : {}) }
    : endpoint.kind === 'cloud'
      ? { endpoint: endpoint.name, url: `cloud:${endpoint.provider}`, ...(endpoint.model !== undefined && endpoint.model !== '' ? { model: endpoint.model } : {}) }
      : { endpoint: endpoint.name, url: `local:${endpoint.runtime}` }

type EgressGate =
  | {
      allow: true
      reach: EgressReach
      destination: EgressDestination
      /** Present only when this raw-frame gate used an HTTP endpoint's explicit private-LAN opt-in. */
      rawFrameTrust?: 'explicit'
    }
  | { allow: false }

/**
 * Once a device-boundary peer may have received payload bytes, a later winner would erase that delivery
 * from winner-only provenance. Stop fallback in that case. Failures proven pre-delivery (DNS/connect
 * refusal, missing auth before fetch) may still fall through safely.
 */
const boundaryDeliveryMayHaveOccurred = (gate: Extract<EgressGate, { allow: true }>, error: unknown): boolean =>
  gate.destination !== 'device-local' && (!(error instanceof InvokeError) || error.delivery !== 'none')

/** Convert an ambiguous/confirmed boundary delivery failure into the same durable hold path every LLM
 * caller already owns. This is not a classifier verdict: it is a privacy/audit suspension that prevents a
 * later winner from erasing the attempted delivery. No response body or URL enters the verdict. */
const boundaryDeliveryHold = (
  endpoint: Endpoint,
  gate: Extract<EgressGate, { allow: true }>,
  consent: EgressConsent | undefined,
  error: unknown,
  guarded?: GuardVerdict,
): GuardHeldError => {
  const certainty = error instanceof InvokeError && error.delivery === 'confirmed' ? 'received the request' : 'may have received the request'
  const verdict: GuardVerdict = {
    behavior: guarded?.behavior ?? 'hold-and-surface',
    outcome: 'held',
    guarded: guarded?.guarded ?? false,
    maskedSpanCount: guarded?.maskedSpanCount ?? 0,
    ...(guarded?.spans !== undefined ? { spans: guarded.spans } : {}),
    ...(guarded?.guardEndpoint !== undefined ? { guardEndpoint: guarded.guardEndpoint } : {}),
    ...(guarded?.classifierDestination !== undefined ? { classifierDestination: guarded.classifierDestination } : {}),
    reason: `target endpoint "${endpoint.name}" ${certainty} but did not complete; fallback suspended so that boundary delivery cannot be hidden by a later winner`,
  }
  return new GuardHeldError(verdict, {
    endpoint: endpoint.name,
    url: endpoint.kind === 'http' ? endpoint.url : `${endpoint.kind}:${endpoint.name}`,
    ...(endpoint.model !== undefined && endpoint.model !== '' ? { model: endpoint.model } : {}),
    destination: gate.destination,
    delivery: error instanceof InvokeError && error.delivery === 'confirmed' ? 'confirmed' : 'possible',
    failureClass: error instanceof InvokeError ? error.class : 'unknown',
    ...(consent !== undefined ? { consent } : {}),
  })
}

/**
 * The egress ENFORCEMENT + guard (#63) decision point, run for each candidate endpoint BEFORE any bytes
 * leave (#64). Combines layer 1 (the endpoint's reach) with the resolved content-side consent:
 *  - a network-`local` endpoint is allowed by general consent; destination provenance separately says
 *    whether it stayed on-device or crossed to the private LAN;
 *  - an `egress` endpoint is allowed ONLY when consent permits egress; otherwise it is SKIPPED here and a
 *    classified `egress-denied` failure is recorded, so the invoke falls through to a local endpoint (or,
 *    if none remains, degrades with a visible reason — never a silent skip).
 *
 * >>> GUARD SLOT HOOK (#63): a `{ allow:true, reach:'egress' }` return is precisely where the egress guard
 * (#63) will INTERCEPT the outbound content, AFTER consent allowed egress and BEFORE the endpoint call
 * sends the body. A DENIAL short-circuits HERE, before the guard ever runs — #63 hooks between this gate
 * allowing an egress reach and the callHttp/callVlmHttp/postTranscription that follows.
 */
const egressGate = (
  endpoint: Endpoint,
  consent: EgressConsent | undefined,
  classified: ClassifiedFailure[],
  lines: string[],
  restriction: 'network-local' | 'loopback-only' = 'network-local',
): EgressGate => {
  const reach = classifyEndpoint(endpoint)
  const destination = classifyDestination(endpoint)
  // Raw screen bytes are stricter than the general egress model: private-LAN endpoints count as
  // `local` for ordinary content, but OCR/VLM frames may reach only an engine-managed runtime, an
  // explicit loopback URL, or an http endpoint the USER explicitly flagged `trustRawFrames` — and that
  // flag is honored only for LAN-local hosts (the cap is absolute: a flagged public host stays denied).
  // This check precedes runtime resolution, auth, guards, and fetch.
  if (restriction === 'loopback-only' && !mayReceiveRawFrames(endpoint)) {
    const flagged = endpoint.kind === 'http' && endpoint.trustRawFrames === true
    // The skip line names the REAL reason: no flag ⇒ the loopback default (and how to opt in); flagged
    // but non-local ⇒ the absolute LAN cap; flagged but a wildcard bind ⇒ not a destination host at all.
    const reason = !flagged
      ? 'raw screen frames are loopback-only — set trustRawFrames on this endpoint to allow it'
      : reach === 'egress'
        ? 'raw screen frames require a local-network host — public endpoint skipped despite trustRawFrames'
        : 'raw screen frames require a real local-network host — a wildcard bind address is not a destination'
    const err = new InvokeError('egress-denied', ctxForGate(endpoint), {
      hint: `${reason} — endpoint "${endpoint.name}" was skipped before invocation`,
    })
    classified.push(err.toFailure())
    lines.push(`${endpoint.name}: ${reason}`)
    return { allow: false }
  }
  if (reach === 'local' || consent === undefined || consent.allowed) {
    const trustedLanRawFrame =
      restriction === 'loopback-only' &&
      destination === 'lan-local' &&
      endpoint.kind === 'http' &&
      endpoint.trustRawFrames === true
    return {
      allow: true,
      reach,
      destination,
      ...(trustedLanRawFrame ? { rawFrameTrust: 'explicit' as const } : {}),
    }
  }
  const err = new InvokeError('egress-denied', ctxForGate(endpoint), {
    hint: `${consent.reason} — egress-capable endpoint "${endpoint.name}" was skipped (${consent.decidedBy})`,
  })
  classified.push(err.toFailure())
  lines.push(`${endpoint.name}: egress denied by ${consent.decidedBy} (${consent.reason})`)
  return { allow: false }
}

/**
 * Build the Authorization header for an http endpoint that declares `auth.keyRef` — injected ONLY
 * here, at invoke time, from the secret store (never in documents/logs). Choice of header: a bearer
 * token (`Authorization: Bearer <resolved>`), the OpenAI-compatible convention these endpoints
 * already speak. Throws (before any fetch) a classified `auth` InvokeError when the ref cannot be
 * resolved so the caller falls through to the next endpoint in fabric order — naming the REF, never
 * the value.
 */
const authHeaders = (endpoint: HttpEndpoint, resolveKey: SecretResolver | undefined): Record<string, string> => {
  const keyRef = endpoint.auth?.keyRef
  if (keyRef === undefined) return {}
  const value = resolveKey?.(keyRef)
  if (value === undefined || value === '') {
    throw new InvokeError('auth', ctxOf(endpoint), {
      serverMessage: `no value stored for keyRef "${keyRef}"`,
      hint: `no value stored for key "${keyRef}" — add it in Settings → Keys`,
    })
  }
  return { authorization: `Bearer ${value}` }
}

export interface LlmResult {
  text: string
  endpoint: string
  model?: string
  slot: 'llm'
  /** token accounting for this invoke (#65) — measured from the API `usage` block or estimated + marked. */
  usage?: InvokeUsage
  /** the resolved egress decision this invoke ran under (#64) — present only when consent was supplied. */
  egress?: EgressDecision
  /** the egress guard verdict (#63) — present only when this text invoke crossed the device boundary
   * (LAN-local or hosted/public) with the guard active. A device-local hop never runs it. */
  guard?: GuardVerdict
}

/** The OpenAI-compatible `usage` block (all optional — servers vary; some omit it entirely, some report only a total). */
interface RawUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

/** A cheap, honest token estimate when the server reports no usage: chars/4 (the widely-used heuristic), rounded up. */
const estimateTokens = (text: string): number => (text.length === 0 ? 0 : Math.ceil(text.length / 4))

/**
 * Assemble the #65 token-accounting block for one invoke. When the server reported ANY numeric `usage`
 * field, the counts are MEASURED (`estimated:false`) — a missing total is derived only when both halves
 * are known. Otherwise the counts are chars/4 ESTIMATES over the prompt/completion text and MARKED
 * (`estimated:true`) so a measurement is never impersonated. `durationMs` is wall-clock either way.
 * Generic on purpose: any slot's caller (llm/vlm/ocr — and the judge that flows through invokeLlm) gets
 * consistent accounting from the same builder.
 */
const buildUsage = (raw: RawUsage | undefined, promptText: string, completionText: string, durationMs: number): InvokeUsage => {
  const p = raw?.prompt_tokens
  const c = raw?.completion_tokens
  const t = raw?.total_tokens
  if (typeof p === 'number' || typeof c === 'number' || typeof t === 'number') {
    const usage: InvokeUsage = { estimated: false, durationMs }
    if (typeof p === 'number') usage.promptTokens = p
    if (typeof c === 'number') usage.completionTokens = c
    if (typeof t === 'number') usage.totalTokens = t
    else if (typeof p === 'number' && typeof c === 'number') usage.totalTokens = p + c
    return usage
  }
  const promptTokens = estimateTokens(promptText)
  const completionTokens = estimateTokens(completionText)
  return { estimated: true, promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, durationMs }
}

export interface InvokeOptions {
  timeoutMs?: number
  maxTokens?: number
  temperature?: number
  /** resolve an endpoint's auth.keyRef to its secret value (injected as a bearer token). */
  resolveKey?: SecretResolver
  /** manages `local` endpoints' spawned runtimes (tier zero); absent ⇒ local endpoints are skipped. */
  runtimeManager?: LocalRuntimeManager
  /**
   * Request EXTRAS for the openai-compat completions body — a per-call override that, when unset, falls
   * back to the endpoint's own `chatTemplateKwargs`/`responseFormat`. Either way the field is included
   * ONLY when set (endpoint or opts); unset everywhere ⇒ the body is byte-for-byte the old shape.
   */
  chatTemplateKwargs?: Record<string, unknown>
  responseFormat?: unknown
  /**
   * The resolved content-side egress consent (#64). When present and `allowed:false`, egress-capable
   * endpoints are filtered out before any request leaves; the result carries the fused EgressDecision so
   * the caller can stamp it on provenance. Absent ⇒ egress is not evaluated (no decision is stamped).
   */
  egress?: EgressConsent
  /**
   * The egress GUARD config (#63). When present, an allowed device-boundary TEXT hop (LAN-local or
   * hosted/public) runs the guard on outbound content BEFORE target bytes leave: redact-and-continue masks flagged spans and proceeds;
   * hold-and-surface (or a fail-closed empty slot) THROWS GuardHeldError to suspend the hop. Absent ⇒ the
   * guard does not run (pre-#63 behavior). Device-local hops never invoke it. Only invokeLlm (the
   * text-egress path) applies it — screen (ocr/vlm) content never egresses and stt audio is not a
   * text-span filter (disclosed).
   */
  guard?: GuardOptions
  /**
   * Streaming seam (the Ask face). When present, the completions request asks the endpoint for SSE
   * (`stream: true`) and each emitted content chunk is handed here AS IT ARRIVES; the resolved
   * `LlmResult.text` is still the full accumulated answer, so every caller downstream is unchanged.
   * HONEST DEGRADE: a server that ignores `stream:true` and answers plain JSON is parsed as the classic
   * single completion and `onDelta` is simply never called — one final chunk, no fake typewriter.
   * Runs AFTER the egress gate + guard (deltas are the model's OUTPUT, not outbound content). Once any
   * delta has been emitted, a mid-stream failure no longer falls through to the next endpoint — partial
   * output has already been shown, so the failure surfaces instead of silently re-answering.
   */
  onDelta?: (text: string) => void
}

interface ChatChoice {
  message?: { content?: string; reasoning_content?: string }
  finish_reason?: string
}
interface ChatCompletion {
  choices?: ChatChoice[]
  usage?: RawUsage
}

/** One SSE frame of an openai-compat STREAMING completion (`"data: {…}"` lines; `delta`, not `message`). */
interface ChatStreamChunk {
  choices?: { delta?: { content?: string; reasoning_content?: string }; finish_reason?: string }[]
  usage?: RawUsage
}

/**
 * Drain an openai-compat SSE completion stream (the Ask face streaming path): parse each `data:` frame,
 * hand every non-empty content delta to `onDelta` as it arrives, and accumulate the full answer. Returns
 * the same shape the buffered parse yields plus the reasoning tells, so the caller classifies a
 * reasoning-exhausted stream exactly like a buffered one. `usage` is taken from whichever frame carries
 * one (servers that report it do so on the final frame); absent ⇒ the caller estimates and marks it.
 */
const readSseCompletion = async (
  response: Response,
  onDelta: (text: string) => void,
  ctx: InvokeCtx,
): Promise<{ text: string; usage: RawUsage | undefined; finishReason: string | undefined; sawReasoning: boolean }> => {
  const body = response.body
  if (body === null) throw new InvokeError('bad-response', ctx, { serverMessage: 'empty body on a streaming completions response', delivery: 'confirmed' })
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let usage: RawUsage | undefined
  let finishReason: string | undefined
  let sawReasoning = false
  let sawFrame = false
  const handleLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return // comments/blank keep-alives — ignored per SSE
    const payload = trimmed.slice(5).trim()
    if (payload === '' || payload === '[DONE]') return
    let chunk: ChatStreamChunk
    try {
      chunk = JSON.parse(payload) as ChatStreamChunk
    } catch {
      return // a torn frame is skipped, not fatal — the stream's end decides success
    }
    sawFrame = true
    if (chunk.usage !== undefined) usage = chunk.usage
    const choice = chunk.choices?.[0]
    if (choice?.finish_reason !== undefined && choice.finish_reason !== null) finishReason = choice.finish_reason
    const reasoning = choice?.delta?.reasoning_content
    if (typeof reasoning === 'string' && reasoning.trim() !== '') sawReasoning = true
    const delta = choice?.delta?.content
    if (typeof delta === 'string' && delta !== '') {
      text += delta
      onDelta(delta)
    }
  }
  try {
    for await (const piece of body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(piece, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        handleLine(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
    }
  } catch {
    // The HTTP peer already answered and began an SSE response, so delivery is confirmed even when the
    // body transport tears later. Preserve a payload-free class for the durable boundary hold.
    throw new InvokeError('bad-response', ctx, { serverMessage: 'stream interrupted before completion', delivery: 'confirmed' })
  }
  if (buffer !== '') handleLine(buffer)
  if (!sawFrame) throw new InvokeError('bad-response', ctx, { serverMessage: 'no SSE data frames in the streaming completions response', delivery: 'confirmed' })
  return { text, usage, finishReason, sawReasoning }
}

/**
 * A reasoning model that burned its whole token budget THINKING and emitted no answer (LM Studio serving
 * qwen3.5-9b does this deterministically at a low max_tokens: all tokens go to reasoning, content ''). The
 * tells: an HTTP-200 completion with empty/whitespace content AND either a non-empty `reasoning_content`
 * or `finish_reason: "length"`. This is a DISTINCT, user-actionable state — NOT a garbled `bad-response`.
 */
const isReasoningExhausted = (choice: ChatChoice | undefined): boolean => {
  const reasoning = choice?.message?.reasoning_content
  return (typeof reasoning === 'string' && reasoning.trim() !== '') || choice?.finish_reason === 'length'
}

/**
 * Call one http llm endpoint speaking the OpenAI-compatible chat-completions shape
 * (mlx / LM Studio style local servers). Throws a CLASSIFIED InvokeError on transport or protocol
 * failure (unreachable/timeout/auth/model-load/bad-response) so the caller can fall through AND surface
 * the real reason. The non-ok body is read before throwing so a model-load 400 (LM Studio's verbatim
 * "Model … failed to load") is captured and classified — not flattened to "HTTP 400".
 */
const callHttp = async (endpoint: HttpEndpoint, messages: LlmMessage[], opts: InvokeOptions): Promise<{ text: string; usage: InvokeUsage }> => {
  const ctx = ctxOf(endpoint)
  const auth = authHeaders(endpoint, opts.resolveKey) // may throw (unresolvable keyRef) → fall through
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000)
  const started = Date.now()
  let response: Response
  try {
    // Streaming (the Ask face): with an onDelta consumer the request asks for SSE; whether the server
    // actually streams is decided from the RESPONSE content-type below — a server that ignores the flag
    // and answers plain JSON degrades honestly to the classic one-chunk parse (no fake typewriter).
    const body: Record<string, unknown> = { messages, stream: opts.onDelta !== undefined }
    if (endpoint.model !== undefined) body['model'] = endpoint.model
    if (opts.maxTokens !== undefined) body['max_tokens'] = opts.maxTokens
    if (opts.temperature !== undefined) body['temperature'] = opts.temperature
    // Per-endpoint request extras (opts override the endpoint's own). Included ONLY when set, so an
    // endpoint that configures neither sends the exact legacy body — no enable_thinking is ever implied.
    const chatTemplateKwargs = opts.chatTemplateKwargs ?? endpoint.chatTemplateKwargs
    if (chatTemplateKwargs !== undefined) body['chat_template_kwargs'] = chatTemplateKwargs
    const responseFormat = opts.responseFormat ?? endpoint.responseFormat
    if (responseFormat !== undefined) body['response_format'] = responseFormat
    response = await fetch(`${endpoint.url.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      // The destination gate/provenance applies to the configured URL only. Never let a local endpoint
      // redirect user content across the device boundary; a redirect fails and the invoke falls through.
      redirect: 'manual',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (error) {
    throw classifyFetchError(error, ctx) // ECONNREFUSED/DNS → unreachable, abort → timeout
  } finally {
    clearTimeout(timeout)
  }
  if (!response.ok) throw classifyHttpResponse(response.status, await response.text().catch(() => ''), ctx)
  // The STREAMED variant: the server honored `stream:true` (SSE content-type) — drain frames, forwarding
  // each content delta as it lands; the reasoning-exhausted classification below mirrors the buffered path.
  if (opts.onDelta !== undefined && (response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const streamed = await readSseCompletion(response, opts.onDelta, ctx)
    if (streamed.text.trim() === '' && (streamed.sawReasoning || streamed.finishReason === 'length')) {
      throw new InvokeError('reasoning-exhausted', ctx, {
        serverMessage: streamed.finishReason === 'length' ? 'finish_reason: length, no streamed content' : 'reasoning consumed the token budget, no streamed content',
        delivery: 'confirmed',
      })
    }
    const usage = buildUsage(streamed.usage, messages.map((m) => m.content).join('\n'), streamed.text, Date.now() - started)
    return { text: streamed.text, usage }
  }
  let json: ChatCompletion
  try {
    json = (await response.json()) as ChatCompletion
  } catch {
    throw new InvokeError('bad-response', ctx, { serverMessage: 'invalid JSON from the completions endpoint', delivery: 'confirmed' })
  }
  const choice = json.choices?.[0]
  const text = choice?.message?.content
  if (typeof text !== 'string') {
    // Some servers (omlx) OMIT `content` entirely — instead of sending '' — when every generated
    // token went to reasoning. That carries the same reasoning-exhausted tells, so classify it
    // honestly rather than as a garbled bad-response.
    if (isReasoningExhausted(choice)) {
      throw new InvokeError('reasoning-exhausted', ctx, {
        serverMessage: choice?.finish_reason === 'length' ? 'finish_reason: length, no content' : 'reasoning consumed the token budget, no content',
        delivery: 'confirmed',
      })
    }
    throw new InvokeError('bad-response', ctx, { serverMessage: 'no completion content in response', delivery: 'confirmed' })
  }
  // Empty output where the model spent its budget reasoning is its OWN class (not a garbled response) —
  // a distinct, user-actionable failure (raise the token budget, or use a non-reasoning instruct model).
  if (text.trim() === '' && isReasoningExhausted(choice)) {
    throw new InvokeError('reasoning-exhausted', ctx, {
      serverMessage: choice?.finish_reason === 'length' ? 'finish_reason: length, empty content' : 'reasoning consumed the token budget, empty content',
      delivery: 'confirmed',
    })
  }
  const usage = buildUsage(json.usage, messages.map((m) => m.content).join('\n'), text, Date.now() - started)
  return { text, usage }
}

/**
 * Invoke the `llm` slot: try endpoints in fabric order (order is fallback, first that answers
 * wins). http/openai-compat endpoints are called; local is a stub (skipped) and cloud is out of
 * scope for this slice — offline local runtimes land with managed runtimes later.
 */
export const invokeLlm = async (
  fabric: Fabric,
  messages: LlmMessage[],
  opts: InvokeOptions = {},
): Promise<LlmResult> => {
  const endpoints = fabric.slots.llm
  const lines: string[] = []
  const classified: ClassifiedFailure[] = []
  // Streaming honesty (the Ask face): once any delta reached the consumer, a later failure must NOT fall
  // through to the next endpoint — partial output was already painted, so silently re-answering from a
  // different model would be a lie. The wrapped onDelta latches the flag; the catch below rethrows on it.
  let deltasEmitted = false
  const callOpts: InvokeOptions =
    opts.onDelta !== undefined
      ? {
          ...opts,
          onDelta: (text: string) => {
            deltasEmitted = true
            opts.onDelta!(text)
          },
        }
      : opts
  for (const endpoint of endpoints) {
    if (endpoint.kind === 'cloud') {
      lines.push(`${endpoint.name}: cloud endpoints are out of scope`)
      continue
    }
    const gate = egressGate(endpoint, opts.egress, classified, lines) // #64: deny short-circuits before any call
    if (!gate.allow) continue
    // #63 GUARD SLOT HOOK: on an ALLOWED DEVICE-BOUNDARY hop, run the content/PII guard on outbound messages
    // BEFORE any bytes leave. redact-and-continue masks flagged spans (outbound is the masked copy);
    // hold-and-surface / a fail-closed empty slot THROWS GuardHeldError, a HARD STOP for this invoke (the
    // held content must not silently reroute to a local endpoint — it surfaces for release/deny). This
    // runs OUTSIDE the per-endpoint try so a held throw propagates out of invokeLlm rather than falling
    // through. Device-local loopback/managed calls never enter this branch; LAN-local calls DO because
    // #196 makes their device-boundary crossing explicit even though the compatibility reach is `local`.
    let outbound = messages
    let guardVerdict: GuardVerdict | undefined
    if (gate.destination !== 'device-local' && opts.guard !== undefined) {
      const guarded = await runEgressGuard(
        messages,
        {
          endpoint: endpoint.name,
          url: endpoint.kind === 'http' ? endpoint.url : `${endpoint.kind}:${endpoint.name}`,
          ...(endpoint.model !== undefined && endpoint.model !== '' ? { model: endpoint.model } : {}),
          destination: gate.destination,
          ...(opts.egress !== undefined ? { consent: opts.egress } : {}),
        },
        opts.guard,
      )
      outbound = guarded.messages
      guardVerdict = guarded.verdict
    }
    try {
      // A local endpoint's spawned runtime is resolved to a localhost http server, then called
      // exactly like an http one (the engine owns its lifecycle; the protocol is identical).
      const http = endpoint.kind === 'local' ? (await resolveLocal(endpoint, opts.runtimeManager)).http : endpoint
      if (http.api !== 'openai-compat') {
        lines.push(`${endpoint.name}: unsupported api "${http.api}"`)
        continue
      }
      const { text, usage } = await callHttp(http, outbound, callOpts)
      const result: LlmResult = { text, endpoint: endpoint.name, slot: 'llm', usage }
      if (endpoint.model !== undefined && endpoint.model !== '') result.model = endpoint.model
      if (opts.egress !== undefined) result.egress = egressDecision(gate.reach, opts.egress, gate)
      if (guardVerdict !== undefined) result.guard = guardVerdict
      return result
    } catch (error) {
      // Deltas already streamed ⇒ no fallback. If this was a boundary target, route the failed delivery
      // through the durable hold path too; stopping fallback alone would leave the attempt unaudited.
      if (deltasEmitted) {
        if (gate.destination !== 'device-local') throw boundaryDeliveryHold(endpoint, gate, opts.egress, error, guardVerdict)
        throw error
      }
      if (error instanceof InvokeError) classified.push(error.toFailure())
      lines.push(`${endpoint.name}: ${error instanceof Error ? error.message : String(error)}`)
      if (boundaryDeliveryMayHaveOccurred(gate, error)) {
        throw boundaryDeliveryHold(endpoint, gate, opts.egress, error, guardVerdict)
      }
    }
  }
  throw new AggregateInvokeError(
    'llm',
    `no llm endpoint answered${lines.length ? ` (${lines.join('; ')})` : ' (fabric llm slot is empty)'}`,
    classified,
  )
}

export interface SttAudio {
  /** the audio bytes as a base64 string (CaptureChunk.data for a base64 audio chunk) */
  base64: string
  /** the source MIME (CaptureChunk.contentType), e.g. audio/wav — decides the multipart filename */
  contentType: string
}

/**
 * The `stt` slot result: the canonical `TranscriptResult` (text — '' is valid silence, not an error —
 * plus language/duration/segments when the flavor supplied them) with invoke provenance. Every STT
 * flavor is normalized to this ONE shape by its adapter, so a consumer reads `text` uniformly whether
 * the transcript came from whisper.cpp, an OpenAI-compatible host, or omlx.
 */
export interface SttResult extends TranscriptResult {
  endpoint: string
  model?: string
  slot: 'stt'
  /** the resolved egress decision this invoke ran under (#64) — present only when consent was supplied. */
  egress?: EgressDecision
}

export interface SttOptions {
  /** STT can be slower than a chat completion (decode + transcribe), so this defaults higher */
  timeoutMs?: number
  /** optional ISO-639-1 hint passed through to the transcriber */
  language?: string
  /** resolve an endpoint's auth.keyRef to its secret value (injected as a bearer token). */
  resolveKey?: SecretResolver
  /** manages `local` endpoints' spawned runtimes (tier zero); absent ⇒ local endpoints are skipped. */
  runtimeManager?: LocalRuntimeManager
  /** resolved content-side egress consent (#64) — see InvokeOptions.egress. */
  egress?: EgressConsent
}

/** audio/<subtype> → a filename the transcriber can sniff a container from; defaults to audio.bin. */
const audioFilename = (contentType: string): string => {
  const subtype = contentType.split(';')[0]?.split('/')[1]?.trim().replace(/^x-/, '')
  const ext = subtype === 'mpeg' ? 'mp3' : subtype && /^[a-z0-9]+$/.test(subtype) ? subtype : 'bin'
  return `audio.${ext}`
}

/**
 * POST one multipart transcription request and NORMALIZE the response via the flavor's adapter. The
 * adapter owns the wire quirks — its `path` (whisper.cpp is `/inference`, not `/v1`), whether the `model`
 * form field is sent (openai/omlx yes, whisper-server no), and the `response_format` — plus mapping the
 * body to the canonical `TranscriptResult`. Throws a CLASSIFIED InvokeError on transport/protocol failure
 * so the caller falls through to the next endpoint in fabric order; the adapter itself never throws.
 */
const postTranscription = async (
  url: string,
  adapter: SttAdapter,
  audio: SttAudio,
  opts: SttOptions,
  extra: { model?: string; auth?: Record<string, string> },
  ctx: InvokeCtx,
): Promise<TranscriptResult> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000)
  let response: Response
  try {
    const form = new FormData()
    if (adapter.request.sendModel && extra.model !== undefined) form.set('model', extra.model)
    if (opts.language !== undefined) form.set('language', opts.language)
    if (adapter.request.responseFormat !== undefined) form.set('response_format', adapter.request.responseFormat)
    const bytes = Buffer.from(audio.base64, 'base64')
    form.set('file', new Blob([bytes], { type: audio.contentType }), audioFilename(audio.contentType))
    response = await fetch(`${url.replace(/\/$/, '')}${adapter.request.path}`, {
      method: 'POST',
      redirect: 'manual',
      headers: extra.auth ?? {},
      body: form,
      signal: controller.signal,
    })
  } catch (error) {
    throw classifyFetchError(error, ctx)
  } finally {
    clearTimeout(timeout)
  }
  if (!response.ok) throw classifyHttpResponse(response.status, await response.text().catch(() => ''), ctx)
  let json: unknown
  try {
    json = await response.json()
  } catch {
    throw new InvokeError('bad-response', ctx, { serverMessage: 'invalid JSON from the transcription endpoint', delivery: 'confirmed' })
  }
  // A transcriber that answers must carry a `text` field; '' (silence) is valid, missing is not. The
  // adapter maps a well-formed body and returns undefined when there is none — one honest bad-response.
  const transcript = adapter.normalize(json)
  if (transcript === undefined) throw new InvokeError('bad-response', ctx, { serverMessage: 'no transcript text in response', delivery: 'confirmed' })
  return transcript
}

/**
 * Invoke the `stt` slot: try endpoints in fabric order (order is fallback, first that answers wins),
 * mirroring invokeLlm. Each endpoint's STT FLAVOR picks an adapter (http/openai-compat → the OpenAI
 * transcription shape; local whisper.cpp → whisper-server `/inference`; local mlx → omlx transcription),
 * and the adapter normalizes every flavor's body to the ONE canonical `TranscriptResult` — a new engine
 * is a new adapter, never a branch here. `cloud` is out of scope, exactly as invokeLlm handles it. An
 * empty transcript ('' = silence) is a normal result.
 */
export const invokeStt = async (fabric: Fabric, audio: SttAudio, opts: SttOptions = {}): Promise<SttResult> => {
  const endpoints = fabric.slots.stt
  const lines: string[] = []
  const classified: ClassifiedFailure[] = []
  for (const endpoint of endpoints) {
    if (endpoint.kind === 'cloud') {
      lines.push(`${endpoint.name}: cloud endpoints are out of scope`)
      continue
    }
    const adapter = selectSttAdapter(endpoint)
    if (adapter === undefined) {
      lines.push(
        endpoint.kind === 'http'
          ? `${endpoint.name}: unsupported api "${endpoint.api}"`
          : `${endpoint.name}: unsupported local runtime "${endpoint.runtime}" for stt`,
      )
      continue
    }
    const gate = egressGate(endpoint, opts.egress, classified, lines) // #64: deny short-circuits before any call
    if (!gate.allow) continue
    try {
      let transcript: TranscriptResult
      if (endpoint.kind === 'local') {
        // A local runtime is resolved to a localhost http server; the adapter (chosen from its runtime)
        // decides the path/model-field. omlx REQUIRES the served model id and a bearer even on localhost;
        // whisper.cpp's /inference takes neither. Both ride the SAME multipart POST via the adapter.
        const { http } = await resolveLocal(endpoint, opts.runtimeManager)
        const auth = authHeaders(http, opts.resolveKey) // may throw (unresolvable keyRef) → fall through
        const extra: { model?: string; auth: Record<string, string> } = { auth }
        if (endpoint.model !== '') extra.model = endpoint.model
        transcript = await postTranscription(http.url, adapter, audio, opts, extra, ctxOf({ ...http, name: endpoint.name }))
      } else {
        const auth = authHeaders(endpoint, opts.resolveKey) // may throw (unresolvable keyRef) → fall through
        const extra: { model?: string; auth: Record<string, string> } = { auth }
        if (endpoint.model !== undefined) extra.model = endpoint.model
        transcript = await postTranscription(endpoint.url, adapter, audio, opts, extra, ctxOf(endpoint))
      }
      const result: SttResult = { ...transcript, endpoint: endpoint.name, slot: 'stt' }
      if (endpoint.model !== undefined && endpoint.model !== '') result.model = endpoint.model
      if (opts.egress !== undefined) result.egress = egressDecision(gate.reach, opts.egress, gate)
      return result
    } catch (error) {
      if (error instanceof InvokeError) classified.push(error.toFailure())
      lines.push(`${endpoint.name}: ${error instanceof Error ? error.message : String(error)}`)
      if (boundaryDeliveryMayHaveOccurred(gate, error)) {
        throw boundaryDeliveryHold(endpoint, gate, opts.egress, error)
      }
    }
  }
  throw new AggregateInvokeError(
    'stt',
    `no stt endpoint answered${lines.length ? ` (${lines.join('; ')})` : ' (fabric stt slot is empty)'}`,
    classified,
  )
}

/**
 * One recognized region — the invoke-side, provenance-free shape of an OcrResult block (a PaddleOCR box):
 * text plus optional confidence and a bounding box in the FRAME PIXEL coordinate space (ScreenFrameMeta
 * width/height). The slice-4 screen processor lifts these verbatim into the persisted `OcrResult.blocks`.
 */
export interface ScreenBlock {
  text: string
  confidence?: number
  region?: { x: number; y: number; width: number; height: number }
}

/**
 * The lightweight result of a screen-understanding invoke (ocr | vlm) — the OcrText body BEFORE the
 * slice-4 processor stamps the full `OcrResult` envelope (id/sessionId/workspaceId/sourceChunks/createdAt).
 * Mirrors LlmResult/SttResult: text + provenance. `blocks` is present only for a region-aware ocr runtime
 * (a vlm produces prose and leaves it absent); `text` is populated uniformly for both slots ('' is a valid
 * empty-frame / silent outcome, never an error — the caller reads `text` regardless of which slot ran).
 */
export interface ScreenTextResult {
  text: string
  blocks?: ScreenBlock[]
  endpoint: string
  model?: string
  slot: 'ocr' | 'vlm'
  /** token accounting for this invoke (#65). For a vision invoke, image tokens are not counted in an
   * estimate (only the text prompt is) — the estimated flag makes that honest; a paddle-serving OCR
   * reports no usage, so its counts are a chars/4 estimate over the recognized text. */
  usage?: InvokeUsage
  /** the resolved egress decision this invoke ran under (#64/#196) — present only when consent was
   * supplied. Screen content denies hosted/public egress; destination distinguishes a device-local call
   * from an explicitly trusted LAN raw-frame call. */
  egress?: EgressDecision
}

/** Shared invoke options for the screen slots — the image + timeout ride the contract params, so these
 * carry only key resolution and the local-runtime manager (mirroring InvokeOptions/SttOptions minus timeout). */
export interface ScreenInvokeOptions {
  /** resolve an endpoint's auth.keyRef to its secret value (injected as a bearer token). */
  resolveKey?: SecretResolver
  /** manages `local` endpoints' spawned runtimes (tier zero); absent ⇒ local endpoints are skipped. */
  runtimeManager?: LocalRuntimeManager
  /** resolved content-side egress consent (#64) — screen content denies hosted/public egress. */
  egress?: EgressConsent
}

/** A base64 image + its mime as an OpenAI-compat `image_url` data URI (`data:<mime>;base64,<bytes>`). */
const imageDataUri = (image: string, contentType: string): string => `data:${contentType};base64,${image}`

/**
 * Classify a non-OK response to a request that carried a raw screen frame WITHOUT reading its body.
 * Some OCR/VLM servers echo the submitted request in an error response; retaining that body would copy
 * the frame's base64 into InvokeError.serverMessage, the aggregate throw, queue/status state, and logs.
 * HTTP status still gives the existing truthful class, while ctx preserves endpoint/model/keyRef + hint.
 */
const throwRawFrameHttpResponse = async (response: Response, ctx: InvokeCtx): Promise<never> => {
  const status = response.status
  await response.body?.cancel().catch(() => undefined)
  throw classifyHttpResponse(status, '', ctx)
}

/**
 * Call one http vlm endpoint speaking OpenAI-compatible VISION chat: a single user message whose `content`
 * is an array of a text part (the prompt) and an `image_url` part carrying the frame as a data URI — what
 * LM Studio / Ollama's OpenAI-compat serve for a qwen2.5-vl-class model. Parses `choices[0].message.content`
 * (prose). Empty content ('') is a valid empty-frame outcome and is returned as-is; a MISSING content field
 * is a `bad-response`. Throws a classified InvokeError on transport/protocol failure so the caller falls through.
 */
const callVlmHttp = async (endpoint: HttpEndpoint, params: VlmInvokeParams, opts: ScreenInvokeOptions): Promise<{ text: string; usage: InvokeUsage }> => {
  // A configured LAN address is operational data, not screen-result provenance. Keep it available to
  // the internal diagnostic probe while ensuring surfaced failures name only the safe endpoint label.
  const ctx = ctxOf(endpoint, true)
  const auth = authHeaders(endpoint, opts.resolveKey) // may throw (unresolvable keyRef) → fall through
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? 60_000)
  const started = Date.now()
  let response: Response
  try {
    const body: Record<string, unknown> = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: params.prompt },
            { type: 'image_url', image_url: { url: imageDataUri(params.image, params.contentType) } },
          ],
        },
      ],
      stream: false,
    }
    if (endpoint.model !== undefined) body['model'] = endpoint.model
    response = await fetch(`${endpoint.url.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (error) {
    throw classifyFetchError(error, ctx)
  } finally {
    clearTimeout(timeout)
  }
  if (!response.ok) await throwRawFrameHttpResponse(response, ctx)
  let json: ChatCompletion
  try {
    json = (await response.json()) as ChatCompletion
  } catch {
    throw new InvokeError('bad-response', ctx, { serverMessage: 'invalid JSON from the vision completions endpoint', delivery: 'confirmed' })
  }
  const text = json.choices?.[0]?.message?.content
  if (typeof text !== 'string') throw new InvokeError('bad-response', ctx, { serverMessage: 'no completion content in vision response', delivery: 'confirmed' })
  // '' is a valid empty-frame result, not an error. The estimate covers only the text prompt (image
  // tokens are not derivable from chars) — `estimated` keeps that honest when the server reports no usage.
  const usage = buildUsage(json.usage, params.prompt, text, Date.now() - started)
  return { text, usage }
}

/**
 * Invoke the `vlm` slot: try endpoints in fabric order (order is fallback, first that answers wins),
 * mirroring invokeLlm. http/openai-compat endpoints POST the OpenAI-compat vision-chat shape (prompt +
 * image data URI); `local` resolves its spawned runtime to a localhost http server, then speaks the same
 * chat (a managed vlm runtime is future — no v0 spec, so it falls through gracefully); `cloud` is out of
 * scope. Produces prose (`text`, no `blocks`). An empty answer ('') is a normal result.
 */
export const invokeVlm = async (
  fabric: Fabric,
  params: VlmInvokeParams,
  opts: ScreenInvokeOptions = {},
): Promise<ScreenTextResult> => {
  const endpoints = fabric.slots.vlm
  const lines: string[] = []
  const classified: ClassifiedFailure[] = []
  for (const endpoint of endpoints) {
    if (endpoint.kind === 'cloud') {
      lines.push(`${endpoint.name}: cloud endpoints are out of scope`)
      continue
    }
    const gate = egressGate(endpoint, opts.egress, classified, lines, 'loopback-only') // raw frame: LAN + egress deny before any call
    if (!gate.allow) continue
    try {
      const http = endpoint.kind === 'local' ? (await resolveLocal(endpoint, opts.runtimeManager)).http : endpoint
      if (http.api !== 'openai-compat') {
        lines.push(`${endpoint.name}: unsupported api "${http.api}"`)
        continue
      }
      const { text, usage } = await callVlmHttp(http, params, opts)
      const result: ScreenTextResult = { text, endpoint: endpoint.name, slot: 'vlm', usage }
      if (endpoint.model !== undefined && endpoint.model !== '') result.model = endpoint.model
      if (opts.egress !== undefined) result.egress = egressDecision(gate.reach, opts.egress, gate)
      return result
    } catch (error) {
      if (error instanceof InvokeError) classified.push(error.toFailure())
      lines.push(`${endpoint.name}: ${error instanceof Error ? error.message : String(error)}`)
      if (boundaryDeliveryMayHaveOccurred(gate, error)) {
        throw boundaryDeliveryHold(endpoint, gate, opts.egress, error)
      }
    }
  }
  throw new AggregateInvokeError(
    'vlm',
    `no vlm endpoint answered${lines.length ? ` (${lines.join('; ')})` : ' (fabric vlm slot is empty)'}`,
    classified,
  )
}

/**
 * The v0 paddle-serving convention (DESIGN-CRITIQUE §5: `runtime:"paddle"` is a supported local runtime;
 * an http endpoint speaks it via `api:'paddle-serving'`). We target PaddleOCR's standard PaddleHub
 * serving contract — the widely-deployed, documented one:
 *
 *   POST {url}/predict/ocr_system   body {"images": ["<base64>"]}   (non-/v1, like whisper.cpp's /inference)
 *   → {"results": [ [ {"text": str, "confidence": num, "text_region": [[x,y],[x,y],[x,y],[x,y]]}, … ] ]}
 *
 * `results` is per-image; we sent ONE image, so `results[0]` is its region list (an empty list = a blank
 * frame, a normal empty result — never an error). Each region maps to a ScreenBlock: `text`, optional
 * `confidence` (kept only when in 0..1), and a `region` axis-aligned bounding box derived from the four
 * `text_region` corners in FRAME PIXEL coords (kept only when non-degenerate and non-negative, so a
 * consumer never sees an out-of-contract box). The parse is deliberately TOLERANT of a missing field on
 * one region (that region is skipped) but says `bad-response` HONESTLY when the top-level shape is wrong
 * (no `results` array) rather than guessing. A managed LOCAL paddle runtime is future — until it lands in
 * RUNTIME_SPECS its dialect/serving path resolve the same honest way whisper.cpp's `/inference` does.
 */
const PADDLE_OCR_PATH = '/predict/ocr_system'

/** The default recognition prompt when an openai-compat VLM endpoint fills the ocr slot (prose, no boxes). */
const OCR_VLM_PROMPT = 'Transcribe all text visible in this image exactly, preserving reading order. Output only the transcribed text.'

interface PaddleResponse {
  results?: unknown
}

/** Axis-aligned bounding box from PaddleOCR's four `text_region` corner points, in frame pixel coords.
 * Returns a contract-valid box (x,y ≥ 0; width,height ≥ 1) or undefined when the corners are unusable. */
const boxFromCorners = (corners: unknown): ScreenBlock['region'] | undefined => {
  if (!Array.isArray(corners)) return undefined
  const xs: number[] = []
  const ys: number[] = []
  for (const point of corners) {
    if (Array.isArray(point) && typeof point[0] === 'number' && typeof point[1] === 'number') {
      xs.push(point[0])
      ys.push(point[1])
    }
  }
  if (xs.length < 2) return undefined
  const x = Math.max(0, Math.round(Math.min(...xs)))
  const y = Math.max(0, Math.round(Math.min(...ys)))
  const width = Math.round(Math.max(...xs) - Math.min(...xs))
  const height = Math.round(Math.max(...ys) - Math.min(...ys))
  return width >= 1 && height >= 1 ? { x, y, width, height } : undefined
}

/** One PaddleHub region → a ScreenBlock; undefined when the region carries no usable text. */
const paddleRegionToBlock = (region: unknown): ScreenBlock | undefined => {
  if (!region || typeof region !== 'object') return undefined
  const text = (region as { text?: unknown }).text
  if (typeof text !== 'string') return undefined
  const block: ScreenBlock = { text }
  const confidence = (region as { confidence?: unknown }).confidence
  if (typeof confidence === 'number' && confidence >= 0 && confidence <= 1) block.confidence = confidence
  const box = boxFromCorners((region as { text_region?: unknown }).text_region)
  if (box !== undefined) block.region = box
  return block
}

/** Call one paddle-serving ocr endpoint (POST /predict/ocr_system). Returns flattened text + region blocks. */
const callPaddleOcr = async (
  endpoint: HttpEndpoint,
  params: OcrInvokeParams,
  opts: ScreenInvokeOptions,
): Promise<{ text: string; blocks: ScreenBlock[]; usage: InvokeUsage }> => {
  // See callVlmHttp: raw-frame failure hints/logs must never disclose the configured endpoint URL.
  const ctx = ctxOf(endpoint, true)
  const auth = authHeaders(endpoint, opts.resolveKey) // may throw (unresolvable keyRef) → fall through
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? 30_000)
  const started = Date.now()
  let response: Response
  try {
    response = await fetch(`${endpoint.url.replace(/\/$/, '')}${PADDLE_OCR_PATH}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ images: [params.image] }),
      signal: controller.signal,
    })
  } catch (error) {
    throw classifyFetchError(error, ctx)
  } finally {
    clearTimeout(timeout)
  }
  if (!response.ok) await throwRawFrameHttpResponse(response, ctx)
  let json: PaddleResponse
  try {
    json = (await response.json()) as PaddleResponse
  } catch {
    throw new InvokeError('bad-response', ctx, { serverMessage: 'invalid JSON from the paddle-serving endpoint', delivery: 'confirmed' })
  }
  // A paddle server that answers MUST return a `results` array (one entry per image); anything else is a
  // genuinely bad response (wrong URL/dialect), said honestly rather than guessed.
  if (!Array.isArray(json.results)) {
    throw new InvokeError('bad-response', ctx, { serverMessage: 'no results array in the paddle-serving response', delivery: 'confirmed' })
  }
  const first = json.results[0] // our single image's region list; absent/empty ⇒ a blank frame (normal)
  const regions = Array.isArray(first) ? first : []
  const blocks: ScreenBlock[] = []
  for (const region of regions) {
    const block = paddleRegionToBlock(region)
    if (block !== undefined) blocks.push(block)
  }
  const text = blocks.map((b) => b.text).join('\n') // '' when nothing recognized — a normal result
  // PaddleOCR reports no token usage; there is no text prompt, only the image. So the count is a chars/4
  // estimate over the RECOGNIZED text (output only), marked estimated — a measurement is never faked.
  const usage = buildUsage(undefined, '', text, Date.now() - started)
  return { text, blocks, usage }
}

/**
 * Invoke the `ocr` slot: try endpoints in fabric order (order is fallback, first that answers wins),
 * mirroring invokeLlm/invokeStt. An http `paddle-serving` endpoint speaks the PaddleHub OCR contract and
 * yields region-aware blocks; an http `openai-compat` endpoint filling the ocr slot is handled gracefully
 * as a VLM transcription (a default recognition prompt → prose, no blocks — the dialect field decides, so
 * a user who only has a vision model still gets screen text). `local` resolves a spawned runtime (a
 * managed paddle runtime is future — no v0 spec, so it falls through); `cloud` is out of scope. An empty
 * recognition ('' / no blocks) is a normal result, exactly as stt silence is.
 */
export const invokeOcr = async (
  fabric: Fabric,
  params: OcrInvokeParams,
  opts: ScreenInvokeOptions = {},
): Promise<ScreenTextResult> => {
  const endpoints = fabric.slots.ocr
  const lines: string[] = []
  const classified: ClassifiedFailure[] = []
  for (const endpoint of endpoints) {
    if (endpoint.kind === 'cloud') {
      lines.push(`${endpoint.name}: cloud endpoints are out of scope`)
      continue
    }
    const gate = egressGate(endpoint, opts.egress, classified, lines, 'loopback-only') // raw frame: LAN + egress deny before any call
    if (!gate.allow) continue
    try {
      const http = endpoint.kind === 'local' ? (await resolveLocal(endpoint, opts.runtimeManager)).http : endpoint
      let text: string
      let blocks: ScreenBlock[] | undefined
      let usage: InvokeUsage
      if (http.api === 'paddle-serving') {
        ;({ text, blocks, usage } = await callPaddleOcr(http, params, opts))
      } else if (http.api === 'openai-compat') {
        // An openai-compat VLM filling the ocr slot: transcribe with a default recognition prompt (prose).
        ;({ text, usage } = await callVlmHttp(
          http,
          { image: params.image, contentType: params.contentType, prompt: OCR_VLM_PROMPT, ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}) },
          opts,
        ))
      } else {
        lines.push(`${endpoint.name}: unsupported api "${http.api}"`)
        continue
      }
      const result: ScreenTextResult = { text, endpoint: endpoint.name, slot: 'ocr', usage }
      if (blocks !== undefined) result.blocks = blocks
      if (endpoint.model !== undefined && endpoint.model !== '') result.model = endpoint.model
      if (opts.egress !== undefined) result.egress = egressDecision(gate.reach, opts.egress, gate)
      return result
    } catch (error) {
      if (error instanceof InvokeError) classified.push(error.toFailure())
      lines.push(`${endpoint.name}: ${error instanceof Error ? error.message : String(error)}`)
      if (boundaryDeliveryMayHaveOccurred(gate, error)) {
        throw boundaryDeliveryHold(endpoint, gate, opts.egress, error)
      }
    }
  }
  throw new AggregateInvokeError(
    'ocr',
    `no ocr endpoint answered${lines.length ? ` (${lines.join('; ')})` : ' (fabric ocr slot is empty)'}`,
    classified,
  )
}
