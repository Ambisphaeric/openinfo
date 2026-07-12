import type { ChatCitation, ChatContextSource, ChatContextSourceKind, ChatTurn, Entity, PinChunk, RelevantEntity } from '@openinfo/contracts'

/**
 * Chat context assembly — DATA, NOT CODE (owner canon 2026-07-11: "context assembly must be DECLARED in
 * the bundle config … so a future DSL compiles onto it", pill P1). The chat route reads the governing
 * bundle's `chat.contextAssembly` — an ORDERED list of the eight declared sources, each with its honest
 * budget — and this module assembles the turn's context by iterating those sources IN DECLARED ORDER,
 * honoring each source's `limit` / `windowChars` / `tokenBudget`. Change the declaration (PUT /bundles) and
 * assembly changes with NO code change; that is the whole point, and a test proves it.
 *
 * Everything here is PURE: `assembleChatContext` takes the declared sources plus an already-gathered data
 * bag (the route does the impure store reads) and returns the composed system-prompt body, the citations,
 * the recent-turn messages, and — the honest-accounting core — one report PER declared source saying what
 * entered and, when something did not, WHY (empty / unavailable / capped). Nothing is ever silently dropped:
 * a capped or omitted source is disclosed in its report and folded into the visible #134 budget note.
 */

/** Cheap, honest token estimate (chars/4, the widely-used heuristic) — MARKED as an estimate by the budget note. */
export const estimateTokens = (text: string): number => (text.length === 0 ? 0 : Math.ceil(text.length / 4))

/**
 * The engine's fallback assembly plan — used ONLY when a governing bundle declares no `chat` plan at all
 * (the shipped Standard App DOES declare one, so this is a safety net, not the norm). Mirrors the seeded
 * declaration's order and caps so a bundle without a chat plan still assembles a sensible, honest context.
 */
export const DEFAULT_CONTEXT_SOURCES: readonly ChatContextSource[] = [
  { kind: 'bundle-prompt' },
  { kind: 'active-preset' },
  { kind: 'transcript-window', windowChars: 4000 },
  { kind: 'insights', limit: 6 },
  { kind: 'relevant-entities', limit: 8 },
  { kind: 'attached-docs', limit: 4, tokenBudget: 1500 },
  { kind: 'screen', tokenBudget: 1000 },
  { kind: 'recent-turns', limit: 8 },
]

/** Per-chunk excerpt cap (chars) for attached-docs — proof-of-source, not the whole chunk. */
export const EXCERPT_CHARS = 320
/** How many relevant entities to name when a `relevant-entities` source declares no `limit`. */
export const DEFAULT_ENTITY_LIMIT = 8
/** Attached-docs char budget when a source declares neither `windowChars` nor `tokenBudget` (≈1.5k tokens). */
export const DEFAULT_ATTACHED_CHARS = 6000
/** Screen-text char budget when a `screen` source declares neither `windowChars` nor `tokenBudget` (≈1k tokens). */
export const DEFAULT_SCREEN_CHARS = 4000

/**
 * Why a declared source contributed what it did — the honest per-source verdict.
 *   included    — the source contributed and nothing of it was dropped.
 *   capped      — the source had more than its declared budget allowed; the overflow was dropped (disclosed).
 *   empty       — the source is wired but had nothing to contribute this turn.
 *   unavailable — the source's data path is not present (e.g. the preset seam is unfilled) — degrade honestly.
 */
export type SourceStatus = 'included' | 'capped' | 'empty' | 'unavailable'

/** One declared source's honest accounting — one per declared source, in declared order. */
export interface SourceReport {
  kind: ChatContextSourceKind
  status: SourceStatus
  /** items/turns/chunks this source contributed (0 when empty/unavailable). */
  items: number
  /** available items/turns/chunks the source held (≥ `items`; the gap is what a `capped` status dropped). */
  available: number
  /** characters this source contributed to the assembled context (0 for recent-turns, which ride as messages). */
  chars: number
}

/**
 * The narrowest read pill P1 needs from the (P2-owned) active-preset machinery: the active preset's label
 * and its priming/overlay text for a workspace, or `undefined` when no preset is selected. P2 builds preset
 * documents + selection; P1 only consumes this seam and degrades HONESTLY:
 *   - seam ABSENT (deps omit `activePreset`)      ⇒ report `unavailable` (machinery not wired yet).
 *   - seam present but returns `undefined`         ⇒ report `empty` (wired, but no preset selected).
 *   - seam returns a ref                           ⇒ report `included` (overlay injected).
 * This is a REFERENCE read only — P1 never stores or selects presets.
 */
export interface ActivePresetRef {
  /** a human label for the active preset — disclosed in accounting (e.g. the preset/register name). */
  label: string
  /** the preset's priming/overlay text injected into the system prompt. */
  text: string
}

/**
 * The already-gathered data the pure assembler draws from — the route fills this with its (impure) store
 * reads, one field per source kind. `activePreset` carries the seam's THREE honest states:
 *   { available: false }                    — the seam is unfilled (P2 has not wired preset selection).
 *   { available: true, ref: undefined }     — wired, but no preset is selected for this workspace.
 *   { available: true, ref: {…} }           — a preset is active; its overlay is injected.
 */
export interface GatheredContext {
  /** the app bundle's own priming prompt (the chat preamble) — always present; '' would report empty. */
  bundlePrompt: string
  activePreset: { available: boolean; ref?: ActivePresetRef | undefined }
  /** recent live-transcript text, newest-last, joined — '' when the ring is empty. */
  transcript: string
  /** session insight lines (distillate summaries), newest-last — [] when none. */
  insights: readonly string[]
  /** the recency×frequency relevant-now join. */
  entities: readonly RelevantEntity[]
  /** the attached pin's cite-ready chunks (empty when no pin is attached). */
  attachedDocs: { pinId?: string | undefined; pinTitle?: string | undefined; chunks: readonly PinChunk[] }
  /** the prior turns of this app-scoped thread (request.history), oldest-first. */
  recentTurns: readonly ChatTurn[]
  /**
   * The Ask face's screenshot-on-send, already READ (the route runs the frame through the screen-
   * understanding path — ocr slot, VLM fallback — under content-class `screen` consent; the assembler
   * only ever sees TEXT). Three honest states, mirroring activePreset:
   *   { attempted: false }                       — the turn shipped no frame ⇒ report `empty`.
   *   { attempted: true, failure: '…' }          — a frame shipped but could not be read (no ocr/vlm
   *                                                 endpoint, invoke failure) ⇒ report `unavailable`.
   *   { attempted: true, text: '…' }             — screen text in hand ('' ⇒ a blank frame, `empty`).
   */
  screen: { attempted: boolean; text?: string | undefined; failure?: string | undefined }
}

/** The assembled turn context — the composed system body, the messages history, citations, and honest reports. */
export interface AssembledContext {
  /** the system-prompt body: the included blocks in DECLARED order, blank-line separated ('' ⇒ bare preamble only). */
  contextText: string
  /** the `recent-turns` source's included turns, to send as chat messages (NOT part of contextText). */
  historyTurns: ChatTurn[]
  /** page-anchored citations from the `attached-docs` source. */
  citations: ChatCitation[]
  /** one honest report per declared source, in declared order. */
  reports: SourceReport[]
  /** true ⇒ at least one source was `capped` — feeds ChatBudget.truncated (disclosed, never silent). */
  truncated: boolean
}

const clip = (text: string, max: number): string => {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

const cite = (chunk: PinChunk): string => (chunk.page !== undefined ? `p.${chunk.page}` : `#${chunk.ordinal}`)

/** The effective character budget a source declares: min of windowChars and tokenBudget×4 (chars/4 estimator), or a fallback. */
const charBudget = (source: ChatContextSource, fallback: number): number => {
  const caps: number[] = []
  if (source.windowChars !== undefined) caps.push(source.windowChars)
  if (source.tokenBudget !== undefined) caps.push(source.tokenBudget * 4)
  return caps.length > 0 ? Math.min(...caps) : fallback
}

/** Render the top relevant entities as context lines. */
const entityLines = (entities: readonly RelevantEntity[]): string[] =>
  entities.map((r: RelevantEntity) => {
    const e: Entity = r.entity
    const recent = r.moments[0]?.text
    return recent ? `- ${e.name} (${e.kind}) — ${clip(recent, 120)}` : `- ${e.name} (${e.kind})`
  })

/**
 * Assemble ONE turn's context by iterating the DECLARED sources in order (PURE). Each source maps to a block
 * of the system prompt (or, for recent-turns, to message history), capped by its OWN declared budget; a
 * source that overflows its budget is `capped` (overflow dropped, disclosed), a wired-but-empty source is
 * `empty`, an unwired seam is `unavailable`. The reports array is the honest ledger the caller surfaces.
 */
export const assembleChatContext = (sources: readonly ChatContextSource[], gathered: GatheredContext): AssembledContext => {
  const blocks: string[] = []
  const citations: ChatCitation[] = []
  const reports: SourceReport[] = []
  let historyTurns: ChatTurn[] = []

  const push = (report: SourceReport, block?: string): void => {
    reports.push(report)
    if (block !== undefined && block !== '') blocks.push(block)
  }

  for (const source of sources) {
    switch (source.kind) {
      case 'bundle-prompt': {
        const budget = charBudget(source, Number.POSITIVE_INFINITY)
        const full = gathered.bundlePrompt.trim()
        if (full === '') {
          push({ kind: source.kind, status: 'empty', items: 0, available: 0, chars: 0 })
          break
        }
        const text = clip(full, budget)
        push(
          { kind: source.kind, status: text.length < full.length ? 'capped' : 'included', items: 1, available: 1, chars: text.length },
          text,
        )
        break
      }

      case 'active-preset': {
        if (!gathered.activePreset.available) {
          push({ kind: source.kind, status: 'unavailable', items: 0, available: 0, chars: 0 })
          break
        }
        const ref = gathered.activePreset.ref
        if (ref === undefined) {
          push({ kind: source.kind, status: 'empty', items: 0, available: 0, chars: 0 })
          break
        }
        const budget = charBudget(source, Number.POSITIVE_INFINITY)
        const text = clip(ref.text, budget)
        const block = `Voice/register — ${ref.label}:\n${text}`
        push(
          { kind: source.kind, status: text.length < ref.text.trim().length ? 'capped' : 'included', items: 1, available: 1, chars: block.length },
          block,
        )
        break
      }

      case 'transcript-window': {
        const full = gathered.transcript.trim()
        if (full === '') {
          push({ kind: source.kind, status: 'empty', items: 0, available: 0, chars: 0 })
          break
        }
        const budget = charBudget(source, Number.POSITIVE_INFINITY)
        // Rolling window: keep the MOST RECENT characters (transcript is newest-last).
        const windowed = full.length > budget ? full.slice(full.length - budget) : full
        const block = `Live transcript (recent):\n${windowed}`
        push(
          { kind: source.kind, status: windowed.length < full.length ? 'capped' : 'included', items: 1, available: 1, chars: block.length },
          block,
        )
        break
      }

      case 'insights': {
        const available = gathered.insights.length
        if (available === 0) {
          push({ kind: source.kind, status: 'empty', items: 0, available: 0, chars: 0 })
          break
        }
        const limit = source.limit ?? available
        // Newest-last: the most recent insights are the most relevant, so keep the tail.
        const kept = gathered.insights.slice(Math.max(0, available - limit))
        const charCap = charBudget(source, Number.POSITIVE_INFINITY)
        const lines: string[] = []
        let used = 0
        let charCapped = false
        for (const insight of kept) {
          const line = `- ${clip(insight, 200)}`
          if (used > 0 && used + line.length > charCap) {
            charCapped = true
            break
          }
          lines.push(line)
          used += line.length
        }
        const block = `Session insights:\n${lines.join('\n')}`
        const capped = lines.length < available || charCapped
        push(
          { kind: source.kind, status: capped ? 'capped' : 'included', items: lines.length, available, chars: block.length },
          block,
        )
        break
      }

      case 'relevant-entities': {
        const available = gathered.entities.length
        if (available === 0) {
          push({ kind: source.kind, status: 'empty', items: 0, available: 0, chars: 0 })
          break
        }
        const limit = source.limit ?? DEFAULT_ENTITY_LIMIT
        const kept = gathered.entities.slice(0, limit)
        const block = `Known in this session:\n${entityLines(kept).join('\n')}`
        push(
          { kind: source.kind, status: kept.length < available ? 'capped' : 'included', items: kept.length, available, chars: block.length },
          block,
        )
        break
      }

      case 'attached-docs': {
        const { pinId, pinTitle, chunks } = gathered.attachedDocs
        const available = chunks.length
        if (pinId === undefined || available === 0) {
          push({ kind: source.kind, status: 'empty', items: 0, available: 0, chars: 0 })
          break
        }
        const countCap = source.limit ?? available
        const charCap = charBudget(source, DEFAULT_ATTACHED_CHARS)
        const excerptLines: string[] = []
        let used = 0
        let cited = 0
        for (const chunk of chunks) {
          if (cited >= countCap) break
          const excerpt = clip(chunk.text, EXCERPT_CHARS)
          if (used > 0 && used + excerpt.length > charCap) break // keep at least one excerpt even if it alone exceeds the cap
          excerptLines.push(`[${cite(chunk)}] ${excerpt}`)
          citations.push({
            pinId,
            ...(pinTitle !== undefined ? { pinTitle } : {}),
            ordinal: chunk.ordinal,
            ...(chunk.page !== undefined ? { page: chunk.page } : {}),
            excerpt,
          })
          used += excerpt.length
          cited += 1
        }
        const title = pinTitle ?? 'the attached document'
        const block = `Excerpts from ${title} (cite the [p.N] / [#N] tags in your answer):\n${excerptLines.join('\n')}`
        push(
          { kind: source.kind, status: cited < available ? 'capped' : 'included', items: cited, available, chars: block.length },
          block,
        )
        break
      }

      case 'screen': {
        // The Ask face's frame, entered as TEXT (the route already ran ocr/vlm under `screen` consent).
        if (!gathered.screen.attempted) {
          push({ kind: source.kind, status: 'empty', items: 0, available: 0, chars: 0 }) // no frame this turn
          break
        }
        if (gathered.screen.failure !== undefined) {
          push({ kind: source.kind, status: 'unavailable', items: 0, available: 0, chars: 0 }) // frame shipped, unreadable — degrade honestly
          break
        }
        const full = (gathered.screen.text ?? '').trim()
        if (full === '') {
          push({ kind: source.kind, status: 'empty', items: 0, available: 0, chars: 0 }) // a blank frame is a normal result
          break
        }
        const budget = charBudget(source, DEFAULT_SCREEN_CHARS)
        const text = clip(full, budget)
        const block = `On the user's screen right now (read at send):\n${text}`
        push(
          { kind: source.kind, status: text.length < full.length ? 'capped' : 'included', items: 1, available: 1, chars: block.length },
          block,
        )
        break
      }

      case 'recent-turns': {
        const available = gathered.recentTurns.length
        if (available === 0) {
          push({ kind: source.kind, status: 'empty', items: 0, available: 0, chars: 0 })
          break
        }
        const limit = source.limit ?? available
        // Keep the most recent turns (oldest-first array ⇒ take the tail).
        historyTurns = gathered.recentTurns.slice(Math.max(0, available - limit))
        push({ kind: source.kind, status: historyTurns.length < available ? 'capped' : 'included', items: historyTurns.length, available, chars: 0 })
        break
      }
    }
  }

  return {
    contextText: blocks.join('\n\n'),
    historyTurns,
    citations,
    reports,
    truncated: reports.some((r) => r.status === 'capped'),
  }
}

/**
 * Compose the honest one-line assembly disclosure that extends the #134 budget note. Names what was INCLUDED
 * (with capped counts) and, separately, what was OMITTED and WHY (empty / unavailable) — so a declaration
 * change is visible to the user and no source is ever silently dropped.
 */
export const describeAssembly = (reports: readonly SourceReport[]): string => {
  const included = reports
    .filter((r) => r.status === 'included' || r.status === 'capped')
    .map((r) => (r.status === 'capped' ? `${r.kind}(${r.items} of ${r.available}, capped)` : `${r.kind}(${r.items})`))
  const omitted = reports.filter((r) => r.status === 'empty' || r.status === 'unavailable').map((r) => `${r.kind} (${r.status})`)
  const parts: string[] = []
  parts.push(included.length > 0 ? `Context: ${included.join(', ')}.` : 'Context: none assembled.')
  if (omitted.length > 0) parts.push(`Omitted: ${omitted.join(', ')}.`)
  return parts.join(' ')
}
