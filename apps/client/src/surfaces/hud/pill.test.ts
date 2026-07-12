import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PillController, pillHeight, pillExtentsFromPanel, PILL_LISTEN_EXTENT, type PillExtents } from './pill.js'

/**
 * The pill's height authority + view-state machine (the-pill), asserted headless: the PURE height math and
 * the state machine driving an injected bridge (no electron). Proves the THREE-state extent (bar/listen/ask
 * — the extension beyond PanelController's two), that selecting a face opens the panel, that Show-Hide
 * collapses to the bar and back, and that Ask is honestly gated until its bundle face resolves.
 */

const extents: PillExtents = { bar: 56, listen: 300, ask: 432 }

test('pillHeight: closed ⇒ the bar; open ⇒ the active face extent (three distinct heights)', () => {
  assert.equal(pillHeight('listen', false, extents), 56)
  assert.equal(pillHeight('ask', false, extents), 56) // closed is the bar regardless of face
  assert.equal(pillHeight('listen', true, extents), 300)
  assert.equal(pillHeight('ask', true, extents), 432) // ~3× the bar — the recorded chat geometry
})

test('pillExtentsFromPanel: derives bar/ask from the surface panel, clamps listen between them', () => {
  assert.deepEqual(pillExtentsFromPanel({ collapsed: 56, expanded: 432 }), { bar: 56, ask: 432, listen: PILL_LISTEN_EXTENT })
  // listen never taller than ask, never shorter than bar
  assert.deepEqual(pillExtentsFromPanel({ collapsed: 56, expanded: 200 }, 300), { bar: 56, ask: 200, listen: 200 })
  assert.deepEqual(pillExtentsFromPanel({ collapsed: 320, expanded: 432 }, 100), { bar: 320, ask: 432, listen: 320 })
})

/** A recording bridge + change counter — the seam the electron shell wires to setContentSize. */
const harness = (opts?: { startOpen?: boolean; startFace?: 'listen' | 'ask' }) => {
  const applied: { height: number }[] = []
  let changes = 0
  const pill = new PillController({
    extents,
    bridge: { apply: (s) => applied.push(s) },
    onChange: () => (changes += 1),
    ...(opts ?? {}),
  })
  return { pill, applied, changes: () => changes }
}

test('start() applies the opening extent; the default is open on the Listen face', () => {
  const h = harness()
  h.pill.start()
  assert.deepEqual(h.pill.state(), { face: 'listen', open: true, askAvailable: false })
  assert.deepEqual(h.applied.at(-1), { height: 300 })
})

test('selecting a face reveals the panel at that face extent and fires onChange', () => {
  const h = harness()
  h.pill.start()
  h.pill.setAskAvailable(true)
  h.pill.setFace('ask')
  assert.deepEqual(h.pill.state(), { face: 'ask', open: true, askAvailable: true })
  assert.deepEqual(h.applied.at(-1), { height: 432 })
  h.pill.setFace('listen')
  assert.deepEqual(h.applied.at(-1), { height: 300 })
})

test('Show-Hide collapses to the bar and back — independent of the selected face', () => {
  const h = harness()
  h.pill.start()
  h.pill.setAskAvailable(true)
  h.pill.setFace('ask') // open, ask ⇒ 432
  h.pill.toggle() // hide ⇒ bar 56
  assert.equal(h.pill.state().open, false)
  assert.deepEqual(h.applied.at(-1), { height: 56 })
  assert.equal(h.pill.state().face, 'ask') // face is remembered while hidden
  h.pill.toggle() // show ⇒ back to ask 432
  assert.equal(h.pill.state().open, true)
  assert.deepEqual(h.applied.at(-1), { height: 432 })
})

test('Ask is honestly inert until its bundle face resolves — setFace(ask) is a no-op while unavailable', () => {
  const h = harness()
  h.pill.start()
  h.pill.setFace('ask') // askAvailable is false ⇒ ignored
  assert.equal(h.pill.state().face, 'listen')
  h.pill.setAskAvailable(true)
  h.pill.setFace('ask')
  assert.equal(h.pill.state().face, 'ask')
})

test('startOpen:false opens as the bar (the dramatically shortened default HUD)', () => {
  const h = harness({ startOpen: false })
  h.pill.start()
  assert.equal(h.pill.state().open, false)
  assert.deepEqual(h.applied.at(-1), { height: 56 })
})
