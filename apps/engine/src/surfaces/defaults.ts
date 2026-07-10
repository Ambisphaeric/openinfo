import type { Surface } from '@openinfo/contracts'

/**
 * The shipped openinfo HUD surface — template #1 (the launch anchor). A versioned, cloneable
 * document, seeded like the distill/voice config docs; the HUD is `render(thisDocument)` with NO
 * hardcoded layout (the deliberate Phase-6 down-payment). Mirrors templates/openinfo-hud/surface.json.
 *
 * The stack composes only the Phase-2-LIVE blocks: `now` (the context line + live topic, always on
 * top), `relevant-now` (the recency×frequency join, top 4 per design/renderings/hud-v2.html state A),
 * and `moments` (this session's typed-event stream). ledger/pinned-doc/hint blocks are real block
 * types but their backing stores (P3/P4) don't exist yet, so they are left out of the DEFAULT stack
 * rather than shipping cards that can't hydrate — the surface.hud-meeting.json example keeps them for
 * when they land. Actions demonstrate both a wired verb (`copy`) and a visible-but-inert one (`open`,
 * no navigation target yet — see PHASE2-NOTES).
 */
export const defaultHudSurface: Surface = {
  id: 'surf-openinfo-hud',
  name: 'openinfo HUD',
  context: 'meeting',
  version: 1,
  stack: [
    { block: 'now' },
    {
      block: 'relevant-now',
      top: 4,
      show: 'always',
      query: { source: 'relevant-now', params: { session: 'current' }, top: 4 },
      actions: [
        { id: 'act-copy', label: 'Copy', verb: 'copy', params: {} },
        { id: 'act-open', label: 'Open', verb: 'open', params: {} },
        // The glyph verb strip (#66), shipped defaults: dismiss is a real write (a suppression record the
        // query then excludes); pin / mark-for-follow-up render as honestly-inert glyphs (no write path
        // this slice — the #15 pattern). The verb SET is document-configurable — a surface edits `actions`.
        { id: 'act-dismiss', label: 'Dismiss', verb: 'dismiss', params: {} },
        { id: 'act-pin', label: 'Pin', verb: 'pin', params: {} },
        { id: 'act-followup', label: 'Follow up', verb: 'mark-for-follow-up', params: {} },
      ],
    },
    {
      block: 'moments',
      collapsed: false,
      query: { source: 'moments', params: { session: 'current' }, top: 20 },
    },
    // Fast fields (#61): the fan-out substrate's surface. `on-match` so the card is invisible until the
    // fast fields have produced values (distill.fields is OFF by default), then it renders each field's
    // current value with a provenance why-line and a provisional micro-state dot. This is the shipped
    // default bundle demonstrating the ≥3 concurrent fields (topic / entities-mentioned / work-items)
    // rendering on a surface. `copy` is the wired verb (the app prepares; verbs never send).
    {
      block: 'fields',
      show: 'on-match',
      top: 8,
      query: { source: 'fields', params: { session: 'current' }, top: 8 },
      actions: [{ id: 'act-copy-field', label: 'Copy', verb: 'copy', params: {} }],
    },
  ],
}

/**
 * Template #3 — "Glass Minimal", the floor (design/renderings/hud-v2.html: the two-line whisper, not
 * a meeting's density). Same primitive as the HUD, a different document → a different layout, which is
 * the whole proof that rendering is document-driven. A pure readout: the Now line plus a collapsed
 * moments block. The interactive two-BUTTON capture pill (mic/screen toggles) is palette/action-input
 * territory (P6, CODE_MAP client/surfaces/palette), so Glass Minimal ships as the minimal readout
 * surface now and gains its buttons when the palette does. Mirrors templates/glass-minimal/surface.json.
 */
export const defaultGlassMinimalSurface: Surface = {
  id: 'surf-glass-minimal',
  name: 'Glass Minimal',
  context: 'any',
  version: 1,
  stack: [
    { block: 'now' },
    {
      block: 'moments',
      collapsed: true,
      query: { source: 'moments', params: { session: 'current' }, top: 5 },
    },
  ],
}

/**
 * The diagnostics app (#101) — the HUD-as-testing-tool v0. The transcript-garbage QA round was diagnosable
 * only over ssh; this surface puts the exact probes on a surface: the transcription inspector (recent
 * ephemeral chunks + the CURRENT stt slot, with the #65 per-chunk-provenance gap disclosed), the per-sense
 * gate chains (#7 as a block), and the queue status/lag block. A debugger the user runs BESIDE a real app
 * (the multi-window Apps folder, #19/#98).
 */
export const defaultDiagnosticsSurface: Surface = {
  id: 'surf-openinfo-diagnostics',
  name: 'Diagnostics',
  context: 'any',
  version: 1,
  stack: [
    { block: 'transcript-inspector', show: 'always', top: 12, query: { source: 'transcript', params: {}, top: 1 } },
    { block: 'sense-gates', show: 'always', query: { source: 'senses', params: {}, top: 3 } },
    { block: 'queue', show: 'always', query: { source: 'queue', params: {}, top: 1 } },
  ],
}
