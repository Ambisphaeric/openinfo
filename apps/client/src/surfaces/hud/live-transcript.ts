import type { CaptureSource } from '@openinfo/contracts'
import { h, type VElement, type VNode } from '../block-renderer/vnode.js'

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
 *
 * STREAM SEPARATION — the merge rule (#96). Two capture streams reach this strip: `mic` and
 * `system-audio` (loopback audio, which may be a call, media, or another source). They arrive as
 * SEPARATE `transcript.updated` events (one per (session, source)); the owner's recorded audio-pipeline
 * decision is that the streams stay SEPARATE end-to-end and are merged ONLY when an ongoing conversation
 * actually spans both — ambient media playing alongside speech is exactly the case that must NOT blend.
 * So at this join point the strip:
 *   1. renders every fragment with its physical SOURCE-STREAM label (`Microphone` / `System audio`, the
 *      same idiom the transcript-inspector uses, #101) — never an inferred speaker identity; and
 *   2. offers a client-local MUTE for the system-audio stream (hide it from THIS strip without disabling
 *      capture) so the "watching a video while talking" case can be silenced with one click.
 * WEAVING two streams into one conversational thread (the actual merge) is downstream distill-accumulator
 * territory and is gated on real conversation-span detection — deliberately NOT built here (that is a
 * design-session decision; disclosed). This strip only ATTRIBUTES and (optionally) FILTERS; it never merges.
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

/**
 * The visible per-line physical SOURCE-STREAM label. A microphone can contain several people and system
 * audio can be a call or media, so neither is ever presented as a speaker identity.
 */
export const streamLabel = (source: CaptureSource): string =>
  source === 'mic' ? 'Microphone' : source === 'system-audio' ? 'System audio' : source

/**
 * Neutral physical-stream CSS hooks. They preserve the existing distinct colours without implying who
 * spoke. Kept separate from `streamLabel` so visible copy and styling remain independently stable.
 */
const streamClass = (source: CaptureSource): string =>
  source === 'mic' ? 'mic' : source === 'system-audio' ? 'system' : 'other'

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
 * The system-stream mute toggle — a strip-level affordance (#96). Carries `data-verb="mute-system-stream"`,
 * wired to a client-local handler (see mount.ts / dev-entry.ts) that flips the Hud's `systemStreamMuted`
 * state and re-paints. It is a DISPLAY filter only: capture keeps running, the transcript-inspector still
 * shows the system stream, and distill still receives it. The state is client-local and session-ephemeral
 * (it lives on the HUD controller; a reload starts unmuted) — the smallest honest choice, disclosed.
 */
const muteToggle = (muted: boolean): VNode =>
  h(
    'button',
    {
      class: `lt-mute${muted ? ' on' : ''}`,
      'data-verb': 'mute-system-stream',
      title: muted
        ? 'Show the system-audio stream in this strip (it is still being captured)'
        : 'Hide the system-audio stream from this strip. Capture, the inspector, and distill keep running',
    },
    muted ? 'show system audio' : 'hide system audio',
  )

/**
 * Render the feed. Returns null when there are no lines AND no live session — no dead chrome at idle.
 * A live session with no words yet gets an explainable empty state ("listening…") so a silent-but-live
 * HUD explains itself rather than looking broken. When the system stream is muted, its lines are filtered
 * from the render (never merged away silently — a note discloses how many are hidden and that capture
 * continues).
 */
export const renderLiveTranscript = (
  lines: readonly TranscriptLine[],
  ctx: { live: boolean; nowMs: number; systemMuted: boolean },
): VElement | null => {
  if (lines.length === 0 && !ctx.live) return null
  const systemCount = lines.reduce((n, line) => (line.source === 'system-audio' ? n + 1 : n), 0)
  const shown = ctx.systemMuted ? lines.filter((line) => line.source !== 'system-audio') : lines
  const header = h(
    'div',
    { class: 'lt-head' },
    h('div', { class: 'glbl' }, 'Live transcript · raw, not saved'),
    muteToggle(ctx.systemMuted),
  )
  if (shown.length === 0) {
    const message =
      ctx.systemMuted && systemCount > 0
        ? 'only system audio right now; hidden by the mute toggle (still captured)'
        : 'listening; spoken words appear here live, before they are distilled'
    return h('div', { class: 'lt', 'data-live-transcript': true }, header, h('div', { class: 'lt-empty' }, message))
  }
  const rows = shown.map((line) => {
    const faded = ctx.nowMs - line.at >= FADE_AFTER_MS
    return h(
      'div',
      { class: `lt-line ${streamClass(line.source)}${faded ? ' fade' : ''}` },
      h('span', { class: 'lt-who' }, streamLabel(line.source)),
      h('span', { class: 'lt-tx' }, line.text),
    )
  })
  const children: VNode[] = [header]
  if (ctx.systemMuted && systemCount > 0) {
    children.push(
      h('div', { class: 'lt-muted-note' }, `system audio hidden · ${systemCount} line${systemCount === 1 ? '' : 's'} not shown (still captured)`),
    )
  }
  children.push(h('div', { class: 'lt-rows' }, ...rows))
  return h('div', { class: 'lt', 'data-live-transcript': true }, ...children)
}
