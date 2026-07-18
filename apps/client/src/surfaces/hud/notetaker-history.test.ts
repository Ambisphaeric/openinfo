import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BlockQuery, Moment, QueryResult, Session, Summary, Surface } from '@openinfo/contracts'
import { mountSurface, renderInto, type ActionHandlers, type MountTarget, type VElement } from '../block-renderer/index.js'
import { defaultBlockRegistry } from '../blocks/index.js'
import { Hud } from './hud.js'
import type { HudTransport } from './transport.js'
import { renderNotetaker } from './notetaker-layout.js'
import { NotetakerView } from './notetaker-view.js'

/**
 * #247 note-taker session-history DRILL-DOWN, driven end-to-end through the REAL client machinery — the Hud
 * controller, the real Hud.mapQuery seam, the real renderNotetaker + NotetakerView, and the real mount-layer
 * click delegation (mount.ts wireActions). No hand-rolled stubs of the mechanism: a synthesized click on the
 * ACTUAL rendered `session-open` button flows through the actual delegated listener → the actual handler →
 * the view-state → a real re-query (mapQuery rewrites the center to the past session) → a real re-render. So
 * a regression in ANY of those links breaks this test. It is the in-gate proof for the served behavior the
 * Electron dev-hud harness (scripts/notetaker-history-e2e.mjs) exercises against a real DOM.
 */

process.env.TZ = 'UTC'

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), '../../../../..', 'templates/openinfo-notetaker/surface.json')
const loadNotetaker = async (): Promise<Surface> => JSON.parse(await readFile(TEMPLATE, 'utf8')) as Surface

const LIVE_ID = 'ses-live'
const PAST_ID = 'ses-past'

const liveSession: Session = {
  id: LIVE_ID, workspaceId: 'default', modeId: 'mode-meeting', startedAt: '2026-07-16T14:00:00Z',
  title: 'Live standup', attribution: { evidence: [], confidence: 1 },
} as unknown as Session
const pastSession: Session = {
  id: PAST_ID, workspaceId: 'default', modeId: 'mode-meeting', startedAt: '2026-07-10T09:00:00Z', endedAt: '2026-07-10T09:31:00Z',
  title: 'Q3 renewal — security review', attribution: { evidence: [], confidence: 1 },
} as unknown as Session

const moment = (id: string, sessionId: string, text: string, at: string): Moment =>
  ({ id, sessionId, workspaceId: 'default', at, kind: 'decision', text, refs: [], source: 'mic', confidence: 0.9 }) as unknown as Moment
const summary = (id: string, sessionId: string, level: Summary['level'], text: string): Summary =>
  ({
    id, workspaceId: 'default', sessionId, level, windowStart: '2026-07-10T09:00:00Z', windowEnd: '2026-07-10T09:05:00Z',
    text, proposal: true, children: [], provenance: { slot: 'llm', endpoint: 'this-mac', model: 'qwen2.5-7b' },
    schemaVersion: 1, createdAt: '2026-07-10T09:05:01Z',
  }) as unknown as Summary

const LIVE_MOMENT = 'Live: shipping the beta today'
const PAST_MOMENT = 'Past: agreed to renew for a year'
const PAST_SESSION_SUMMARY = 'they agreed the one-year renewal'

/** A transport that answers session-scoped queries keyed by the resolved `session` param, like the engine. */
class FakeTransport implements HudTransport {
  surfaceDoc!: Surface
  queries: BlockQuery[] = []
  /** flip to simulate a past-session detail query that comes back empty (a failed/quiet session). */
  pastEmpty = false

  surface(): Promise<Surface> {
    return Promise.resolve(this.surfaceDoc)
  }
  query(query: BlockQuery): Promise<QueryResult> {
    this.queries.push(query)
    const sess = query.params['session']
    const items = ((): unknown[] => {
      if (query.source === 'sessions') return [liveSession, pastSession]
      if (query.source === 'moments') {
        if (sess === 'current') return [moment('m-live', LIVE_ID, LIVE_MOMENT, '2026-07-16T14:02:00Z')]
        if (sess === PAST_ID) return this.pastEmpty ? [] : [moment('m-past', PAST_ID, PAST_MOMENT, '2026-07-10T09:03:00Z')]
        return []
      }
      if (query.source === 'summaries') {
        const level = query.params['level'] as Summary['level'] | undefined
        if (sess === PAST_ID && !this.pastEmpty) return [summary(`s-${level}`, PAST_ID, level ?? 'session', PAST_SESSION_SUMMARY)]
        if (sess === 'current') return [] // the live pad has no summary yet in this fixture
        return []
      }
      return []
    })()
    return Promise.resolve({ source: query.source, items, truncated: false })
  }
  sessions(): Promise<Session[]> {
    return Promise.resolve([liveSession])
  }
  subscribe(): () => void {
    return () => {}
  }
}

/** The clicked-element shape the mount layer reads (structurally the mount.ts ActionElement). */
type ClickEl = { getAttribute(name: string): string | null; textContent: string; className: string }
type ClickHandler = (event: { target: { closest(selector: string): ClickEl | null } | null }) => void

/** A minimal MountTarget that captures the delegated click listener so the test can dispatch a real click. */
class FakeDom implements MountTarget {
  innerHTML = ''
  private click: ClickHandler | undefined
  addEventListener(_type: 'click', handler: ClickHandler): void {
    this.click = handler
  }
  /** Find the rendered `<button data-verb=verb>` (optionally the one for a given session) and dispatch it. */
  clickVerb(verb: string, dataSession?: string): boolean {
    const pattern = dataSession
      ? `<button ([^>]*data-verb="${verb}"[^>]*data-session="${dataSession}"[^>]*)>`
      : `<button ([^>]*data-verb="${verb}"[^>]*)>`
    const match = this.innerHTML.match(new RegExp(pattern))
    if (!match) return false
    const attrs = match[1]!
    const el: ClickEl = {
      getAttribute: (name: string): string | null => {
        const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`))
        return m ? m[1]! : null
      },
      textContent: '',
      className: '',
    }
    this.click?.({ target: { closest: () => el } })
    return true
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))

/** Build a live Hud + notetaker view + fake DOM, wired exactly as dev-entry does, and start it. */
const boot = async (transport: FakeTransport): Promise<{ dom: FakeDom; view: NotetakerView; transport: FakeTransport }> => {
  const dom = new FakeDom()
  let mounted = false
  const hud: { current?: Hud } = {}
  const view = new NotetakerView(() => void hud.current!.refresh())
  const handlers: ActionHandlers = {
    copy: () => undefined,
    sessionOpen: (payload) => view.open(payload),
    sessionBack: () => view.backToLive(),
  }
  hud.current = new Hud({
    transport,
    surfaceId: 'surf-openinfo-notetaker',
    mapQuery: view.mapQuery,
    renderSurface: (input, registry) => renderNotetaker(input, registry, view.selection()),
    onRender: (node: VElement) => {
      if (!mounted) {
        mountSurface(dom, node, handlers)
        mounted = true
      } else {
        renderInto(dom, node)
      }
    },
  })
  await hud.current.start()
  await tick()
  return { dom, view, transport }
}

const centerOf = (html: string): string => {
  const m = html.match(/<div class="nt-center">([\s\S]*?)<div class="nt-right">/)
  return m ? m[1]! : ''
}

test('#247 driven: clicking a past-session row shows THAT session in the center; back-to-live returns', async () => {
  const transport = new FakeTransport()
  transport.surfaceDoc = await loadNotetaker()
  const { dom } = await boot(transport)

  // Live pad first: the center shows the LIVE session's moment, no past header, the history row is clickable.
  assert.match(centerOf(dom.innerHTML), new RegExp(LIVE_MOMENT))
  assert.doesNotMatch(centerOf(dom.innerHTML), /Past session/)
  assert.match(dom.innerHTML, /data-verb="session-open" data-session="ses-past"/)

  // CLICK the past-session row through the REAL delegated listener → view.open → re-query → re-render.
  assert.ok(dom.clickVerb('session-open', PAST_ID), 'the past-session row button was rendered and clickable')
  await tick()

  const center = centerOf(dom.innerHTML)
  // the center now shows the PAST session's record — its summary + its moment — NOT the live one's.
  assert.match(center, /Past session/)
  assert.match(center, /Q3 renewal — security review/) // the past session named in the header
  assert.match(center, new RegExp(PAST_MOMENT))
  assert.match(center, new RegExp(PAST_SESSION_SUMMARY))
  assert.doesNotMatch(center, new RegExp(LIVE_MOMENT)) // the live moment is gone from the center
  assert.match(center, /data-verb="session-back"/) // the always-visible back-to-live control
  // the center re-queried the moments source against the PAST id (the mapQuery drill-down actually ran)
  assert.ok(transport.queries.some((q) => q.source === 'moments' && q.params['session'] === PAST_ID), 'center moments re-queried for the past session')

  // CLICK back-to-live → the live current-session view returns.
  assert.ok(dom.clickVerb('session-back'))
  await tick()
  const back = centerOf(dom.innerHTML)
  assert.doesNotMatch(back, /Past session/)
  assert.match(back, new RegExp(LIVE_MOMENT))
  assert.doesNotMatch(back, /data-verb="session-back"/)
})

test('#247 driven: a past session whose detail query returns nothing surfaces honest text, never a blank', async () => {
  const transport = new FakeTransport()
  transport.surfaceDoc = await loadNotetaker()
  transport.pastEmpty = true
  const { dom } = await boot(transport)

  assert.ok(dom.clickVerb('session-open', PAST_ID))
  await tick()
  const center = centerOf(dom.innerHTML)
  assert.match(center, /Past session/) // still named + navigable…
  assert.match(center, /Nothing was captured in this session\./) // …and honest, never a blank center
  assert.match(center, /data-verb="session-back"/) // back-to-live is always reachable
})
