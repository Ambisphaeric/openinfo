import type { ChatReply, ChatTurn } from '@openinfo/contracts'

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
 * The File subset the upload dep needs. `path` is the local filesystem path Electron exposes on a
 * dropped/picked File (`File.path`) — the engine's EXISTING file ingest reads that path, so this is how a
 * desktop upload rides the pins/ingest substrate without a new engine capability. A plain browser File has
 * no `path`, so the upload dep surfaces an honest "needs the desktop app" message rather than pretending.
 */
export interface UploadFile {
  name: string
  type?: string
  path?: string
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

/** The injected write paths — the real ones (fetch + ingest) live in dev-entry; a test injects fakes. */
export interface InputDeps {
  /** POST a turn to the configured route (e.g. /chat). Rejects with a MESSAGE on failure — surfaced verbatim. */
  submit(input: { target: string; route: string; message: string; pinId?: string; history: ChatTurn[] }): Promise<ChatReply>
  /** Run the EXISTING pins/ingest path over a dropped file and return the citable attachment. Absent ⇒ file-drop is inert. */
  upload?(file: UploadFile): Promise<AttachedDoc>
}

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

  constructor(deps: InputDeps) {
    this.deps = deps
  }

  /** Wire the delegated submit-click + file-change listeners onto the mount container (survives re-render). */
  install(container: InputDomNode): void {
    container.addEventListener('click', (event) => {
      const el = event.target?.closest('[data-verb="input-submit"]')
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
    const message = (textarea?.value ?? '').trim()
    if (!route || message === '') return
    this.turns.push({ role: 'user', content: message })
    this.pending = true
    this.status = { kind: 'info', text: 'Thinking…' }
    this.draft = ''
    if (textarea) textarea.value = ''
    this.repaintFrom(block)
    try {
      const reply = await this.deps.submit({
        target,
        route,
        message,
        ...(this.attached ? { pinId: this.attached.pinId } : {}),
        history: this.turns.slice(0, -1),
      })
      this.turns.push({ role: 'assistant', content: reply.answer })
      this.lastReply = reply
      this.status = { kind: 'ok', text: reply.budget.note }
    } catch (error) {
      // VISIBLE FAILURE — the reason is painted as text, never swallowed.
      this.status = { kind: 'error', text: error instanceof Error ? error.message : String(error) }
    } finally {
      this.pending = false
      this.repaintFrom(block)
    }
  }

  private async onFile(block: InputDomNode, file: UploadFile): Promise<void> {
    if (!this.deps.upload) {
      this.status = { kind: 'error', text: 'file upload is not available here' }
      this.repaintFrom(block)
      return
    }
    this.status = { kind: 'info', text: `Ingesting ${file.name}…` }
    this.repaintFrom(block)
    try {
      this.attached = await this.deps.upload(file)
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
    if (log) log.innerHTML = this.turns.map(turnHtml).join('') + (this.lastReply ? citationsHtml(this.lastReply) : '')
    const context = block.querySelector('.in-context')
    if (context) context.innerHTML = this.attached ? `<div class="in-attached">📎 ${escapeHtml(this.attached.title)} — ${escapeHtml(this.attached.summary)}</div>` : ''
    const status = block.querySelector('.in-status')
    if (status) status.innerHTML = this.status ? `<div class="in-note ${this.status.kind}">${escapeHtml(this.status.text)}</div>` : ''
    // Restore the in-progress draft the re-render wiped from the (fresh) textarea.
    const textarea = block.querySelector('.in-text')
    if (textarea && this.draft !== '' && textarea.value !== this.draft) textarea.value = this.draft
  }
}
