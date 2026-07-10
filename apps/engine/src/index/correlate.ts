import type { OcrResult, Sighting } from '@openinfo/contracts'
import { nameSimilarity, normalizeForm } from './phonetic.js'
import { SIGNAL_MULTIPLIER_MAX } from './resolve.js'

/**
 * Cross-source sighting correlation (#74) — the windowed correlator that makes the resolver's dead
 * `crossSourceCorroboration` input real. A multi-sense capture (audio transcript + screen OCR, kept as
 * separate streams but sharing window timing) uniquely knows when the SAME concept arrives through two
 * independent senses near-simultaneously: a name heard in the transcript while the same string is on
 * screen. Their agreement in a time window is near-proof — neither sense alone can resolve a mangled name
 * with confidence, but together they can.
 *
 * DETERMINISTIC, PURE ENGINE CODE — like the resolver it feeds, every function here is a pure function of
 * its inputs (no DB, no model, no clock beyond the timestamps handed in), so it is fixture-testable. It
 * produces two things a corroborated match earns:
 *  - the `crossSourceCorroboration` MULTIPLIER fed into `resolveEntity` (defaults neutral 1.0; a match
 *    emits `boost`). The score lift flows through the RESOLVER'S existing band decision — this module never
 *    forks a second promotion path; it only supplies the multiplier and the evidence.
 *  - a `seen` Sighting (the typed evidence trail entry) the store appends alongside the `heard` sighting,
 *    so the record carries the honest "seen + heard" why-line and the alias is taught with no user ask.
 *
 * The boost defaults to the resolver's signal-clamp ceiling (`SIGNAL_MULTIPLIER_MAX`, 1.5×) — enough to
 * rescue a weak-but-plausible phonetic match when the screen agrees, bounded so a spurious correlation can
 * never silently override the phonetic evidence wholesale (the resolver re-clamps at its boundary anyway).
 */

export interface CorrelationConfig {
  /**
   * The correlation window slack (ms): an OCR sighting counts as same-window if its capture instant lies
   * within this gap of the heard window interval. Default ~8s (the design brief's one-window figure).
   */
  windowMs: number
  /**
   * Minimum `nameSimilarity` between a heard surface form and an OCR surface form for them to count as the
   * SAME concept seen. Tuned so an ASR homophone ("pie dev" ↔ "pi.dev", ~0.92) corroborates while unrelated
   * on-screen text stays well below.
   */
  matchThreshold: number
  /** The `crossSourceCorroboration` multiplier emitted on a corroborated match (neutral 1.0 otherwise). */
  boost: number
}

export const DEFAULT_CORRELATION_CONFIG: CorrelationConfig = {
  windowMs: 8_000,
  matchThreshold: 0.7,
  // Aligned with the resolver's SIGNAL_MULTIPLIER_MAX so the strongest signal pulls exactly as hard as the
  // resolver's clamp permits — no more (a producer emitting more is re-clamped at the resolver boundary).
  boost: SIGNAL_MULTIPLIER_MAX,
}

/** The heard mention to correlate against the screen — its extracted surface form plus any aliases. */
export interface Correlatable {
  name: string
  aliases?: readonly string[]
}

export interface CorrelationResult {
  /** true ⇒ an independent same-window OCR form matched a heard form at/above `matchThreshold`. */
  corroborated: boolean
  /** the strongest heard-form × OCR-form similarity found ∈ [0,1]. */
  similarity: number
  /** the OCR surface form that corroborated (present only when corroborated). */
  matchedForm?: string
  /** the crossSourceCorroboration multiplier to feed the resolver: `boost` when corroborated, else 1.0. */
  multiplier: number
}

/**
 * Does an instant lie within `windowMs` of the [start,end] window interval? Non-finite (unparseable)
 * timestamps read as NOT in-window — proximity is never fabricated from a corrupt time (mirrors the
 * resolver's NaN-flooring discipline).
 */
export const overlapsWindow = (atIso: string, windowStart: string, windowEnd: string, windowMs: number): boolean => {
  const at = new Date(atIso).getTime()
  const start = new Date(windowStart).getTime()
  const end = new Date(windowEnd).getTime()
  if (!Number.isFinite(at) || !Number.isFinite(start) || !Number.isFinite(end)) return false
  const lo = Math.min(start, end)
  const hi = Math.max(start, end)
  return at >= lo - windowMs && at <= hi + windowMs
}

const SEGMENT_SEP = /[·|,;:\n\t]+|\s{2,}/

/**
 * Split one OCR string into candidate surface forms: the whole line, its separator-delimited segments, and
 * the path components of any segment (so "acme/pi.dev · Pull requests · #218" yields "acme/pi.dev",
 * "pi.dev", "acme", "Pull requests", …). This matters because `nameSimilarity` penalizes unmatched tokens —
 * the WHOLE "acme/pi.dev" (3 tokens) scores below the floor against a heard "pie dev" (2 tokens), but the
 * split-out "pi.dev" scores ~0.92. Empties are dropped; dedup happens in `ocrForms`.
 */
export const ocrTextForms = (text: string): string[] => {
  const out: string[] = []
  const push = (s: string): void => {
    const t = s.trim()
    if (t.length > 0) out.push(t)
  }
  push(text)
  for (const segment of text.split(SEGMENT_SEP)) {
    push(segment)
    if (segment.includes('/')) for (const part of segment.split('/')) push(part)
  }
  return out
}

/** Every candidate surface form an OcrResult offers — from its per-region blocks (when present) and its text, deduped by normalized form. */
export const ocrForms = (ocr: OcrResult): string[] => {
  const raw: string[] = []
  for (const block of ocr.blocks ?? []) raw.push(...ocrTextForms(block.text))
  raw.push(...ocrTextForms(ocr.text))
  const seen = new Set<string>()
  const forms: string[] = []
  for (const form of raw) {
    const key = normalizeForm(form)
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    forms.push(form)
  }
  return forms
}

/**
 * Correlate a heard mention against a set of already-extracted OCR surface forms. Returns the strongest
 * similarity, whether it cleared the threshold, and the multiplier to feed the resolver. Pure — the caller
 * supplies the forms (from `ocrForms`), so this is trivially fixture-testable against canned pairs.
 */
export const correlate = (
  heard: Correlatable,
  seenForms: readonly string[],
  config: CorrelationConfig = DEFAULT_CORRELATION_CONFIG,
): CorrelationResult => {
  const heardForms = [heard.name, ...(heard.aliases ?? [])].map((f) => f.trim()).filter((f) => f.length > 0)
  let best = 0
  let bestForm: string | undefined
  for (const h of heardForms) {
    for (const s of seenForms) {
      const sim = nameSimilarity(h, s)
      if (sim > best) {
        best = sim
        bestForm = s
      }
    }
  }
  const corroborated = best >= config.matchThreshold
  return {
    corroborated,
    similarity: best,
    ...(corroborated && bestForm !== undefined ? { matchedForm: bestForm } : {}),
    multiplier: corroborated ? config.boost : 1,
  }
}

export interface WindowCorrelationInput {
  /** the heard mention being resolved this window. */
  heard: Correlatable
  /** the heard window interval — OCR outside this (± the window slack) is not the same window. */
  window: { start: string; end: string }
  /** candidate same-session OCR results (the store's persisted screen-understanding stream). */
  ocr: readonly OcrResult[]
  config?: CorrelationConfig
}

export interface WindowCorrelation extends CorrelationResult {
  /** the `seen` evidence to append to the entity when corroborated — the store stamps it onto the record. */
  sighting?: Sighting
}

/** The instant an OCR pass saw the screen — the true capture time (#102 keep-time) when carried, else when recognition finished. */
const ocrAt = (ocr: OcrResult): string => ocr.capturedAt ?? ocr.createdAt

/**
 * The window-level correlator the distiller wiring calls: filter the OCR stream to the heard window, gather
 * their surface forms, correlate, and — on a match — build the `seen` Sighting to append. This is the thin
 * boundary between the pure math above and the persisted OcrResult stream; it opens no DB and mutates
 * nothing. `sighting.detail` carries the matched on-screen form (the evidence, not a secret value), and
 * `at` is the OCR capture instant so the trail is honest about WHEN the screen agreed.
 */
export const correlateWindow = (input: WindowCorrelationInput): WindowCorrelation => {
  const config = input.config ?? DEFAULT_CORRELATION_CONFIG
  const inWindow = input.ocr.filter((o) => overlapsWindow(ocrAt(o), input.window.start, input.window.end, config.windowMs))
  const forms = inWindow.flatMap(ocrForms)
  const result = correlate(input.heard, forms, config)
  if (!result.corroborated || result.matchedForm === undefined) return result
  const source =
    inWindow.find((o) => ocrForms(o).some((f) => normalizeForm(f) === normalizeForm(result.matchedForm!))) ?? inWindow[0]!
  const sighting: Sighting = { via: 'seen', at: ocrAt(source), detail: result.matchedForm }
  return { ...result, sighting }
}
