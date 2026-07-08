import type { Endpoint, Fabric, VlmInvokeParams } from '@openinfo/contracts'
import type { SecretResolver } from './secrets.js'
import type { LocalEndpoint, LocalRuntimeManager } from './endpoints/local.js'
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
): Promise<{ http: HttpEndpoint; transcribePath?: string }> => {
  if (!manager) throw new Error('local runtime not managed here (no runtime manager)')
  const { url, spec } = await manager.ensureRunning(endpoint)
  const http: HttpEndpoint = { kind: 'http', name: endpoint.name, url, api: 'openai-compat' }
  if (endpoint.model !== '') http.model = endpoint.model
  return spec.transcribePath !== undefined ? { http, transcribePath: spec.transcribePath } : { http }
}

/** The endpoint identity a failure is classified against — name/url/model/keyRef, never a secret value. */
const ctxOf = (endpoint: HttpEndpoint): InvokeCtx => ({
  endpoint: endpoint.name,
  url: endpoint.url,
  ...(endpoint.model !== undefined && endpoint.model !== '' ? { model: endpoint.model } : {}),
  ...(endpoint.auth?.keyRef !== undefined ? { keyRef: endpoint.auth.keyRef } : {}),
})

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
}

export interface InvokeOptions {
  timeoutMs?: number
  maxTokens?: number
  temperature?: number
  /** resolve an endpoint's auth.keyRef to its secret value (injected as a bearer token). */
  resolveKey?: SecretResolver
  /** manages `local` endpoints' spawned runtimes (tier zero); absent ⇒ local endpoints are skipped. */
  runtimeManager?: LocalRuntimeManager
}

interface ChatChoice {
  message?: { content?: string; reasoning_content?: string }
  finish_reason?: string
}
interface ChatCompletion {
  choices?: ChatChoice[]
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
const callHttp = async (endpoint: HttpEndpoint, messages: LlmMessage[], opts: InvokeOptions): Promise<string> => {
  const ctx = ctxOf(endpoint)
  const auth = authHeaders(endpoint, opts.resolveKey) // may throw (unresolvable keyRef) → fall through
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000)
  let response: Response
  try {
    const body: Record<string, unknown> = { messages, stream: false }
    if (endpoint.model !== undefined) body['model'] = endpoint.model
    if (opts.maxTokens !== undefined) body['max_tokens'] = opts.maxTokens
    if (opts.temperature !== undefined) body['temperature'] = opts.temperature
    response = await fetch(`${endpoint.url.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
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
  let json: ChatCompletion
  try {
    json = (await response.json()) as ChatCompletion
  } catch {
    throw new InvokeError('bad-response', ctx, { serverMessage: 'invalid JSON from the completions endpoint' })
  }
  const choice = json.choices?.[0]
  const text = choice?.message?.content
  if (typeof text !== 'string') throw new InvokeError('bad-response', ctx, { serverMessage: 'no completion content in response' })
  // Empty output where the model spent its budget reasoning is its OWN class (not a garbled response) —
  // a distinct, user-actionable failure (raise the token budget, or use a non-reasoning instruct model).
  if (text.trim() === '' && isReasoningExhausted(choice)) {
    throw new InvokeError('reasoning-exhausted', ctx, {
      serverMessage: choice?.finish_reason === 'length' ? 'finish_reason: length, empty content' : 'reasoning consumed the token budget, empty content',
    })
  }
  return text
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
  for (const endpoint of endpoints) {
    if (endpoint.kind === 'cloud') {
      lines.push(`${endpoint.name}: cloud endpoints are out of scope`)
      continue
    }
    try {
      // A local endpoint's spawned runtime is resolved to a localhost http server, then called
      // exactly like an http one (the engine owns its lifecycle; the protocol is identical).
      const http = endpoint.kind === 'local' ? (await resolveLocal(endpoint, opts.runtimeManager)).http : endpoint
      if (http.api !== 'openai-compat') {
        lines.push(`${endpoint.name}: unsupported api "${http.api}"`)
        continue
      }
      const text = await callHttp(http, messages, opts)
      const result: LlmResult = { text, endpoint: endpoint.name, slot: 'llm' }
      if (endpoint.model !== undefined && endpoint.model !== '') result.model = endpoint.model
      return result
    } catch (error) {
      if (error instanceof InvokeError) classified.push(error.toFailure())
      lines.push(`${endpoint.name}: ${error instanceof Error ? error.message : String(error)}`)
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

export interface SttResult {
  /** the transcript; '' is a valid silence outcome, not an error */
  text: string
  endpoint: string
  model?: string
  slot: 'stt'
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
}

/** audio/<subtype> → a filename the transcriber can sniff a container from; defaults to audio.bin. */
const audioFilename = (contentType: string): string => {
  const subtype = contentType.split(';')[0]?.split('/')[1]?.trim().replace(/^x-/, '')
  const ext = subtype === 'mpeg' ? 'mp3' : subtype && /^[a-z0-9]+$/.test(subtype) ? subtype : 'bin'
  return `audio.${ext}`
}

/**
 * POST one multipart transcription request and return the transcript. Used by BOTH the http kind
 * (OpenAI-compat `/v1/audio/transcriptions`, model + file) and the local whisper.cpp runtime
 * (`/inference` with `response_format=json` — whisper-server does NOT serve the /v1 path). Throws on
 * transport or protocol failure so the caller falls through to the next endpoint in fabric order.
 */
const postTranscription = async (
  url: string,
  path: string,
  audio: SttAudio,
  opts: SttOptions,
  extra: { model?: string; auth?: Record<string, string>; responseFormat?: boolean },
  ctx: InvokeCtx,
): Promise<string> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000)
  let response: Response
  try {
    const form = new FormData()
    if (extra.model !== undefined) form.set('model', extra.model)
    if (opts.language !== undefined) form.set('language', opts.language)
    if (extra.responseFormat) form.set('response_format', 'json')
    const bytes = Buffer.from(audio.base64, 'base64')
    form.set('file', new Blob([bytes], { type: audio.contentType }), audioFilename(audio.contentType))
    response = await fetch(`${url.replace(/\/$/, '')}${path}`, {
      method: 'POST',
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
  let json: { text?: unknown }
  try {
    json = (await response.json()) as { text?: unknown }
  } catch {
    throw new InvokeError('bad-response', ctx, { serverMessage: 'invalid JSON from the transcription endpoint' })
  }
  // A transcriber that answers must return a `text` field; '' (silence) is valid, missing is not.
  if (typeof json.text !== 'string') throw new InvokeError('bad-response', ctx, { serverMessage: 'no transcript text in response' })
  return json.text
}

/** Call one http stt endpoint (OpenAI-compat `/v1/audio/transcriptions`, model + file). */
const callSttHttp = (endpoint: HttpEndpoint, audio: SttAudio, opts: SttOptions): Promise<string> => {
  const auth = authHeaders(endpoint, opts.resolveKey) // may throw (unresolvable keyRef) → fall through
  const extra: { model?: string; auth: Record<string, string> } = { auth }
  if (endpoint.model !== undefined) extra.model = endpoint.model
  return postTranscription(endpoint.url, '/v1/audio/transcriptions', audio, opts, extra, ctxOf(endpoint))
}

/**
 * Invoke the `stt` slot: try endpoints in fabric order (order is fallback, first that answers wins),
 * mirroring invokeLlm. http/openai-compat endpoints POST the multipart transcription shape; `local`
 * is a stub (skipped, offline runtimes land with managed runtimes later) and `cloud` is out of
 * scope, exactly as invokeLlm handles them. An empty transcript ('' = silence) is a normal result.
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
    try {
      let text: string
      if (endpoint.kind === 'local') {
        // The spawned whisper.cpp runtime serves /inference (response_format=json), not /v1.
        const { http, transcribePath } = await resolveLocal(endpoint, opts.runtimeManager)
        if (transcribePath === undefined) throw new Error('local runtime has no transcription path')
        text = await postTranscription(http.url, transcribePath, audio, opts, { responseFormat: true }, ctxOf({ ...http, name: endpoint.name }))
      } else {
        if (endpoint.api !== 'openai-compat') {
          lines.push(`${endpoint.name}: unsupported api "${endpoint.api}"`)
          continue
        }
        text = await callSttHttp(endpoint, audio, opts)
      }
      const result: SttResult = { text, endpoint: endpoint.name, slot: 'stt' }
      if (endpoint.model !== undefined && endpoint.model !== '') result.model = endpoint.model
      return result
    } catch (error) {
      if (error instanceof InvokeError) classified.push(error.toFailure())
      lines.push(`${endpoint.name}: ${error instanceof Error ? error.message : String(error)}`)
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
}

/** Shared invoke options for the screen slots — the image + timeout ride the contract params, so these
 * carry only key resolution and the local-runtime manager (mirroring InvokeOptions/SttOptions minus timeout). */
export interface ScreenInvokeOptions {
  /** resolve an endpoint's auth.keyRef to its secret value (injected as a bearer token). */
  resolveKey?: SecretResolver
  /** manages `local` endpoints' spawned runtimes (tier zero); absent ⇒ local endpoints are skipped. */
  runtimeManager?: LocalRuntimeManager
}

/** A base64 image + its mime as an OpenAI-compat `image_url` data URI (`data:<mime>;base64,<bytes>`). */
const imageDataUri = (image: string, contentType: string): string => `data:${contentType};base64,${image}`

/**
 * Call one http vlm endpoint speaking OpenAI-compatible VISION chat: a single user message whose `content`
 * is an array of a text part (the prompt) and an `image_url` part carrying the frame as a data URI — what
 * LM Studio / Ollama's OpenAI-compat serve for a qwen2.5-vl-class model. Parses `choices[0].message.content`
 * (prose). Empty content ('') is a valid empty-frame outcome and is returned as-is; a MISSING content field
 * is a `bad-response`. Throws a classified InvokeError on transport/protocol failure so the caller falls through.
 */
const callVlmHttp = async (endpoint: HttpEndpoint, params: VlmInvokeParams, opts: ScreenInvokeOptions): Promise<string> => {
  const ctx = ctxOf(endpoint)
  const auth = authHeaders(endpoint, opts.resolveKey) // may throw (unresolvable keyRef) → fall through
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? 60_000)
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
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (error) {
    throw classifyFetchError(error, ctx)
  } finally {
    clearTimeout(timeout)
  }
  if (!response.ok) throw classifyHttpResponse(response.status, await response.text().catch(() => ''), ctx)
  let json: ChatCompletion
  try {
    json = (await response.json()) as ChatCompletion
  } catch {
    throw new InvokeError('bad-response', ctx, { serverMessage: 'invalid JSON from the vision completions endpoint' })
  }
  const text = json.choices?.[0]?.message?.content
  if (typeof text !== 'string') throw new InvokeError('bad-response', ctx, { serverMessage: 'no completion content in vision response' })
  return text // '' is a valid empty-frame result, not an error
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
    try {
      const http = endpoint.kind === 'local' ? (await resolveLocal(endpoint, opts.runtimeManager)).http : endpoint
      if (http.api !== 'openai-compat') {
        lines.push(`${endpoint.name}: unsupported api "${http.api}"`)
        continue
      }
      const text = await callVlmHttp(http, params, opts)
      const result: ScreenTextResult = { text, endpoint: endpoint.name, slot: 'vlm' }
      if (endpoint.model !== undefined && endpoint.model !== '') result.model = endpoint.model
      return result
    } catch (error) {
      if (error instanceof InvokeError) classified.push(error.toFailure())
      lines.push(`${endpoint.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new AggregateInvokeError(
    'vlm',
    `no vlm endpoint answered${lines.length ? ` (${lines.join('; ')})` : ' (fabric vlm slot is empty)'}`,
    classified,
  )
}
