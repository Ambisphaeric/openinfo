import type { Block, BlockQuery } from '@openinfo/contracts'

/**
 * The note-taker's session-history drill-down view-state (#247) — the client-local selection that turns the
 * static history list into a walkable one. It is deliberately TINY and READ-ONLY: it holds at most one
 * selected past session and never touches capture or session lifecycle (the #41 consent boundary: a session
 * never auto-starts, and clicking a history row must not start/stop one). It is the note-taker sibling of the
 * pill's PillController / the Hud's clarify state — owned outside the layout-agnostic Hud controller and fed
 * back in through two seams the controller already exposes:
 *
 *   1. `mapQuery` (Hud.mapQuery) — when a past session is selected, the CENTER session-scoped blocks are
 *      re-pointed from the live `session: 'current'` binding to the selected id, so a plain `hud.refresh()`
 *      re-hydrates the center against THAT session's records. Every other block (the left history list, the
 *      right live enrichments) is left on its own query, so history browsing never disturbs them.
 *   2. `selection()` — read fresh on every render by the note-taker renderer (dev-entry wraps renderNotetaker
 *      in a closure that passes it), so the center paints the past-session header + back-to-live affordance
 *      and its read-only record while the selection stands.
 *
 * `open`/`backToLive` mutate the selection then invoke `onChange` (dev-entry wires it to `hud.refresh()`),
 * which re-queries with the new mapping and re-renders. The selection is session-ephemeral (a reload starts
 * live), exactly like the clarify/mute view-state.
 */

/** The selected past session — its id (the query binding) plus a resolved title + start time to name the view. */
export interface NotetakerSelection {
  sessionId: string
  title?: string
  startedAt?: string
}

/** The id-prefix the note-taker layout uses for CENTER blocks (kept in lockstep with notetaker-layout.ts). */
const CENTER_PREFIX = 'nt-center-'
/** The live-session sentinel a context-agnostic block declares; only these are re-pointed to a past session. */
const LIVE_SENTINEL = 'current'

export class NotetakerView {
  private selected: NotetakerSelection | undefined

  /** `onChange` re-queries + re-renders (dev-entry: `hud.refresh()`), so a selection change takes effect. */
  constructor(private readonly onChange: () => void) {}

  /** The current selection, or undefined for the live current-session view. Read fresh on every render. */
  selection(): NotetakerSelection | undefined {
    return this.selected
  }

  /** Select a past session (a history-row click) — READ-ONLY, never a lifecycle action. Re-queries the center. */
  open(selection: NotetakerSelection): void {
    this.selected = selection
    this.onChange()
  }

  /** Return to the live current-session view. A no-op (no re-query) when already live, so a stray click is cheap. */
  backToLive(): void {
    if (this.selected === undefined) return
    this.selected = undefined
    this.onChange()
  }

  /**
   * The Hud.mapQuery seam. When a past session is selected, a CENTER block that reads the live session
   * (`params.session === 'current'`) is re-pointed to the selected id; everything else (including the center
   * `now` block, which has no query) is left untouched → the controller uses `block.query` unchanged.
   */
  mapQuery = (block: Block): BlockQuery | undefined => {
    const selected = this.selected
    if (selected === undefined || !block.query) return undefined
    if (!(block.id ?? '').startsWith(CENTER_PREFIX)) return undefined
    if (block.query.params['session'] !== LIVE_SENTINEL) return undefined
    return { ...block.query, params: { ...block.query.params, session: selected.sessionId } }
  }
}
