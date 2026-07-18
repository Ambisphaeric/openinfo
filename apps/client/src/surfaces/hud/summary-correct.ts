import { SUMMARY_EDIT_VERB, SUMMARY_CANCEL_VERB, SUMMARY_CORRECT_VERB } from '../blocks/summaries.js'

/**
 * The imperative controller behind the summary correction affordance (#246) — the client half of "a draft
 * you can correct". The pure renderer (blocks/summaries.ts) emits the pencil, and — when a row is OPEN in
 * the editor — the `.sum-editing` row with a `.sum-edit-text` textarea, an empty `.sum-status`, and the
 * Save/Cancel verbs. This controller owns the interaction the renderer cannot: which row is open, the typed
 * draft, and the honest failure line. It mirrors the InputSession discipline exactly:
 *  - VISIBLE FAILURE (the Save-button lesson): a refused save paints a calm human line into `.sum-status`
 *    with the raw reason on its hover title — never a silent no-op, never a thrown-away promise.
 *  - COMPOSE-AFTER-RENDER: the open row, the draft, and the error live HERE, not in the DOM, so the ~1/s
 *    live panel re-render (renderInto wipes innerHTML) never eats them — dev-entry calls repaint() after
 *    every onRender, exactly as it does for the input block.
 *
 * A successful save is a LOCAL write (POST /summaries/correct) that outranks the machine row at read time;
 * the controller then re-hydrates so the corrected row loads as the live head — the correction visibly takes
 * effect (hud-voice §5). Editing state is owned here and read by the Hud each render (via `editingId`), the
 * same shape as the pill/session-readiness getters — so the Hud stays layout-agnostic.
 *
 * Typed structurally over a minimal DOM subset (like mount.ts / input-submit.ts) so it runs headless under
 * node:test with a fake container — no jsdom, no live network.
 */

/** The DOM subset the controller touches — real elements satisfy it without a cast. */
export interface SummaryDomNode {
  closest(selector: string): SummaryDomNode | null
  querySelector(selector: string): SummaryDomNode | null
  getAttribute(name: string): string | null
  addEventListener(type: 'click' | 'input', handler: (event: SummaryDomEvent) => void): void
  value: string
  textContent: string
  title: string
  className: string
  focus?(): void
  selectionStart?: number | null
  selectionEnd?: number | null
  setSelectionRange?(start: number, end: number): void
}
export interface SummaryDomEvent {
  target: { closest(selector: string): SummaryDomNode | null } | null
}

/** The injected write path + host hooks — real ones live in dev-entry; a test injects fakes. */
export interface SummaryCorrectDeps {
  /** POST the sovereign correction (POST /summaries/correct). Rejects with a MESSAGE on failure — surfaced verbatim on hover. */
  correct(input: { workspaceId: string; summaryId: string; text: string }): Promise<void>
  /** Re-paint the panel with the CURRENT data (a client-local view change — open/cancel). */
  requestRender(): void
  /** Re-hydrate every block query so the corrected row loads as the live head. Called after a successful save. */
  refresh(): Promise<void>
}

/** The controller for a surface's summary rows. One per panel; owns the single open editor's state. */
export class SummaryEditSession {
  private readonly deps: SummaryCorrectDeps
  private editing: string | undefined
  private pending = false
  // The in-progress edit text, held here so a destructive panel re-render never erases what the user is
  // mid-typing — repaint restores it (the same reason the input block holds its draft).
  private draft: string | undefined
  // The honest failure line for the open editor; painted into `.sum-status` and re-injected on repaint.
  private error: { text: string; detail?: string } | undefined
  // Focus the textarea once when an editor first opens (best-effort; a headless test simply skips it).
  private focusPending = false
  private container: SummaryDomNode | undefined

  constructor(deps: SummaryCorrectDeps) {
    this.deps = deps
  }

  /** The row currently open in the editor — read by the Hud each render to thread the summaryEdit context. */
  editingId(): string | undefined {
    return this.editing
  }

  /** Wire the delegated click + input listeners onto the mount container (they survive innerHTML replacement). */
  install(container: SummaryDomNode): void {
    this.container = container
    container.addEventListener('click', (event) => {
      const open = event.target?.closest(`[data-verb="${SUMMARY_EDIT_VERB}"]`)
      if (open) {
        this.openEditor(open.getAttribute('data-summary'))
        return
      }
      const cancel = event.target?.closest(`[data-verb="${SUMMARY_CANCEL_VERB}"]`)
      if (cancel) {
        this.closeEditor()
        return
      }
      const save = event.target?.closest(`[data-verb="${SUMMARY_CORRECT_VERB}"]`)
      if (save) void this.onSave(save)
    })
    // Track the draft as it is typed so a live re-render can restore it (never erase mid-edit).
    container.addEventListener('input', (event) => {
      const el = event.target?.closest('.sum-edit-text')
      if (el) this.draft = el.value
    })
  }

  private openEditor(summaryId: string | null): void {
    if (summaryId === null) return
    this.editing = summaryId
    this.draft = undefined
    this.error = undefined
    this.focusPending = true
    this.deps.requestRender()
  }

  private closeEditor(): void {
    this.editing = undefined
    this.draft = undefined
    this.error = undefined
    this.deps.requestRender()
  }

  private async onSave(button: SummaryDomNode): Promise<void> {
    if (this.pending) return
    const summaryId = button.getAttribute('data-summary')
    const workspaceId = button.getAttribute('data-workspace')
    const row = button.closest('.sum-editing')
    const textarea = row?.querySelector('.sum-edit-text') ?? undefined
    const text = (textarea?.value ?? this.draft ?? '').trim()
    if (summaryId === null || workspaceId === null) return // inert — nothing addressable to correct
    if (text === '') {
      // Empty is a correction of nothing — say so calmly rather than posting an empty body the engine rejects.
      this.error = { text: 'Add a few words before saving your correction.' }
      if (row) this.paintStatus(row)
      return
    }
    this.pending = true
    try {
      await this.deps.correct({ workspaceId, summaryId, text })
      // Success: close the editor and re-hydrate so the corrected row loads as the live head (visible effect).
      this.editing = undefined
      this.draft = undefined
      this.error = undefined
      this.deps.requestRender()
      await this.deps.refresh()
    } catch (error) {
      // VISIBLE FAILURE (hud-voice §3, the Save-button lesson): one calm human line; the raw reason rides the
      // hover title (the detail-on-inspection pattern), reachable but never painted as slop.
      this.error = {
        text: 'Couldn’t save your correction — the engine returned an error.',
        detail: error instanceof Error ? error.message : String(error),
      }
      if (row) this.paintStatus(row)
    } finally {
      this.pending = false
    }
  }

  /** Paint the honest failure line straight into an open row's `.sum-status` (no re-render — keeps the textarea). */
  private paintStatus(row: SummaryDomNode): void {
    const status = row.querySelector('.sum-status')
    if (!status) return
    status.textContent = this.error ? this.error.text : ''
    status.className = this.error ? 'sum-status err' : 'sum-status'
    status.title = this.error?.detail ?? ''
  }

  /**
   * Re-inject the editor's state after a panel render (call after every onRender). Restores the in-progress
   * draft the wipe erased from the fresh textarea, re-paints any failure line, and focuses the textarea once
   * when an editor first opens. A no-op when nothing is open.
   */
  repaint(container: SummaryDomNode): void {
    this.container = container
    if (this.editing === undefined) return
    const textarea = container.querySelector('.sum-edit-text')
    if (!textarea) return
    if (this.draft !== undefined && textarea.value !== this.draft) textarea.value = this.draft
    const row = textarea.closest('.sum-editing')
    if (row) this.paintStatus(row)
    if (this.focusPending) {
      this.focusPending = false
      textarea.focus?.()
      const end = textarea.value.length
      textarea.setSelectionRange?.(end, end)
    }
  }
}
