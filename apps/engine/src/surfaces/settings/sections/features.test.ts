import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Fabric, Flag } from '@openinfo/contracts'
import type { SetupData } from '../../setup/view.js'
import { renderFeatures } from './features.js'

const emptyFabric = (): Fabric => ({ slots: { stt: [], tts: [], llm: [], vlm: [], ocr: [], embed: [] } })

const data = (flags: Flag[]): SetupData => ({
  profiles: [], activeId: undefined, liveFabric: emptyFabric(), editing: undefined, secretRefs: [], flags,
})

/** The six real gating flags + the two seeded engine toggles, as GET /flags returns them. */
const sixReal: Flag[] = [
  { key: 'distill.enabled', default: false, scope: 'engine', description: 'the distiller', minTier: 'T1' },
  { key: 'distill.transcribe', default: false, scope: 'engine', description: 'stt pre-distill', minTier: 'T1' },
  { key: 'distill.moments', default: false, scope: 'engine', description: 'typed moments', minTier: 'T1' },
  { key: 'distill.index', default: false, scope: 'engine', description: 'entity index', minTier: 'T1' },
  { key: 'act.enabled', default: false, scope: 'engine', description: 'follow-up draft', minTier: 'T1' },
  { key: 'route.detect', default: false, scope: 'engine', description: 'context detect', minTier: 'T1' },
  { key: 'capture.sim', default: false, scope: 'engine', description: 'sim', minTier: 'T0' },
  { key: 'fabric.http', default: false, scope: 'engine', description: 'health/bench', minTier: 'T0' },
]

test('empty flags ⇒ an honest "no flags seeded yet" note (never a blank pane)', () => {
  assert.match(renderFeatures(data([])), /No feature flags are seeded yet/)
})

test('every flag renders as a human-named toggle carrying its key + minTier chip', () => {
  const html = renderFeatures(data(sixReal))
  // each flag becomes a toggle over PUT /flags/:key
  for (const f of sixReal) assert.match(html, new RegExp(`class="flag-toggle" data-flag-key="${f.key.replace(/\./g, '\\.')}"`))
  // human names, not raw keys, lead the row
  assert.match(html, /Distill what is captured/)
  assert.match(html, /Prepare a follow-up draft/)
  assert.match(html, /Detect what I am working on/)
  // the key is still shown (for the curious) and the minTier chip renders
  assert.match(html, /class="feat-key">distill\.enabled</)
  assert.match(html, /class="tier-chip">T1</)
})

test('flags are grouped by pipeline stage (Capture / Distill / Extraction / Index / Act / Router)', () => {
  const html = renderFeatures(data(sixReal))
  for (const stage of ['Capture', 'Distill', 'Extraction', 'Index', 'Act', 'Router']) {
    assert.match(html, new RegExp(`class="feat-stage-head">${stage}`))
  }
})

test('dependency notes render: distill.* + act.enabled show they need distillation, and its live state', () => {
  // distill.enabled OFF ⇒ dependents show an UNMET dependency chip
  const off = renderFeatures(data(sixReal))
  assert.match(off, /needs Distill what is captured \(off\)/)
  assert.match(off, /class="dep unmet"/)
  // distill.enabled ON ⇒ the same dependents show a SATISFIED chip
  const on = renderFeatures(data(sixReal.map((f) => (f.key === 'distill.enabled' ? { ...f, default: true } : f))))
  assert.match(on, /class="dep ok"/)
  // route.detect runs independently of distillation — its row (Router stage) carries no dependency chip
  const routerBlock = off.slice(off.indexOf('>Router<'))
  assert.doesNotMatch(routerBlock, /feat-deps/)
})

test('the on-count and the current toggle state reflect the flag documents', () => {
  const mixed = sixReal.map((f) => (f.key === 'distill.enabled' || f.key === 'distill.moments' ? { ...f, default: true } : f))
  const html = renderFeatures(data(mixed))
  assert.match(html, /2 of 8 features on/)
  // an ON flag's checkbox is checked; an OFF flag's is not
  assert.match(html, /data-flag-key="distill\.enabled" checked/)
  assert.doesNotMatch(html, /data-flag-key="act\.enabled" checked/)
  // the whole flag list is embedded so the browser can PUT the flipped document without re-fetching
  assert.match(html, /id="flags-data"/)
})

test('an unregistered flag still renders (under Other, humanized) — GET /flags drives the section', () => {
  // a key NOT in the presentation registry — a forward/hand-set flag must never be invisible
  const html = renderFeatures(data([{ key: 'experiment.new-thing', default: false, scope: 'engine', description: 'some future experiment' }]))
  assert.match(html, /class="feat-stage-head">Other/)
  assert.match(html, /experiment new thing/) // humanized key (dots + hyphens → spaces)
  assert.match(html, /some future experiment/) // falls back to the flag's own description
  assert.match(html, /data-flag-key="experiment\.new-thing"/)
})
