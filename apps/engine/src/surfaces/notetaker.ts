import type { Surface } from '@openinfo/contracts'

/**
 * The meeting note-taker app (#133) — the mainstream look-and-speed EXEMPLAR for the mini-app substrate
 * (folder of apps, multi-window #19, silo-bound instances #99, JSON-defined surfaces). Feature parity with
 * the Meetily-class note-taker (github.com/Zackriya-Solutions/meeting-minutes), NOT pixel parity: a
 * minimalist three-zone layout — LEFT rail (home + feature nav + meeting/archive folders + pins/favorites),
 * CENTER canvas (live notes + the AI summary), RIGHT sidebar (enrichments — the rolling summary lives here).
 *
 * Like every other app it is a PURE DOCUMENT composing the SHIPPED block types + query sources — no new
 * block type, no renderer branch in the generic block renderer. The three zones are expressed IN the
 * document: each block declares its zone through an `id` PREFIX (`nt-left-*` / `nt-center-*` / `nt-right-*`)
 * that the client notetaker layout (surfaces/hud/notetaker-layout.ts) partitions the flat stack by, then
 * renders each zone's sub-stack through the SAME `renderSurface` and composes the three into a CSS grid
 * frame. A block with no recognized prefix falls to the center — so the document, not the renderer, owns
 * the layout (the Phase-6 document-driven-layout principle the HUD established, extended to columns).
 *
 * Zone composition (block → zone), all EXISTING blocks + sources:
 *  - LEFT   · `pinned-doc` (source `pins`) — the Pins/Favorites list · `sessions` (the #211/#177 session
 *            HISTORY list) — the meeting/archive folders REALIZED as a self-labeling "Sessions" block over
 *            the existing `sessions` query source. The rail's home button and feature nav stay app CHROME
 *            (notetaker-layout.ts); the earlier dead Meetings/Archives placeholder folders are gone (the
 *            frame renders chrome above the WHOLE left zone, so a folder header could never sit adjacent to
 *            its list — the honest realization is a self-labeling block IN the zone, mirroring Pinned).
 *  - CENTER · `now` (the meeting context line + heartbeat) · `moments` (the live typed-note stream) ·
 *            `summaries` five-minute (the AI SUMMARY — the #177 memory headline, always-on with an honest
 *            empty state) · `summaries` session (the durable "this session" result, on-match).
 *  - RIGHT  · `distillates`, rendered as the raw ROLLING transcript/distillate STREAM (#12 — the sentence-
 *            level substance the summaries roll up FROM, demoted here so the center reads SUMMARY and the
 *            right reads the raw stream) · `todos` (action items) · `fields` (the #61 fast-field
 *            enrichments, on-match).
 *
 * #177/#211 rewire (version 2): the center summary was the raw `distillates` sentence stream; it now reads
 * the `summaries` five-minute VIEW (the same shape the HUD leads with, defaults.ts) so the CENTER canvas
 * reads as a real summary hierarchy and the raw stream is demoted to the right column. The left rail gains
 * the session-history list the folders always stood in for. LEGACY_DEFAULT_NOTETAKER_SURFACE preserves the
 * exact v1 body as a one-time seed-refresh fingerprint (SurfaceDocuments.ensureDefaults — the #174 pill
 * precedent): an install whose notetaker record is the untouched v1 seed is refreshed to v2; any user edit
 * (a bumped record version or a changed body) is the user's and stays untouched.
 *
 * The #58 live-transcript strip is NOT a stack block — it is the HUD controller's event-fed layer,
 * composed onto every surface this controller renders, so the note-taker inherits the ~1-2s transcript
 * feed for free (the layout parks it as a full-width ticker across the bottom of the frame).
 *
 * Record affordance: #136 makes the center canvas-header Record button a LIVE in-window session control (the
 * client notetaker layout renders it — not a stack block, so this document is unchanged). It dispatches
 * through the SAME shell path the tray's Start/End Session uses, so the consent boundary (#41) is untouched:
 * a window still launches STOPPED, capture ON is the explicit click, one session lifecycle. When the shell
 * can't act (no bridge / engine unreachable / skew-refused) the button renders disabled with the true reason
 * inline — honest, never a fake-live button. Mirrors templates/openinfo-notetaker/surface.json.
 */
/**
 * The exact v1 note-taker body shipped before the #177/#211 summary+sessions rewire. SurfaceDocuments uses
 * this ONLY as a conservative one-time seed-refresh fingerprint (the #174 pill precedent): record version 1
 * AND byte-identical body, or it hands off to the user's copy. Never rendered — it is a migration probe.
 */
export const LEGACY_DEFAULT_NOTETAKER_SURFACE: Surface = {
  id: 'surf-openinfo-notetaker',
  name: 'Note-taker',
  context: 'meeting',
  version: 1,
  stack: [
    // LEFT rail — the Pins/Favorites list (home/nav/folders are chrome; see the module header). No actions:
    // the only one here was `open`, which was never wired (no navigation target) — a support tier keeps ONLY
    // verbs that actually work (S7 chrome honesty), so the dead Open is dropped rather than shipped inert.
    {
      block: 'pinned-doc',
      id: 'nt-left-pins',
      show: 'always',
      top: 6,
      query: { source: 'pins', params: {}, top: 6 },
    },
    // CENTER canvas — meeting context, the live note stream, and the running AI summary.
    { block: 'now', id: 'nt-center-now' },
    {
      block: 'moments',
      id: 'nt-center-notes',
      collapsed: false,
      query: { source: 'moments', params: { session: 'current' }, top: 30 },
    },
    {
      block: 'distillates',
      id: 'nt-center-summary',
      show: 'always',
      top: 8,
      query: { source: 'distillates', params: { session: 'current' }, top: 8 },
      actions: [{ id: 'act-nt-copy-summary', label: 'Copy', verb: 'copy', params: {} }],
    },
    // RIGHT sidebar — enrichments: the rolling summary (distillate stream), action items, fast fields.
    {
      block: 'distillates',
      id: 'nt-right-rolling',
      show: 'always',
      top: 12,
      query: { source: 'distillates', params: { session: 'current' }, top: 12 },
      actions: [{ id: 'act-nt-copy-rolling', label: 'Copy', verb: 'copy', params: {} }],
    },
    {
      block: 'todos',
      id: 'nt-right-actions',
      show: 'always',
      top: 8,
      query: { source: 'todos', params: { session: 'current' }, top: 8 },
      actions: [
        { id: 'act-nt-copy-todo', label: 'Copy', verb: 'copy', params: {} },
        { id: 'act-nt-done-todo', label: 'Done', verb: 'mark-done', params: {} },
        { id: 'act-nt-dismiss-todo', label: 'Dismiss', verb: 'dismiss', params: {} },
      ],
    },
    {
      block: 'fields',
      id: 'nt-right-fields',
      show: 'on-match',
      top: 8,
      query: { source: 'fields', params: { session: 'current' }, top: 8 },
      actions: [
        { id: 'act-nt-copy-field', label: 'Copy', verb: 'copy', params: {} },
        { id: 'act-nt-dismiss-field', label: 'Dismiss', verb: 'dismiss', params: {} },
      ],
    },
  ],
}

/**
 * Exact serialized v1 body — the migration fingerprint (mirrors PREVIOUS_DEFAULT_PILL_BODY). An existing
 * install gets the v2 rewire ONLY when its stored notetaker record is byte-identical to this AND untouched.
 */
export const PREVIOUS_DEFAULT_NOTETAKER_BODY = JSON.stringify(LEGACY_DEFAULT_NOTETAKER_SURFACE)

/**
 * Current note-taker (version 2). The CENTER canvas now reads a real SUMMARY hierarchy rather than the raw
 * sentence stream: `nt-center-summary` is the `summaries` FIVE-MINUTE view (the #177 memory headline, same
 * shape the HUD leads with) shown ALWAYS with an honest empty state — a dedicated notes surface whose
 * summary block vanished when empty would read as broken (the Fields-app reasoning, defaults.ts), so it
 * explains itself instead. `nt-center-session` adds the durable "this session" result ON-MATCH (it only
 * exists once the loop has rolled a session up — an empty second card beneath the five-minute one would be
 * noise). The raw distillate stream stays available, DEMOTED to the right column's rolling block, so the
 * center reads SUMMARY and the right reads the raw stream + enrichments. The LEFT rail gains the
 * `nt-left-sessions` history list (the folders the chrome only ever placeheld), self-labeling like Pinned.
 */
export const defaultNotetakerSurface: Surface = {
  ...LEGACY_DEFAULT_NOTETAKER_SURFACE,
  version: 2,
  stack: [
    // LEFT rail — the Pins/Favorites list, then the session-history list (read-only this slice — no
    // click-through to a session detail view yet, so the rows are plain rows, never fake-live buttons).
    {
      block: 'pinned-doc',
      id: 'nt-left-pins',
      show: 'always',
      top: 6,
      query: { source: 'pins', params: {}, top: 6 },
    },
    {
      block: 'sessions',
      id: 'nt-left-sessions',
      show: 'always',
      top: 6,
      // No session param ⇒ the whole workspace's history (newest-first, per store.listSessions). `top` fetches
      // a small superset so the block can show the recent window and disclose an honest "N more" beyond it.
      query: { source: 'sessions', params: {}, top: 24 },
    },
    // CENTER canvas — meeting context, the live note stream, then the AI summary hierarchy.
    { block: 'now', id: 'nt-center-now' },
    {
      block: 'moments',
      id: 'nt-center-notes',
      collapsed: false,
      query: { source: 'moments', params: { session: 'current' }, top: 30 },
    },
    {
      block: 'summaries',
      id: 'nt-center-summary',
      show: 'always',
      top: 1,
      query: { source: 'summaries', params: { session: 'current', level: 'five-minute' }, top: 1 },
      actions: [{ id: 'act-nt-copy-summary', label: 'Copy', verb: 'copy', params: {} }],
    },
    {
      block: 'summaries',
      id: 'nt-center-session',
      show: 'on-match',
      top: 1,
      query: { source: 'summaries', params: { session: 'current', level: 'session' }, top: 1 },
      actions: [{ id: 'act-nt-copy-session', label: 'Copy', verb: 'copy', params: {} }],
    },
    // RIGHT sidebar — enrichments: the raw rolling distillate stream, action items, fast fields.
    {
      block: 'distillates',
      id: 'nt-right-rolling',
      show: 'always',
      top: 12,
      query: { source: 'distillates', params: { session: 'current' }, top: 12 },
      actions: [{ id: 'act-nt-copy-rolling', label: 'Copy', verb: 'copy', params: {} }],
    },
    {
      block: 'todos',
      id: 'nt-right-actions',
      show: 'always',
      top: 8,
      query: { source: 'todos', params: { session: 'current' }, top: 8 },
      actions: [
        { id: 'act-nt-copy-todo', label: 'Copy', verb: 'copy', params: {} },
        { id: 'act-nt-done-todo', label: 'Done', verb: 'mark-done', params: {} },
        { id: 'act-nt-dismiss-todo', label: 'Dismiss', verb: 'dismiss', params: {} },
      ],
    },
    {
      block: 'fields',
      id: 'nt-right-fields',
      show: 'on-match',
      top: 8,
      query: { source: 'fields', params: { session: 'current' }, top: 8 },
      actions: [
        { id: 'act-nt-copy-field', label: 'Copy', verb: 'copy', params: {} },
        { id: 'act-nt-dismiss-field', label: 'Dismiss', verb: 'dismiss', params: {} },
      ],
    },
  ],
}
