import type { Surface } from '@openinfo/contracts'

/**
 * The two ATTACHED-EXPANSION-PANEL shells (#134) — the first surfaces built on the input-block + attached-
 * panel primitives. Kept in their OWN module (not inlined into defaults.ts) so seeding them is a one-line
 * mechanical edit there: one import + one spread into SEEDED_SURFACES. Each is a versioned, cloneable
 * document seeded only-when-absent, exactly like the HUD/fields/diagnostics surfaces.
 *
 * These ship the PRIMITIVES made concrete; UX polish (animation, exact geometry, the conversation styling)
 * is the frontends design session. They are honest FUNCTIONAL shells: the chat input POSTs to a real route,
 * failures surface as visible text, and the sidebar opens as a dismissible suggestion on a real bus event.
 */

/**
 * The below-HUD CHAT shell. `panel.edge:'below'` → the window expands in HEIGHT: a slim input bar when
 * collapsed (120px), a full conversation panel when expanded (432px ≈ 3× the HUD rectangle, the recorded
 * geometry). `reveal:'user'` — the user drives expand/collapse; no event forces it open. The stack is the
 * `now` context line plus ONE `input` block wired to POST /chat with `mode:'both'` (text entry + file drop):
 * a typed turn is answered by the llm slot WITH THE CORPUS IN HAND (relevant entities + cited pin chunks),
 * and a dropped file runs the EXISTING pins/ingest path so its extract becomes citable context. The turn
 * budget the route returns is disclosed honestly in the conversation area (never a silent truncation).
 */
export const chatPanelSurface: Surface = {
  id: 'surf-openinfo-chat',
  name: 'Chat',
  context: 'any',
  version: 1,
  panel: { edge: 'below', collapsed: 120, expanded: 432, reveal: 'user', startExpanded: false },
  stack: [
    { block: 'now' },
    {
      block: 'input',
      input: {
        target: 'chat',
        submit: '/chat',
        mode: 'both',
        placeholder: 'Ask about this session — attach a doc to cite it',
        submitLabel: 'Send',
        accept: '.pdf,.txt,.md',
      },
    },
  ],
}

/**
 * The right SIDEBAR shell. `panel.edge:'right'` → the window expands in WIDTH: fully hidden when collapsed
 * (0px), a 320px cheat-sheet when expanded. `reveal:'event'` with `openOn:'entity.updated'` — it stays out
 * of the way and pops open as a DISMISSIBLE SUGGESTION when the classification changes (an entity locks in
 * or switches), never modal, never auto-captured. The `openOn` name is matched tolerantly, so the parallel
 * orientation trigger (#131) can drive the same seam once it lands — an unregistered event is a no-op, not
 * an error. The stack is the `now` line plus a `relevant-now` cheat-sheet (the recency×frequency join).
 */
export const sidebarSurface: Surface = {
  id: 'surf-openinfo-sidebar',
  name: 'Sidebar',
  context: 'any',
  version: 1,
  panel: { edge: 'right', collapsed: 0, expanded: 320, reveal: 'event', openOn: 'entity.updated', startExpanded: false },
  stack: [
    { block: 'now' },
    {
      block: 'relevant-now',
      top: 6,
      show: 'always',
      query: { source: 'relevant-now', params: { session: 'current' }, top: 6 },
    },
  ],
}

/** Both #134 panel shells, spread into SEEDED_SURFACES as one list entry (keeps the defaults.ts edit mechanical). */
export const PANEL_SURFACES: readonly Surface[] = [chatPanelSurface, sidebarSurface]
