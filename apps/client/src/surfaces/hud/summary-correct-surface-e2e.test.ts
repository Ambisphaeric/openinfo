import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { Block, QueryResult, Summary, Surface } from '@openinfo/contracts'
import { renderSurface, renderToHtml, type NowContext, type VNode } from '../block-renderer/index.js'
import { defaultBlockRegistry } from '../blocks/index.js'
import { correctSummaryWrite } from './dev-entry.js'
import { SummaryEditSession, type SummaryDomEvent, type SummaryDomNode } from './summary-correct.js'

/**
 * #246 DRIVEN SERVED e2e — the correction affordance exercised end-to-end over a REAL HTTP write path, the
 * REAL SummaryEditSession controller, and the REAL summaries renderer. No route-test shortcut: this clicks
 * the pencil, types into the field, clicks Save, and asserts the corrected prose actually RENDERS; re-queries
 * and asserts it persists; and simulates a refused save and asserts an HONEST visible error line (the
 * Save-button lesson — a handler that fails must surface as text, with the raw reason on hover).
 *
 * The renderer is a pure vnode tree, so — as input-submit.test.ts does — this rebuilds the exact tree the
 * renderer emits into a tiny structural-DOM shim and drives the real controller over it (the container's
 * delegated listeners survive a re-render, exactly like the mount layer's). The engine is a minimal fake
 * HTTP server holding the summaries; the real engine's sovereignty/resolution is proven separately
 * (apps/engine summaries-correct.test.ts). Only the summary logic is faked — the client write path, the
 * controller, and the renderer are all real.
 */

// ── a tiny structural-DOM shim (mirrors input-submit.test.ts) ───────────────────────────────────────────
class FakeNode implements SummaryDomNode {
  tag: string
  classes: Set<string>
  attrs = new Map<string, string>()
  children: FakeNode[] = []
  parent: FakeNode | undefined
  value = ''
  textContent = ''
  title = ''
  selectionStart: number | null = null
  selectionEnd: number | null = null
  focused = false
  private listeners = new Map<string, ((event: SummaryDomEvent) => void)[]>()

  constructor(tag: string, classes: string[] = []) {
    this.tag = tag
    this.classes = new Set(classes)
  }

  get className(): string {
    return [...this.classes].join(' ')
  }
  set className(value: string) {
    this.classes = new Set(value.split(/\s+/).filter(Boolean))
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
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null
  }
  closest(selector: string): FakeNode | null {
    let node: FakeNode | undefined = this
    while (node) {
      if (node.matches(selector)) return node
      node = node.parent
    }
    return null
  }
  querySelector(selector: string): FakeNode | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child
      const nested = child.querySelector(selector)
      if (nested) return nested
    }
    return null
  }
  addEventListener(type: 'click' | 'input', handler: (event: SummaryDomEvent) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }
  dispatch(type: 'click' | 'input', target: FakeNode): void {
    const event: SummaryDomEvent = { target }
    for (const h of this.listeners.get(type) ?? []) h(event)
  }
}

/** Convert the renderer's vnode tree into the FakeNode subtree (children of `parent`), mirroring a real mount. */
const mountInto = (parent: FakeNode, node: VNode): void => {
  if (typeof node === 'string') {
    parent.textContent += node
    if (parent.tag === 'textarea') parent.value += node
    return
  }
  const classes = typeof node.attrs['class'] === 'string' ? (node.attrs['class'] as string).split(/\s+/).filter(Boolean) : []
  const el = new FakeNode(node.tag, classes)
  for (const [name, value] of Object.entries(node.attrs)) {
    if (name === 'class' || value === undefined || value === false) continue
    el.attrs.set(name, String(value))
  }
  parent.add(el)
  for (const child of node.children) mountInto(el, child)
  parent.textContent += el.textContent
}

// ── the minimal fake engine (only the summary logic is faked) ───────────────────────────────────────────
const machine: Summary = {
  id: 'sum-1', workspaceId: 'default', sessionId: 'ses', level: 'five-minute',
  windowStart: '2026-07-16T14:25:00Z', windowEnd: '2026-07-16T14:30:00Z',
  children: [{ record: 'summary', id: 'r-1', at: '2026-07-16T14:25:00Z', role: 'child', level: 'rolling' }],
  bound: { childrenAvailable: 1, childrenConsumed: 1, evidenceAvailable: 0, evidenceConsumed: 0 },
  text: 'the team maybe ships next week', proposal: true, confidence: 0.6,
  provenance: { builder: 'bounded-hierarchical-summary', windowMs: 300_000, childLevel: 'rolling', templateId: 'tpl-summary-five-minute', slot: 'llm', endpoint: 'llm.fast' },
  revision: 1, schemaVersion: 1, createdAt: '2026-07-16T14:30:00Z',
}

/** A fake engine: GET /summaries returns the resolved head (a user correction outranks the machine row). */
const startFakeEngine = async (opts: { failCorrect?: boolean } = {}): Promise<{ server: Server; url: string; rows: () => Summary[] }> => {
  const rows: Summary[] = [{ ...machine }]
  const server = createServer((req, res) => {
    const bufs: Buffer[] = []
    req.on('data', (c: Buffer) => bufs.push(c))
    req.on('end', () => {
      if (req.method === 'GET' && req.url?.startsWith('/summaries')) {
        const correction = [...rows].reverse().find((r) => r.source === 'user')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(correction ? [correction] : rows.filter((r) => r.source !== 'user')))
        return
      }
      if (req.method === 'POST' && req.url === '/summaries/correct') {
        if (opts.failCorrect) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'summary store write failed (disk full)' }))
          return
        }
        const body = JSON.parse(Buffer.concat(bufs).toString('utf8')) as { summaryId: string; text: string }
        const correction: Summary = {
          ...machine, id: `sum-user-${rows.length}`, text: body.text, proposal: false, source: 'user',
          correction: { at: '2026-07-16T14:31:00Z' }, corrects: body.summaryId, confidence: 1,
          provenance: { builder: 'bounded-hierarchical-summary', windowMs: 300_000, childLevel: 'rolling', templateId: 'tpl-summary-five-minute' },
          createdAt: '2026-07-16T14:31:00Z',
        }
        rows.push(correction)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(correction))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}`, rows: () => rows }
}

const now: NowContext = { live: true, workspace: 'acme' }
const surface: Surface = {
  id: 'surf-openinfo-hud', name: 'HUD', context: 'meeting', version: 1,
  stack: [{ block: 'summaries', show: 'always', query: { source: 'summaries', params: { session: 'current', level: 'five-minute' } }, actions: [{ id: 'a-copy', label: 'Copy', verb: 'copy', params: {} }] } as Block],
}

/** Drive the real controller + real renderer against the fake engine, and hand back the harness. */
const harness = async (opts: { failCorrect?: boolean } = {}) => {
  const engine = await startFakeEngine(opts)
  let summaries: Summary[] = (await (await fetch(`${engine.url}/summaries`)).json()) as Summary[]
  const container = new FakeNode('root', ['hud'])
  const controller = new SummaryEditSession({
    correct: correctSummaryWrite(engine.url),
    requestRender: () => render(),
    refresh: async () => {
      summaries = (await (await fetch(`${engine.url}/summaries`)).json()) as Summary[]
      render()
    },
  })
  let html = ''
  const render = (): void => {
    const result: QueryResult = { source: 'summaries', items: summaries, truncated: false }
    const editingId = controller.editingId()
    const vnode = renderSurface({ surface, now, results: [result], summaryEdit: editingId !== undefined ? { editing: editingId } : {} }, defaultBlockRegistry)
    html = renderToHtml(vnode)
    container.children = [] // the container node persists (listeners survive), its children are replaced
    for (const child of vnode.children) mountInto(container, child)
    controller.repaint(container)
  }
  controller.install(container)
  render()
  return { engine, container, controller, render, html: () => html }
}

test('e2e (#246): click the pencil, type, save — the corrected prose renders, persists on re-query, and marks the row as your edit', async () => {
  const h = await harness()
  try {
    // The read row shows the model draft + the pencil affordance (the surface supports correction).
    assert.match(h.html(), /the team maybe ships next week/)
    assert.match(h.html(), /data-verb="summary-edit"/) // the pencil is present
    assert.doesNotMatch(h.html(), /<textarea/) // not yet editing

    // Click the pencil → the row swaps to the inline editor, prefilled with the current prose.
    h.container.dispatch('click', h.container.querySelector('[data-verb="summary-edit"]')!)
    assert.match(h.html(), /<textarea[^>]*class="sum-edit-text"/)
    assert.match(h.html(), /data-verb="summary-correct"/) // Save is live
    const textarea = h.container.querySelector('.sum-edit-text')!
    assert.equal(textarea.value, 'the team maybe ships next week') // prefilled with the current text

    // Type a correction and Save.
    textarea.value = 'the team ships Thursday; Dana owns the deck'
    h.container.dispatch('input', textarea)
    h.container.dispatch('click', h.container.querySelector('[data-verb="summary-correct"]')!)
    await new Promise((r) => setTimeout(r, 20)) // let the POST + re-hydrate settle

    // The corrected prose RENDERS as the live row, marked honestly as the user's own edit, editor closed.
    assert.match(h.html(), /the team ships Thursday; Dana owns the deck/)
    assert.match(h.html(), /edited by you/) // the honest correction marker
    assert.doesNotMatch(h.html(), /<textarea/) // the editor closed
    assert.doesNotMatch(h.html(), /the team maybe ships next week/) // the draft is superseded on read
    // Copy stays value-only — it now carries the CORRECTED bare text.
    assert.match(h.html(), /data-copy="the team ships Thursday; Dana owns the deck"/)

    // PERSISTS: a fresh re-query of the served engine returns the correction as the head.
    const reread = (await (await fetch(`${h.engine.url}/summaries`)).json()) as Summary[]
    assert.equal(reread.length, 1)
    assert.equal(reread[0]!.source, 'user')
    assert.equal(reread[0]!.text, 'the team ships Thursday; Dana owns the deck')
  } finally {
    await new Promise<void>((resolve) => h.engine.server.close(() => resolve()))
  }
})

test('e2e (#246): a REFUSED save surfaces an honest visible error line — never a silent no-op — with the raw reason on hover', async () => {
  const h = await harness({ failCorrect: true })
  try {
    h.container.dispatch('click', h.container.querySelector('[data-verb="summary-edit"]')!)
    const textarea = h.container.querySelector('.sum-edit-text')!
    textarea.value = 'a correction the engine will refuse'
    h.container.dispatch('input', textarea)
    h.container.dispatch('click', h.container.querySelector('[data-verb="summary-correct"]')!)
    await new Promise((r) => setTimeout(r, 20))

    // VISIBLE FAILURE: a calm human line in the status region, the editor stays open (nothing lost).
    const status = h.container.querySelector('.sum-status')!
    assert.match(status.textContent, /Couldn’t save your correction — the engine returned an error\./)
    assert.ok(status.classes.has('err'))
    // The raw reason is reachable on hover (detail-on-inspection), never painted as glance slop.
    assert.match(status.title, /disk full/)
    // The editor is still open with the typed text intact — the failure did not discard the correction.
    assert.equal(h.container.querySelector('.sum-edit-text')!.value, 'a correction the engine will refuse')
  } finally {
    await new Promise<void>((resolve) => h.engine.server.close(() => resolve()))
  }
})
