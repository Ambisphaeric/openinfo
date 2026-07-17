import type { ChatReply, ChatScreenshot, ChatTurn } from '@openinfo/contracts'

/**
 * The imperative wiring behind the `input` block (#134) — the client half of the text-entry / file-drop
 * primitive. The pure renderer (blocks/input.ts) emits the control shell with `data-target`/`data-submit`
 * on `.input-block` and empty `.in-log` / `.in-context` / `.in-status` regions; this controller reads the
 * typed text (and dropped files), POSTs a turn to the configured route, and REPAINTS the regions from its
 * own state. Two disciplines matter:
 *  - VISIBLE FAILURE (the QA doctrine): a rejected submit paints the reason into `.in-status` as text —
 *    never a silent no-op, never a thrown-away promise.
 *  - COMPOSE-AFTER-RENDER: the conversation/attachment/status live in THIS controller, not the DOM, so a
 *    destructive panel re-render (renderInto wipes innerHTML) never eats them — dev-entry calls repaint()
 *    after every onRender, exactly as the HUD composes its live-transcript strip after render.
 *
 * Typed structurally over a minimal DOM subset (like mount.ts) so it runs headless under node:test with a
 * fake container + injected deps — no jsdom, no live model, no real network.
 */

/**
 * The File subset the upload dep needs. `path` is the local filesystem path the engine's EXISTING file
 * ingest reads, so this is how a desktop upload rides the pins/ingest substrate without a new engine
 * capability. It is RESOLVED at attach time (resolveUploadFile), not read off the raw File:
 *   - Desktop shell (Electron 38): `File.path` was removed in Electron 32, so a picked/dropped File no
 *     longer carries its path — the path comes from `webUtils.getPathForFile`, exposed on the preload
 *     bridge as `window.openinfoFiles.getPathForFile` (basics wave B / S2). Reading `.path` directly is
 *     the exact bug this slice fixes: it is always undefined now, so attach went silently inert.
 *   - Dev-harness / served-test / plain browser: no preload bridge exists, so the FALLBACK is a `path`
 *     already present on the File-like the caller supplies (a test/harness sets it explicitly). A real
 *     plain-browser File has neither bridge nor `.path`, so the upload dep surfaces an honest
 *     "needs the desktop app" message rather than pretending.
 */
export interface UploadFile {
  name: string
  type?: string
  path?: string
}

/**
 * The preload bridge (preload.cts → contextBridge) that resolves a picked/dropped File to its local
 * filesystem path via Electron's `webUtils.getPathForFile`. Present only inside the desktop shell;
 * `undefined` in a plain browser / served test, which is what the dev-harness fallback handles.
 */
interface FilePathBridge {
  getPathForFile(file: unknown): string
}

/** A minimal FileList — real DOM `HTMLInputElement.files` satisfies this structurally. */
export interface FileListLike {
  length: number
  item(index: number): UploadFile | null
}

/** The DOM event subset the controller reads — a real DOM Event satisfies it structurally. */
export interface InputDomEvent {
  target: InputDomNode | null
  /** keydown only: the key name (e.g. `'Enter'`) + modifier, used for the Enter-submits / Shift+Enter-newline convention. */
  key?: string
  shiftKey?: boolean
  /** true while the keystroke is part of an IME composition — Enter then confirms the candidate, never submits. */
  isComposing?: boolean
  preventDefault?(): void
}

/** The events the controller delegates on its container. All bubble, so ONE listener each covers the re-rendered subtree. */
export type InputDomEventType = 'click' | 'change' | 'input' | 'keydown' | 'focusin' | 'focusout' | 'compositionstart' | 'compositionend' | 'compositioncancel'

/** The DOM subset the controller touches — real elements satisfy it without a cast. */
export interface InputDomNode {
  querySelector(selector: string): InputDomNode | null
  closest(selector: string): InputDomNode | null
  getAttribute(name: string): string | null
  addEventListener(type: InputDomEventType, handler: (event: InputDomEvent) => void): void
  value: string
  innerHTML: string
  files: FileListLike | null
  /** Present on the textarea (HTMLTextAreaElement) — used to restore focus + caret across a destructive re-render. */
  focus?(): void
  selectionStart?: number | null
  selectionEnd?: number | null
  setSelectionRange?(start: number, end: number): void
}

/** An ingested attachment the chat can cite — the pin id its chunks live under, plus a human summary. */
export interface AttachedDoc {
  pinId: string
  title: string
  /** a one-line extract/ingest summary shown in the context area (e.g. "12 pages ingested"). */
  summary: string
}

/**
 * The honest outcome of asking the shell for one screen frame (the Ask face). `ok:false` carries the
 * human WHY (sense off / permission refused / no frame yet) — the send proceeds without a frame and the
 * reason is disclosed in the status line, never swallowed and never blocking.
 */
export type CaptureOutcome = { ok: true; frame: ChatScreenshot } | { ok: false; reason: string }

/** The persisted thread a chat window rehydrates on open (GET /chat/history) — capped tail, disclosed. */
export interface ChatThread {
  turns: ChatTurn[]
  total: number
  truncated: boolean
}

/** The injected write paths — the real ones (fetch + ingest) live in dev-entry; a test injects fakes. */
export interface InputDeps {
  /** POST a turn to the configured route (e.g. /chat). Rejects with a MESSAGE on failure — surfaced verbatim.
   * `screenshot` is the frame captured for THIS send; `turnId` keys the ephemeral chat.delta stream. */
  submit(input: { target: string; route: string; message: string; pinId?: string; history: ChatTurn[]; screenshot?: ChatScreenshot; turnId: string }): Promise<ChatReply>
  /** Run the EXISTING pins/ingest path over a dropped file and return the citable attachment. Absent ⇒ file-drop is inert. */
  upload?(file: UploadFile): Promise<AttachedDoc>
  /** Grab ONE screen frame for THIS send (the shell's `openinfoScreen` bridge; consent gated in main).
   * Absent ⇒ no desktop bridge here — the send runs without a frame and says so. Called exactly once per
   * submit, never on a timer: this is not ambient capture. */
  captureScreen?(): Promise<CaptureOutcome>
  /** Resolve the Ask face's DEFAULT question (the tpl-ask-default document body over GET /templates/:id)
   * — what an EMPTY send with a captured frame asks. Absent ⇒ an empty send is a visible no-op. */
  defaultAsk?(): Promise<string>
  /** Ask the host to re-render the surface. Used ONLY to FLUSH a re-render that was deferred while an IME
   * composition was in flight (see rerenderInto). Absent ⇒ the next live event catches the display up. */
  requestRender?(): void
}

/**
 * The verb the input block's submit button carries and this controller dispatches (the selector in
 * install() gates on it). Exported as the source of truth so the honesty interaction lint can union it
 * with the mount layer's WIRED_VERBS instead of hardcoding the literal — the input block's dispatch path
 * lives here, not in wireActions, so its verb is contributed from here.
 */
export const INPUT_SUBMIT_VERB = 'input-submit'

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const turnHtml = (turn: ChatTurn): string =>
  `<div class="in-turn ${turn.role}"><span class="in-who">${turn.role === 'user' ? 'You' : 'openinfo'}</span><span class="in-msg">${escapeHtml(turn.content)}</span></div>`

const citationsHtml = (reply: ChatReply): string => {
  if (reply.citations.length === 0) return ''
  // A page anchor is human ("p.3"); the chunk ORDINAL is a machine index (hud-voice §2), so a pageless
  // source is named by its human title instead, never "#2" (#242). Deduped so repeated anchors don't stutter.
  const tags = [...new Set(reply.citations.map((c) => (c.page !== undefined ? `p.${c.page}` : (c.pinTitle ?? 'a passage'))))]
    .map(escapeHtml)
    .join(' · ')
  return `<div class="in-cites">cited ${tags}</div>`
}

interface Status {
  kind: 'ok' | 'error' | 'info'
  text: string
  /** the full machine disclosure, moved behind inspection (a hover title) rather than shown as slop. */
  detail?: string
}

/**
 * Translate a resolved chat reply into a CALM, human status line (hud-voice) plus the full machine
 * disclosure for inspection. The DEFAULT — a clean answer — shows NOTHING: the answer itself is the
 * feedback, and the raw context-assembly note (source kinds/counts, "Context:"/"Omitted:", capped/empty)
 * is exactly the machine-speak the chat strip must not render. A DEGRADED turn says so in plain words:
 * the screen could not be included, or the conversation was trimmed to fit. The raw note is never the
 * visible text — it rides `detail` (a hover title) and lives in full on the Diagnostics surface.
 */
export const calmChatStatus = (reply: ChatReply, captureNote?: string): { text: string; detail: string } => {
  const parts: string[] = []
  if (captureNote) parts.push(`Answered without your screen — ${captureNote}.`)
  else if (reply.budget.truncated) parts.push('Answered from a trimmed view of the conversation.')
  const detail = captureNote ? `${reply.budget.note} Screen skipped: ${captureNote}.` : reply.budget.note
  return { text: parts.join(' '), detail }
}

/**
 * The live conversation controller for ONE input block. Holds the turns + attachment + status; paints them
 * into a container's `.in-*` regions on demand. One per panel (the chat shell has a single input block).
 */
export class InputSession {
  private readonly deps: InputDeps
  private readonly turns: ChatTurn[] = []
  private attached: AttachedDoc | undefined
  private status: Status | undefined
  private pending = false
  // The in-progress entry text, held here so a destructive panel re-render (renderInto wipes the textarea)
  // never erases what the user is mid-typing — repaint restores it, the same reason turns/status live here.
  private draft = ''
  // The container install() wired — kept so an EVENT (a chat.delta frame, a history seed) can repaint
  // without waiting for the next submit (the live-strip discipline: payload events re-paint directly).
  private container: InputDomNode | undefined
  // The in-flight turn's ephemeral stream state (the Ask face): deltas keyed to OUR minted turnId append
  // here and paint as a growing provisional assistant turn; the resolved ChatReply is the authoritative
  // answer that replaces it (event-fed render, query-fed truth — the #58 idiom).
  private streaming: { turnId: string; buffer: string; lastSeq: number } | undefined
  // The honest cap disclosure when the rehydrated thread is a truncated tail (seedHistory).
  private historyNote: string | undefined
  // Interaction state the live refresh must not trample (the #222 focus repair). `focused` tracks whether
  // the chat input currently holds keyboard focus (via bubbling focusin/focusout); `composing` is true while
  // an IME composition is in flight (a destructive re-render is DEFERRED then, so the node is never replaced
  // mid-composition); `focusSnapshot` is the focus + caret captured just before a wipe, restored by the paired
  // repaint; `renderDeferred` remembers that a refresh was skipped during composition so compositionend flushes it.
  private focused = false
  private composing = false
  private renderDeferred = false
  private focusSnapshot: { start: number; end: number } | undefined

  constructor(deps: InputDeps) {
    this.deps = deps
  }

  /** Wire the delegated submit-click + file-change listeners onto the mount container (survives re-render). */
  install(container: InputDomNode): void {
    this.container = container
    container.addEventListener('click', (event) => {
      const el = event.target?.closest(`[data-verb="${INPUT_SUBMIT_VERB}"]`)
      if (!el) return
      const block = el.closest('.input-block')
      if (block) void this.onSubmit(block)
    })
    container.addEventListener('change', (event) => {
      const el = event.target?.closest('.in-file')
      if (!el) return
      const block = el.closest('.input-block')
      const file = el.files?.item(0) ?? null
      if (block && file) void this.onFile(block, file)
    })
    // Track the draft as it is typed so a re-render can restore it (never erase mid-entry).
    container.addEventListener('input', (event) => {
      const el = event.target?.closest('.in-text')
      if (el) this.draft = el.value
    })
    // Enter submits, Shift+Enter inserts a newline (the standard chat convention). This is delegated and
    // GATED on the chat input — NOT a global key capture: keydown only fires on the focused element, and we
    // act only when that element is `.in-text`. Enter DURING an IME composition confirms the candidate and
    // must never submit — both our own `composing` flag and the event's `isComposing` guard that.
    container.addEventListener('keydown', (event) => {
      const el = event.target?.closest('.in-text')
      if (!el) return
      if (event.key !== 'Enter' || event.shiftKey === true) return
      if (this.composing || event.isComposing === true) return
      event.preventDefault?.() // stop the newline the textarea would otherwise insert
      const block = el.closest('.input-block')
      if (block) void this.onSubmit(block)
    })
    // Focus tracking so a destructive re-render can restore focus to the fresh textarea (focusin/focusout
    // BUBBLE to the container; focus/blur do not, which is why the delegated listener uses these).
    container.addEventListener('focusin', (event) => {
      if (event.target?.closest('.in-text')) this.focused = true
    })
    container.addEventListener('focusout', (event) => {
      if (!event.target?.closest('.in-text')) return
      this.focused = false
      // A blur can end an IME composition WITHOUT emitting compositionend/compositioncancel (not spec-guaranteed
      // across IMEs). If `composing` stuck true, EVERY later rerenderInto would defer forever — a permanently
      // frozen panel (no transcript updates, no draft restore). So a blur while composing conservatively ends it.
      if (this.composing) this.endComposition()
    })
    // IME composition: while a candidate is being composed the textarea node must NOT be replaced (that drops
    // the composition buffer), so rerenderInto defers the wipe; ending the composition flushes any deferred
    // refresh. compositioncancel is handled identically to compositionend (both terminate the composition).
    container.addEventListener('compositionstart', (event) => {
      if (event.target?.closest('.in-text')) this.composing = true
    })
    const onCompositionDone = (event: InputDomEvent): void => {
      if (event.target?.closest('.in-text')) this.endComposition()
    }
    container.addEventListener('compositionend', onCompositionDone)
    container.addEventListener('compositioncancel', onCompositionDone)
  }

  /** True while an IME composition is in flight — the host must defer a destructive re-render (see rerenderInto). */
  isComposing(): boolean {
    return this.composing
  }

  /**
   * End the current IME composition and flush a re-render that was deferred while it was in flight. Called on
   * compositionend/compositioncancel AND defensively on blur (some IMEs end a composition on blur emitting no
   * composition event), so `composing` can never stick true and freeze the panel in permanent deferral.
   */
  private endComposition(): void {
    this.composing = false
    if (this.renderDeferred) {
      this.renderDeferred = false
      this.deps.requestRender?.()
    }
  }

  /**
   * Run a destructive panel re-render (renderInto wipes innerHTML, replacing the `.in-text` node) while
   * PRESERVING the chat input's interaction state — the #222 fix for "typing into nothing" on the live
   * refresh. The draft text was already held here (repaint restores it); this adds focus, caret, and IME:
   *  - mid-IME-composition: the render is DEFERRED (the live node survives, the composition continues) and
   *    flushed on compositionend, so a refresh can never replace the node the user is composing into.
   *  - otherwise: focus + caret are snapshotted BEFORE the wipe and restored by the paired repaint AFTER it
   *    (one synchronous turn, so the user never sees the input lose focus), so a refresh never moves keyboard
   *    focus away from an input being typed in.
   */
  rerenderInto(container: InputDomNode, doRender: () => void): void {
    if (this.composing) {
      this.renderDeferred = true
      return
    }
    this.captureFocus(container)
    // repaint runs in `finally` so a throwing render still CONSUMES the one-shot focus snapshot (a leaked
    // snapshot would phantom-focus a later, unrelated repaint) and still re-injects the conversation; the
    // render's error then propagates to the host's onError as before.
    try {
      doRender()
    } finally {
      this.repaint(container)
    }
  }

  /** Snapshot whether the chat input holds focus and where its caret sits, before a wipe destroys the node. */
  private captureFocus(container: InputDomNode): void {
    this.focusSnapshot = undefined
    if (!this.focused) return
    const textarea = container.querySelector('.in-text')
    if (!textarea) return
    const caretEnd = textarea.value.length
    const start = typeof textarea.selectionStart === 'number' ? textarea.selectionStart : caretEnd
    const end = typeof textarea.selectionEnd === 'number' ? textarea.selectionEnd : caretEnd
    this.focusSnapshot = { start, end }
  }

  private async onSubmit(block: InputDomNode): Promise<void> {
    if (this.pending) return
    const route = block.getAttribute('data-submit')
    const target = block.getAttribute('data-target') ?? 'chat'
    const textarea = block.querySelector('.in-text')
    const typed = (textarea?.value ?? '').trim()
    if (!route) return
    this.pending = true
    try {
      // Screenshot-on-every-send (the Ask face): ask the shell for ONE frame for THIS send — the only
      // capture trigger on this path (an explicit user act, never ambient). A refusal/absence yields the
      // human reason, disclosed in the status alongside the engine's budget note — never silent.
      let screenshot: ChatScreenshot | undefined
      let captureNote: string | undefined
      if (this.deps.captureScreen) {
        try {
          const outcome = await this.deps.captureScreen()
          if (outcome.ok) screenshot = outcome.frame
          else captureNote = outcome.reason
        } catch {
          // A capture bridge that throws is a screen-side failure, not the answer — say so in calm words,
          // never paint the raw exception into the status line (hud-voice §2, #242).
          captureNote = 'screen capture did not respond'
        }
      } else {
        captureNote = 'screen capture needs the desktop app'
      }

      // EMPTY send = "explain my screen" (owner canon): with a frame in hand, the message becomes the
      // shipped default-ask DOCUMENT's body (tpl-ask-default, resolved fresh — #130 posture, no baked
      // string). With NO frame available, an empty send is an honest visible no-op — text, not a swallow.
      let message = typed
      if (message === '') {
        if (screenshot === undefined) {
          this.status = {
            kind: 'info',
            text: `Nothing to ask — type a message, or allow screen capture to ask about your screen${captureNote ? ` (${captureNote})` : ''}.`,
          }
          return
        }
        if (!this.deps.defaultAsk) {
          this.status = { kind: 'error', text: 'empty send: the default ask is not available here' }
          return
        }
        message = (await this.deps.defaultAsk()).trim() // a failed read throws → painted below
        if (message === '') throw new Error('the default ask document has an empty body')
      }

      // The stream key for this turn — minted HERE so the chat.delta frames the engine broadcasts can be
      // recognized as ours and painted while the POST is still in flight.
      const turnId = `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      this.streaming = { turnId, buffer: '', lastSeq: -1 }
      this.turns.push({ role: 'user', content: message })
      this.status = { kind: 'info', text: 'Thinking…' }
      this.draft = ''
      if (textarea) textarea.value = ''
      this.repaintFrom(block)
      const reply = await this.deps.submit({
        target,
        route,
        message,
        ...(this.attached ? { pinId: this.attached.pinId } : {}),
        history: this.turns.slice(0, -1),
        ...(screenshot !== undefined ? { screenshot } : {}),
        turnId,
      })
      // The authoritative answer replaces the streamed provisional paint (query-fed truth).
      this.turns.push({ role: 'assistant', content: reply.answer })
      this.lastReply = reply
      // Calm, human status (hud-voice): a clean answer says nothing (the answer IS the feedback); a degraded
      // turn says so plainly; the raw machine disclosure moves to the hover title, never the visible strip.
      const calm = calmChatStatus(reply, captureNote)
      this.status = calm.text === '' ? undefined : { kind: 'ok', text: calm.text, detail: calm.detail }
    } catch (error) {
      // VISIBLE FAILURE — the reason is never swallowed, but the raw exception is machine-speak
      // (hud-voice §2): the strip shows one calm human line and the raw message rides the hover title
      // (the same detail-on-inspection pattern as calmChatStatus), reachable but never painted as slop (#242).
      this.status = {
        kind: 'error',
        text: 'Couldn’t answer — the engine returned an error.',
        detail: error instanceof Error ? error.message : String(error),
      }
    } finally {
      this.streaming = undefined
      this.pending = false
      this.repaintFrom(block)
    }
  }

  /**
   * Ingest one ephemeral `chat.delta` WS frame (the Ask face streamed reply). Defensive about shape (a
   * malformed frame is ignored, never a throw into the WS handler — the #58 discipline); frames for a
   * turn we did not mint, duplicate/out-of-order seqs, and terminal done frames are dropped (the resolved
   * ChatReply — not the stream — is what lands in the thread). Appends and re-paints DIRECTLY: payload
   * events re-paint, they never re-query.
   */
  ingestDelta(payload: unknown): void {
    if (typeof payload !== 'object' || payload === null) return
    const p = payload as { turnId?: unknown; seq?: unknown; text?: unknown; done?: unknown }
    if (typeof p.turnId !== 'string' || typeof p.seq !== 'number' || typeof p.text !== 'string') return
    const s = this.streaming
    if (!s || s.turnId !== p.turnId || p.done === true || p.seq <= s.lastSeq) return
    s.lastSeq = p.seq
    s.buffer += p.text
    if (this.container) this.repaint(this.container)
  }

  /**
   * Seed the rehydrated per-workspace thread (GET /chat/history) so the chat window opens mid-conversation
   * (the owner's persistent app-scoped thread). Only ever fills an EMPTY session — a live conversation is
   * never clobbered by a late fetch. A truncated tail is DISCLOSED at the top of the log, never silently
   * absorbed as "the whole thread".
   */
  seedHistory(thread: ChatThread): void {
    if (this.turns.length > 0) return
    this.turns.push(...thread.turns)
    if (thread.truncated) this.historyNote = `Showing the last ${thread.turns.length} of ${thread.total} turns.`
    if (this.container) this.repaint(this.container)
  }

  /**
   * Resolve a picked/dropped File to the plain {name, type, path} the upload dep ingests. The path can no
   * longer be read off the File (`File.path` gone since Electron 32) — in the desktop shell it comes from
   * the preload's `webUtils.getPathForFile` bridge; outside it (dev harness / served test / plain browser)
   * it falls back to any `path` already on the supplied File-like. We build a fresh plain object rather
   * than spreading the File because a real DOM File's name/type/path are prototype getters, not own
   * enumerable props, so a spread would drop them. An empty-string bridge result (a File with no disk
   * backing) is treated as no path, so the upload dep raises its honest "needs the desktop app" failure.
   */
  private resolveUploadFile(file: UploadFile): UploadFile {
    const bridge = (globalThis as { openinfoFiles?: FilePathBridge }).openinfoFiles
    let path: string | undefined
    try {
      const viaBridge = bridge?.getPathForFile(file)
      path = viaBridge !== undefined && viaBridge !== '' ? viaBridge : file.path
    } catch {
      // A bridge that throws (unexpected) must never eat the attach — fall back to whatever the File carries.
      path = file.path
    }
    return {
      name: file.name,
      ...(file.type !== undefined ? { type: file.type } : {}),
      ...(path !== undefined ? { path } : {}),
    }
  }

  private async onFile(block: InputDomNode, file: UploadFile): Promise<void> {
    if (!this.deps.upload) {
      this.status = { kind: 'error', text: 'file upload is not available here' }
      this.repaintFrom(block)
      return
    }
    const resolved = this.resolveUploadFile(file)
    this.status = { kind: 'info', text: `Ingesting ${resolved.name}…` }
    this.repaintFrom(block)
    try {
      this.attached = await this.deps.upload(resolved)
      this.status = { kind: 'ok', text: `Attached ${this.attached.title} — ${this.attached.summary}` }
    } catch (error) {
      this.attached = undefined
      this.status = { kind: 'error', text: error instanceof Error ? error.message : String(error) }
    } finally {
      this.repaintFrom(block)
    }
  }

  private lastReply: ChatReply | undefined

  /** Re-inject the controller's state into a container's `.in-*` regions (call after every panel render). */
  repaint(container: InputDomNode): void {
    const block = container.querySelector('.input-block')
    if (block) this.repaintFrom(block)
  }

  private repaintFrom(block: InputDomNode): void {
    const log = block.querySelector('.in-log')
    if (log) {
      // The honest cap note (a truncated rehydrated thread) leads; the streamed provisional turn — the
      // in-flight answer painting as it arrives — trails, until the authoritative reply replaces it.
      const historyNoteHtml = this.historyNote ? `<div class="in-note info">${escapeHtml(this.historyNote)}</div>` : ''
      const streamingHtml =
        this.pending && this.streaming !== undefined && this.streaming.buffer !== ''
          ? `<div class="in-turn assistant streaming"><span class="in-who">openinfo</span><span class="in-msg">${escapeHtml(this.streaming.buffer)}</span></div>`
          : ''
      log.innerHTML = historyNoteHtml + this.turns.map(turnHtml).join('') + streamingHtml + (this.lastReply ? citationsHtml(this.lastReply) : '')
    }
    const context = block.querySelector('.in-context')
    if (context) context.innerHTML = this.attached ? `<div class="in-attached">📎 ${escapeHtml(this.attached.title)} — ${escapeHtml(this.attached.summary)}</div>` : ''
    const status = block.querySelector('.in-status')
    if (status) {
      const titleAttr = this.status?.detail ? ` title="${escapeHtml(this.status.detail)}"` : ''
      status.innerHTML = this.status ? `<div class="in-note ${this.status.kind}"${titleAttr}>${escapeHtml(this.status.text)}</div>` : ''
    }
    // Restore the in-progress draft the re-render wiped from the (fresh) textarea — but NOT mid-composition
    // (writing .value would disrupt the live IME buffer; the 'input' events keep the draft current meanwhile).
    const textarea = block.querySelector('.in-text')
    if (textarea && !this.composing && this.draft !== '' && textarea.value !== this.draft) textarea.value = this.draft
    // Restore keyboard focus + caret when this repaint follows a wipe that destroyed a FOCUSED input (the
    // snapshot is set only by captureFocus and consumed once here), so the live refresh never steals focus.
    if (textarea && this.focusSnapshot) {
      const { start, end } = this.focusSnapshot
      this.focusSnapshot = undefined
      textarea.focus?.()
      if (textarea.setSelectionRange) textarea.setSelectionRange(start, end)
      else {
        textarea.selectionStart = start
        textarea.selectionEnd = end
      }
    }
  }
}
