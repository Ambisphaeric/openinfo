import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Fabric, FabricProfile } from '@openinfo/contracts'
import { editorHtml, rowTemplateHtml, type SetupData } from './view.js'
import { SETUP_SCRIPT } from './assets.js'

/**
 * END-TO-END save/delete regression for the engine-served settings editor. Route tests alone missed the
 * silent-Save bug because the break was in the BROWSER path: the served `#base-fabric` JSON blob was
 * html-escaped (`{&quot;…`), and a <script> is raw text, so `JSON.parse(textContent)` threw BEFORE the
 * save fetch — no request, no error, a silent no-op. These tests execute the SERVED SETUP_SCRIPT (not a
 * reimplementation) against a minimal DOM shim built by parsing the SERVED editorHtml/rowTemplateHtml,
 * then drive the real click handler and assert the real fetch body — so this class of bug surfaces here.
 *
 * The shim is intentionally tiny: it implements only what the save/delete/add-row path touches (a small
 * HTML parser with the browser's raw-text-<script> vs entity-decoded-attribute distinction — the exact
 * fidelity the bug lived in — plus querySelector/closest, dataset, form-control .value, and a document
 * click dispatch). No heavy dep; runs under `node --test`.
 */

// --- entity decode (attributes + text; NEVER applied to <script> raw content) ---------------------
const decodeEntities = (s: string): string =>
  s.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_m, e) =>
    e === 'amp' ? '&' : e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : "'",
  )

// --- the minimal DOM ------------------------------------------------------------------------------
const VOID = new Set(['input', 'meta', 'br', 'img', 'hr'])

interface Attr {
  name: string
  value: string
}
interface Compound {
  tag?: string
  id?: string
  classes: string[]
  attrs: { name: string; value?: string }[]
}

class DomNode {
  tag: string
  attrs = new Map<string, string>()
  children: DomNode[] = []
  parent: DomNode | null = null
  /** text data for '#text' nodes */
  data = ''
  /** <template>'s inert content fragment */
  content: DomNode | null = null
  /** form-control live value (inputs); selects compute from options */
  private _value: string | undefined
  readonly dataset: Record<string, string | undefined>

  constructor(tag: string) {
    this.tag = tag
    const self = this
    this.dataset = new Proxy(
      {},
      {
        get: (_t, prop: string) => self.attrs.get('data-' + camelToKebab(prop)),
        set: (_t, prop: string, val: string) => {
          self.attrs.set('data-' + camelToKebab(prop), String(val))
          return true
        },
      },
    ) as Record<string, string | undefined>
  }

  get tagName(): string {
    return this.tag.toUpperCase()
  }

  get className(): string {
    return this.attrs.get('class') ?? ''
  }
  set className(v: string) {
    this.attrs.set('class', v)
  }

  get classList() {
    const self = this
    const list = () => (self.className ? self.className.split(/\s+/).filter(Boolean) : [])
    return {
      contains: (c: string) => list().includes(c),
      add: (c: string) => {
        const l = list()
        if (!l.includes(c)) {
          l.push(c)
          self.className = l.join(' ')
        }
      },
      remove: (c: string) => {
        self.className = list()
          .filter((x) => x !== c)
          .join(' ')
      },
    }
  }

  get value(): string {
    if (this.tag === 'select') {
      const opts = this.querySelectorAll('option')
      const sel = opts.find((o) => o.attrs.has('selected'))
      const pick = sel ?? opts[0]
      return pick ? (pick.attrs.get('value') ?? '') : ''
    }
    return this._value ?? this.attrs.get('value') ?? ''
  }
  set value(v: string) {
    this._value = v
  }

  get textContent(): string {
    if (this.tag === '#text') return this.data
    return this.children.map((c) => c.textContent).join('')
  }
  set textContent(v: string) {
    const t = new DomNode('#text')
    t.data = v
    t.parent = this
    this.children = [t]
  }

  get childElementNodes(): DomNode[] {
    return this.children.filter((c) => c.tag !== '#text')
  }
  get previousElementSibling(): DomNode | null {
    if (!this.parent) return null
    const sibs = this.parent.childElementNodes
    const i = sibs.indexOf(this)
    return i > 0 ? sibs[i - 1]! : null
  }
  get nextElementSibling(): DomNode | null {
    if (!this.parent) return null
    const sibs = this.parent.childElementNodes
    const i = sibs.indexOf(this)
    return i >= 0 && i < sibs.length - 1 ? sibs[i + 1]! : null
  }
  get parentNode(): DomNode | null {
    return this.parent
  }

  appendChild(node: DomNode): void {
    // Appending a fragment moves its children (DOM semantics), matching addRow's template clone.
    if (node.tag === '#fragment') {
      for (const c of [...node.children]) this.appendChild(c)
      return
    }
    node.parent = this
    this.children.push(node)
  }

  remove(): void {
    if (!this.parent) return
    const i = this.parent.children.indexOf(this)
    if (i >= 0) this.parent.children.splice(i, 1)
    this.parent = null
  }

  insertBefore(node: DomNode, ref: DomNode): void {
    const i = this.children.indexOf(ref)
    node.parent = this
    if (i < 0) this.children.push(node)
    else this.children.splice(i, 0, node)
  }

  cloneNode(_deep: boolean): DomNode {
    const copy = new DomNode(this.tag)
    copy.attrs = new Map(this.attrs)
    copy.data = this.data
    copy._value = this._value
    if (this.content) copy.content = this.content.cloneNode(true)
    for (const c of this.children) copy.appendChild(c.cloneNode(true))
    return copy
  }

  matches(compound: Compound): boolean {
    if (this.tag === '#text' || this.tag === '#fragment') return false
    if (compound.tag && this.tag !== compound.tag) return false
    if (compound.id && this.attrs.get('id') !== compound.id) return false
    for (const c of compound.classes) if (!this.classList.contains(c)) return false
    for (const a of compound.attrs) {
      if (!this.attrs.has(a.name)) return false
      if (a.value !== undefined && this.attrs.get(a.name) !== a.value) return false
    }
    return true
  }

  private descendants(): DomNode[] {
    const out: DomNode[] = []
    const walk = (n: DomNode) => {
      for (const c of n.children) {
        if (c.tag === '#text') continue
        out.push(c)
        walk(c)
      }
    }
    walk(this)
    return out
  }

  querySelectorAll(selector: string): DomNode[] {
    const chain = parseSelector(selector)
    const last = chain[chain.length - 1]!
    const candidates = this.descendants().filter((n) => n.matches(last))
    if (chain.length === 1) return candidates
    // Descendant combinator: verify the preceding compounds match some ancestor chain (right-to-left).
    return candidates.filter((n) => {
      let idx = chain.length - 2
      let cur: DomNode | null = n.parent
      while (cur && idx >= 0) {
        if (cur.matches(chain[idx]!)) idx--
        cur = cur.parent
      }
      return idx < 0
    })
  }

  querySelector(selector: string): DomNode | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  closest(selector: string): DomNode | null {
    const compound = parseSelector(selector)[0]!
    let cur: DomNode | null = this
    while (cur) {
      if (cur.matches(compound)) return cur
      cur = cur.parent
    }
    return null
  }
}

const camelToKebab = (s: string): string => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())

const parseSelector = (selector: string): Compound[] =>
  selector
    .trim()
    .split(/\s+/)
    .map((part): Compound => {
      const compound: Compound = { classes: [], attrs: [] }
      const re = /([.#]?[a-zA-Z][\w-]*)|\[([\w-]+)(?:=["']([^"']*)["'])?\]/g
      let m: RegExpExecArray | null
      while ((m = re.exec(part)) !== null) {
        if (m[1]) {
          if (m[1].startsWith('.')) compound.classes.push(m[1].slice(1))
          else if (m[1].startsWith('#')) compound.id = m[1].slice(1)
          else compound.tag = m[1]
        } else if (m[2]) {
          compound.attrs.push(m[3] !== undefined ? { name: m[2], value: m[3] } : { name: m[2] })
        }
      }
      return compound
    })

// --- a tiny HTML parser: raw-text <script>, template.content, entity-decoded attrs ----------------
const parseHtml = (html: string): DomNode => {
  const root = new DomNode('#root')
  const stack: DomNode[] = [root]
  let i = 0
  const top = () => stack[stack.length - 1]!
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt === -1) {
      appendText(top(), html.slice(i))
      break
    }
    if (lt > i) appendText(top(), html.slice(i, lt))
    if (html.startsWith('</', lt)) {
      const gt = html.indexOf('>', lt)
      const tag = html.slice(lt + 2, gt).trim().toLowerCase()
      // pop to the matching open tag
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s]!.tag === tag) {
          stack.length = s
          break
        }
      }
      i = gt + 1
      continue
    }
    // open tag
    const gt = html.indexOf('>', lt)
    const rawTag = html.slice(lt + 1, gt)
    const selfClose = rawTag.endsWith('/')
    const { tag, attrs } = parseTag(selfClose ? rawTag.slice(0, -1) : rawTag)
    const el = new DomNode(tag)
    for (const a of attrs) el.attrs.set(a.name, decodeEntities(a.value))
    if (tag === 'input' && el.attrs.has('value')) el.value = el.attrs.get('value')!
    top().appendChild(el)
    i = gt + 1
    if (tag === 'script' || tag === 'style') {
      // raw text: content is NOT entity-decoded (the crux of the bug)
      const close = html.indexOf('</' + tag, i)
      const raw = html.slice(i, close)
      if (raw.length) {
        const t = new DomNode('#text')
        t.data = raw
        el.appendChild(t)
      }
      i = html.indexOf('>', close) + 1
      continue
    }
    if (tag === 'template') {
      // children go into an inert content fragment, not the main tree
      const frag = new DomNode('#fragment')
      el.content = frag
      stack.push(frag)
      continue
    }
    if (!VOID.has(tag) && !selfClose) stack.push(el)
  }
  return root
}

const appendText = (parent: DomNode, raw: string): void => {
  if (raw === '') return
  const t = new DomNode('#text')
  t.data = decodeEntities(raw)
  parent.appendChild(t)
}

const parseTag = (raw: string): { tag: string; attrs: Attr[] } => {
  const trimmed = raw.trim()
  const sp = trimmed.search(/\s/)
  const tag = (sp === -1 ? trimmed : trimmed.slice(0, sp)).toLowerCase()
  const attrs: Attr[] = []
  if (sp !== -1) {
    const rest = trimmed.slice(sp)
    const re = /([\w-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'))?/g
    let m: RegExpExecArray | null
    while ((m = re.exec(rest)) !== null) {
      if (!m[1]) continue
      const value = m[3] ?? m[4] ?? ''
      attrs.push({ name: m[1], value })
    }
  }
  return { tag, attrs }
}

// --- a document that runs the SERVED script -------------------------------------------------------
interface FetchCall {
  method: string
  path: string
  body: unknown
}

interface Harness {
  root: DomNode
  fetchCalls: FetchCall[]
  reloaded: boolean
  getElementById(id: string): DomNode | null
  click(el: DomNode): void
  setFetchResult(fn: (call: FetchCall) => { ok: boolean; status: number; json: unknown } | 'reject'): void
}

const buildHarness = (bodyHtml: string): Harness => {
  const root = parseHtml(bodyHtml)
  const clickListeners: Array<(e: unknown) => void> = []
  const fetchCalls: FetchCall[] = []
  const state = { reloaded: false }
  let fetchResult: (call: FetchCall) => { ok: boolean; status: number; json: unknown } | 'reject' = () => ({
    ok: true,
    status: 200,
    json: {},
  })

  const findById = (id: string): DomNode | null => {
    const stack = [root]
    while (stack.length) {
      const n = stack.pop()!
      if (n.attrs.get('id') === id) return n
      for (const c of n.children) if (c.tag !== '#text') stack.push(c)
    }
    return null
  }

  const documentStub = {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      if (type === 'click') clickListeners.push(fn)
    },
    getElementById: (id: string) => findById(id),
    querySelector: (s: string) => root.querySelector(s),
    querySelectorAll: (s: string) => root.querySelectorAll(s),
    createElement: (tag: string) => new DomNode(tag),
    createTextNode: (data: string) => {
      const t = new DomNode('#text')
      t.data = data
      return t
    },
  }

  const fetchStub = (path: string, init?: { method?: string; body?: string }) => {
    const call: FetchCall = {
      method: init?.method ?? 'GET',
      path,
      body: init?.body !== undefined ? JSON.parse(init.body) : undefined,
    }
    fetchCalls.push(call)
    const r = fetchResult(call)
    if (r === 'reject') return Promise.reject(new Error('network down'))
    return Promise.resolve({ ok: r.ok, status: r.status, json: () => Promise.resolve(r.json) })
  }

  const locationStub = {
    reload: () => {
      state.reloaded = true
    },
    protocol: 'http:',
    host: 'localhost',
    href: '',
  }

  // Execute the SERVED script (an IIFE) with our stubs injected as its free globals — not a copy of it.
  const run = new Function('document', 'fetch', 'location', 'alert', 'window', SETUP_SCRIPT)
  run(documentStub, fetchStub, locationStub, () => {}, {})

  return {
    root,
    fetchCalls,
    get reloaded() {
      return state.reloaded
    },
    getElementById: findById,
    click: (el: DomNode) => {
      const evt = { target: el, preventDefault: () => {} }
      for (const fn of clickListeners) fn(evt)
    },
    setFetchResult: (fn) => {
      fetchResult = fn
    },
  } as Harness
}

// --- fixtures -------------------------------------------------------------------------------------
const emptySlots = (): Fabric['slots'] => ({ stt: [], tts: [], llm: [], vlm: [], ocr: [], embed: [] })

const profileWithLlm = (): FabricProfile => ({
  id: 'remote-http',
  name: 'Remote HTTP',
  version: 2,
  fabric: {
    slots: { ...emptySlots(), llm: [{ kind: 'http', name: 'my-endpoint', url: 'http://localhost:8000', api: 'openai-compat' }] },
  },
})

const data = (editing: FabricProfile): SetupData => ({
  profiles: [editing],
  activeId: undefined,
  liveFabric: { slots: emptySlots() },
  editing,
  secretRefs: ['remote-key'],
})

/** The served editor body the browser receives: the editor fragment + the add-row template. */
const editorPage = (d: SetupData): string => editorHtml(d) + rowTemplateHtml(d.secretRefs)

const addFreshRow = (h: Harness, slot: string): DomNode => {
  const addBtn = h.root.querySelector('.slot[data-slot="' + slot + '"] button[data-act="addrow"]')!
  h.click(addBtn)
  const rows = h.root.querySelectorAll('.slot[data-slot="' + slot + '"] .row')
  return rows[rows.length - 1]!
}

// --- the regressions ------------------------------------------------------------------------------
const flush = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve))

test('existing-row edit persists: the Save fetch fires with the edited endpoint', async () => {
  const h = buildHarness(editorPage(data(profileWithLlm())))
  // edit the seeded row's port 8000 -> 9001
  const row = h.root.querySelector('.slot[data-slot="llm"] .row')!
  row.querySelector('.f-port')!.value = '9001'
  h.click(h.getElementById('editor')!.querySelector('button[data-act="save"]')!)

  assert.equal(h.fetchCalls.length, 1, 'exactly one save request fired (not a silent no-op)')
  const call = h.fetchCalls[0]!
  assert.equal(call.method, 'PUT')
  assert.equal(call.path, '/fabric/profiles/remote-http')
  const body = call.body as FabricProfile
  assert.deepEqual(body.fabric.slots.llm, [
    { kind: 'http', name: 'my-endpoint', url: 'http://localhost:9001', api: 'openai-compat' },
  ])
  await flush()
  assert.equal(h.reloaded, true, 'a successful save reloads to reflect server state')
})

test('fresh-row save persists: a newly added row is composed and sent', () => {
  const h = buildHarness(editorPage(data(profileWithLlm())))
  const fresh = addFreshRow(h, 'llm')
  fresh.querySelector('.f-name')!.value = 'fresh'
  fresh.querySelector('.f-host')!.value = '127.0.0.1'
  fresh.querySelector('.f-port')!.value = '1234'
  h.click(h.getElementById('editor')!.querySelector('button[data-act="save"]')!)

  assert.equal(h.fetchCalls.length, 1)
  const body = h.fetchCalls[0]!.body as FabricProfile
  assert.deepEqual(body.fabric.slots.llm, [
    { kind: 'http', name: 'my-endpoint', url: 'http://localhost:8000', api: 'openai-compat' },
    { kind: 'http', name: 'fresh', url: 'http://127.0.0.1:1234', api: 'openai-compat' },
  ])
})

test('blank-row delete survives save: remove drops the row and the save omits it', () => {
  const h = buildHarness(editorPage(data(profileWithLlm())))
  const fresh = addFreshRow(h, 'llm')
  // the fresh row is blank; its ✕ removes it
  h.click(fresh.querySelector('button[data-act="remove"]')!)
  assert.equal(h.root.querySelectorAll('.slot[data-slot="llm"] .row').length, 1, 'the blank row is gone from the DOM')
  h.click(h.getElementById('editor')!.querySelector('button[data-act="save"]')!)

  assert.equal(h.fetchCalls.length, 1)
  const body = h.fetchCalls[0]!.body as FabricProfile
  // only the original endpoint remains; the removed blank row is not persisted
  assert.equal(body.fabric.slots.llm.length, 1)
  assert.equal(body.fabric.slots.llm[0]!.name, 'my-endpoint')
})

test('a blank row left in place is filtered out of the save (never persisted)', () => {
  const h = buildHarness(editorPage(data(profileWithLlm())))
  addFreshRow(h, 'llm') // left blank, NOT removed
  h.click(h.getElementById('editor')!.querySelector('button[data-act="save"]')!)
  const body = h.fetchCalls[0]!.body as FabricProfile
  assert.equal(body.fabric.slots.llm.length, 1, 'a blank (urlless) row is dropped on save')
})

test('a save failure surfaces as visible text near the button — never a silent no-op', async () => {
  const h = buildHarness(editorPage(data(profileWithLlm())))
  h.setFetchResult(() => ({ ok: false, status: 500, json: { error: 'boom' } }))
  h.click(h.getElementById('editor')!.querySelector('button[data-act="save"]')!)
  // fetch fired, then the strip carries the reason (the honesty net)
  assert.equal(h.fetchCalls.length, 1)
  await flush()
  const strip = h.getElementById('save-error')!
  assert.match(strip.textContent, /save failed/)
  assert.match(strip.textContent, /500/)
  assert.match(strip.textContent, /boom/)
  assert.ok(strip.classList.contains('bad'))
  assert.equal(h.reloaded, false, 'a failed save does not reload')
})

test('a rejected save fetch also surfaces text (not a swallowed rejection)', async () => {
  const h = buildHarness(editorPage(data(profileWithLlm())))
  h.setFetchResult(() => 'reject')
  h.click(h.getElementById('editor')!.querySelector('button[data-act="save"]')!)
  await flush()
  const strip = h.getElementById('save-error')!
  assert.match(strip.textContent, /save failed/)
})

test('GUARD: the served base-fabric blob is verbatim JSON, not html-escaped (the root-cause guard)', () => {
  // The bug was `escapeHtml(JSON.stringify(fabric))` inside a raw-text <script>. A browser does not decode
  // entities there, so JSON.parse(textContent) threw before the fetch. This asserts the served blob parses.
  const h = buildHarness(editorPage(data(profileWithLlm())))
  const blob = h.getElementById('base-fabric')!.textContent
  assert.doesNotThrow(() => JSON.parse(blob), 'base-fabric must be JSON.parse-able as served')
  assert.ok(!blob.includes('&quot;'), 'base-fabric must not be html-escaped')
})
