import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatReply, ChatTurn } from '@openinfo/contracts'
import { InputSession, type AttachedDoc, type InputDomNode, type UploadFile } from './input-submit.js'

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
  private listeners = new Map<string, ((event: { target: InputDomNode | null }) => void)[]>()

  constructor(tag: string, classes: string[] = []) {
    this.tag = tag
    this.classes = new Set(classes)
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

  addEventListener(type: 'click' | 'change' | 'input', handler: (event: { target: InputDomNode | null }) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }

  dispatch(type: 'click' | 'change' | 'input', target: FakeNode): void {
    for (const h of this.listeners.get(type) ?? []) h({ target })
  }
}

/** Build the DOM the renderer emits (fresh each render — re-injection regions start empty). */
const buildContainer = (): { container: FakeNode; textarea: FakeNode; file: FakeNode; submit: FakeNode } => {
  const container = new FakeNode('div', ['hud'])
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
  return { container, textarea, file, submit }
}

const reply = (answer: string, note = 'ok', citations: ChatReply['citations'] = []): ChatReply => ({
  answer,
  citations,
  budget: { contextTokens: 10, maxTokens: 512, turnsRemaining: 3, truncated: false, note },
})

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

test('a text submit posts the typed message, then paints both turns and the budget note', async () => {
  const calls: { message: string; pinId?: string; history: ChatTurn[] }[] = []
  const session = new InputSession({
    submit: async (input) => {
      calls.push({ message: input.message, ...(input.pinId !== undefined ? { pinId: input.pinId } : {}), history: input.history })
      return reply('the answer', '~3 useful turns left')
    },
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
  assert.match(container.querySelector('.in-status')!.innerHTML, /in-note ok">~3 useful turns left/)
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

test('an empty message is ignored (no post)', async () => {
  let posted = false
  const session = new InputSession({ submit: async () => { posted = true; return reply('x') } })
  const { container, textarea, submit } = buildContainer()
  session.install(container)
  textarea.value = '   '
  container.dispatch('click', submit)
  await flush()
  assert.equal(posted, false)
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
