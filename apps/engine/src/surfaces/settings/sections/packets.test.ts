import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ContextPacket, Moment, OcrResult } from '@openinfo/contracts'
import type { SetupData } from '../../setup/view.js'
import { buildContextPacketViews, renderContextPackets, type ContextPacketsData } from './packets.js'

/**
 * The Context packets diagnostics section (#176 slice 2), rendered headless. Asserts every acceptance
 * facet on the served markup — membership (per lane), exclusions (the gap reasons in human words), timing
 * (window bounds + observation instants), confidence (framed, raw value on inspection), the supersession
 * chain, and every honest state: empty, an assembly failure, and a contained live-producer failure.
 */

const setup = (contextPackets: ContextPacketsData | undefined): SetupData => ({ contextPackets } as unknown as SetupData)

const packet = (over: Partial<ContextPacket>): ContextPacket => ({
  id: 'cp-1',
  workspaceId: 'default',
  sessionId: 'ses-1',
  windowStart: '2026-07-14T14:00:00.000Z',
  windowEnd: '2026-07-14T14:01:00.000Z',
  microphone: [{ record: 'stt-segment', id: 'stt-mic-1', at: '2026-07-14T14:00:05.000Z' }],
  systemAudio: [],
  screen: [{ record: 'ocr-result', id: 'ocr-1', at: '2026-07-14T14:00:20.000Z' }],
  candidates: [],
  gaps: [{ lane: 'system-audio', reason: 'no-observations-this-session' }],
  confidence: 0.7,
  provenance: { builder: 'deterministic-correlation', windowMs: 60_000 },
  revision: 1,
  schemaVersion: 1,
  createdAt: '2026-07-14T14:01:01.000Z',
  ...over,
})

const ocr = (over: Partial<OcrResult>): OcrResult => ({
  id: 'ocr-1',
  sessionId: 'ses-1',
  workspaceId: 'default',
  sourceChunks: ['cap-1'],
  text: 'Pull request 150 — checks passing',
  provenance: { slot: 'ocr', endpoint: 'fixture-ocr' },
  schemaVersion: 1,
  createdAt: '2026-07-14T14:00:21.000Z',
  capturedAt: '2026-07-14T14:00:20.000Z',
  ...over,
})

const moment = (over: Partial<Moment>): Moment => ({
  id: 'mom-1',
  workspaceId: 'default',
  sessionId: 'ses-1',
  at: '2026-07-14T14:00:15.000Z',
  kind: 'commitment',
  text: 'Dana will send the board deck by Friday',
  refs: ['ent-dana'],
  source: 'mic',
  confidence: 0.85,
  ...over,
})

test('#176: renders membership, timing, exclusions and confidence with each value traceable', () => {
  const html = renderContextPackets(
    setup({ packets: [packet({})], ocrResults: [ocr({})], moments: [] }),
  )
  // Timing: the window clock span, with the full ISO bounds available on inspection.
  assert.match(html, /14:00:00–14:01:00/)
  assert.match(html, /2026-07-14T14:00:00\.000Z → 2026-07-14T14:01:00\.000Z/)
  // Membership: the mic lane (count + instant) and the screen lane resolving OCR text from its source.
  assert.match(html, /Microphone/)
  assert.match(html, /1 heard/)
  assert.match(html, /1 seen/)
  assert.match(html, /Pull request 150 — checks passing/, 'screen text resolved from the OcrResult at render')
  assert.match(html, /stt-mic-1/, 'the audio record id is present for inspection (never a fabricated quote)')
  // Confidence: framed in human words, with the raw score only on inspection.
  assert.match(html, /two senses agree/)
  assert.match(html, /confidence 0\.7/)
  assert.doesNotMatch(html, /class="cpk-conf"[^>]*>[^<]*0\.7/, 'the raw score is not the headline text')
  // Exclusions: the honest gap reason in human words.
  assert.match(html, /System audio — nothing captured this session/)
})

test('#176: candidates resolve their mention text and screen corroboration, both traceable', () => {
  const html = renderContextPackets(
    setup({
      packets: [
        packet({
          candidates: [
            { entityId: 'ent-dana', name: 'Dana', momentRefs: ['mom-1'], seenOnScreen: { ocrId: 'ocr-1', form: 'Dana', similarity: 0.95 } },
          ],
        }),
      ],
      ocrResults: [ocr({})],
      moments: [moment({})],
    }),
  )
  assert.match(html, /Named here/)
  assert.match(html, /Dana/)
  assert.match(html, /also on screen/)
  assert.match(html, /Dana will send the board deck by Friday/, 'mention text resolved from the source moment')
  assert.match(html, /ent-dana/, 'the entity id is available for inspection')
})

test('#176: the supersession chain is visible — a later observation appended a new version', () => {
  const v1 = packet({ id: 'cp-1', revision: 1, screen: [], gaps: [{ lane: 'screen', reason: 'no-observations-in-window' }, { lane: 'system-audio', reason: 'no-observations-this-session' }] })
  const v2 = packet({ id: 'cp-2', revision: 2, supersedes: 'cp-1', createdAt: '2026-07-14T14:05:00.000Z' })
  const views = buildContextPacketViews({ packets: [v1, v2], ocrResults: [ocr({})], moments: [] })
  assert.equal(views.length, 1, 'the two revisions collapse into one window group')
  assert.equal(views[0]!.head.id, 'cp-2', 'the live head is the not-superseded revision')
  assert.deepEqual(views[0]!.superseded.map((p) => p.id), ['cp-1'])

  const html = renderContextPackets(setup({ packets: [v1, v2], ocrResults: [ocr({})], moments: [] }))
  assert.match(html, /now version 2/)
  assert.match(html, /version 1/)
})

test('#176: the empty state reads human — says what will appear and what to do', () => {
  const html = renderContextPackets(setup({ packets: [], ocrResults: [], moments: [] }))
  assert.match(html, /No context packets yet/)
  assert.match(html, /Start a session with listening or screen understanding on/)
  assert.doesNotMatch(html, /undefined/)
})

test('#176: a contained live-producer failure surfaces as the honest "last update didn’t finish" line', () => {
  const html = renderContextPackets(
    setup({
      packets: [packet({})],
      ocrResults: [ocr({})],
      moments: [],
      lastBuild: { workspaceId: 'default', sessionId: 'ses-1', trigger: 'session-end', at: '2026-07-14T14:02:00.000Z', created: 0, unchanged: 0, error: 'SQLITE_CORRUPT: database disk image is malformed' },
    }),
  )
  assert.match(html, /Last update didn’t finish/)
  assert.match(html, /SQLITE_CORRUPT: database disk image is malformed/)
  assert.match(html, /The packets below are the last good version/)
  // The prior packets still render — a build failure never blanks the view.
  assert.match(html, /14:00:00–14:01:00/)
})

test('#176: a successful last build shows a calm one-line summary', () => {
  const html = renderContextPackets(
    setup({
      packets: [packet({})],
      ocrResults: [ocr({})],
      moments: [],
      lastBuild: { workspaceId: 'default', sessionId: 'ses-1', trigger: 'session-end', at: '2026-07-14T14:02:00.000Z', created: 2, unchanged: 1 },
    }),
  )
  assert.match(html, /Last update/)
  assert.match(html, /grouped 2 new windows/)
})

test('#176: an assembly failure renders the true reason, never a blank', () => {
  const html = renderContextPackets(setup({ packets: [], ocrResults: [], moments: [], problem: 'SQLITE_CORRUPT: malformed' }))
  assert.match(html, /Context packets unavailable/)
  assert.match(html, /SQLITE_CORRUPT: malformed/)
})

test('#176: an unwired section (no data) explains itself rather than blanking', () => {
  const html = renderContextPackets(setup(undefined))
  assert.match(html, /Context packets unavailable/)
})
