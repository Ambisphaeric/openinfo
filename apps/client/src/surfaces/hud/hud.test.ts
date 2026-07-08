import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BlockQuery, Moment, QueryResult, Session, Surface } from '@openinfo/contracts'
import { renderToHtml, type VElement } from '../block-renderer/index.js'
import { Hud } from './hud.js'
import type { HudTransport } from './transport.js'

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
