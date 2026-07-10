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
 *  - LEFT   · `pinned-doc` (source `pins`) — the Pins/Favorites list; the rail's home button, feature nav,
 *            and the Meetings/Archives folder headers are app CHROME (notetaker-layout.ts), NOT blocks —
 *            there is no `sessions`-list block type yet (the disclosed gap; a follow-up block would light
 *            the folders up from the existing `sessions` query source).
 *  - CENTER · `now` (the meeting context line + heartbeat) · `moments` (the live typed-note stream) ·
 *            `distillates` (the running AI summary — the persisted distillate stream, #12).
 *  - RIGHT  · `distillates` again, rendered as the ROLLING SUMMARY (the owner's pickle-glass rolling
 *            transcript summary, rebuilt on our primitives — the distillate stream is its data source, #12)
 *            · `todos` (action items) · `fields` (the #61 fast-field enrichments, on-match).
 *
 * The #58 live-transcript strip is NOT a stack block — it is the HUD controller's event-fed layer,
 * composed onto every surface this controller renders, so the note-taker inherits the ~1-2s transcript
 * feed for free (the layout parks it as a full-width ticker across the bottom of the frame).
 *
 * Record affordance: capture start/stop is the tray's session control today (consent boundary, #41 — a
 * window launches STOPPED, never auto-resuming). An IN-WINDOW record button needs the #136 session-control
 * block, which is NOT built; the layout ships an honest, visibly-inert Record placeholder in the center
 * canvas header linking that gap (chosen placement — flagged in the PR for the owner's first-render review)
 * rather than a fake-live button. Mirrors templates/openinfo-notetaker/surface.json.
 */
export const defaultNotetakerSurface: Surface = {
  id: 'surf-openinfo-notetaker',
  name: 'Note-taker',
  context: 'meeting',
  version: 1,
  stack: [
    // LEFT rail — the Pins/Favorites list (home/nav/folders are chrome; see the module header).
    {
      block: 'pinned-doc',
      id: 'nt-left-pins',
      show: 'always',
      top: 6,
      query: { source: 'pins', params: {}, top: 6 },
      actions: [{ id: 'act-nt-open-pin', label: 'Open', verb: 'open', params: {} }],
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
