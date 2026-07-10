import type { CaptureSource } from '@openinfo/contracts'
import { h, type VElement } from '../block-renderer/vnode.js'

/**
 * The live-transcript feed (#58) — a client-side rolling buffer rendered as a compact strip on the HUD.
 *
 * DEVIATION, disclosed: every other HUD block is QUERY-fed (the engine ranks, the block renders the
 * hydrated result). This feed is EVENT-fed — the transcript.updated WS events carry their payload to
 * render DIRECTLY, with no engine query. The rationale is the whole point of the fast-path: raw words
 * must paint within one WS hop of transcription, before anything is persisted, so there is nothing to
 * query. It is honestly labeled LIVE / raw so it reads as distinct from the distilled blocks, and the
 * why-line convention (nothing surfaces without a one-line why) does not apply — this is unjudged raw
 * capture, not an engine inference.
 */

/** Keep roughly the last window of speech; older lines drop. */
export const TRANSCRIPT_WINDOW_MS = 45_000
/** Cap the rendered lines so a long monologue can't grow the DOM without bound. */
export const TRANSCRIPT_MAX_LINES = 12
/** Lines older than this dim (CSS `.fade`) as they age toward dropping — the "oldest fading" behavior. */
const FADE_AFTER_MS = 30_000

export interface TranscriptLine {
  /** monotonic id assigned on ingest — stable ordering independent of clock skew. */
  seq: number
  source: CaptureSource
  text: string
  /** ms epoch used for age/expiry (the end of the update's capturedAt range). */
  at: number
}

/** me/them from the free capture split (mic = me, system-audio = them); other sources render raw. */
export const transcriptSpeaker = (source: CaptureSource): string =>
  source === 'mic' ? 'me' : source === 'system-audio' ? 'them' : source

/**
 * Drop lines older than the window relative to `nowMs`, then keep only the newest MAX_LINES. Pure — the
 * HUD calls it on every repaint so the feed self-prunes as new speech pushes in (and clears via the
 * controller on session start/end). With no new speech the last lines linger until the next event; that
 * is acceptable for a live feed and avoids a background repaint timer (a flake source). Disclosed.
 */
export const pruneTranscript = (lines: readonly TranscriptLine[], nowMs: number): TranscriptLine[] => {
  const live = lines.filter((line) => nowMs - line.at <= TRANSCRIPT_WINDOW_MS)
  return live.length > TRANSCRIPT_MAX_LINES ? live.slice(live.length - TRANSCRIPT_MAX_LINES) : live.slice()
}

/**
 * Render the feed. Returns null when there are no lines AND no live session — no dead chrome at idle.
 * A live session with no words yet gets an explainable empty state ("listening…") so a silent-but-live
 * HUD explains itself rather than looking broken.
 */
export const renderLiveTranscript = (
  lines: readonly TranscriptLine[],
  ctx: { live: boolean; nowMs: number },
): VElement | null => {
  if (lines.length === 0 && !ctx.live) return null
  const header = h('div', { class: 'hgroup', style: 'padding-bottom:0' }, h('div', { class: 'glbl' }, 'Live transcript · raw, not saved'))
  if (lines.length === 0) {
    return h(
      'div',
      { class: 'lt', 'data-live-transcript': true },
      header,
      h('div', { class: 'lt-empty' }, 'listening — spoken words appear here live, before they are distilled'),
    )
  }
  const rows = lines.map((line) => {
    const faded = ctx.nowMs - line.at >= FADE_AFTER_MS
    const who = transcriptSpeaker(line.source)
    return h(
      'div',
      { class: `lt-line ${who}${faded ? ' fade' : ''}` },
      h('span', { class: 'lt-who' }, who),
      h('span', { class: 'lt-tx' }, line.text),
    )
  })
  return h('div', { class: 'lt', 'data-live-transcript': true }, header, h('div', { class: 'lt-rows' }, ...rows))
}
