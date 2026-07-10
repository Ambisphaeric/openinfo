import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BlockQuery, Moment, QueryResult, Session, Surface } from '@openinfo/contracts'
import { renderToHtml, mountSurface, renderInto, type VElement, type MountTarget } from '../block-renderer/index.js'
import { Hud } from './hud.js'
import type { HudTransport } from './transport.js'

// clockLabel (via the session status line) renders viewer-local; pin this process to UTC so the elapsed
// clock assertion below is host-stable.
process.env.TZ = 'UTC'

const surface: Surface = {
  id: 'surf-openinfo-hud', name: 'openinfo HUD', context: 'meeting', version: 1,
  stack: [
    { block: 'now' },
    { block: 'relevant-now', top: 4, query: { source: 'relevant-now', params: { session: 'current' }, top: 4 } },
    { block: 'moments', query: { source: 'moments', params: { session: 'current' } } },
  ],
}

/** A controllable in-memory transport: the test mutates its data, then fires WS events. */
class FakeTransport implements HudTransport {
  live: Session[] = []
  moments: Moment[] = []
  /** the surface document served — the test can swap it to simulate a /setup layout edit */
  surfaceDoc: Surface = surface
  private handler: ((event: { name: string; payload: unknown }) => void) | undefined
  surfaceCalls = 0
  lastSurfaceId: string | undefined

  surface(id: string): Promise<Surface> {
    this.surfaceCalls += 1
    this.lastSurfaceId = id
    return Promise.resolve(this.surfaceDoc)
  }
  query(query: BlockQuery): Promise<QueryResult> {
    const items = query.source === 'moments' ? this.moments : []
    return Promise.resolve({ source: query.source, items, truncated: false })
  }
  sessions(): Promise<Session[]> {
    return Promise.resolve(this.live)
  }
  subscribe(handler: (event: { name: string; payload: unknown }) => void): () => void {
    this.handler = handler
    return () => {
      this.handler = undefined
    }
  }
  fire(name: string, payload: unknown = {}): void {
    this.handler?.({ name, payload })
  }
}

const session = (over: Partial<Session> = {}): Session => ({
  id: 'ses-live', workspaceId: 'acme', modeId: 'mode-meeting', startedAt: '2026-07-07T14:16:00Z', title: 'Renewal',
  attribution: { evidence: [{ kind: 'manual', detail: 'x', weight: 1 }], confidence: 1 }, ...over,
})
const moment = (text: string, at: string): Moment => ({
  id: `mom-${text}`, sessionId: 'ses-live', workspaceId: 'acme', at, kind: 'commitment', text, refs: [], source: 'mic', confidence: 0.8,
})
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))

test('the HUD loads a surface, renders once, and re-queries on live WS events', async () => {
  const transport = new FakeTransport()
  let panel: VElement | undefined
  const hud = new Hud({ transport, onRender: (p) => { panel = p }, workspace: 'acme', now: () => new Date('2026-07-07T14:47:00Z') })

  await hud.start()
  // initial render: no live session → dead heartbeat, no moments, no Now line
  assert.ok(panel)
  let html = renderToHtml(panel)
  assert.match(html, /class="livedot off"/)
  assert.doesNotMatch(html, /nowline/)

  // a session starts and a commitment is extracted; the engine emits WS events → HUD re-queries
  transport.live = [session()]
  transport.moments = [moment('written answer to Dana by Thursday', '2026-07-07T14:44:00Z')]
  transport.fire('session.started')
  transport.fire('moment.created')
  await tick()

  html = renderToHtml(panel)
  assert.match(html, /class="livedot"/) // now live
  assert.match(html, /class="ws">acme \//)
  assert.match(html, /Renewal/)
  assert.match(html, /2:16p · 31m/) // elapsed off the injected clock
  assert.match(html, /class="nowline">Now: <b>written answer to Dana by Thursday<\/b>/) // topic = latest moment
  assert.match(html, /class="g mk c">●/)
  // surface document fetched exactly once — live updates re-hydrate queries, not the layout
  assert.equal(transport.surfaceCalls, 1)

  // ending the session drops the heartbeat
  transport.live = [session({ endedAt: '2026-07-07T14:50:00Z' })]
  transport.fire('session.ended')
  await tick()
  assert.match(renderToHtml(panel), /class="livedot off"/)

  hud.stop()
})

test('the HUD renders the configured surface id (client config / ?surface=)', async () => {
  const transport = new FakeTransport()
  const hud = new Hud({ transport, onRender: () => undefined, surfaceId: 'surf-glass-minimal' })
  await hud.start()
  assert.equal(transport.lastSurfaceId, 'surf-glass-minimal')
  hud.stop()
})

test('the HUD hot-reloads when surface.updated arrives for ITS surface id', async () => {
  const transport = new FakeTransport()
  transport.live = [session()]
  transport.moments = [moment('written answer to Dana', '2026-07-07T14:44:00Z')]
  let panel: VElement | undefined
  const hud = new Hud({ transport, onRender: (p) => { panel = p }, workspace: 'acme', now: () => new Date('2026-07-07T14:47:00Z') })

  await hud.start()
  assert.equal(transport.surfaceCalls, 1)
  assert.equal(transport.lastSurfaceId, 'surf-openinfo-hud')
  assert.match(renderToHtml(panel!), /class="g mk c">●/) // the moments block renders the commitment

  // a /setup edit removes the moments block; the engine emits surface.updated for this surface
  transport.surfaceDoc = { ...surface, version: 2, stack: surface.stack.filter((b) => b.block !== 'moments') }
  transport.fire('surface.updated', { id: 'surf-openinfo-hud' })
  await tick()

  assert.equal(transport.surfaceCalls, 2) // the document was refetched, not just re-hydrated
  assert.doesNotMatch(renderToHtml(panel!), /class="g mk c">●/) // the moments block is gone from the layout
  hud.stop()
})

test('surface.updated for a DIFFERENT surface id is ignored', async () => {
  const transport = new FakeTransport()
  const hud = new Hud({ transport, onRender: () => undefined, workspace: 'acme' })
  await hud.start()
  assert.equal(transport.surfaceCalls, 1)
  transport.fire('surface.updated', { id: 'surf-someone-else' })
  await tick()
  assert.equal(transport.surfaceCalls, 1) // not refetched — the HUD renders exactly one surface
  hud.stop()
})

test('irrelevant events do not trigger a refresh; a burst coalesces', async () => {
  const transport = new FakeTransport()
  let renders = 0
  const hud = new Hud({ transport, onRender: () => { renders += 1 }, workspace: 'acme' })
  await hud.start()
  assert.equal(renders, 1) // the initial render

  transport.fire('queue.updated') // not in REFRESH_EVENTS → no re-render
  await tick()
  assert.equal(renders, 1)

  transport.fire('moment.created')
  transport.fire('entity.updated')
  transport.fire('distillate.updated')
  await tick()
  // a burst produces at least one and at most a small number of refreshes (coalesced), never one-per-event stampede
  assert.ok(renders >= 2 && renders <= 4)
  hud.stop()
})

test("'ws.open' (a transport (re)connect) re-hydrates data missed while disconnected", async () => {
  const transport = new FakeTransport()
  let renders = 0
  const hud = new Hud({ transport, onRender: () => { renders += 1 }, workspace: 'acme' })
  await hud.start()
  assert.equal(renders, 1)

  // the engine restarted: events were missed; the fresh socket synthesizes ws.open → one catch-up refresh
  transport.live = [session()]
  transport.fire('ws.open')
  await tick()
  assert.equal(renders, 2)
  hud.stop()
})

// --- #58: the event-fed live-transcript feed ---------------------------------------------------
const iso = (ms: number): string => new Date(ms).toISOString()

test('the HUD renders live-transcript lines from injected transcript.updated events (raw feed, me/them split)', async () => {
  const transport = new FakeTransport()
  transport.live = [session()]
  let panel: VElement | undefined
  const t0 = Date.parse('2026-07-07T14:47:00Z')
  const hud = new Hud({ transport, onRender: (p) => { panel = p }, workspace: 'acme', now: () => new Date(t0) })
  await hud.start()

  // a transcript.updated (payload-fed, NOT a query refresh) renders a line immediately — no re-query
  transport.fire('transcript.updated', { sessionId: 'ses-live', source: 'mic', text: 'we should ship Thursday', capturedAtRange: { start: iso(t0 - 2000), end: iso(t0 - 1000) } })
  transport.fire('transcript.updated', { sessionId: 'ses-live', source: 'system-audio', text: 'agreed', capturedAtRange: { start: iso(t0 - 500), end: iso(t0) } })

  const html = renderToHtml(panel!)
  assert.match(html, /data-live-transcript/)
  assert.match(html, /Live transcript · raw, not saved/) // honestly labeled as raw/live, distinct from distilled
  assert.match(html, /class="lt-line me"/) // mic → me
  assert.match(html, /class="lt-line them"/) // system-audio → them
  assert.match(html, /mic · me/) // #96: each fragment carries its SOURCE-STREAM label (inspector idiom)
  assert.match(html, /sys · them/)
  assert.match(html, /we should ship Thursday/)
  assert.match(html, /agreed/)
  // payload feed did NOT trigger the query path (the coalescing discipline): surface fetched once
  assert.equal(transport.surfaceCalls, 1)
  hud.stop()
})

test('the live feed expires lines older than the ~45s window', async () => {
  const transport = new FakeTransport()
  transport.live = [session()]
  let panel: VElement | undefined
  let nowMs = Date.parse('2026-07-07T14:47:00Z')
  const hud = new Hud({ transport, onRender: (p) => { panel = p }, workspace: 'acme', now: () => new Date(nowMs) })
  await hud.start()

  transport.fire('transcript.updated', { sessionId: 'ses-live', source: 'mic', text: 'old line', capturedAtRange: { start: iso(nowMs - 1000), end: iso(nowMs) } })
  assert.match(renderToHtml(panel!), /old line/)

  // advance the clock past the window, then a new line arrives → the stale line is pruned on repaint
  nowMs += 50_000
  transport.fire('transcript.updated', { sessionId: 'ses-live', source: 'mic', text: 'fresh line', capturedAtRange: { start: iso(nowMs - 1000), end: iso(nowMs) } })
  const html = renderToHtml(panel!)
  assert.doesNotMatch(html, /old line/) // dropped: older than ~45s
  assert.match(html, /fresh line/)
  hud.stop()
})

test('a live session with no words shows an explainable empty state; idle-with-no-lines shows no feed', async () => {
  const transport = new FakeTransport()
  let panel: VElement | undefined
  const hud = new Hud({ transport, onRender: (p) => { panel = p }, workspace: 'acme' })

  // no live session and no transcript → no dead chrome
  await hud.start()
  assert.doesNotMatch(renderToHtml(panel!), /data-live-transcript/)

  // a live session with no words yet → the feed explains itself rather than looking broken
  transport.live = [session()]
  transport.fire('session.started')
  await tick()
  const html = renderToHtml(panel!)
  assert.match(html, /data-live-transcript/)
  assert.match(html, /listening/)
  hud.stop()
})

test('starting/ending a session resets the live transcript buffer', async () => {
  const transport = new FakeTransport()
  transport.live = [session()]
  let panel: VElement | undefined
  const hud = new Hud({ transport, onRender: (p) => { panel = p }, workspace: 'acme', now: () => new Date('2026-07-07T14:47:00Z') })
  await hud.start()

  transport.fire('transcript.updated', { sessionId: 'ses-live', source: 'mic', text: 'from the old session', capturedAtRange: { start: '2026-07-07T14:46:59Z', end: '2026-07-07T14:47:00Z' } })
  assert.match(renderToHtml(panel!), /from the old session/)

  transport.fire('session.ended')
  await tick()
  assert.doesNotMatch(renderToHtml(panel!), /from the old session/) // the feed cleared on the boundary
  hud.stop()
})

// --- #96: system-stream mute, DRIVEN through the real mount/wireActions seam (the QA rule) ---------
/**
 * A stage that captures the single delegated click listener mountSurface installs and lets the test
 * dispatch a click at a `data-verb` button — the same pattern copy-feedback.test.ts uses, so this drives
 * the REAL seam (Hud state → render → mount delegation → wireActions verb), not just the markup.
 */
const makeStage = (): { target: MountTarget; click: (verb: string) => void } => {
  let handler: ((event: { target: { closest(sel: string): { getAttribute(n: string): string | null } | null } | null }) => void) | undefined
  const target = { innerHTML: '', addEventListener: (_t: 'click', h: typeof handler) => { handler = h } }
  return {
    target: target as unknown as MountTarget,
    click: (verb) => handler?.({ target: { closest: () => ({ getAttribute: (n) => (n === 'data-verb' ? verb : null) }) } }),
  }
}

test('the system-stream mute toggle hides system audio from the strip without disabling capture (driven click)', async () => {
  const transport = new FakeTransport()
  transport.live = [session()]
  const t0 = Date.parse('2026-07-07T14:47:00Z')
  const stage = makeStage()
  let mounted = false
  const hud = new Hud({
    transport,
    workspace: 'acme',
    now: () => new Date(t0),
    onRender: (node) => {
      if (!mounted) { mountSurface(stage.target, node, { copy: () => undefined, muteSystemStream: () => hud.toggleSystemStream() }); mounted = true }
      else renderInto(stage.target, node)
    },
  })
  await hud.start()

  transport.fire('transcript.updated', { sessionId: 'ses-live', source: 'mic', text: 'lets ship it', capturedAtRange: { start: iso(t0 - 2000), end: iso(t0 - 1000) } })
  transport.fire('transcript.updated', { sessionId: 'ses-live', source: 'system-audio', text: 'BREAKING NEWS tonight', capturedAtRange: { start: iso(t0 - 500), end: iso(t0) } })
  // both streams present and attributed — the interleave the owner saw, but each fragment is labelled
  assert.match(stage.target.innerHTML, /lets ship it/)
  assert.match(stage.target.innerHTML, /BREAKING NEWS tonight/)
  assert.match(stage.target.innerHTML, /sys · them/)

  // drive the ACTUAL mute click through the delegated listener the mount installed
  stage.click('mute-system-stream')
  assert.match(stage.target.innerHTML, /lets ship it/) // mic stream stays
  assert.doesNotMatch(stage.target.innerHTML, /BREAKING NEWS tonight/) // system audio hidden — the blend is gone
  assert.match(stage.target.innerHTML, /system audio hidden · 1 line not shown \(still captured\)/) // honest, not silent

  // capture was NOT disabled — the line is still buffered; un-muting brings it right back
  stage.click('mute-system-stream')
  assert.match(stage.target.innerHTML, /BREAKING NEWS tonight/)
  hud.stop()
})

test('an event-driven refresh failure routes to onError — never an unhandled rejection', async () => {
  const transport = new FakeTransport()
  const errors: unknown[] = []
  const hud = new Hud({ transport, onRender: () => undefined, workspace: 'acme', onError: (e) => errors.push(e) })
  await hud.start()

  // the engine vanishes: sessions() rejects during a WS-triggered refresh
  transport.sessions = () => Promise.reject(new Error('engine gone'))
  transport.fire('moment.created')
  await tick()
  assert.equal(errors.length, 1)
  assert.match(String(errors[0]), /engine gone/)

  // a surface reload failure routes the same way
  transport.surface = () => Promise.reject(new Error('surface gone'))
  transport.fire('surface.updated', { id: 'surf-openinfo-hud' })
  await tick()
  assert.equal(errors.length, 2)
  assert.match(String(errors[1]), /surface gone/)
  hud.stop()
})
