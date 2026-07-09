/**
 * The invoke-failure taxonomy (INVOKE-RESILIENCE slice). Every transport/protocol failure of the llm
 * or stt slot becomes an `InvokeError` carrying a CLASS, the endpoint it happened on, and a one-line
 * troubleshoot hint — so the system can tell "the model won't load" from "the key is wrong" from "the
 * server isn't running" and say exactly what to do: detect the difference between a failed API key
 * and a model that's not loading, and suggest a troubleshoot step.
 *
 * Additive and engine-internal: invoke's fall-through semantics are unchanged (a classified failure is
 * still just a reason to try the next endpoint); the classes ride along in the per-endpoint failure list
 * so a caller (the queue drain, the Try-it card, a generate probe) can surface the REAL reason instead of
 * guessing. NO secret VALUE ever appears here — an auth failure names the keyRef, never its value.
 */

export type InvokeErrorClass = 'unreachable' | 'timeout' | 'auth' | 'model-load' | 'bad-response' | 'reasoning-exhausted'

/** What we were calling when it failed — the endpoint, named (never a secret value). */
export interface InvokeCtx {
  /** the endpoint's name (fabric-order identity), safe to surface */
  endpoint: string
  url: string
  model?: string
  /** the endpoint's auth.keyRef, if any — the REFERENCE, never the resolved value */
  keyRef?: string
}

/** The classified, surface-ready shape of ONE invoke failure. Carries a keyRef, never a key value. */
export interface ClassifiedFailure {
  class: InvokeErrorClass
  endpoint: string
  url: string
  model?: string
  keyRef?: string
  /** the server's OWN error text (model-load / bad-response) captured verbatim, truncated */
  serverMessage?: string
  /** the one-line "what to do about it" step */
  hint: string
}

const MAX_SERVER_MESSAGE = 500

/** The default troubleshoot line for a class, given the endpoint context. Overridable per-failure. */
const hintFor = (cls: InvokeErrorClass, ctx: InvokeCtx): string => {
  switch (cls) {
    case 'unreachable':
      return `is the server running? check the URL ${ctx.url}`
    case 'timeout':
      return 'no response in time — the model may still be loading; pick a smaller/loaded model in Settings → Endpoints'
    case 'auth':
      return ctx.keyRef !== undefined
        ? `check key "${ctx.keyRef}" in Settings → Keys`
        : 'authorization required — add a key in Settings → Keys and reference it via keyRef'
    case 'model-load':
      return `model ${ctx.model !== undefined ? `"${ctx.model}" ` : ''}failed to load on ${ctx.url} — pick a smaller/loaded model in Settings → Endpoints`
    case 'bad-response':
      return 'the server responded in an unexpected way — check the URL points at an OpenAI-compatible server'
    case 'reasoning-exhausted':
      return `model ${ctx.model !== undefined ? `"${ctx.model}" ` : ''}spent its entire token budget thinking and returned no output — use a non-reasoning instruct model for this slot, or raise the mode's token budget`
  }
}

export class InvokeError extends Error {
  readonly class: InvokeErrorClass
  readonly endpoint: string
  readonly url: string
  readonly model?: string
  readonly keyRef?: string
  readonly serverMessage?: string
  readonly hint: string

  constructor(cls: InvokeErrorClass, ctx: InvokeCtx, extra: { serverMessage?: string; hint?: string } = {}) {
    const serverMessage = extra.serverMessage
    const hint = extra.hint ?? hintFor(cls, ctx)
    super(`${cls}: ${serverMessage ?? hint}`)
    this.name = 'InvokeError'
    this.class = cls
    this.endpoint = ctx.endpoint
    this.url = ctx.url
    if (ctx.model !== undefined) this.model = ctx.model
    if (ctx.keyRef !== undefined) this.keyRef = ctx.keyRef
    if (serverMessage !== undefined) this.serverMessage = serverMessage
    this.hint = hint
  }

  toFailure(): ClassifiedFailure {
    return {
      class: this.class,
      endpoint: this.endpoint,
      url: this.url,
      ...(this.model !== undefined ? { model: this.model } : {}),
      ...(this.keyRef !== undefined ? { keyRef: this.keyRef } : {}),
      ...(this.serverMessage !== undefined ? { serverMessage: this.serverMessage } : {}),
      hint: this.hint,
    }
  }
}

/**
 * The final throw of invokeLlm/invokeStt when NO endpoint answered — carries the classified per-endpoint
 * failures so a caller can surface the real reason (the drain records it; the generate probe reports it).
 */
export class AggregateInvokeError extends Error {
  readonly slot: 'llm' | 'stt' | 'ocr' | 'vlm'
  readonly failures: ClassifiedFailure[]

  constructor(slot: 'llm' | 'stt' | 'ocr' | 'vlm', message: string, failures: ClassifiedFailure[]) {
    super(message)
    this.name = 'AggregateInvokeError'
    this.slot = slot
    this.failures = failures
  }
}

/** Dig an OS error code (ECONNREFUSED, ENOTFOUND, …) out of a thrown fetch error's cause chain. */
const errorCode = (error: unknown): string | undefined => {
  const direct = (error as { code?: unknown }).code
  if (typeof direct === 'string') return direct
  const cause = (error as { cause?: unknown }).cause
  if (cause && typeof cause === 'object') {
    const code = (cause as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return undefined
}

/**
 * Classify a THROWN fetch error (never a response) — a timed-out abort becomes `timeout`, anything
 * else (ECONNREFUSED / DNS / reset) becomes `unreachable`. The OS code, when present, is the serverMessage.
 */
export const classifyFetchError = (error: unknown, ctx: InvokeCtx): InvokeError => {
  if (error instanceof Error && error.name === 'AbortError') return new InvokeError('timeout', ctx)
  const code = errorCode(error)
  return new InvokeError('unreachable', ctx, code !== undefined ? { serverMessage: code } : {})
}

/** Pull the server's own message out of an error body (JSON {error}/{error.message}/{message}, else raw). */
export const extractServerMessage = (bodyText: string): string | undefined => {
  const raw = bodyText.trim()
  if (raw === '') return undefined
  try {
    const json = JSON.parse(raw) as unknown
    if (json && typeof json === 'object') {
      const err = (json as { error?: unknown }).error
      if (typeof err === 'string') return err.slice(0, MAX_SERVER_MESSAGE)
      if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
        return (err as { message: string }).message.slice(0, MAX_SERVER_MESSAGE)
      }
      const msg = (json as { message?: unknown }).message
      if (typeof msg === 'string') return msg.slice(0, MAX_SERVER_MESSAGE)
    }
  } catch {
    // not JSON — fall through to the raw body
  }
  return raw.slice(0, MAX_SERVER_MESSAGE)
}

/** True when an error body reads like a model that failed to load / is not loaded (LM Studio's 400). */
const looksLikeModelLoad = (bodyText: string): boolean =>
  /fail(?:ed|ure)?\s+to\s+load|not\s+loaded|no\s+model|unable\s+to\s+load|error\s+loading|load(?:ing)?\s+the\s+model|model\s+.*\bload/i.test(
    bodyText,
  )

/**
 * Classify a NON-OK HTTP response from a completions/transcription call:
 * - 401/403 → `auth` (name the keyRef, never the value)
 * - a body that reads like a model-load failure, OR any 400 / 5xx → `model-load` (the server rejected the
 *   generation — for an LLM server this is almost always the model, so capture its message and suggest a
 *   smaller/loaded one). This is the LM Studio case: HTTP 400 with `{"error":"Model … failed to load …"}`.
 * - anything else (404, 429, …) → `bad-response` (an unexpected reply — likely the wrong URL/shape).
 */
export const classifyHttpResponse = (status: number, bodyText: string, ctx: InvokeCtx): InvokeError => {
  const serverMessage = extractServerMessage(bodyText)
  if (status === 401 || status === 403) {
    return new InvokeError('auth', ctx, serverMessage !== undefined ? { serverMessage } : {})
  }
  if (looksLikeModelLoad(bodyText) || status === 400 || status >= 500) {
    return new InvokeError('model-load', ctx, { serverMessage: serverMessage ?? `HTTP ${status}` })
  }
  return new InvokeError('bad-response', ctx, { serverMessage: serverMessage ?? `HTTP ${status}` })
}

/** Pull the representative classified failure out of an invoke throw (the primary/first endpoint's). */
export const describeInvokeFailure = (error: unknown): ClassifiedFailure | undefined => {
  if (error instanceof AggregateInvokeError) return error.failures[0]
  if (error instanceof InvokeError) return error.toFailure()
  return undefined
}
