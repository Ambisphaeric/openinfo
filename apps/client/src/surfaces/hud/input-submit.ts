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

/** The DOM subset the controller touches — real elements satisfy it without a cast. */
export interface InputDomNode {
  querySelector(selector: string): InputDomNode | null
  closest(selector: string): InputDomNode | null
  getAttribute(name: string): string | null
  addEventListener(type: 'click' | 'change' | 'input', handler: (event: { target: InputDomNode | null }) => void): void
  value: string
  innerHTML: string
  files: FileListLike | null
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
  const tags = reply.citations.map((c) => escapeHtml(c.page !== undefined ? `p.${c.page}` : `#${c.ordinal}`)).join(' · ')
  return `<div class="in-cites">cited ${tags}</div>`
}

interface Status {
  kind: 'ok' | 'error' | 'info'
  text: string
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
        } catch (error) {
          captureNote = error instanceof Error ? error.message : String(error)
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
      this.status = { kind: 'ok', text: captureNote ? `${reply.budget.note} Screen skipped: ${captureNote}.` : reply.budget.note }
    } catch (error) {
      // VISIBLE FAILURE — the reason is painted as text, never swallowed.
      this.status = { kind: 'error', text: error instanceof Error ? error.message : String(error) }
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
    if (status) status.innerHTML = this.status ? `<div class="in-note ${this.status.kind}">${escapeHtml(this.status.text)}</div>` : ''
    // Restore the in-progress draft the re-render wiped from the (fresh) textarea.
    const textarea = block.querySelector('.in-text')
    if (textarea && this.draft !== '' && textarea.value !== this.draft) textarea.value = this.draft
  }
}
