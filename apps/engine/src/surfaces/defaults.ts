import type { Surface } from '@openinfo/contracts'
import { defaultNotetakerSurface } from './notetaker.js'
import { defaultPillSurface } from './pill.js'
import { PANEL_SURFACES } from './panel-surfaces.js'

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
 * when they land. CHROME HONESTY (S7): the HUD is the minimal glance tier and carries NO text action
 * buttons — the dead `open` verb (never wired, no navigation target) is gone, and `copy` is dropped here
 * too (it belongs to the working SUPPORT surfaces below, not the whisper glance). What remains on the
 * relevant-now row is the compact #66 glyph strip: `dismiss` (a real suppression write) plus the
 * honestly-inert `pin` / `mark-for-follow-up` ghosts. Every verb SET stays document-configurable.
 */
export const defaultHudSurface: Surface = {
  id: 'surf-openinfo-hud',
  name: 'openinfo HUD',
  context: 'meeting',
  version: 1,
  stack: [
    { block: 'now' },
    // #177 slice 2 — the memory HEADLINE. The default human surface leads with the concise five-minute VIEW
    // and the durable session result, NOT the sentence-level distillate stream (which now lives on the
    // Fields/Diagnostics support surfaces). `on-match` so the cards appear only once a summary exists (the
    // fields-block precedent) — summaries.enabled ships OFF like every engine-processing behavior, so a fresh
    // install shows no empty card; the instant the loop runs, the five-minute view is the top card. Each
    // summary is a model PROPOSAL with an honest degraded state and a why-line — no machine-speak (hud-voice).
    {
      block: 'summaries',
      show: 'on-match',
      top: 1,
      query: { source: 'summaries', params: { session: 'current', level: 'five-minute' }, top: 1 },
    },
    {
      block: 'summaries',
      show: 'on-match',
      top: 1,
      query: { source: 'summaries', params: { session: 'current', level: 'session' }, top: 1 },
    },
    {
      block: 'relevant-now',
      top: 4,
      show: 'always',
      query: { source: 'relevant-now', params: { session: 'current' }, top: 4 },
      actions: [
        // Copy/Open stripped (S7): Open was never wired, and the HUD glance carries no text buttons. Only the
        // glyph verb strip (#66) rides here — dismiss is a real write (a suppression record the query then
        // excludes); pin / mark-for-follow-up render as honestly-inert glyphs (no write path this slice — the
        // #15 pattern). The verb SET is document-configurable — a surface edits `actions`.
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
    // rendering on a surface. No actions on the HUD glance (S7 chrome honesty) — copy rides on the
    // dedicated Fields APP (surf-openinfo-fields) below, the support tier where working verbs live.
    {
      block: 'fields',
      show: 'on-match',
      top: 8,
      query: { source: 'fields', params: { session: 'current' }, top: 8 },
    },
  ],
}

/**
 * The shipped fields-panel app (#100) — the FIRST genuinely different app surface, a companion panel meant
 * to run side-by-side with the HUD. It is the fast-fields canon (#61) made visible as a dedicated surface:
 * everything shipped this week — the fan-out fields, the #62 judge state, the #66 micro-state dots and glyph
 * verb strip — rides only as blocks on the default HUD today; this surface is the demo of the mini-app frame.
 *
 * The stack, top→bottom: `now` (this window's own context line — workspace/topic/elapsed), the `fields`
 * block SHOWN ALWAYS (not on-match like the HUD's — a fields APP that vanished when empty would be a broken
 * app, so it renders an EXPLAINABLE empty naming the distill.fields flag + its fix instead), and the
 * `distillates` block — "Transcript · distillate stream", the durable, queryable transcript the fields are
 * distilled FROM (raw pre-distill words are transient; the distillate stream is the persisted substance,
 * #12), so the provenance chain transcript→field is visible on one surface. The EPHEMERAL live-transcript
 * strip (#58) is NOT a stack block — by its own design it is the HUD controller's event-fed layer, composed
 * onto every surface this controller renders (hud.ts), so this app inherits it for free (see window-options).
 *
 * The `fields` block carries the full #66 glyph verb strip — copy (a wired text verb: the app prepares, it
 * never sends) plus dismiss/pin/mark-for-follow-up as glyphs (dismiss is a real suppression write; pin /
 * follow-up render honestly-inert per #15). `top` caps each list. Mirrors templates/openinfo-fields/surface.json.
 */
export const defaultFieldsSurface: Surface = {
  id: 'surf-openinfo-fields',
  name: 'Fields',
  context: 'meeting',
  version: 1,
  stack: [
    { block: 'now' },
    {
      block: 'fields',
      show: 'always',
      top: 8,
      query: { source: 'fields', params: { session: 'current' }, top: 8 },
      actions: [
        { id: 'act-copy-field', label: 'Copy', verb: 'copy', params: {} },
        { id: 'act-dismiss-field', label: 'Dismiss', verb: 'dismiss', params: {} },
        { id: 'act-pin-field', label: 'Pin', verb: 'pin', params: {} },
        { id: 'act-followup-field', label: 'Follow up', verb: 'mark-for-follow-up', params: {} },
      ],
    },
    {
      block: 'distillates',
      show: 'always',
      top: 6,
      query: { source: 'distillates', params: { session: 'current' }, top: 6 },
      actions: [{ id: 'act-copy-distillate', label: 'Copy', verb: 'copy', params: {} }],
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
    // Sentence-level processing REMAINS available here (#177): the distillate stream — the per-window
    // distilled text the summaries roll up from — stays on this diagnostics surface for inspection, so it is
    // no longer the human headline (that is the summaries cards on the HUD) yet is never hidden from a debugger.
    { block: 'distillates', show: 'always', top: 12, query: { source: 'distillates', params: { session: 'current' }, top: 12 } },
  ],
}

/**
 * The surfaces SEEDED into a workspace's _meta.db on boot (ensureDefaults) and always enumerated by list()
 * — the shipped apps the tray Apps folder shows out of the box. Append a const here to ship a new default
 * surface (one line); each is seeded ONLY when absent, so a user's edits are never clobbered. Glass Minimal
 * is deliberately NOT here — it is a cloneable TEMPLATE (templates/glass-minimal), not a seeded default.
 */
export const SEEDED_SURFACES: readonly Surface[] = [defaultPillSurface, defaultHudSurface, defaultFieldsSurface, defaultDiagnosticsSurface, defaultNotetakerSurface, ...PANEL_SURFACES]
