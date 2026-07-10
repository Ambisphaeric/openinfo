import type { Endpoint, GuardBehavior, GuardSpan, GuardVerdict } from '@openinfo/contracts'
import type { SecretResolver } from './secrets.js'
import type { LlmMessage } from './invoke.js'
import type { ClassifiedFailure } from './invoke-error.js'

/**
 * The egress GUARD (#63) — the content/PII filter run on every hop MARKED egress, AFTER the #64 egress
 * gate has ALLOWED egress and BEFORE any bytes leave. This module is the pure core (redaction + policy
 * evaluation, exhaustively testable) plus a small OpenAI-compat classifier client. It never does egress
 * enforcement itself — invoke.ts calls it only at a `{allow:true, reach:'egress'}` hop, so local-only hops
 * never reach it (no egress ⇒ no filter).
 *
 * The verdict→behavior policy is DOCUMENT-DRIVEN (GuardPolicy / the guard.enabled flag), never hardcoded:
 * `redact-and-continue` masks flagged spans and proceeds; `hold-and-surface` suspends the hop. The
 * fail-closed edges (empty guard slot) are handled in `evaluateGuard`, and a configured-but-unreachable
 * guard also HOLDS (never lets content leave unguarded).
 */

/** The guard config threaded into an egress invoke — the guard slot + the resolved policy. */
export interface GuardOptions {
  /** the fabric `guard` slot (order is fallback, first that answers wins); empty ⇒ the fail-closed edge. */
  endpoints: readonly Endpoint[]
  /** the resolved policy behavior (redact-and-continue default, hold-and-surface strict). */
  behavior: GuardBehavior
  /** default mode + empty slot: true ⇒ egress proceeds unguarded (recorded); false ⇒ it HOLDS. */
  acknowledgeUnguardedEgress: boolean
  /** resolve a guard endpoint's auth.keyRef at classify time (bearer injection); optional. */
  resolveKey?: SecretResolver | undefined
  /** classify-call timeout; defaults to 15s. */
  timeoutMs?: number | undefined
}

/** The deterministic outbound serialization the classifier sees and redaction offsets are relative to. */
export const serializeMessages = (messages: readonly LlmMessage[]): string => messages.map((m) => m.content).join('\n')

/**
 * Mask a text's flagged spans with `[redacted:<kind>]`, replacing back-to-front so earlier offsets stay
 * valid. Out-of-range / zero-length spans are skipped and the masked extent is clamped to the text — a
 * classifier that over-reports never corrupts the body. Overlapping spans are assumed disjoint (the
 * classifier reports disjoint spans); the raw value is never retained. Pure.
 */
export const applyRedaction = (text: string, spans: readonly GuardSpan[]): string => {
  const valid = spans
    .filter((s) => s.start >= 0 && s.length >= 1 && s.start < text.length)
    .map((s) => ({ kind: s.kind, start: s.start, end: Math.min(text.length, s.start + s.length) }))
    .sort((a, b) => b.start - a.start)
  let out = text
  for (const s of valid) out = out.slice(0, s.start) + `[redacted:${s.kind}]` + out.slice(s.end)
  return out
}

/**
 * Redact flagged spans across a message list, mirroring `serializeMessages` (contents joined by '\n', one
 * char per separator) so a span's global offset maps to the right message. A span that falls entirely
 * inside one message's window is translated to a local offset and masked there; a span that straddles a
 * message boundary is left alone (a PII token is within one message). Pure — returns fresh messages.
 */
export const redactMessages = (messages: readonly LlmMessage[], spans: readonly GuardSpan[]): LlmMessage[] => {
  const result = messages.map((m) => ({ ...m }))
  if (spans.length === 0) return result
  let base = 0
  for (const msg of result) {
    const winStart = base
    const winEnd = base + msg.content.length
    const local = spans
      .filter((s) => s.start >= winStart && s.start + s.length <= winEnd)
      .map((s) => ({ kind: s.kind, start: s.start - winStart, length: s.length }))
    if (local.length > 0) msg.content = applyRedaction(msg.content, local)
    base = winEnd + 1 // the '\n' separator serializeMessages joins with
  }
  return result
}

/** The pure policy input — what the classifier found plus the resolved policy and slot posture. */
export interface GuardEvalInput {
  spans: readonly GuardSpan[]
  guardConfigured: boolean
  behavior: GuardBehavior
  acknowledgeUnguardedEgress: boolean
  guardEndpoint?: string | undefined
}

/** The pure policy output: whether to proceed, whether to redact first, and the verdict to record. */
export interface GuardDecision {
  proceed: boolean
  redact: boolean
  verdict: GuardVerdict
}

/**
 * The pure verdict→behavior policy — the whole decision table (#63 canon), no I/O:
 *  - guard configured, nothing flagged            → proceed, outcome 'clean'.
 *  - guard configured, flagged, redact-and-continue → proceed + redact, outcome 'redacted'.
 *  - guard configured, flagged, hold-and-surface    → HOLD, outcome 'held'.
 *  - EMPTY slot + hold-and-surface (strict)          → HOLD (fail closed), outcome 'held'.
 *  - EMPTY slot + default + acknowledged             → proceed UNGUARDED, outcome 'unguarded'.
 *  - EMPTY slot + default + NOT acknowledged         → HOLD (never silently unguarded), outcome 'held'.
 * Span descriptors (kind/start/length — never the raw value) ride the verdict for redacted/held.
 */
export const evaluateGuard = (input: GuardEvalInput): GuardDecision => {
  const { spans, guardConfigured, behavior, acknowledgeUnguardedEgress, guardEndpoint } = input
  const ep = guardEndpoint !== undefined ? { guardEndpoint } : {}

  if (!guardConfigured) {
    if (behavior === 'hold-and-surface') {
      return {
        proceed: false,
        redact: false,
        verdict: { behavior, outcome: 'held', guarded: false, maskedSpanCount: 0, reason: 'no guard endpoint configured and strict mode is on — egress held (fail closed)' },
      }
    }
    if (acknowledgeUnguardedEgress) {
      return {
        proceed: true,
        redact: false,
        verdict: { behavior, outcome: 'unguarded', guarded: false, maskedSpanCount: 0, reason: 'no guard endpoint configured — egress proceeded under an explicit unguarded acknowledgment' },
      }
    }
    return {
      proceed: false,
      redact: false,
      verdict: { behavior, outcome: 'held', guarded: false, maskedSpanCount: 0, reason: 'no guard endpoint configured and unguarded egress not acknowledged — egress held (never silently unguarded)' },
    }
  }

  if (spans.length === 0) {
    return {
      proceed: true,
      redact: false,
      verdict: { behavior, outcome: 'clean', guarded: true, maskedSpanCount: 0, ...ep, reason: 'the egress guard flagged no sensitive spans' },
    }
  }
  if (behavior === 'hold-and-surface') {
    return {
      proceed: false,
      redact: false,
      verdict: { behavior, outcome: 'held', guarded: true, maskedSpanCount: spans.length, spans: [...spans], ...ep, reason: `the egress guard flagged ${spans.length} span(s); strict mode suspended the hop for review` },
    }
  }
  return {
    proceed: true,
    redact: true,
    verdict: { behavior, outcome: 'redacted', guarded: true, maskedSpanCount: spans.length, spans: [...spans], ...ep, reason: `the egress guard masked ${spans.length} flagged span(s) before the content left the machine` },
  }
}

/** A held hop — thrown out of the invoke to STOP it (a hard stop, never a fall-through). Carries the
 * verdict (with span descriptors, never the raw value) so the caller persists it to the audit trail. */
export class GuardHeldError extends Error {
  readonly class = 'guard-held' as const
  readonly verdict: GuardVerdict
  readonly endpointName: string
  readonly url: string
  constructor(verdict: GuardVerdict, ctx: { endpoint: string; url: string }) {
    super(`guard-held: ${verdict.reason}`)
    this.name = 'GuardHeldError'
    this.verdict = verdict
    this.endpointName = ctx.endpoint
    this.url = ctx.url
  }
  toFailure(): ClassifiedFailure {
    return { class: 'guard-held', endpoint: this.endpointName, url: this.url, hint: this.verdict.reason }
  }
}

/** The v0 guard classifier system prompt — asks an OpenAI-compat model to return disjoint sensitive spans
 * as strict JSON offsets into the user message. A real llama-guard's safe/unsafe+categories output would
 * ride a small adapter (like the STT adapters) — deferred; v0 speaks this one JSON shape. */
const GUARD_SYSTEM =
  'You are a content-safety classifier guarding data leaving a machine. In the user message, find spans of ' +
  'sensitive or PII content (payment card numbers, secrets/API keys, government/account identifiers, emails, ' +
  'phone numbers). Respond with ONLY JSON of the form {"flagged":[{"start":<int>,"length":<int>,"kind":"<label>"}]} ' +
  'using character offsets into the user message. If nothing is sensitive, respond {"flagged":[]}. No prose.'

/** The classifier result — flagged span descriptors and which guard endpoint answered (name, never url/secret). */
export interface GuardClassification {
  flagged: GuardSpan[]
  guardEndpoint?: string
}

/** Extract a `{...}` JSON object from a model reply that may wrap it in prose/code fences; undefined if none. */
const extractJsonObject = (content: string): unknown => {
  const trimmed = content.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const first = trimmed.indexOf('{')
    const last = trimmed.lastIndexOf('}')
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(trimmed.slice(first, last + 1))
      } catch {
        return undefined
      }
    }
    return undefined
  }
}

/** Coerce a parsed `{flagged:[...]}` reply into validated GuardSpans (dropping malformed entries), clamped
 * to the classified text length so a span can never point outside the content. */
const parseFlagged = (parsed: unknown, textLength: number): GuardSpan[] => {
  const flagged = (parsed as { flagged?: unknown } | undefined)?.flagged
  if (!Array.isArray(flagged)) return []
  const spans: GuardSpan[] = []
  for (const raw of flagged) {
    if (!raw || typeof raw !== 'object') continue
    const start = (raw as { start?: unknown }).start
    const length = (raw as { length?: unknown }).length
    const kind = (raw as { kind?: unknown }).kind
    if (typeof start !== 'number' || typeof length !== 'number') continue
    const s = Math.max(0, Math.trunc(start))
    if (s >= textLength) continue
    const len = Math.min(textLength - s, Math.trunc(length))
    if (len < 1) continue
    spans.push({ start: s, length: len, kind: typeof kind === 'string' && kind.trim() !== '' ? kind : 'sensitive' })
  }
  return spans
}

interface ChatCompletion {
  choices?: { message?: { content?: string } }[]
}

/** POST the text to ONE http/openai-compat guard endpoint and parse its flagged spans. Throws on any
 * transport/protocol/parse failure so the caller can fall through (and, if none answer, fail closed). */
const classifyOne = async (endpoint: Extract<Endpoint, { kind: 'http' }>, text: string, opts: GuardOptions): Promise<GuardSpan[]> => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const keyRef = endpoint.auth?.keyRef
  if (keyRef !== undefined) {
    const value = opts.resolveKey?.(keyRef)
    if (value === undefined || value === '') throw new Error(`guard endpoint "${endpoint.name}": no value stored for keyRef "${keyRef}"`)
    headers['authorization'] = `Bearer ${value}`
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000)
  let response: Response
  try {
    const body: Record<string, unknown> = {
      messages: [
        { role: 'system', content: GUARD_SYSTEM },
        { role: 'user', content: text },
      ],
      stream: false,
    }
    if (endpoint.model !== undefined) body['model'] = endpoint.model
    response = await fetch(`${endpoint.url.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
  if (!response.ok) throw new Error(`guard endpoint "${endpoint.name}" HTTP ${response.status}`)
  const json = (await response.json()) as ChatCompletion
  const content = json.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new Error(`guard endpoint "${endpoint.name}" returned no classifier content`)
  const parsed = extractJsonObject(content)
  if (parsed === undefined) throw new Error(`guard endpoint "${endpoint.name}" returned unparseable classifier output`)
  return parseFlagged(parsed, text.length)
}

/**
 * Classify outbound text against the guard slot: try endpoints in fabric order, first that answers wins.
 * v0 speaks http/openai-compat guard endpoints; local/cloud guard endpoints are skipped (disclosed — a
 * managed-local guard runtime is a follow-up). Throws when NO configured guard endpoint could classify, so
 * the caller fails CLOSED (a configured-but-unreachable guard never lets content leave unguarded).
 */
export const classifyEgressText = async (text: string, opts: GuardOptions): Promise<GuardClassification> => {
  const errors: string[] = []
  for (const endpoint of opts.endpoints) {
    if (endpoint.kind !== 'http' || endpoint.api !== 'openai-compat') {
      errors.push(`${endpoint.name}: unsupported guard endpoint (v0 supports http/openai-compat)`)
      continue
    }
    try {
      const flagged = await classifyOne(endpoint, text, opts)
      return { flagged, guardEndpoint: endpoint.name }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  throw new Error(`no guard endpoint classified the content${errors.length ? ` (${errors.join('; ')})` : ''}`)
}

/**
 * The full egress-guard step for one allowed egress hop: classify (when a guard is configured), evaluate
 * the policy, and either return the (possibly redacted) messages + verdict to proceed, or THROW
 * GuardHeldError to suspend the hop. A configured guard that cannot classify HOLDS (fail closed). This is
 * the ONE function invoke.ts calls at the `{allow:true, reach:'egress'}` hook point.
 */
export const runEgressGuard = async (
  messages: readonly LlmMessage[],
  ctx: { endpoint: string; url: string },
  opts: GuardOptions,
): Promise<{ messages: LlmMessage[]; verdict: GuardVerdict }> => {
  const guardConfigured = opts.endpoints.length > 0
  let flagged: GuardSpan[] = []
  let guardEndpoint: string | undefined
  if (guardConfigured) {
    try {
      const classification = await classifyEgressText(serializeMessages(messages), opts)
      flagged = classification.flagged
      guardEndpoint = classification.guardEndpoint
    } catch {
      // Fail closed: a configured guard that cannot classify must NOT let content leave unguarded.
      throw new GuardHeldError(
        { behavior: opts.behavior, outcome: 'held', guarded: false, maskedSpanCount: 0, reason: 'the configured egress guard could not classify the content (unreachable or unparseable) — egress held (fail closed)' },
        ctx,
      )
    }
  }
  const decision = evaluateGuard({
    spans: flagged,
    guardConfigured,
    behavior: opts.behavior,
    acknowledgeUnguardedEgress: opts.acknowledgeUnguardedEgress,
    guardEndpoint,
  })
  if (!decision.proceed) throw new GuardHeldError(decision.verdict, ctx)
  return { messages: decision.redact ? redactMessages(messages, flagged) : messages.map((m) => ({ ...m })), verdict: decision.verdict }
}
