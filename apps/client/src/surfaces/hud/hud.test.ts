import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BlockQuery, Moment, QueryResult, SenseLaneSnapshot, Session, Surface } from '@openinfo/contracts'
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
  liveSenses: SenseLaneSnapshot[] = []
  /** the surface document served — the test can swap it to simulate a /setup layout edit */
  surfaceDoc: Surface = surface
  private handler: ((event: { name: string; payload: unknown }) => void) | undefined
  surfaceCalls = 0
  queryCalls = 0
  lastQuerySurfaceId: string | undefined
  lastSurfaceId: string | undefined

  surface(id: string): Promise<Surface> {
    this.surfaceCalls += 1
    this.lastSurfaceId = id
    return Promise.resolve(this.surfaceDoc)
  }
  query(query: BlockQuery, surfaceId?: string): Promise<QueryResult> {
    this.queryCalls += 1
    this.lastQuerySurfaceId = surfaceId
    const items = query.source === 'moments' ? this.moments : query.source === 'live-senses' ? this.liveSenses : []
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

const senseSurface: Surface = {
  id: 'surf-openinfo-hud',
  name: 'openinfo HUD',
  context: 'meeting',
  version: 1,
  stack: [
    { block: 'now' },
    { block: 'sense-lanes', show: 'always', query: { source: 'live-senses', params: { session: 'current' } } },
  ],
}

const senseLane = <Source extends SenseLaneSnapshot['source']>(
  source: Source,
  over: Partial<Extract<SenseLaneSnapshot, { source: Source }>> = {},
): Extract<SenseLaneSnapshot, { source: Source }> => ({
  workspaceId: 'acme',
  sessionId: 'ses-live',
  source,
  disposition: 'waiting',
  health: 'healthy',
  reason: 'awaiting-capture',
  updatedAt: '2026-07-07T14:47:00Z',
  ...over,
}) as Extract<SenseLaneSnapshot, { source: Source }>

const hydratedSenses = (): SenseLaneSnapshot[] => [
  senseLane('mic'),
  senseLane('system-audio'),
  senseLane('screen'),
]

test('the HUD loads a surface, renders once, and re-queries on live WS events', async () => {
  const transport = new FakeTransport()
  let panel: VElement | undefined
  const hud = new Hud({ transport, onRender: (p) => { panel = p }, workspace: 'acme', now: () => new Date('2026-07-07T14:47:00Z') })

  await hud.start()
  // initial render: no live session → dead heartbeat, no moments, no Now line. With the engine's honest
  // display scope (#210) this is exactly the fresh-launch/stale-session state: GET /sessions?live returns []
  // and the `session: 'current'` moments query returns [], so the HUD shows no Now line and zero moment rows
  // — never a previous session's content rendered as current.
  assert.ok(panel)
  let html = renderToHtml(panel)
  assert.match(html, /class="livedot off"/)
  assert.doesNotMatch(html, /nowline/)
  assert.doesNotMatch(html, /class="mo"/) // no moment rows — honest empty, not stale content

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

// --- #174: live-sense payload cache ---------------------------------------------------------------

test('sense.lane.updated patches the hydrated source in canonical order and repaints with zero query calls', async () => {
  const transport = new FakeTransport()
  transport.surfaceDoc = senseSurface
  transport.live = [session()]
  transport.liveSenses = hydratedSenses()
  let panel: VElement | undefined
  let renders = 0
  const hud = new Hud({
    transport,
    onRender: (p) => { panel = p; renders += 1 },
    workspace: 'acme',
    now: () => new Date('2026-07-07T14:47:00Z'),
  })

  await hud.start()
  assert.equal(transport.queryCalls, 1, 'the authenticated initial query hydrates the lane cache once')
  assert.equal(transport.lastQuerySurfaceId, 'surf-openinfo-hud', 'hydration carries the app-instance surface binding')
  const initialRenders = renders

  transport.fire('sense.lane.updated', senseLane('screen', {
    disposition: 'delta-skipped',
    reason: 'delta-skipped',
    updatedAt: '2026-07-07T14:47:01Z',
    latestObservation: { id: 'obs-private', occurredAt: '2026-07-07T14:47:01Z', outcome: 'delta-skipped' },
  }))

  const html = renderToHtml(panel!)
  assert.equal(transport.queryCalls, 1, 'one payload update must never refetch /query')
  assert.equal(renders, initialRenders + 1, 'the accepted payload repaints synchronously')
  assert.match(html, /Screen · No screen change · Healthy/)
  assert.match(html, /No screen change observed 2:47p/)
  assert.doesNotMatch(html, /obs-private/)
  assert.ok(html.indexOf('Microphone') < html.indexOf('System audio'))
  assert.ok(html.indexOf('System audio') < html.indexOf('Screen'))

  // A reconnect remains an authoritative catch-up query for events missed while the socket was down.
  transport.liveSenses = [
    senseLane('mic', { disposition: 'processed', reason: 'processed', updatedAt: '2026-07-07T14:47:01Z' }),
    senseLane('system-audio'),
    senseLane('screen'),
  ]
  transport.fire('ws.open')
  await tick()
  assert.equal(transport.queryCalls, 2)
  assert.match(renderToHtml(panel!), /Microphone · Processed · Healthy/)

  // A session boundary invalidates the old hydrated scope before its catch-up query, so a late old-session
  // payload cannot repaint while the new session is loading.
  transport.live = [session({ id: 'ses-next' })]
  transport.liveSenses = [
    senseLane('mic', { sessionId: 'ses-next', disposition: 'queued', reason: 'awaiting-processing' }),
    senseLane('system-audio', { sessionId: 'ses-next' }),
    senseLane('screen', { sessionId: 'ses-next' }),
  ]
  transport.fire('session.started')
  transport.fire('sense.lane.updated', senseLane('mic', {
    disposition: 'failed',
    health: 'failed',
    reason: 'processing-failed',
    updatedAt: '2026-07-07T14:47:02Z',
  }))
  await tick()
  assert.equal(transport.queryCalls, 3)
  assert.match(renderToHtml(panel!), /Microphone · Queued · Healthy/)
  assert.doesNotMatch(renderToHtml(panel!), /Microphone · Failed/)
  hud.stop()
})

test('a surface-bound live-sense cache is event authority even when Hud constructor workspace stays default', async () => {
  const transport = new FakeTransport()
  transport.surfaceDoc = { ...senseSurface, workspaceId: 'bound-workspace' }
  transport.liveSenses = [
    senseLane('mic', { workspaceId: 'bound-workspace', sessionId: 'bound-session' }),
    senseLane('system-audio', { workspaceId: 'bound-workspace', sessionId: 'bound-session' }),
    senseLane('screen', { workspaceId: 'bound-workspace', sessionId: 'bound-session' }),
  ]
  let panel: VElement | undefined
  const hud = new Hud({ transport, onRender: (p) => { panel = p } })
  await hud.start()
  assert.equal(transport.queryCalls, 1)
  assert.equal(transport.lastQuerySurfaceId, 'surf-openinfo-hud')

  transport.fire('sense.lane.updated', senseLane('mic', {
    workspaceId: 'bound-workspace',
    sessionId: 'bound-session',
    disposition: 'processed',
    reason: 'processed',
    updatedAt: '2026-07-07T14:47:01Z',
  }))

  assert.equal(transport.queryCalls, 1, 'surface-bound event patching does not refetch')
  assert.match(renderToHtml(panel!), /Microphone · Processed · Healthy/)
  hud.stop()
})

test('a delayed older hydration response cannot overwrite a newer same-scope lane event', async () => {
  const transport = new FakeTransport()
  transport.surfaceDoc = senseSurface
  transport.live = [session()]
  transport.liveSenses = hydratedSenses()
  let panel: VElement | undefined
  const hud = new Hud({ transport, onRender: (p) => { panel = p }, workspace: 'acme' })
  await hud.start()

  const staleSnapshot: SenseLaneSnapshot[] = [
    senseLane('mic', { disposition: 'queued', reason: 'awaiting-processing', updatedAt: '2026-07-07T14:47:01Z' }),
    senseLane('system-audio'),
    senseLane('screen'),
  ]
  let release: (() => void) | undefined
  transport.query = (query, surfaceId) => {
    transport.queryCalls += 1
    transport.lastQuerySurfaceId = surfaceId
    return new Promise<QueryResult>((resolve) => {
      release = () => resolve({ source: query.source, items: staleSnapshot, truncated: false })
    })
  }

  transport.fire('ws.open')
  assert.equal(transport.queryCalls, 2, 'the catch-up hydration is now in flight')
  transport.fire('sense.lane.updated', senseLane('mic', {
    disposition: 'processed',
    reason: 'processed',
    updatedAt: '2026-07-07T14:47:02Z',
  }))
  assert.match(renderToHtml(panel!), /Microphone · Processed · Healthy/)

  release?.()
  await tick()
  assert.equal(transport.queryCalls, 2, 'reconciliation does not add a retry query')
  assert.match(renderToHtml(panel!), /Microphone · Processed · Healthy/)
  assert.doesNotMatch(renderToHtml(panel!), /Microphone · Queued/)
  hud.stop()
})

test('live-sense events reject cold, cross-scope, malformed, and widened payloads without repaint or refetch', async () => {
  const transport = new FakeTransport()
  transport.surfaceDoc = senseSurface
  transport.live = [session()]
  transport.liveSenses = hydratedSenses()
  let panel: VElement | undefined
  let renders = 0
  const hud = new Hud({ transport, onRender: (p) => { panel = p; renders += 1 }, workspace: 'acme' })
  await hud.start()
  const original = renderToHtml(panel!)
  const originalRenders = renders
  const originalQueries = transport.queryCalls

  const widened = {
    ...senseLane('mic', { disposition: 'processed', reason: 'processed' }),
    text: 'private transcript leak',
    endpoint: 'private-endpoint',
  }
  const nestedWidened = {
    ...senseLane('screen', {
      disposition: 'delta-skipped',
      reason: 'delta-skipped',
      latestObservation: { id: 'obs', occurredAt: '2026-07-07T14:47:01Z', outcome: 'delta-skipped' },
    }),
    latestObservation: {
      id: 'obs',
      occurredAt: '2026-07-07T14:47:01Z',
      outcome: 'delta-skipped',
      pixels: 'private-pixels',
    },
  }
  for (const payload of [
    senseLane('mic', { workspaceId: 'another-workspace' }),
    senseLane('mic', { sessionId: 'another-session' }),
    { ...senseLane('mic'), disposition: 'invented' },
    widened,
    nestedWidened,
  ]) transport.fire('sense.lane.updated', payload)

  assert.equal(transport.queryCalls, originalQueries)
  assert.equal(renders, originalRenders)
  assert.equal(renderToHtml(panel!), original)
  assert.doesNotMatch(renderToHtml(panel!), /private transcript|private-endpoint|private-pixels/)
  hud.stop()

  // A valid event cannot synthesize authority when initial hydration did not contain the canonical set.
  const cold = new FakeTransport()
  cold.surfaceDoc = senseSurface
  cold.live = [session()]
  let coldRenders = 0
  const coldHud = new Hud({ transport: cold, onRender: () => { coldRenders += 1 }, workspace: 'acme' })
  await coldHud.start()
  const beforeColdEvent = coldRenders
  cold.fire('sense.lane.updated', senseLane('mic', { disposition: 'processed', reason: 'processed' }))
  assert.equal(coldRenders, beforeColdEvent)
  assert.equal(cold.queryCalls, 1)
  coldHud.stop()
})

test('a sense-lanes block with top below 3 stays live per hydrated source and never grows an unhydrated one (#193)', async () => {
  const transport = new FakeTransport()
  transport.surfaceDoc = {
    ...senseSurface,
    stack: [
      { block: 'now' },
      { block: 'sense-lanes', show: 'always', top: 2, query: { source: 'live-senses', params: { session: 'current' }, top: 2 } },
    ],
  }
  transport.live = [session()]
  // The engine caps live-senses in canonical order, so top:2 hydrates mic + system-audio only.
  transport.liveSenses = [senseLane('mic'), senseLane('system-audio')]
  let panel: VElement | undefined
  let renders = 0
  const hud = new Hud({
    transport,
    onRender: (p) => { panel = p; renders += 1 },
    workspace: 'acme',
    now: () => new Date('2026-07-07T14:47:00Z'),
  })
  await hud.start()
  assert.equal(transport.queryCalls, 1)
  const initialRenders = renders

  // A payload for a HYDRATED source keeps the live fast path: repaint, zero re-query.
  transport.fire('sense.lane.updated', senseLane('system-audio', {
    disposition: 'processed',
    reason: 'processed',
    updatedAt: '2026-07-07T14:47:01Z',
  }))
  assert.equal(transport.queryCalls, 1, 'a sub-trio block must not degrade to coarse re-query updates')
  assert.equal(renders, initialRenders + 1, 'the accepted payload repaints synchronously')
  let html = renderToHtml(panel!)
  assert.match(html, /System audio · Processed · Healthy/)
  assert.doesNotMatch(html, /data-sense-source="screen"/, 'the configured-out lane paints no placeholder row')
  assert.doesNotMatch(html, /Status unavailable/)

  // A payload for the UNHYDRATED source is ignored: no repaint, no refetch, no invented row.
  transport.fire('sense.lane.updated', senseLane('screen', {
    disposition: 'delta-skipped',
    reason: 'delta-skipped',
    updatedAt: '2026-07-07T14:47:02Z',
    latestObservation: { id: 'obs-private', occurredAt: '2026-07-07T14:47:02Z', outcome: 'delta-skipped' },
  }))
  assert.equal(transport.queryCalls, 1)
  assert.equal(renders, initialRenders + 1)
  html = renderToHtml(panel!)
  assert.doesNotMatch(html, /data-sense-source="screen"|No screen change|obs-private/)
  hud.stop()
})

// --- #58: the event-fed live-transcript feed ---------------------------------------------------
const iso = (ms: number): string => new Date(ms).toISOString()

test('the HUD renders live-transcript lines from injected transcript.updated events with physical stream labels', async () => {
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
  assert.match(html, /class="lt-line mic"/)
  assert.match(html, /class="lt-line system"/)
  assert.match(html, /Microphone/)
  assert.match(html, /System audio/)
  assert.doesNotMatch(html, /mic · me|sys · them|class="lt-line (?:me|them)"|speaker/i)
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
  assert.match(stage.target.innerHTML, /System audio/)

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
