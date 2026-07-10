import type { Endpoint, LocalRuntime } from '@openinfo/contracts'

/**
 * The STT interop seam (PHASE4 P4-T9). The ENGINE owns transcript normalization: every STT flavor —
 * whisper.cpp's non-/v1 `/inference`, an OpenAI-compatible `/v1/audio/transcriptions` host, omlx's
 * Apple-silicon transcription endpoint — answers with a DIFFERENT wire body, and this module maps each
 * onto ONE canonical `TranscriptResult`. Adding a new STT engine is a new adapter here plus an endpoint
 * doc, NEVER a new branch at the invoke call site: `invokeStt` selects an adapter by the endpoint's api
 * kind (http) / runtime (local) and speaks only the canonical shape afterwards.
 *
 * Verified-live (2026-07 rig): omlx 0.4.5 `/v1/audio/transcriptions` returns
 *   {text, language?, duration?, segments?:[{start,end,text,…}]}
 * — the OpenAI verbose_json shape — proven against its whisper model. (omlx 0.4.5 rejects PARAKEET for
 * stt with "Model type … not supported for stt"; that is a server-side limitation, so the omlx adapter
 * is exercised live via omlx-whisper and stays correct for parakeet once the server supports it — the
 * response model is the same endpoint contract.) whisper.cpp's shape is docs/precedent-derived from the
 * existing `/inference` seam (`{text}`, plus centisecond `t0`/`t1` segments in its verbose mode).
 */

/** One transcript segment in CANONICAL units — seconds, whatever centisecond/second dialect it arrived in. */
export interface TranscriptSegment {
  text: string
  startSec?: number
  endSec?: number
  /**
   * Whisper-class no-speech probability for this segment (0..1): the model's confidence that the window
   * held NO speech. Present only for flavors that offer it — openai/omlx verbose_json carry a per-segment
   * `no_speech_prob`; whisper.cpp `/inference` and parakeet-class engines do not. Consumed by
   * `dropSilentSegments` to drop hallucinated stock phrases from near-silent windows before they reach the
   * distill accumulator (#69). Append-only + optional: a consumer that does not care never sees it.
   */
  noSpeechProb?: number
}

/**
 * The ONE transcript shape every STT flavor normalizes to. `text` is the whole transcript ('' is a valid
 * silence outcome, never an error); the rest are present only when the flavor supplied them, so a consumer
 * reads `text` uniformly and reaches for language/duration/segments only when a richer engine offers them.
 */
export interface TranscriptResult {
  text: string
  language?: string
  durationSec?: number
  segments?: TranscriptSegment[]
}

/**
 * Default no-speech probability at or above which a whisper-class segment is treated as silence and
 * dropped before it can enter the distill accumulator (#69). Whisper's own decoder defaults its
 * `no_speech_threshold` to 0.6 but only acts on it in combination with `avg_logprob`; using
 * `no_speech_prob` as the SOLE gate we set the bar higher (0.8) so only high-confidence silence is
 * dropped and genuinely quiet speech is spared. The target failure mode — plausible stock phrases from
 * an empty room — sits well above 0.9 in practice, comfortably above 0.8.
 */
export const DEFAULT_NO_SPEECH_THRESHOLD = 0.8

/** The outcome of `dropSilentSegments`: the surviving transcript plus how many segments were dropped. */
export interface SilenceFilterResult {
  /** transcript rebuilt from the surviving (speech) segments, trimmed; '' when every segment was silence */
  text: string
  /** segments dropped as no-speech / hallucination */
  dropped: number
  /** total segments the flavor offered (0 when it offered none — no per-segment signal to filter on) */
  total: number
}

/**
 * Drop no-speech / hallucinated segments from a normalized transcript BEFORE it reaches the distill
 * accumulator (#69) and rebuild the transcript from what survives.
 *
 * - whisper-class (openai/omlx verbose_json): a segment whose `noSpeechProb` is at/above `threshold` is
 *   silence — the known failure mode where a near-silent window decodes as a confident stock phrase.
 * - parakeet-class (no `noSpeechProb`): there is no confidence signal, so the only HONEST per-segment
 *   test is empty/whitespace text — that is all this drops for those flavors. Disclosed weakness: a
 *   parakeet hallucination with non-empty text is NOT caught here; the real defense there is the optional
 *   client-side energy gate (out of scope for this slice), which stops the window ever being shipped.
 *
 * A flavor that offered no segments at all (plain `{text}`, e.g. whisper.cpp `/inference?json`) has no
 * per-segment signal, so its whole transcript passes through unchanged (`dropped:0, total:0`) — pure ''
 * silence is still handled by the caller's existing empty-text check.
 */
export const dropSilentSegments = (
  result: TranscriptResult,
  threshold: number = DEFAULT_NO_SPEECH_THRESHOLD,
): SilenceFilterResult => {
  const segments = result.segments
  if (segments === undefined || segments.length === 0) return { text: result.text.trim(), dropped: 0, total: 0 }
  const kept: string[] = []
  let dropped = 0
  for (const seg of segments) {
    const silent = seg.noSpeechProb !== undefined ? seg.noSpeechProb >= threshold : seg.text.trim().length === 0
    if (silent) dropped += 1
    else kept.push(seg.text)
  }
  // Segment texts carry whisper's leading-space convention, so join with '' and trim once at the end —
  // this reconstructs the same string the flavor's own `text` field would have, minus the dropped spans.
  return { text: kept.join('').trim(), dropped, total: segments.length }
}

/** The STT wire dialects the engine speaks. A new engine adds a member + an adapter, nothing else. */
export type SttFlavor = 'openai' | 'omlx' | 'whisper-server'

/** How a flavor shapes its multipart REQUEST (the response is handled by `normalize`). */
export interface SttRequestShape {
  /**
   * Send the `model` form field. Required by openai/omlx (they serve many models and pick per request);
   * whisper.cpp's `whisper-server` loads ONE model via `-m` and its `/inference` takes no `model` field.
   */
  sendModel: boolean
  /** The `response_format` form field to send, or undefined to send none (let the server default). */
  responseFormat?: string
  /** The transcription POST path relative to the endpoint url (whisper.cpp is /inference, not /v1). */
  path: string
}

/** A per-flavor STT adapter: how to shape the request + how to normalize the response to canonical form. */
export interface SttAdapter {
  flavor: SttFlavor
  request: SttRequestShape
  /**
   * Normalize a parsed JSON body to the canonical `TranscriptResult`, or undefined when it carries no
   * usable transcript (missing `text`) so the caller raises a single honest `bad-response` — the adapter
   * never throws or classifies, it only maps a well-formed body.
   */
  normalize: (body: unknown) => TranscriptResult | undefined
}

const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const asNumber = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/**
 * OpenAI verbose_json / omlx transcription segments: `{start, end, text}` with times already in SECONDS.
 * A segment with no string `text` is dropped (tolerant), so a malformed entry never poisons the list.
 */
const openAiSegments = (raw: unknown): TranscriptSegment[] | undefined => {
  if (!Array.isArray(raw)) return undefined
  const out: TranscriptSegment[] = []
  for (const seg of raw) {
    const text = asString((seg as { text?: unknown } | null)?.text)
    if (text === undefined) continue
    const segment: TranscriptSegment = { text }
    const start = asNumber((seg as { start?: unknown }).start)
    const end = asNumber((seg as { end?: unknown }).end)
    const noSpeechProb = asNumber((seg as { no_speech_prob?: unknown }).no_speech_prob)
    if (start !== undefined) segment.startSec = start
    if (end !== undefined) segment.endSec = end
    if (noSpeechProb !== undefined) segment.noSpeechProb = noSpeechProb
    out.push(segment)
  }
  return out.length > 0 ? out : undefined
}

/**
 * Normalize the OpenAI-compatible transcription body (also omlx's — verified live): `text` is required,
 * `language`/`duration`/`segments` ride along when present. Missing `text` ⇒ undefined (a bad response).
 */
const normalizeOpenAi = (body: unknown): TranscriptResult | undefined => {
  const text = asString((body as { text?: unknown } | null)?.text)
  if (text === undefined) return undefined
  const result: TranscriptResult = { text }
  const language = asString((body as { language?: unknown }).language)
  const duration = asNumber((body as { duration?: unknown }).duration)
  const segments = openAiSegments((body as { segments?: unknown }).segments)
  if (language !== undefined) result.language = language
  // omlx reports duration:0.0 for short clips; keep only a positive duration (0 carries no information).
  if (duration !== undefined && duration > 0) result.durationSec = duration
  if (segments !== undefined) result.segments = segments
  return result
}

/**
 * whisper.cpp `whisper-server` `/inference`: plain `{text}` under response_format=json. Its VERBOSE mode
 * emits `segments:[{t0, t1, text}]` where `t0`/`t1` are CENTISECONDS (0.01s) — a real per-flavor units
 * difference, so this adapter divides by 100 to reach canonical seconds rather than pretend it is OpenAI.
 * Tolerant of the plain shape (no segments) since that is what the current `/inference?response_format=json`
 * seam actually returns.
 */
const whisperServerSegments = (raw: unknown): TranscriptSegment[] | undefined => {
  if (!Array.isArray(raw)) return undefined
  const out: TranscriptSegment[] = []
  for (const seg of raw) {
    const text = asString((seg as { text?: unknown } | null)?.text)
    if (text === undefined) continue
    const segment: TranscriptSegment = { text }
    const t0 = asNumber((seg as { t0?: unknown }).t0)
    const t1 = asNumber((seg as { t1?: unknown }).t1)
    if (t0 !== undefined) segment.startSec = t0 / 100
    if (t1 !== undefined) segment.endSec = t1 / 100
    out.push(segment)
  }
  return out.length > 0 ? out : undefined
}

const normalizeWhisperServer = (body: unknown): TranscriptResult | undefined => {
  const text = asString((body as { text?: unknown } | null)?.text)
  if (text === undefined) return undefined
  const result: TranscriptResult = { text }
  const segments = whisperServerSegments((body as { segments?: unknown }).segments)
  if (segments !== undefined) result.segments = segments
  return result
}

/**
 * The STT adapter table — one entry per flavor. `openai` and `omlx` share the OpenAI-compatible request +
 * normalizer (omlx IS OpenAI-compatible on the wire, verified live); they are DISTINCT entries so a future
 * omlx-specific divergence changes only this record, never the invoke seam. whisper-server is its own
 * dialect (non-/v1 path, no model field, centisecond segments).
 */
export const STT_ADAPTERS: Record<SttFlavor, SttAdapter> = {
  openai: {
    flavor: 'openai',
    // verbose_json (not plain json) so the response carries per-segment `no_speech_prob` — the signal the
    // silence filter (#69) needs to drop hallucinated stock phrases from near-silent windows. The
    // normalizer already tolerates the plain `{text}` shape, so a host that ignores the field still works.
    request: { sendModel: true, responseFormat: 'verbose_json', path: '/v1/audio/transcriptions' },
    normalize: normalizeOpenAi,
  },
  omlx: {
    flavor: 'omlx',
    request: { sendModel: true, responseFormat: 'verbose_json', path: '/v1/audio/transcriptions' },
    normalize: normalizeOpenAi,
  },
  'whisper-server': {
    flavor: 'whisper-server',
    request: { sendModel: false, responseFormat: 'json', path: '/inference' },
    normalize: normalizeWhisperServer,
  },
}

/** The STT flavor a `local` runtime speaks (mlx/omlx transcription vs whisper.cpp's /inference). */
const LOCAL_RUNTIME_FLAVOR: Partial<Record<LocalRuntime, SttFlavor>> = {
  mlx: 'omlx',
  'whisper.cpp': 'whisper-server',
}

/**
 * Choose the STT adapter for an endpoint — the ONE place flavor selection lives, mirroring how the llm/vlm
 * slots choose a call path by kind/api. http endpoints select by `api` (openai-compat → the OpenAI adapter);
 * local endpoints select by `runtime` (mlx → omlx, whisper.cpp → whisper-server). Returns undefined for a
 * dialect the engine does not (yet) speak — the caller records an honest "unsupported" and falls through.
 */
export const selectSttAdapter = (endpoint: Endpoint, runtime?: LocalRuntime): SttAdapter | undefined => {
  if (endpoint.kind === 'http') {
    return endpoint.api === 'openai-compat' ? STT_ADAPTERS.openai : undefined
  }
  if (endpoint.kind === 'local') {
    const flavor = LOCAL_RUNTIME_FLAVOR[runtime ?? endpoint.runtime]
    return flavor ? STT_ADAPTERS[flavor] : undefined
  }
  return undefined
}
