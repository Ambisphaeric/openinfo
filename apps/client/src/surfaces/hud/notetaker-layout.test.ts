import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Distillate, FieldValue, Moment, Pin, QueryResult, Session, Summary, Surface, TodoItem } from '@openinfo/contracts'
import { renderToHtml, type NowContext, type SessionReadiness, type VElement } from '../block-renderer/index.js'
import { defaultBlockRegistry } from '../blocks/index.js'
import { renderNotetaker, zoneOf, partitionZones } from './notetaker-layout.js'

/**
 * The #133 meeting note-taker app, DRIVEN end-to-end through the real renderer: the actual shipped surface
 * DOCUMENT (templates/openinfo-notetaker/surface.json — the byte mirror of the engine's seeded
 * `defaultNotetakerSurface`, pinned by the engine documents test) composed by `renderNotetaker` +
 * `defaultBlockRegistry` (which itself calls the SAME `renderSurface` per zone). No hand-rolled stub — if
 * the shipped document, the id-prefix zone convention, or any block renderer drifts, THIS test breaks, which
 * is the point (the served-UI-must-be-driven rule). The three zones are asserted independently so a block
 * landing in the wrong column is caught.
 */

// dist/surfaces/hud → dist/surfaces → dist → apps/client → apps → repo root
const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), '../../../../..', 'templates/openinfo-notetaker/surface.json')
const loadNotetaker = async (): Promise<Surface> => JSON.parse(await readFile(TEMPLATE, 'utf8')) as Surface

const now: NowContext = { live: true, workspace: 'acme', title: 'Q3 renewal — security review', topic: 'renewal pricing', elapsed: '12m' }

const pin: Pin = { id: 'pin-1', workspaceId: 'default', title: 'Renewal MSA', kind: 'pdf', uri: 'file://msa.pdf', ingest: { status: 'ingested', pages: 12 }, schemaVersion: 1, createdAt: '2026-07-10T12:00:00Z' } as unknown as Pin
const session: Session = { id: 'ses-1', workspaceId: 'default', modeId: 'mode-meeting', startedAt: '2026-07-10T12:00:00Z', endedAt: '2026-07-10T12:42:00Z', title: 'Q3 renewal — security review', attribution: { evidence: [], confidence: 1 } } as unknown as Session
const noteMoment: Moment = { id: 'mo-1', kind: 'decision', at: '2026-07-10T12:03:00Z', text: 'Agreed to ship the quote Friday' } as unknown as Moment
const fiveMinSummary: Summary = {
  id: 'sum-5m', workspaceId: 'default', sessionId: 'ses-1', level: 'five-minute',
  windowStart: '2026-07-10T12:00:00Z', windowEnd: '2026-07-10T12:05:00Z',
  text: 'they agreed to ship the renewal quote Friday', proposal: true, children: [],
  provenance: { slot: 'llm', endpoint: 'this-mac', model: 'qwen2.5-7b' }, schemaVersion: 1, createdAt: '2026-07-10T12:05:01Z',
} as unknown as Summary
const summaryDistillate = (id: string, text: string): Distillate =>
  ({
    id,
    workspaceId: 'default',
    sessionId: 'ses-1',
    windowStart: '2026-07-10T12:00:00Z',
    windowEnd: '2026-07-10T12:00:30Z',
    sourceChunks: ['chunk-1'],
    text,
    voice: { scope: 'global', dials: { tone: 5, warmth: 5, wit: 2, charm: 2, specificity: 7, brevity: 7 } },
    provenance: { slot: 'llm', endpoint: 'this-mac', model: 'qwen2.5-7b' },
    schemaVersion: 1,
    createdAt: '2026-07-10T12:00:31Z',
  }) as unknown as Distillate
const todo: TodoItem = { id: 'td-1', text: 'Send updated quote to Dana', done: false, provenance: { sessionId: 'ses-1' } } as unknown as TodoItem
const field: FieldValue = {
  id: 'fv:default:ses-1:field-topic',
  fieldId: 'field-topic',
  workspaceId: 'default',
  sessionId: 'ses-1',
  label: 'topic',
  value: 'Q3 renewal pricing',
  state: 'provisional',
  provenance: { templateId: 'tpl-field-topic', slot: 'llm', endpoint: 'this-mac', model: 'qwen2.5-7b', windowStart: '2026-07-10T12:00:00Z', windowEnd: '2026-07-10T12:00:30Z' },
  updatedAt: '2026-07-10T12:00:31Z',
  schemaVersion: 1,
} as unknown as FieldValue

const q = (source: string, items: unknown[]): QueryResult => ({ source, items, truncated: false } as unknown as QueryResult)

/**
 * Results parallel to the shipped v2 stack:
 * [pins, sessions, now(query-less), moments, center-summary(five-minute), center-session(session),
 *  right-rolling(distillates), todos, fields].
 */
const results = (): (QueryResult | undefined)[] => [
  q('pins', [pin]),
  q('sessions', [session]),
  undefined,
  q('moments', [noteMoment]),
  q('summaries', [fiveMinSummary]),
  q('summaries', []),
  q('distillates', [summaryDistillate('dist-rolling', 'Rolling — Dana asked about SOC 2')]),
  q('todos', [todo]),
  q('fields', [field]),
]

const zones = (frame: VElement): { left: string; center: string; right: string } => {
  const cols = frame.children as VElement[]
  return { left: renderToHtml(cols[0]!), center: renderToHtml(cols[1]!), right: renderToHtml(cols[2]!) }
}

test('the shipped note-taker document declares the three-zone stack via id prefixes', async () => {
  const surface = await loadNotetaker()
  assert.equal(surface.id, 'surf-openinfo-notetaker')
  assert.equal(surface.name, 'Note-taker')
  assert.equal(surface.version, 2) // the #177/#211 summary-hierarchy + sessions rewire
  assert.deepEqual(
    surface.stack.map((b) => [b.id, b.block]),
    [
      ['nt-left-pins', 'pinned-doc'],
      ['nt-left-sessions', 'sessions'],
      ['nt-center-now', 'now'],
      ['nt-center-notes', 'moments'],
      ['nt-center-summary', 'summaries'],
      ['nt-center-session', 'summaries'],
      ['nt-right-rolling', 'distillates'],
      ['nt-right-actions', 'todos'],
      ['nt-right-fields', 'fields'],
    ],
  )
  // the CENTER summary reads the five-minute VIEW (always) + the durable session result (on-match) — the
  // #177 memory headline, NOT the raw distillate stream (which is demoted to the right rolling block).
  const centerSummary = surface.stack.find((b) => b.id === 'nt-center-summary')
  assert.equal(centerSummary?.query?.source, 'summaries')
  assert.equal(centerSummary?.query?.params['level'], 'five-minute')
  assert.equal(centerSummary?.show, 'always')
  assert.equal(surface.stack.find((b) => b.id === 'nt-center-session')?.query?.params['level'], 'session')
  assert.equal(surface.stack.find((b) => b.id === 'nt-center-session')?.show, 'on-match')
  assert.equal(surface.stack.find((b) => b.id === 'nt-right-rolling')?.query?.source, 'distillates')
  // the zone convention resolves each block to its column (unprefixed ⇒ center — never un-renderable)
  assert.equal(zoneOf(surface.stack[0]!), 'left')
  assert.equal(zoneOf(surface.stack[1]!), 'left')
  assert.equal(zoneOf(surface.stack[2]!), 'center')
  assert.equal(zoneOf(surface.stack[6]!), 'right')
  assert.equal(zoneOf({ block: 'now' } as Surface['stack'][number]), 'center')
  const parts = partitionZones({ surface, now, results: results() })
  assert.deepEqual(parts.left.stack.map((b) => b.id), ['nt-left-pins', 'nt-left-sessions'])
  assert.deepEqual(parts.center.stack.map((b) => b.id), ['nt-center-now', 'nt-center-notes', 'nt-center-summary', 'nt-center-session'])
  assert.deepEqual(parts.right.stack.map((b) => b.id), ['nt-right-rolling', 'nt-right-actions', 'nt-right-fields'])
})

test('the shipped note-taker document renders three zones through the real renderer, blocks in the right column', async () => {
  const surface = await loadNotetaker()
  const frame = renderNotetaker({ surface, now, results: results() }, defaultBlockRegistry)
  assert.equal(frame.attrs['class'], 'nt-app')
  const html = renderToHtml(frame)
  assert.match(html, /class="nt-left"/)
  assert.match(html, /class="nt-center"/)
  assert.match(html, /class="nt-right"/)

  const { left, center, right } = zones(frame)

  // LEFT rail: home + feature nav + the Pins list (real pinned-doc) + the Sessions history list (new block)
  assert.match(left, /class="nt-home"/)
  assert.match(left, /Notes<\/button>/)
  assert.match(left, /Search<\/button>/) // the disabled Search tab stays (the deferred search view, disclosed)
  assert.match(left, /Renewal MSA/) // the pin hydrates
  assert.match(left, /Sessions</) // the sessions block self-labels (realizing the old Meetings/Archives folders)
  assert.match(left, /Q3 renewal — security review/) // the session-history row title hydrates
  assert.doesNotMatch(left, /session-list block pending/) // the placeholder gap note is GONE — the block realizes it
  assert.doesNotMatch(left, /Meetings</) // the dead placeholder folders are gone
  assert.doesNotMatch(left, /Archives</)
  assert.doesNotMatch(left, /nt-record/) // the record button is NOT in the left rail
  assert.doesNotMatch(left, /Rolling — Dana/) // the rolling summary is NOT in the left rail

  // CENTER canvas: the #136 in-window session control + context + notes + summary. With NO shell readiness
  // in this render input (a plain frame), the control is honestly DISABLED with the true reason inline
  // (`.session-record-note`), never a tooltip-only fake-live button — the interaction-honesty pattern.
  assert.match(center, /class="session-record pending"[^>]*data-nt="record"[^>]*disabled/)
  assert.match(center, /class="session-record-note">Recording is controlled from the desktop app/) // inline disclosure
  assert.doesNotMatch(center, /#136/) // #227: end-user copy never leaks a raw issue number
  assert.match(center, /Q3 renewal — security review/) // the now context line
  assert.match(center, /Agreed to ship the quote Friday/) // the live note (moments)
  assert.match(center, /they agreed to ship the renewal quote Friday/) // the center FIVE-MINUTE summary (a proposal)
  assert.match(center, /a draft you can correct/) // the summaries why-line — never asserted as truth
  assert.doesNotMatch(center, /Rolling — Dana/) // the rolling distillate stream belongs to the RIGHT sidebar

  // RIGHT sidebar (enrichments): the raw rolling distillate stream + action items + fast fields
  assert.match(right, /Enrichments</)
  assert.match(right, /Rolling — Dana asked about SOC 2/) // the raw rolling distillate stream (demoted here)
  assert.match(right, /Send updated quote to Dana/) // the action item (todos)
  assert.match(right, /Q3 renewal pricing/) // the fast field value
  assert.match(right, /class="dot provisional"/) // the #66 micro-state dot rides through unchanged
  assert.doesNotMatch(right, /they agreed to ship the renewal quote Friday/) // the center summary stays in the center
})

test('the note-taker Record control is LIVE when the shell is ready: start when stopped, stop when live (#136)', async () => {
  const surface = await loadNotetaker()
  const centerOf = (input: Parameters<typeof renderNotetaker>[0]): string => zones(renderNotetaker(input, defaultBlockRegistry)).center

  // Ready + STOPPED (no live session) → a LIVE start button dispatching the wired `session-start` verb.
  const stopped = centerOf({ surface, now: { ...now, live: false }, results: results(), session: { ready: true } })
  assert.match(stopped, /class="session-record"[^>]*data-nt="record"[^>]*data-verb="session-start"/)
  assert.doesNotMatch(stopped, /disabled/) // it is genuinely live, not the placeholder
  assert.match(stopped, />Record</)

  // Ready + LIVE → the SAME control now STOPS the session (wired `session-stop`) + an honest capture note.
  const capturing: SessionReadiness = { ready: true, capture: { tone: 'rec', note: 'Recording · mic + system' } }
  const live = centerOf({ surface, now: { ...now, live: true }, results: results(), session: capturing })
  assert.match(live, /class="session-record recording"[^>]*data-nt="record"[^>]*data-verb="session-stop"/)
  assert.match(live, />Stop</)
  assert.match(live, /class="session-record-note">Recording · mic \+ system/) // honest capture sub-state
})

test('the note-taker Record control is honestly DISABLED with the true reason when the shell cannot act (#136)', async () => {
  const surface = await loadNotetaker()
  const centerOf = (session: SessionReadiness | undefined): string =>
    zones(renderNotetaker({ surface, now, results: results(), ...(session !== undefined ? { session } : {}) }, defaultBlockRegistry)).center

  // Each honest-disabled reason: not-connected engine, skew-refused, and no bridge at all (undefined). The
  // button carries `disabled` (never receives a click) and the TRUE reason renders inline (hud-voice).
  const unreachable = centerOf({ ready: false, reason: 'Engine unreachable — reconnecting' })
  assert.match(unreachable, /class="session-record pending"[^>]*data-nt="record"[^>]*disabled/)
  assert.match(unreachable, /class="session-record-note">Engine unreachable — reconnecting/)

  const skew = centerOf({ ready: false, reason: 'Engine refused — version mismatch' })
  assert.match(skew, /class="session-record pending"[^>]*disabled/)
  assert.match(skew, /class="session-record-note">Engine refused — version mismatch/)

  const noBridge = centerOf(undefined) // a plain browser / served frame — no desktop shell
  assert.match(noBridge, /class="session-record pending"[^>]*disabled/)
  assert.match(noBridge, /class="session-record-note">Recording is controlled from the desktop app/)
})

test('the note-taker zones are honest when empty (always-on blocks explain themselves, on-match blocks hide)', async () => {
  const surface = await loadNotetaker()
  const empty: (QueryResult | undefined)[] = [
    q('pins', []), q('sessions', []), undefined, q('moments', []),
    q('summaries', []), q('summaries', []), q('distillates', []), q('todos', []), q('fields', []),
  ]
  const { left, center, right } = zones(renderNotetaker({ surface, now, results: empty }, defaultBlockRegistry))
  // the always-visible CENTER summary explains itself rather than vanish (never a blank canvas on a notes app),
  // and (#227) its live-empty why names the Settings → Features toggle so a fresh install has a path forward.
  assert.match(center, /No summary yet/)
  assert.match(center, /turn on “Build a summary timeline” in Settings → Features/)
  // the on-match session-level summary card simply stays hidden until the loop rolls a session up (no empty card)
  assert.doesNotMatch(center, /This session/)
  // the always-visible left sessions list + right rolling stream both explain their empty, never blank; (#227)
  // the right rolling distillates stream names its enablement toggle too (renamed live-empty title).
  assert.match(left, /No sessions yet/)
  assert.match(right, /No transcript yet/)
  assert.match(right, /turn on “Distill what is captured” in Settings → Features/)
  // the on-match fields block simply stays hidden when it has produced nothing (no fabricated card)
  assert.doesNotMatch(right, /class="glbl">Fields</)
})
