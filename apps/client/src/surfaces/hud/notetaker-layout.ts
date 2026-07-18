import type { Block } from '@openinfo/contracts'
import { h, renderSurface, type BlockRegistry, type SurfaceRenderInput, type VElement, type VNode } from '../block-renderer/index.js'
import { clockLabel } from '../block-renderer/format.js'
import { renderSessionControl } from '../blocks/session-control.js'
import type { NotetakerSelection } from './notetaker-view.js'

/**
 * The meeting note-taker three-zone layout (#133) — the minimal, DOCUMENT-DRIVEN column extension.
 *
 * The generic block renderer (`renderSurface`) walks a flat stack and stacks the blocks vertically into
 * one `.hud` panel — no notion of columns. Rather than teach that renderer about zones (it must stay the
 * one document-driven renderer every surface shares) or add a `zone` field to the contract, the note-taker
 * expresses its layout IN the document: every block declares its zone through an `id` PREFIX
 * (`nt-left-*` / `nt-center-*` / `nt-right-*`). This module partitions the flat stack by that prefix,
 * renders EACH zone's sub-stack through the SAME `renderSurface` (so every block behaves exactly as it does
 * on the HUD — same hydration, same actions, same empty states), and composes the three resulting panels
 * into a CSS-grid frame with the app chrome (the brand mark on the left above the Pins + Sessions blocks, the
 * record affordance in the center canvas header). A block whose id carries no recognized prefix falls to the
 * CENTER — so an un-annotated document still renders, and the DOCUMENT (not this code) owns which block lives
 * where. The session-history list is the pad's real navigation: #247 makes its rows open a past session's
 * read-only record in the CENTER (with a Back-to-live control), so no dead feature-nav tabs are rendered.
 *
 * Signature-compatible with `renderSurface` so the Hud controller can call it interchangeably for the
 * note-taker surface (dev-entry selects it by surface id); the controller appends the #58 live-transcript
 * feed to the returned frame's children exactly as it does for a plain panel — the CSS parks that `.lt`
 * strip as a full-width transcript ticker across the bottom of the frame.
 */

/** The three columns, left→right. An unrecognized id-prefix falls to `center`. */
export type Zone = 'left' | 'center' | 'right'

const PREFIX: ReadonlyArray<[string, Zone]> = [
  ['nt-left-', 'left'],
  ['nt-center-', 'center'],
  ['nt-right-', 'right'],
]

/** The zone a block declares through its id prefix (default `center` — a document is never un-renderable). */
export const zoneOf = (block: Block): Zone => {
  const id = block.id ?? ''
  for (const [prefix, zone] of PREFIX) if (id.startsWith(prefix)) return zone
  return 'center'
}

/** The blocks + their PARALLEL hydrated results for one zone, indices preserved from the original stack. */
interface ZoneInput {
  stack: Block[]
  results: (SurfaceRenderInput['results'][number])[]
}

const emptyZone = (): ZoneInput => ({ stack: [], results: [] })

/** Partition the flat stack (and its parallel results array) into the three zones, preserving order. */
export const partitionZones = (input: SurfaceRenderInput): Record<Zone, ZoneInput> => {
  const zones: Record<Zone, ZoneInput> = { left: emptyZone(), center: emptyZone(), right: emptyZone() }
  input.surface.stack.forEach((block, index) => {
    const zone = zones[zoneOf(block)]
    zone.stack.push(block)
    zone.results.push(input.results[index])
  })
  return zones
}

/** Render one zone's sub-stack through the SAME generic renderer, so its blocks behave identically. */
const renderZonePanel = (input: SurfaceRenderInput, zone: ZoneInput, registry: BlockRegistry): VElement =>
  renderSurface(
    {
      surface: { ...input.surface, stack: zone.stack },
      now: input.now,
      results: zone.results,
      ...(input.clarify !== undefined ? { clarify: input.clarify } : {}),
      ...(input.session !== undefined ? { session: input.session } : {}),
      // #246: thread the summary-correction context so the PAD's summary rows (the owner's flagship surface)
      // get the same in-place edit affordance the HUD has. It flows to the CENTER live summary AND — since the
      // past-session body re-renders through this same path — to a past session's record: a correction targets
      // a summary IDENTITY (id/window), not `session:'current'`, so the write-path works on any session. A
      // read-only past view still forbids CAPTURE (no Record control), but correcting derived prose IS the
      // sovereignty affordance and stays available.
      ...(input.summaryEdit !== undefined ? { summaryEdit: input.summaryEdit } : {}),
    },
    registry,
  )

/**
 * The left-rail chrome (NOT blocks — the Pins + Sessions lists below are real hydrated blocks). It is now
 * just the brand mark: the ◆ glyph + the app name. The old feature-nav tabs (Notes/Summary/Search) and the
 * Home button were DEAD chrome — disabled buttons whose only disclosure was a hover tooltip, for views that
 * do not exist (multi-view routing #19 is unbuilt). Per the interaction-honesty policy (a rendered affordance
 * with no live handler must not present as live), rendering them at all taught the user to distrust the pad,
 * so they are REMOVED until their views exist. The Search VIEW they promised stays tracked by #230 (a
 * disclosed follow-up, not silently dropped) — its removal here is intentional, not an omission. The pad's
 * navigation is now the real, walkable thing: the session-history list below (#247 makes its rows open a
 * past session in the center). The ◆ is a non-interactive brand mark, not a button — no dead click target.
 */
const leftRailChrome = (): VNode =>
  h(
    'div',
    { class: 'nt-rail-chrome' },
    h('div', { class: 'nt-brand' }, h('span', { class: 'nt-home', 'aria-hidden': 'true' }, '◆'), h('span', { class: 'nt-brand-name' }, 'openinfo')),
  )

/**
 * The center canvas header — carries the RECORD affordance (#133 relocated it here; the original placement
 * was disliked). #136 makes it a LIVE in-window session control: `renderSessionControl` renders the start/stop
 * button that dispatches through the SAME shell session path the tray uses (verb `session-start`/`session-stop`
 * → the mount layer → the openinfoSession bridge → shell `dispatch`), so there is ONE session lifecycle and
 * the #41 consent boundary is untouched (a session never auto-starts; capture ON is the explicit click). It
 * is honest about when it can act: with no shell bridge / an unreachable or skew-refused engine it renders
 * DISABLED with the true reason inline (the same disabled-with-disclosure shape the placeholder used, no more
 * a tooltip-only fake). `live` is the engine truth (NowContext.live); `readiness` is the shell's signal.
 */
const canvasHeaderChrome = (state: { live: boolean; readiness?: SurfaceRenderInput['session'] }): VNode =>
  h(
    'div',
    { class: 'nt-canvas-head' },
    h('span', { class: 'nt-canvas-title' }, 'Notes'),
    renderSessionControl({ live: state.live, ...(state.readiness !== undefined ? { readiness: state.readiness } : {}) }),
  )

/** Compact local calendar date, e.g. "Jul 16" — mirrors the sessions block's own formatter (viewer-local). */
const dateLabel = (iso: string): string => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(d)
}

/**
 * The center header while a PAST session is open (#247): a calm "Past session" eyebrow, the session's
 * resolved name, its start time, and an ALWAYS-visible "Back to live" control (the wired `session-back`
 * verb — an honest live affordance) returning to the current-session view. It replaces the live Record
 * control: history is READ-ONLY, so the center must offer NO capture affordance while browsing the past
 * (the consent boundary — a history click never starts/stops a session).
 */
const pastSessionHeader = (selection: NotetakerSelection): VNode =>
  h(
    'div',
    { class: 'nt-canvas-head nt-past-head' },
    h(
      'div',
      { class: 'nt-past-id' },
      h('span', { class: 'nt-past-eyebrow' }, 'Past session'),
      h('span', { class: 'nt-canvas-title' }, selection.title !== undefined && selection.title.trim() !== '' ? selection.title : 'Session'),
      selection.startedAt !== undefined && selection.startedAt.trim() !== ''
        ? h('span', { class: 'nt-past-when' }, `${clockLabel(selection.startedAt)} · ${dateLabel(selection.startedAt)}`)
        : null,
    ),
    h('button', { class: 'nt-back-live', 'data-verb': 'session-back' }, '← Back to live'),
  )

/**
 * The center body while a past session is open. The center blocks were re-queried against the selected
 * session (Hud.mapQuery → the #247 drill-down), so their hydrated results already carry THAT session's
 * moments + summaries. Two adjustments make the read honest:
 *   - the live `now` block (the heartbeat/elapsed of the CURRENT session) is dropped — it is meaningless for
 *     a past record and would read as live truth over a historical view; and
 *   - the remaining content blocks are forced to `on-match`, so a past session that captured nothing simply
 *     hides them and the honest empty note below carries the whole meaning (never a live-empty "turn this on"
 *     prompt over a finished session, never a blank canvas).
 */
const renderPastCenterBody = (input: SurfaceRenderInput, center: ZoneInput, registry: BlockRegistry): VElement => {
  const stack: Block[] = []
  const results: ZoneInput['results'] = []
  center.stack.forEach((block, index) => {
    if (block.block === 'now') return // the live heartbeat has no place in a historical record
    stack.push({ ...block, show: 'on-match' })
    results.push(center.results[index]!)
  })
  const body = renderZonePanel(input, { stack, results }, registry)
  if (body.children.length > 0) return body
  // Nothing was captured in this session — say so plainly (hud-voice), never a blank center.
  return h('div', { class: 'hud' }, h('div', { class: 'hgroup' }, h('div', { class: 'nt-past-empty' }, 'Nothing was captured in this session.')))
}

/**
 * Render the note-taker surface into its three-zone frame. Drop-in for `renderSurface` (same signature),
 * PLUS an optional third argument the dev entry closes over: the session-history SELECTION (#247). Absent
 * (or undefined) ⇒ the live current-session pad, unchanged. Present ⇒ the CENTER shows that past session's
 * read-only record under a "Past session" header with a Back-to-live control; the left history list and the
 * right live enrichments are untouched.
 */
export const renderNotetaker = (input: SurfaceRenderInput, registry: BlockRegistry, selection?: NotetakerSelection): VElement => {
  const zones = partitionZones(input)
  const center =
    selection !== undefined
      ? h('div', { class: 'nt-center' }, pastSessionHeader(selection), renderPastCenterBody(input, zones.center, registry))
      : h(
          'div',
          { class: 'nt-center' },
          canvasHeaderChrome({ live: input.now.live, ...(input.session !== undefined ? { readiness: input.session } : {}) }),
          renderZonePanel(input, zones.center, registry),
        )
  return h(
    'div',
    { class: 'nt-app' },
    h('div', { class: 'nt-left' }, leftRailChrome(), renderZonePanel(input, zones.left, registry)),
    center,
    // The right sidebar's blocks self-label (Transcript / Actions / Fields), exactly as the left column's
    // Pinned + Sessions do — so no hard-coded column header is painted over them (the old machine-word
    // "Enrichments" header is gone; a bold header over possibly-empty content is never honest — #247).
    h('div', { class: 'nt-right' }, renderZonePanel(input, zones.right, registry)),
  )
}
