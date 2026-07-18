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
  addEventListener(type: SummaryDomEventType, handler: (event: SummaryDomEvent) => void): void
  value: string
  textContent: string
  title: string
  className: string
  focus?(): void
  selectionStart?: number | null
  selectionEnd?: number | null
  setSelectionRange?(start: number, end: number): void
}
/** The events the controller delegates on its container. All bubble, so ONE listener each covers a re-rendered subtree. */
export type SummaryDomEventType = 'click' | 'input' | 'focusin' | 'focusout' | 'compositionstart' | 'compositionend' | 'compositioncancel'
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
  // Interaction state the live refresh must not trample (the #225/#222 focus repair, scoped to `.sum-edit-text`).
  // `focused` tracks whether the editor holds keyboard focus (via bubbling focusin/focusout); `composing` is
  // true while an IME composition is in flight (a destructive re-render is DEFERRED then, so the node is never
  // replaced mid-composition); `focusSnapshot` is the focus + caret captured just before a wipe, restored by the
  // paired repaint; `renderDeferred` remembers a refresh skipped during composition so compositionend flushes it.
  private focused = false
  private composing = false
  private renderDeferred = false
  private focusSnapshot: { start: number; end: number } | undefined
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
    // Focus tracking so a destructive re-render can restore focus to the fresh textarea (focusin/focusout
    // BUBBLE to the container; focus/blur do not, which is why the delegated listener uses these).
    container.addEventListener('focusin', (event) => {
      if (event.target?.closest('.sum-edit-text')) this.focused = true
    })
    container.addEventListener('focusout', (event) => {
      if (!event.target?.closest('.sum-edit-text')) return
      this.focused = false
      // A blur can end an IME composition without emitting compositionend (not spec-guaranteed across IMEs).
      // If `composing` stuck true, every later wipe would defer forever — a frozen editor. Conservatively end it.
      if (this.composing) this.endComposition()
    })
    // IME composition: while a candidate is being composed the textarea node must NOT be replaced (that drops
    // the composition buffer), so rerenderInto defers the wipe; ending the composition flushes any deferred one.
    container.addEventListener('compositionstart', (event) => {
      if (event.target?.closest('.sum-edit-text')) this.composing = true
    })
    const onCompositionDone = (event: SummaryDomEvent): void => {
      if (event.target?.closest('.sum-edit-text')) this.endComposition()
    }
    container.addEventListener('compositionend', onCompositionDone)
    container.addEventListener('compositioncancel', onCompositionDone)
  }

  /** True while an IME composition is in flight in the editor — the host must defer a destructive re-render. */
  isComposing(): boolean {
    return this.composing
  }

  /** End the current IME composition and flush a re-render deferred while it was in flight (or defensively on blur). */
  private endComposition(): void {
    this.composing = false
    if (this.renderDeferred) {
      this.renderDeferred = false
      this.deps.requestRender()
    }
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

  /**
   * Run a destructive panel re-render (renderInto wipes innerHTML, replacing the `.sum-edit-text` node) while
   * PRESERVING the editor's interaction state — the #225 fix, scoped to the correction editor. The draft text
   * is already held here (repaint restores it); this adds focus, caret, and IME:
   *  - mid-IME-composition: the render is DEFERRED (the live node survives) and flushed on compositionend, so a
   *    refresh can never replace the node the user is composing into.
   *  - otherwise: focus + caret are snapshotted BEFORE the wipe and restored by the paired repaint AFTER it (one
   *    synchronous turn), so a live refresh never steals keyboard focus from an editor being typed in.
   * Composed by the host AROUND the actual wipe (dev-entry nests it with the input block's rerenderInto).
   */
  rerenderInto(container: SummaryDomNode, doRender: () => void): void {
    if (this.composing) {
      this.renderDeferred = true
      return
    }
    this.captureFocus(container)
    // repaint runs in `finally` so a throwing render still CONSUMES the one-shot snapshot (a leaked snapshot
    // would phantom-focus a later repaint) and still re-injects the editor state; the error then propagates.
    try {
      doRender()
    } finally {
      this.repaint(container)
    }
  }

  /** Snapshot whether the editor holds focus and where its caret sits, before a wipe destroys the node. */
  private captureFocus(container: SummaryDomNode): void {
    this.focusSnapshot = undefined
    if (!this.focused) return
    const textarea = container.querySelector('.sum-edit-text')
    if (!textarea) return
    const caretEnd = textarea.value.length
    const start = typeof textarea.selectionStart === 'number' ? textarea.selectionStart : caretEnd
    const end = typeof textarea.selectionEnd === 'number' ? textarea.selectionEnd : caretEnd
    this.focusSnapshot = { start, end }
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
    // Restore the in-progress draft the wipe erased — but NOT mid-composition (writing .value would disrupt the
    // live IME buffer; the 'input' events keep the draft current meanwhile).
    if (!this.composing && this.draft !== undefined && textarea.value !== this.draft) textarea.value = this.draft
    const row = textarea.closest('.sum-editing')
    if (row) this.paintStatus(row)
    // Initial open: focus the fresh editor once and place the caret at the end (and mark it focused, since a
    // programmatic focus() may not emit focusin for our delegated tracker).
    if (this.focusPending) {
      this.focusPending = false
      this.focused = true
      textarea.focus?.()
      const end = textarea.value.length
      this.setCaret(textarea, end, end)
      return
    }
    // Live refresh survival: restore keyboard focus + caret snapshotted before the wipe (one-shot).
    if (this.focusSnapshot) {
      const { start, end } = this.focusSnapshot
      this.focusSnapshot = undefined
      textarea.focus?.()
      this.setCaret(textarea, start, end)
    }
  }

  private setCaret(textarea: SummaryDomNode, start: number, end: number): void {
    if (textarea.setSelectionRange) textarea.setSelectionRange(start, end)
    else {
      textarea.selectionStart = start
      textarea.selectionEnd = end
    }
  }
}
