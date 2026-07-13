import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { QueryResult, SenseLaneSnapshot, Surface } from '@openinfo/contracts'
import { renderSurface, renderToHtml, type NowContext } from '../block-renderer/index.js'
import { sanitizeSenseLaneSnapshot } from '../sense-lane-snapshot.js'
import { defaultBlockRegistry } from './index.js'
import { loadFixtureSync } from '../../../../../tools/fixtures/model.mjs'
import { senseLaneRowsFromFixture } from '../../../../../tools/fixtures/lane-rows.mjs'

process.env.TZ = 'UTC'

/**
 * The surface half of the #174 slice-E "distinguishable end to end" proof — carried to the served renderer.
 *
 * The client depends only on @openinfo/contracts, never the engine, so it cannot run the SenseLaneTracker.
 * Instead it renders the SAME canonical rows, `senseLaneRowsFromFixture`, that the engine replay test
 * (apps/engine/src/senses/live-replay.test.ts) proves the REAL tracker emits when the tri-lane fixture is
 * replayed through the real transcribe + ScreenOcrProcessor stages. Those rows are extracted from the
 * committed synthetic-converged fixture (#32) — not hand-authored — so this test proves the honest,
 * proven-canonical lane truth survives the last hop through the real `sanitizeSenseLaneSnapshot` +
 * `renderSenseLanes` and stays distinguishable per lane in the painted DOM.
 */

const fixture = loadFixtureSync(new URL('../../../../../tools/fixtures/fixtures/synthetic-converged.v1.json', import.meta.url))
const rows = senseLaneRowsFromFixture(fixture) as unknown as SenseLaneSnapshot[]

const surface: Surface = {
  id: 'surf-replay',
  name: 'Replay',
  context: 'meeting',
  version: 1,
  stack: [{ block: 'sense-lanes', show: 'always', top: 3, query: { source: 'live-senses', params: { session: 'current' } } }],
}
const now: NowContext = { live: true, workspace: 'workspace-synthetic', title: 'Replay' }
const result: QueryResult = { source: 'live-senses', items: rows, truncated: false }
const html = renderToHtml(renderSurface({ surface, now, results: [result] }, defaultBlockRegistry))

/** The rendered fragment for one physical lane (between its data-sense-source marker and the next lane's). */
const laneSlice = (source: SenseLaneSnapshot['source']): string => {
  const start = html.indexOf(`data-sense-source="${source}"`)
  assert.ok(start >= 0, `${source} lane is missing from the render`)
  const ends = (['mic', 'system-audio', 'screen'] as const)
    .filter((other) => other !== source)
    .map((other) => html.indexOf(`data-sense-source="${other}"`))
    .filter((index) => index > start)
  return html.slice(start, ends.length > 0 ? Math.min(...ends) : html.length)
}

test('the fixture-derived rows are already the exact closed contract: sanitize is a faithful identity', () => {
  // Each row survives the strict client boundary unchanged — proof the shared canonical rows are exactly
  // the metadata contract, so the render below exercises real hydration rather than a lenient shortcut.
  for (const row of rows) assert.deepEqual(sanitizeSenseLaneSnapshot(row), row)
})

test('all three replayed lanes render simultaneously in canonical order, each keeping its own identity', () => {
  assert.ok(html.indexOf('Microphone') < html.indexOf('System audio'), 'mic before system audio')
  assert.ok(html.indexOf('System audio') < html.indexOf('Screen'), 'system audio before screen')
  assert.match(laneSlice('mic'), /Microphone · Processed · Healthy/)
  assert.match(laneSlice('system-audio'), /System audio · Processed · Healthy/)
  assert.match(laneSlice('screen'), /Screen · Processed · Healthy/)
})

test('each lane carries its OWN correlated processing lag — the three lanes are not merged or swapped', () => {
  // mic captured 13:00:00, system 13:00:01, screen 13:00:02, all completed at the 13:00:03 replay clock →
  // 3 s / 2 s / 1 s. Binding each distinct lag to its own lane row proves the surface preserves per-lane
  // attribution end to end; a merge or swap would surface the wrong lag under a lane.
  const mic = laneSlice('mic')
  const system = laneSlice('system-audio')
  const screen = laneSlice('screen')
  assert.match(mic, /Last captured \d{1,2}:\d{2}[ap] · Processing complete in 3 s/)
  assert.match(system, /Last captured \d{1,2}:\d{2}[ap] · Processing complete in 2 s/)
  assert.match(screen, /Last captured \d{1,2}:\d{2}[ap] · Processing complete in 1 s/)
  assert.doesNotMatch(mic, /in 2 s|in 1 s/)
  assert.doesNotMatch(system, /in 3 s|in 1 s/)
  assert.doesNotMatch(screen, /in 3 s|in 2 s/)
})

test('the surface keeps each lane distinguishable WITHOUT leaking its private capture id or content', () => {
  for (const secret of [
    'cap-mic-0001', 'cap-system-0001', 'cap-screen-image-0001',
    'Please follow up', 'I will review', 'Pull request 150',
    'fixture-parakeet', 'fixture-ocr', 'U1lOVEhFVElD',
  ]) {
    assert.doesNotMatch(html, new RegExp(secret), `rendered surface leaked ${secret}`)
  }
  // Source is the physical lane, never an inferred speaker identity.
  assert.doesNotMatch(html, /\bme\b|\bthem\b|speaker/i)
})
