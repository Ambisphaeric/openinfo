import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { QueryResult, Session, Surface } from '@openinfo/contracts'
import { renderSurface, renderToHtml, type NowContext } from '../block-renderer/index.js'
import { defaultBlockRegistry } from './index.js'

// clockLabel/dateLabel render viewer-local; pin this process to UTC so wall-clock assertions are host-stable.
process.env.TZ = 'UTC'

const now: NowContext = { live: true, workspace: 'acme', title: 'Renewal — security review' }
const result = (items: unknown[], truncated = false): QueryResult => ({ source: 'sessions', items, truncated })

const session = (over: Partial<Session> = {}): Session => ({
  id: 'ses-1', workspaceId: 'default', modeId: 'mode-meeting',
  startedAt: '2026-07-10T14:00:00Z', endedAt: '2026-07-10T14:42:00Z',
  title: 'Q3 renewal — security review',
  attribution: { evidence: [], confidence: 1 },
  ...over,
})

const surface = (top?: number): Surface => ({
  id: 's', name: 's', context: 'meeting', version: 2,
  stack: [{ block: 'sessions', id: 'nt-left-sessions', show: 'always', ...(top !== undefined ? { top } : {}), query: { source: 'sessions', params: {}, top: 24 } }],
})

const render = (items: unknown[], truncated = false, top?: number): string =>
  renderToHtml(renderSurface({ surface: top !== undefined ? surface(top) : surface(), now, results: [result(items, truncated)] }, defaultBlockRegistry))

test('the sessions block renders a history row: derived title, start time, and a calm status — no raw ids', () => {
  const html = render([session()])
  assert.match(html, /Sessions/) // the self-labeling block group header (realizes the old folders)
  assert.match(html, /Q3 renewal — security review/) // the resolved title
  assert.match(html, /2:00p/) // the start time (viewer-local clock; UTC-pinned here)
  assert.match(html, /Jul 10 · 42m/) // date + ended duration in the why line
  assert.doesNotMatch(html, />ses-1</) // NEVER a raw session id in HUMAN-VISIBLE text (hud-voice §2)…
  // …but the row IS a clickable nav control (#247) carrying the id/title/start time in DATA attributes only,
  // dispatching the wired `session-open` verb — a live affordance, not a dead one.
  assert.match(html, /<button class="rel sess-nav" data-verb="session-open" data-session="ses-1"/)
  assert.match(html, /data-session-title="Q3 renewal — security review"/)
  assert.match(html, /data-session-started="2026-07-10T14:00:00Z"/)
})

test('the empty + overflow notes stay PLAIN — there is nothing to open, so no fake click target', () => {
  assert.doesNotMatch(render([]), /<button/) // empty state: no session to navigate to
  const many = Array.from({ length: 8 }, (_, i) => session({ id: `ses-${i}`, title: `Session ${i}` }))
  const html = render(many, false, 6)
  // the "N more" note is a plain div row (the earlier sessions are disclosed, not individually openable here)
  assert.match(html, /<div class="rel"><span class="mk t">⋯<\/span>/)
  assert.match(html, /2 earlier sessions in history/)
})

test('a live (unended) session reads "in progress", never a fabricated end', () => {
  const { endedAt: _endedAt, ...live } = session() // omit endedAt (exactOptionalPropertyTypes: no `undefined`)
  const html = render([live])
  assert.match(html, /in progress/)
  assert.doesNotMatch(html, /42m/)
})

test('an untitled session falls back to an HONEST start-time name (#211), never a raw id', () => {
  const { title: _title, ...untitled } = session() // omit title entirely
  const html = render([untitled])
  assert.match(html, /Session · Jul 10/) // the honest fallback title — the session named by when it started
  // the raw id may ride in DATA attributes (the nav payload), but never in human-visible text (hud-voice §2)
  assert.doesNotMatch(html.replace(/\sdata-[a-z-]+="[^"]*"/g, ''), /ses-1/)
})

test('the empty state is explainable, not a blank card', () => {
  const html = render([])
  assert.match(html, /Sessions/) // still self-labels
  assert.match(html, /No sessions yet/)
  assert.match(html, /your recorded sessions appear here/)
})

test('the recent window is bounded and the overflow is disclosed as an honest "N more", never dropped', () => {
  const many = Array.from({ length: 8 }, (_, i) => session({ id: `ses-${i}`, title: `Session ${i}` }))
  const html = render(many, false, 6) // show 6 of the 8 fetched
  assert.match(html, /Session 0/) // the recent window renders
  assert.match(html, /Session 5/)
  assert.doesNotMatch(html, /Session 6/) // the 7th+ are beyond the window
  assert.match(html, /2 earlier sessions in history/) // …and disclosed, not silently dropped
})

test('when the fetch itself hit the cap, the overflow count is an honest floor (N+)', () => {
  const many = Array.from({ length: 24 }, (_, i) => session({ id: `ses-${i}`, title: `Session ${i}` }))
  const html = render(many, true, 6) // 24 fetched (the query cap), truncated ⇒ more exist beyond
  assert.match(html, /18\+ earlier sessions in history/)
})
