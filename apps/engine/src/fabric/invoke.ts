import type { Endpoint, Fabric } from '@openinfo/contracts'
import type { SecretResolver } from './secrets.js'

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

type HttpEndpoint = Extract<Endpoint, { kind: 'http' }>

/**
 * Build the Authorization header for an http endpoint that declares `auth.keyRef` — injected ONLY
 * here, at invoke time, from the secret store (never in documents/logs). Choice of header: a bearer
 * token (`Authorization: Bearer <resolved>`), the OpenAI-compatible convention these endpoints
 * already speak. Throws (before any fetch) when the ref cannot be resolved so the caller falls
 * through to the next endpoint in fabric order — the error names the REF, never the value.
 */
const authHeaders = (endpoint: HttpEndpoint, resolveKey: SecretResolver | undefined): Record<string, string> => {
  const keyRef = endpoint.auth?.keyRef
  if (keyRef === undefined) return {}
  const value = resolveKey?.(keyRef)
  if (value === undefined || value === '') throw new Error(`missing secret for keyRef "${keyRef}"`)
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
}

interface ChatCompletion {
  choices?: { message?: { content?: string } }[]
}

/**
 * Call one http llm endpoint speaking the OpenAI-compatible chat-completions shape
 * (mlx / LM Studio style local servers). Throws on transport or protocol failure so the caller
 * can fall through to the next endpoint in fabric order.
 */
const callHttp = async (endpoint: HttpEndpoint, messages: LlmMessage[], opts: InvokeOptions): Promise<string> => {
  const auth = authHeaders(endpoint, opts.resolveKey) // may throw (unresolvable keyRef) → fall through
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000)
  try {
    const body: Record<string, unknown> = { messages, stream: false }
    if (endpoint.model !== undefined) body['model'] = endpoint.model
    if (opts.maxTokens !== undefined) body['max_tokens'] = opts.maxTokens
    if (opts.temperature !== undefined) body['temperature'] = opts.temperature
    const response = await fetch(`${endpoint.url.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const json = (await response.json()) as ChatCompletion
    const text = json.choices?.[0]?.message?.content
    if (typeof text !== 'string') throw new Error('no completion content in response')
    return text
  } finally {
    clearTimeout(timeout)
  }
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
  const failures: string[] = []
  for (const endpoint of endpoints) {
    if (endpoint.kind === 'local') {
      failures.push(`${endpoint.name}: local runtime invocation is stubbed`)
      continue
    }
    if (endpoint.kind === 'cloud') {
      failures.push(`${endpoint.name}: cloud endpoints are out of scope`)
      continue
    }
    if (endpoint.api !== 'openai-compat') {
      failures.push(`${endpoint.name}: unsupported api "${endpoint.api}"`)
      continue
    }
    try {
      const text = await callHttp(endpoint, messages, opts)
      const result: LlmResult = { text, endpoint: endpoint.name, slot: 'llm' }
      if (endpoint.model !== undefined) result.model = endpoint.model
      return result
    } catch (error) {
      failures.push(`${endpoint.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`no llm endpoint answered${failures.length ? ` (${failures.join('; ')})` : ' (fabric llm slot is empty)'}`)
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
}

/** audio/<subtype> → a filename the transcriber can sniff a container from; defaults to audio.bin. */
const audioFilename = (contentType: string): string => {
  const subtype = contentType.split(';')[0]?.split('/')[1]?.trim().replace(/^x-/, '')
  const ext = subtype === 'mpeg' ? 'mp3' : subtype && /^[a-z0-9]+$/.test(subtype) ? subtype : 'bin'
  return `audio.${ext}`
}

/**
 * Call one http stt endpoint speaking the OpenAI-compatible multipart shape
 * (`POST /v1/audio/transcriptions` with `model` + `file` fields — whisper.cpp/faster-whisper-server
 * style local servers). Throws on transport or protocol failure so the caller falls through to the
 * next endpoint in fabric order, exactly like callHttp for llm.
 */
const callSttHttp = async (endpoint: HttpEndpoint, audio: SttAudio, opts: SttOptions): Promise<string> => {
  const auth = authHeaders(endpoint, opts.resolveKey) // may throw (unresolvable keyRef) → fall through
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000)
  try {
    const form = new FormData()
    if (endpoint.model !== undefined) form.set('model', endpoint.model)
    if (opts.language !== undefined) form.set('language', opts.language)
    const bytes = Buffer.from(audio.base64, 'base64')
    form.set('file', new Blob([bytes], { type: audio.contentType }), audioFilename(audio.contentType))
    const response = await fetch(`${endpoint.url.replace(/\/$/, '')}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: auth,
      body: form,
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const json = (await response.json()) as { text?: unknown }
    // A transcriber that answers must return a `text` field; '' (silence) is valid, missing is not.
    if (typeof json.text !== 'string') throw new Error('no transcript text in response')
    return json.text
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Invoke the `stt` slot: try endpoints in fabric order (order is fallback, first that answers wins),
 * mirroring invokeLlm. http/openai-compat endpoints POST the multipart transcription shape; `local`
 * is a stub (skipped, offline runtimes land with managed runtimes later) and `cloud` is out of
 * scope, exactly as invokeLlm handles them. An empty transcript ('' = silence) is a normal result.
 */
export const invokeStt = async (fabric: Fabric, audio: SttAudio, opts: SttOptions = {}): Promise<SttResult> => {
  const endpoints = fabric.slots.stt
  const failures: string[] = []
  for (const endpoint of endpoints) {
    if (endpoint.kind === 'local') {
      failures.push(`${endpoint.name}: local runtime invocation is stubbed`)
      continue
    }
    if (endpoint.kind === 'cloud') {
      failures.push(`${endpoint.name}: cloud endpoints are out of scope`)
      continue
    }
    if (endpoint.api !== 'openai-compat') {
      failures.push(`${endpoint.name}: unsupported api "${endpoint.api}"`)
      continue
    }
    try {
      const text = await callSttHttp(endpoint, audio, opts)
      const result: SttResult = { text, endpoint: endpoint.name, slot: 'stt' }
      if (endpoint.model !== undefined) result.model = endpoint.model
      return result
    } catch (error) {
      failures.push(`${endpoint.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`no stt endpoint answered${failures.length ? ` (${failures.join('; ')})` : ' (fabric stt slot is empty)'}`)
}
