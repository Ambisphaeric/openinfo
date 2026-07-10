import type { Block } from '@openinfo/contracts'
import { h, renderSurface, type BlockRegistry, type SurfaceRenderInput, type VElement, type VNode } from '../block-renderer/index.js'

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
 * into a CSS-grid frame with the app chrome (home + feature nav + folders on the left, the record affordance
 * in the center canvas header). A block whose id carries no recognized prefix falls to the CENTER — so an
 * un-annotated document still renders, and the DOCUMENT (not this code) owns which block lives where.
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
    },
    registry,
  )

/** The left-rail nav + folder chrome (NOT blocks — see the module header on the missing sessions block). */
const leftRailChrome = (): VNode =>
  h(
    'div',
    { class: 'nt-rail-chrome' },
    h('div', { class: 'nt-brand' }, h('button', { class: 'nt-home', 'data-nt': 'home', title: 'Home' }, '◆'), h('span', { class: 'nt-brand-name' }, 'openinfo')),
    h(
      'div',
      { class: 'nt-nav' },
      h('button', { class: 'nt-navitem active', 'data-nt': 'nav-notes' }, 'Notes'),
      h('button', { class: 'nt-navitem', 'data-nt': 'nav-summary' }, 'Summary'),
      h('button', { class: 'nt-navitem', 'data-nt': 'nav-search' }, 'Search'),
    ),
    // Meetings / Archives folders: the LABELS are chrome; the session list they should hold has no block
    // type yet (the `sessions` query source exists — see the module header). Honest placeholder, not blank.
    h(
      'div',
      { class: 'nt-folders' },
      h('div', { class: 'nt-folder' }, h('span', { class: 'nt-folder-glyph' }, '▸'), 'Meetings'),
      h('div', { class: 'nt-folder' }, h('span', { class: 'nt-folder-glyph' }, '▸'), 'Archives'),
      h('div', { class: 'nt-folder-note' }, 'session-list block pending'),
    ),
  )

/**
 * The center canvas header — carries the RECORD affordance (#133 relocated it here; the original placement
 * was disliked). Capture start/stop is the tray's session control today (consent boundary #41); an in-window
 * button needs the #136 session-control block, which is NOT built — so this is an honest, visibly-inert
 * placeholder (`.nt-record.pending`), not a fake-live button. Placement is flagged for the owner's review.
 */
const canvasHeaderChrome = (): VNode =>
  h(
    'div',
    { class: 'nt-canvas-head' },
    h('span', { class: 'nt-canvas-title' }, 'Notes'),
    h(
      'button',
      { class: 'nt-record pending', 'data-nt': 'record', title: 'Recording is controlled from the tray today · in-window start/stop needs the #136 session-control block' },
      h('span', { class: 'nt-record-dot' }),
      'Record',
    ),
  )

const rightHeaderChrome = (): VNode => h('div', { class: 'nt-side-head' }, 'Enrichments')

/**
 * Render the note-taker surface into its three-zone frame. Drop-in for `renderSurface` (same signature),
 * so the Hud controller renders and live-updates it exactly like any other surface.
 */
export const renderNotetaker = (input: SurfaceRenderInput, registry: BlockRegistry): VElement => {
  const zones = partitionZones(input)
  return h(
    'div',
    { class: 'nt-app' },
    h('div', { class: 'nt-left' }, leftRailChrome(), renderZonePanel(input, zones.left, registry)),
    h('div', { class: 'nt-center' }, canvasHeaderChrome(), renderZonePanel(input, zones.center, registry)),
    h('div', { class: 'nt-right' }, rightHeaderChrome(), renderZonePanel(input, zones.right, registry)),
  )
}
