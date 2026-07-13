import type { Surface } from '@openinfo/contracts'

/**
 * The PILL — the MVP Standard App window at glass parity (the always-on-glance `hud` face). A compact
 * header RECTANGLE (Listen / Ask / Show-Hide / settings-on-hover) with a DOCKED PANEL beneath it. It is
 * an ASSEMBLY of existing organs, not a new capability:
 *
 *  - LISTEN face = this surface's own glance stack (the #58 live-transcript strip the HUD controller
 *    composes for free, plus the distilled glance blocks: `now`, `relevant-now`, `moments`, `fields`).
 *    The pill IS the bundle's `hud` glance face, so it legitimately owns the glance content — the same
 *    curated stack the standalone `surf-openinfo-hud` template ships (that surface remains cloneable).
 *  - ASK face = RESOLVED FROM THE BUNDLE at open (GET /bundles → the `chat` face surfaceRef). The pill
 *    does NOT re-declare the chat organs; it mounts whatever surface the bundle's chat face names
 *    (surf-openinfo-chat by seed: the `input` block + the streamed-reply / history organs), so a
 *    different bundle produces a different Ask panel. See surfaces/hud/pill-layout.ts + pill.ts.
 *
 * GEOMETRY (`panel`, #134): `edge:'below'` ⇒ the window is sized in HEIGHT. `collapsed` is the BAR
 * (Show-Hide off — just the header rectangle); `expanded` is the ASK panel (~3× the bar, the recorded
 * chat-beneath-HUD geometry). The pill's client height authority (PillController) adds a third, shorter
 * LISTEN extent between them — the three-state extension of the two-state PanelController, disclosed.
 * `startExpanded:true` so the pill opens showing its Listen glance rather than a lone bar.
 *
 * Registered as the Standard App bundle's `hud` face (bundle.standard-app.json) and seeded via
 * SEEDED_SURFACES (defaults.ts). The `sense-lanes` block is a declarative runtime-data organ — its
 * `live-senses` query returns the same closed, metadata-only lane rows as GET /senses/live — while the
 * pill's header + face switch remains a per-surface LAYOUT (pill-layout.ts, selected by surface id in
 * dev-entry) exactly like the note-taker's three-zone frame.
 */
export const LEGACY_DEFAULT_PILL_SURFACE: Surface = {
  id: 'surf-openinfo-pill',
  name: 'openinfo',
  context: 'meeting',
  version: 1,
  // BAR = 56 (the compact header rectangle) · ASK = 432 (~3× the bar, the recorded chat geometry). The
  // intermediate LISTEN extent is a client layout constant (pill.ts) — the contract carries the two the
  // shell's panel machinery needs. startExpanded so the window opens as the pill + its Listen glance.
  panel: { edge: 'below', collapsed: 56, expanded: 432, reveal: 'user', startExpanded: true },
  stack: [
    { block: 'now', id: 'pill-listen-now' },
    {
      block: 'relevant-now',
      id: 'pill-listen-relevant',
      top: 4,
      show: 'always',
      query: { source: 'relevant-now', params: { session: 'current' }, top: 4 },
      actions: [
        // The HUD glance carries only the compact #66 glyph strip (S7 chrome honesty): dismiss is a real
        // suppression write; pin / mark-for-follow-up render as honestly-inert glyphs (no write path yet).
        { id: 'act-dismiss', label: 'Dismiss', verb: 'dismiss', params: {} },
        { id: 'act-pin', label: 'Pin', verb: 'pin', params: {} },
        { id: 'act-followup', label: 'Follow up', verb: 'mark-for-follow-up', params: {} },
      ],
    },
    {
      block: 'moments',
      id: 'pill-listen-moments',
      collapsed: false,
      query: { source: 'moments', params: { session: 'current' }, top: 20 },
    },
    {
      block: 'fields',
      id: 'pill-listen-fields',
      show: 'on-match',
      top: 8,
      query: { source: 'fields', params: { session: 'current' }, top: 8 },
    },
  ],
}

/**
 * Exact serialized body shipped before the live lane organ. SurfaceDocuments uses this only as a
 * conservative one-time migration fingerprint: record version 1 AND byte-identical body, or hands off.
 */
export const PREVIOUS_DEFAULT_PILL_BODY = JSON.stringify(LEGACY_DEFAULT_PILL_SURFACE)

/**
 * Current Standard pill. Version 2 adds the composable live-sense organ immediately after `now`, so the
 * user sees capture truth before inferred/recalled content. The query is instance-bindable and asks for
 * this process's current session; three rows are the natural full result, not an arbitrary truncation.
 */
export const defaultPillSurface: Surface = {
  ...LEGACY_DEFAULT_PILL_SURFACE,
  version: 2,
  stack: [
    LEGACY_DEFAULT_PILL_SURFACE.stack[0]!,
    {
      block: 'sense-lanes',
      id: 'pill-listen-sense-lanes',
      show: 'always',
      top: 3,
      query: { source: 'live-senses', params: { session: 'current' }, top: 3 },
    },
    ...LEGACY_DEFAULT_PILL_SURFACE.stack.slice(1).map((block) =>
      block.id === 'pill-listen-moments' ? { ...block, show: 'on-match' as const } : block,
    ),
  ],
}
