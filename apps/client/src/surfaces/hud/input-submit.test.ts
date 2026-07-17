import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatReply, ChatTurn } from '@openinfo/contracts'
import { InputSession, calmChatStatus, type AttachedDoc, type InputDomEvent, type InputDomEventType, type InputDomNode, type UploadFile } from './input-submit.js'

/**
 * A tiny structural-DOM shim — enough of querySelector/closest/getAttribute/addEventListener + the value/
 * innerHTML/files properties for InputSession, with a manual dispatch. Mirrors the save-handler.test shim
 * spirit: drive the REAL controller (not a reimplementation) over a fake tree, then assert what it painted.
 */
class FakeNode implements InputDomNode {
  tag: string
  classes: Set<string>
  attrs = new Map<string, string>()
  children: FakeNode[] = []
  parent: FakeNode | undefined
  value = ''
  innerHTML = ''
  files: { length: number; item(i: number): UploadFile | null } | null = null
  // textarea interaction state (the #222 focus repair): a real HTMLTextAreaElement carries these.
  selectionStart: number | null = null
  selectionEnd: number | null = null
  focused = false
  private listeners = new Map<string, ((event: InputDomEvent) => void)[]>()

  constructor(tag: string, classes: string[] = []) {
    this.tag = tag
    this.classes = new Set(classes)
  }

  focus(): void {
    this.focused = true
  }

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start
    this.selectionEnd = end
  }

  add(child: FakeNode): FakeNode {
    child.parent = this
    this.children.push(child)
    return child
  }

  private matches(selector: string): boolean {
    if (selector.startsWith('.')) return this.classes.has(selector.slice(1))
    const attr = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/)
    if (attr) return attr[2] === undefined ? this.attrs.has(attr[1]!) : this.attrs.get(attr[1]!) === attr[2]
    return this.tag === selector
  }

  querySelector(selector: string): FakeNode | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child
      const nested = child.querySelector(selector)
      if (nested) return nested
    }
    return null
  }

  closest(selector: string): FakeNode | null {
    let node: FakeNode | undefined = this
    while (node) {
      if (node.matches(selector)) return node
      node = node.parent
    }
    return null
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null
  }

  addEventListener(type: InputDomEventType, handler: (event: InputDomEvent) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }

  /** Fire a delegated event on the container toward `target`. `extra` carries key/modifier/composition fields.
   * Returns true if a handler called preventDefault (the Enter-submits path stops the textarea's newline). */
  dispatch(type: InputDomEventType, target: FakeNode, extra: Partial<InputDomEvent> = {}): boolean {
    let defaultPrevented = false
    const event: InputDomEvent = { target, preventDefault: () => { defaultPrevented = true }, ...extra }
    for (const h of this.listeners.get(type) ?? []) h(event)
    return defaultPrevented
  }
}

interface Block {
  textarea: FakeNode
  file: FakeNode
  submit: FakeNode
}

/** Add the block subtree the pure renderer emits into `container` (re-injection regions start empty). */
const addBlock = (container: FakeNode): Block => {
  const block = container.add(new FakeNode('div', ['input-block']))
  block.attrs.set('data-target', 'chat')
  block.attrs.set('data-submit', '/chat')
  block.attrs.set('data-mode', 'both')
  block.add(new FakeNode('div', ['in-log']))
  block.add(new FakeNode('div', ['in-context']))
  const row = block.add(new FakeNode('div', ['in-row']))
  const textarea = row.add(new FakeNode('textarea', ['in-text']))
  const label = row.add(new FakeNode('label', ['in-drop']))
  const file = label.add(new FakeNode('input', ['in-file']))
  const submit = row.add(new FakeNode('button', ['mini', 'in-submit']))
  submit.attrs.set('data-verb', 'input-submit')
  block.add(new FakeNode('div', ['in-status']))
  return { textarea, file, submit }
}

/** Build the DOM the renderer emits (fresh each render — re-injection regions start empty). */
const buildContainer = (): { container: FakeNode; textarea: FakeNode; file: FakeNode; submit: FakeNode } => {
  const container = new FakeNode('div', ['hud'])
  const block = addBlock(container)
  return { container, ...block }
}

/**
 * Simulate a destructive `renderInto` on the SAME container the listeners live on: the container node
 * persists (the delegated listeners survive), but its children — including the focused textarea — are
 * replaced with a fresh subtree. Returns the fresh block, exactly as it is after the innerHTML swap.
 */
const wipe = (container: FakeNode): Block => {
  container.children = []
  return addBlock(container)
}

const reply = (answer: string, note = 'ok', citations: ChatReply['citations'] = []): ChatReply => ({
  answer,
  citations,
  budget: { contextTokens: 10, maxTokens: 512, turnsRemaining: 3, truncated: false, note },
})

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

test('a text submit posts the typed message, then paints both turns; a clean answer leaves the status calm', async () => {
  const calls: { message: string; pinId?: string; history: ChatTurn[] }[] = []
  const session = new InputSession({
    submit: async (input) => {
      calls.push({ message: input.message, ...(input.pinId !== undefined ? { pinId: input.pinId } : {}), history: input.history })
      return reply('the answer', '~3 useful turns left')
    },
    // the clean production case: the screen frame was captured fine, so there is no skip to disclose.
    captureScreen: async () => ({ ok: true, frame: { contentType: 'image/jpeg', data: 'aGk=' } }),
  })
  const { container, textarea, submit } = buildContainer()
  session.install(container)
  textarea.value = '  what is the topic?  '
  container.dispatch('click', submit)
  await flush()

  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.message, 'what is the topic?') // trimmed
  assert.equal(textarea.value, '') // cleared on submit
  const log = container.querySelector('.in-log')!.innerHTML
  assert.match(log, /You<\/span><span class="in-msg">what is the topic\?/)
  assert.match(log, /openinfo<\/span><span class="in-msg">the answer/)
  // hud-voice: a clean answer is its own feedback — the strip stays quiet (no raw budget/source dump).
  assert.equal(container.querySelector('.in-status')!.innerHTML, '')
})

test('a FAILED submit paints the reason as visible text (never a silent no-op)', async () => {
  const session = new InputSession({
    submit: async () => {
      throw new Error('no llm endpoint answered (fabric llm slot is empty)')
    },
  })
  const { container, textarea, submit } = buildContainer()
  session.install(container)
  textarea.value = 'hello'
  container.dispatch('click', submit)
  await flush()

  const status = container.querySelector('.in-status')!.innerHTML
  assert.match(status, /in-note error">no llm endpoint answered/)
  // the user turn is still shown; the assistant turn is NOT fabricated
  const log = container.querySelector('.in-log')!.innerHTML
  assert.match(log, /You<\/span><span class="in-msg">hello/)
  assert.doesNotMatch(log, /openinfo<\/span>/)
})

test('an empty send with NO screenshot available is an honest VISIBLE no-op (text, not a swallow)', async () => {
  let posted = false
  const session = new InputSession({ submit: async () => { posted = true; return reply('x') } })
  const { container, textarea, submit } = buildContainer()
  session.install(container)
  textarea.value = '   '
  container.dispatch('click', submit)
  await flush()
  assert.equal(posted, false)
  const status = container.querySelector('.in-status')!
  assert.match(status.innerHTML, /Nothing to ask/, 'the no-op is painted, never silent')
  assert.match(status.innerHTML, /screen capture needs the desktop app/, 'the WHY rides along')
})

test('a dropped file ingests via the injected upload, shows the attachment, and cites it on the next turn', async () => {
  const uploaded: UploadFile[] = []
  let pinSent: string | undefined
  const attached: AttachedDoc = { pinId: 'pin-1', title: 'paper.txt', summary: '3 pages ingested' }
  const session = new InputSession({
    submit: async (input) => {
      pinSent = input.pinId
      return reply('summarized', 'cited', [{ pinId: 'pin-1', ordinal: 0, page: 2, excerpt: 'x' }])
    },
    upload: async (file) => {
      uploaded.push(file)
      return attached
    },
  })
  const { container, textarea, file, submit } = buildContainer()
  session.install(container)
  file.files = { length: 1, item: () => ({ name: 'paper.txt', path: '/tmp/paper.txt' }) }
  container.dispatch('change', file)
  await flush()
  assert.equal(uploaded.length, 1)
  assert.match(container.querySelector('.in-context')!.innerHTML, /paper\.txt — 3 pages ingested/)

  textarea.value = 'summarize it'
  container.dispatch('click', submit)
  await flush()
  assert.equal(pinSent, 'pin-1') // the attached pin id rode the turn
  assert.match(container.querySelector('.in-log')!.innerHTML, /cited p\.2/)
})

test('the local path is resolved via the preload webUtils bridge (Electron 32+ removed File.path)', async () => {
  // The desktop shell's real DOM File no longer carries `.path` (removed in Electron 32; this repo ships
  // 38) — the path now comes from webUtils.getPathForFile, exposed on window.openinfoFiles by preload.cts.
  const g = globalThis as { openinfoFiles?: { getPathForFile(file: unknown): string } }
  const original = g.openinfoFiles
  const seen: unknown[] = []
  g.openinfoFiles = { getPathForFile: (file) => { seen.push(file); return '/Users/me/Documents/report.txt' } }
  try {
    const uploaded: UploadFile[] = []
    const session = new InputSession({
      submit: async () => reply('x'),
      upload: async (file) => { uploaded.push(file); return { pinId: 'pin-9', title: file.name, summary: '5 pages ingested' } },
    })
    const { container, file } = buildContainer()
    session.install(container)
    // A file WITHOUT `.path` — exactly what a real Electron 38 File looks like.
    file.files = { length: 1, item: () => ({ name: 'report.txt', type: 'text/plain' }) }
    container.dispatch('change', file)
    await flush()

    assert.equal(seen.length, 1) // the bridge was consulted
    assert.equal(uploaded.length, 1)
    assert.equal(uploaded[0]!.path, '/Users/me/Documents/report.txt') // the resolved OS path rode to ingest
    assert.equal(uploaded[0]!.name, 'report.txt')
    assert.match(container.querySelector('.in-context')!.innerHTML, /report\.txt — 5 pages ingested/)
  } finally {
    if (original === undefined) delete g.openinfoFiles
    else g.openinfoFiles = original
  }
})

test('a bridge path of "" (a File with no disk backing) yields a VISIBLE failure, never a silent no-op', async () => {
  // getPathForFile returns '' for a File built in JS with no file on disk — the attach must treat that as
  // "no path" and let the upload dep raise its honest reason as text (the QA doctrine), not swallow it.
  const g = globalThis as { openinfoFiles?: { getPathForFile(file: unknown): string } }
  const original = g.openinfoFiles
  g.openinfoFiles = { getPathForFile: () => '' }
  try {
    const session = new InputSession({
      submit: async () => reply('x'),
      // mirrors dev-entry's uploadAndIngest guard: no local path ⇒ honest rejection.
      upload: async (file) => {
        if (!file.path) throw new Error('file upload needs the desktop app (this file has no local path)')
        return { pinId: 'pin-x', title: file.name, summary: 'ok' }
      },
    })
    const { container, file } = buildContainer()
    session.install(container)
    file.files = { length: 1, item: () => ({ name: 'ghost.txt' }) }
    container.dispatch('change', file)
    await flush()

    assert.match(container.querySelector('.in-status')!.innerHTML, /in-note error">file upload needs the desktop app/)
    assert.equal(container.querySelector('.in-context')!.innerHTML, '') // nothing attached
  } finally {
    if (original === undefined) delete g.openinfoFiles
    else g.openinfoFiles = original
  }
})

test('with no preload bridge, a File-like carrying a path still attaches (the dev-harness / served-test fallback)', async () => {
  // A plain browser / served test has no window.openinfoFiles; a harness supplies the path on the File-like
  // directly, and the attach uses it unchanged — this is how the served driven e2e drives a real attach.
  const g = globalThis as { openinfoFiles?: { getPathForFile(file: unknown): string } }
  assert.equal(g.openinfoFiles, undefined) // no bridge in the headless test env
  const uploaded: UploadFile[] = []
  const session = new InputSession({
    submit: async () => reply('x'),
    upload: async (file) => { uploaded.push(file); return { pinId: 'pin-h', title: file.name, summary: '2 pages ingested' } },
  })
  const { container, file } = buildContainer()
  session.install(container)
  file.files = { length: 1, item: () => ({ name: 'harness.txt', path: '/tmp/harness.txt' }) }
  container.dispatch('change', file)
  await flush()

  assert.equal(uploaded.length, 1)
  assert.equal(uploaded[0]!.path, '/tmp/harness.txt')
})

test('an in-progress draft survives a destructive re-render (typing is never erased)', () => {
  const session = new InputSession({ submit: async () => reply('x') })
  const first = buildContainer()
  session.install(first.container)
  first.textarea.value = 'half a thought'
  first.container.dispatch('input', first.textarea) // user typing captured into the draft

  const second = buildContainer() // renderInto wiped the panel → a fresh empty textarea
  assert.equal(second.textarea.value, '')
  session.repaint(second.container)
  assert.equal(second.textarea.value, 'half a thought') // restored
})

test('repaint re-injects the conversation after a destructive re-render (state lives in the controller)', async () => {
  const session = new InputSession({ submit: async () => reply('kept') })
  const first = buildContainer()
  session.install(first.container)
  first.textarea.value = 'remember this'
  first.container.dispatch('click', first.submit)
  await flush()
  assert.match(first.container.querySelector('.in-log')!.innerHTML, /remember this/)

  // simulate renderInto replacing the panel: a brand-new empty tree, then repaint from controller state
  const second = buildContainer()
  assert.equal(second.container.querySelector('.in-log')!.innerHTML, '')
  session.repaint(second.container)
  assert.match(second.container.querySelector('.in-log')!.innerHTML, /remember this/)
  assert.match(second.container.querySelector('.in-log')!.innerHTML, /kept/)
})

test('Ask face: EVERY send captures one frame and ships it; a refused capture is disclosed beside the note', async () => {
  const sent: { screenshot?: unknown; turnId?: string }[] = []
  let captureCalls = 0
  const session = new InputSession({
    submit: async (input) => {
      sent.push({ screenshot: input.screenshot, ...(input.turnId !== undefined ? { turnId: input.turnId } : {}) })
      return reply('seen', 'Context: screen(1).')
    },
    captureScreen: async () => {
      captureCalls += 1
      return { ok: true, frame: { contentType: 'image/jpeg', data: 'aGVsbG8=' } }
    },
  })
  const { container, textarea, submit } = buildContainer()
  session.install(container)
  textarea.value = 'what am I looking at?'
  container.dispatch('click', submit)
  await flush()
  assert.equal(captureCalls, 1, 'exactly ONE frame per send — never ambient')
  assert.deepEqual(sent[0]!.screenshot, { contentType: 'image/jpeg', data: 'aGVsbG8=' })
  assert.match(sent[0]!.turnId ?? '', /^turn-/, 'the client mints the stream key')

  // A refused capture: the send still posts (frameless) and the WHY is disclosed with the note.
  const refusing = new InputSession({
    submit: async (input) => {
      sent.push({ screenshot: input.screenshot })
      return reply('answered anyway', 'Context: none. Omitted: screen (empty).')
    },
    captureScreen: async () => ({ ok: false, reason: 'screen capture is off (enable screenEnabled in client config)' }),
  })
  const second = buildContainer()
  refusing.install(second.container)
  second.textarea.value = 'and now?'
  second.container.dispatch('click', second.submit)
  await flush()
  assert.equal(sent[1]!.screenshot, undefined, 'no frame shipped')
  const status = second.container.querySelector('.in-status')!.innerHTML
  // hud-voice: the VISIBLE line is a calm human sentence about the user's world…
  assert.match(status, /Answered without your screen/, 'the degraded turn is named in human words')
  assert.match(status, /screen capture is off/, 'the client-side WHY rides along, in the visible line')
  // …and the raw machine disclosure ("Omitted: screen (empty)") moves behind inspection (a hover title).
  assert.match(status, /title="[^"]*Omitted: screen \(empty\)/, 'the machine note is reachable but not shown as slop')
})

test('Ask face: an EMPTY send with a frame becomes the default-ask DOCUMENT question (explain my screen)', async () => {
  const posted: { message: string; screenshot?: unknown }[] = []
  const session = new InputSession({
    submit: async (input) => {
      posted.push({ message: input.message, screenshot: input.screenshot })
      return reply('that is your invoice')
    },
    captureScreen: async () => ({ ok: true, frame: { contentType: 'image/jpeg', data: 'ZnJhbWU=' } }),
    defaultAsk: async () => 'Explain what is on my screen right now, briefly and in plain terms.',
  })
  const { container, textarea, submit } = buildContainer()
  session.install(container)
  textarea.value = ''
  container.dispatch('click', submit)
  await flush()
  assert.equal(posted.length, 1)
  assert.equal(posted[0]!.message, 'Explain what is on my screen right now, briefly and in plain terms.')
  assert.notEqual(posted[0]!.screenshot, undefined, 'the frame rides the default ask')
  const log = container.querySelector('.in-log')!
  assert.match(log.innerHTML, /Explain what is on my screen/, 'the resolved question is the visible user turn')

  // A failing default-ask read is a VISIBLE error (never a silent swallow).
  const failing = new InputSession({
    submit: async () => reply('x'),
    captureScreen: async () => ({ ok: true, frame: { contentType: 'image/jpeg', data: 'ZnJhbWU=' } }),
    defaultAsk: async () => { throw new Error('the default ask document could not be read (HTTP 404)') },
  })
  const second = buildContainer()
  failing.install(second.container)
  second.container.dispatch('click', second.submit)
  await flush()
  assert.match(second.container.querySelector('.in-status')!.innerHTML, /default ask document could not be read/)
})

test('Ask face: chat.delta frames for OUR in-flight turn paint progressively; the reply is the authoritative record', async () => {
  let releaseReply: (() => void) | undefined
  let capturedTurnId = ''
  const session = new InputSession({
    submit: async (input) => {
      capturedTurnId = input.turnId
      await new Promise<void>((resolve) => { releaseReply = resolve })
      return reply('Hello world.', 'done')
    },
  })
  const { container, textarea, submit } = buildContainer()
  session.install(container)
  textarea.value = 'hi'
  container.dispatch('click', submit)
  await flush()
  const log = container.querySelector('.in-log')!

  // Frames keyed to OUR turn append and paint as the provisional streaming turn.
  session.ingestDelta({ turnId: capturedTurnId, seq: 0, text: 'Hello ', done: false })
  assert.match(log.innerHTML, /in-turn assistant streaming/, 'a provisional streamed turn paints')
  assert.match(log.innerHTML, /Hello\s/, 'the first delta is visible before the reply resolves')
  // A duplicate/out-of-order seq is dropped; a foreign turn is ignored; malformed frames never throw.
  session.ingestDelta({ turnId: capturedTurnId, seq: 0, text: 'Hello ', done: false })
  session.ingestDelta({ turnId: 'turn-not-ours', seq: 1, text: 'INTRUDER', done: false })
  session.ingestDelta('garbage')
  session.ingestDelta({ turnId: capturedTurnId, seq: 1, text: 'world.', done: false })
  assert.match(log.innerHTML, /Hello world\./)
  assert.ok(!log.innerHTML.includes('INTRUDER'))
  assert.ok(!log.innerHTML.includes('Hello Hello'), 'the duplicate seq did not double-append')

  // The resolved reply replaces the provisional paint — one authoritative assistant turn, no streaming residue.
  releaseReply!()
  await flush()
  assert.ok(!log.innerHTML.includes('streaming'), 'the provisional turn is gone')
  assert.match(log.innerHTML, /Hello world\./, 'the authoritative answer stands')
})

test('Ask face: seedHistory renders the rehydrated thread once, discloses a truncated tail, never clobbers a live session', async () => {
  const session = new InputSession({ submit: async () => reply('x') })
  const { container } = buildContainer()
  session.install(container)
  session.seedHistory({ turns: [{ role: 'user', content: 'earlier question' }, { role: 'assistant', content: 'earlier answer' }], total: 12, truncated: true })
  const log = container.querySelector('.in-log')!
  assert.match(log.innerHTML, /earlier question/)
  assert.match(log.innerHTML, /earlier answer/)
  assert.match(log.innerHTML, /Showing the last 2 of 12 turns\./, 'the cap is disclosed, never silent')

  // A second (late) seed against a non-empty session is a no-op — a live conversation is never clobbered.
  session.seedHistory({ turns: [{ role: 'user', content: 'CLOBBER' }], total: 1, truncated: false })
  assert.ok(!log.innerHTML.includes('CLOBBER'))
})

// ── #222 chat-focus repair ──────────────────────────────────────────────────────────────────────────

test('#222: keyboard focus + caret survive a destructive live re-render (never "typing into nothing")', () => {
  // The rig bug: while typing, the ~1/s live refresh replaces the whole panel via renderInto, destroying the
  // focused textarea. Before the fix, repaint restored the DRAFT but not focus/caret — the user "typed into
  // nothing." This drives the REAL rerenderInto seam dev-entry now uses, over the SAME container the wipe
  // preserves. Without the captureFocus + focus/caret restore, the final three assertions fail.
  const session = new InputSession({ submit: async () => reply('x') })
  const { container } = buildContainer()
  session.install(container)
  const before = container.querySelector('.in-text')!
  container.dispatch('focusin', before) // the user is focused in the input
  before.value = 'hello world'
  container.dispatch('input', before) // typing captured into the draft
  before.selectionStart = 5
  before.selectionEnd = 5 // caret sits right after "hello"

  let after: FakeNode | undefined
  session.rerenderInto(container, () => {
    after = wipe(container).textarea // renderInto swaps in a brand-new, empty, unfocused textarea
  })

  assert.notEqual(after, before, 'the textarea node really was replaced (a true destructive re-render)')
  assert.equal(after!.value, 'hello world', 'the in-progress draft is restored')
  assert.equal(after!.focused, true, 'keyboard focus is restored to the fresh input — the refresh did not steal it')
  assert.equal(after!.selectionStart, 5, 'the caret position is restored')
  assert.equal(after!.selectionEnd, 5)
})

test('#222: a re-render when the input is NOT focused leaves focus alone (no focus stealing either way)', () => {
  const session = new InputSession({ submit: async () => reply('x') })
  const { container } = buildContainer()
  session.install(container)
  // never focused — a background refresh must not yank focus INTO the input.
  let after: FakeNode | undefined
  session.rerenderInto(container, () => {
    after = wipe(container).textarea
  })
  assert.equal(after!.focused, false, 'an unfocused input stays unfocused across a refresh')
})

test('#222: a destructive re-render is DEFERRED during IME composition, then flushed on compositionend', () => {
  // Replacing the textarea mid-composition would drop the IME buffer — so the wipe must not run while a
  // composition is in flight. The deferred refresh is flushed once composition ends.
  let renders = 0
  const session = new InputSession({ submit: async () => reply('x'), requestRender: () => { renders += 1 } })
  const { container } = buildContainer()
  const textarea = container.querySelector('.in-text')!
  session.install(container)
  container.dispatch('focusin', textarea)
  container.dispatch('compositionstart', textarea)
  assert.equal(session.isComposing(), true)

  let wiped = false
  session.rerenderInto(container, () => { wiped = true })
  assert.equal(wiped, false, 'the wipe was deferred — the composing node was NOT destroyed')
  assert.equal(renders, 0, 'no flush yet — composition is still in flight')

  container.dispatch('compositionend', textarea)
  assert.equal(session.isComposing(), false)
  assert.equal(renders, 1, 'compositionend flushed exactly the one deferred refresh')
})

test('#222: repaint does not overwrite the textarea value while a composition is in flight', () => {
  // A non-destructive repaint (e.g. a streamed chat delta) must not write .value mid-composition — that
  // would disrupt the live IME buffer. Once composition ends, the draft restore resumes normally.
  const session = new InputSession({ submit: async () => reply('x') })
  const { container } = buildContainer()
  const textarea = container.querySelector('.in-text')!
  session.install(container)
  textarea.value = 'earlier draft'
  container.dispatch('input', textarea) // draft = 'earlier draft'
  container.dispatch('compositionstart', textarea)
  textarea.value = 'mid-composition-buffer' // the IME owns the value now
  session.repaint(container)
  assert.equal(textarea.value, 'mid-composition-buffer', 'repaint left the composing value untouched')
  container.dispatch('compositionend', textarea)
})

test('#222: Enter submits, Shift+Enter inserts a newline, and Enter mid-composition never submits', async () => {
  const posted: string[] = []
  const session = new InputSession({ submit: async (input) => { posted.push(input.message); return reply('ok') } })
  const { container, textarea } = buildContainer()
  session.install(container)

  // Shift+Enter is a newline — no submit, and the default (newline insertion) is NOT prevented.
  textarea.value = 'line one'
  container.dispatch('input', textarea)
  const shiftPrevented = container.dispatch('keydown', textarea, { key: 'Enter', shiftKey: true })
  await flush()
  assert.equal(posted.length, 0, 'Shift+Enter does not submit')
  assert.equal(shiftPrevented, false, 'Shift+Enter keeps the default newline')

  // Enter WHILE composing confirms the IME candidate — it must not submit.
  container.dispatch('compositionstart', textarea)
  const composingPrevented = container.dispatch('keydown', textarea, { key: 'Enter', isComposing: true })
  await flush()
  assert.equal(posted.length, 0, 'Enter during composition confirms the candidate, never submits')
  assert.equal(composingPrevented, false, 'the composition Enter is left to the IME')
  container.dispatch('compositionend', textarea)

  // A plain Enter submits and prevents the newline.
  const enterPrevented = container.dispatch('keydown', textarea, { key: 'Enter' })
  await flush()
  assert.equal(enterPrevented, true, 'Enter prevents the textarea newline')
  assert.deepEqual(posted, ['line one'], 'Enter submits the typed message')
})

test('#222: Enter is scoped to the input — a keydown elsewhere is never captured', async () => {
  const posted: string[] = []
  const session = new InputSession({ submit: async (input) => { posted.push(input.message); return reply('ok') } })
  const { container, textarea, submit } = buildContainer()
  session.install(container)
  textarea.value = 'typed'
  container.dispatch('input', textarea)
  // Enter dispatched toward a NON-input element (e.g. a button) must not submit — no global key capture.
  container.dispatch('keydown', submit, { key: 'Enter' })
  await flush()
  assert.equal(posted.length, 0, 'Enter outside the chat input is ignored')
})

test('#222: calmChatStatus keeps the default calm and moves the machine note behind inspection', () => {
  // A clean answer → nothing visible (the answer is the feedback); the raw note is still available as detail.
  const clean = calmChatStatus(reply('a', 'Context: transcript(3 of 12, capped), screen(1). Omitted: pins (empty).'))
  assert.equal(clean.text, '', 'a clean answer shows no status text')
  assert.match(clean.detail, /Context: transcript/, 'the full machine disclosure is preserved for inspection')

  // A trimmed-context turn is named in human words, no source dump.
  const trimmed = calmChatStatus({ ...reply('a', 'Context: transcript(3 of 40, capped).'), budget: { ...reply('a').budget, truncated: true, note: 'Context: transcript(3 of 40, capped).' } })
  assert.match(trimmed.text, /trimmed view of the conversation/)
  assert.doesNotMatch(trimmed.text, /transcript|Context:|capped/, 'no machine-speak in the visible line')

  // A skipped screen is disclosed in human words; the machine note rides detail.
  const skipped = calmChatStatus(reply('a', 'Context: none.'), 'screen capture is off')
  assert.match(skipped.text, /Answered without your screen — screen capture is off/)
  assert.match(skipped.detail, /Screen skipped: screen capture is off/)
})
