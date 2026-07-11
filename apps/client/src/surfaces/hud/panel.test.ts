import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AttachedPanel } from '@openinfo/contracts'
import { PanelController, matchesTrigger, panelSize, type PanelEventFeed, type PanelSize } from './panel.js'

const below: AttachedPanel = { edge: 'below', collapsed: 120, expanded: 432, reveal: 'user', startExpanded: false }
const sidebar: AttachedPanel = { edge: 'right', collapsed: 0, expanded: 320, reveal: 'event', openOn: 'entity.updated', startExpanded: false }

// A recording bridge + a controllable event feed.
const harness = (panel: AttachedPanel) => {
  const applied: PanelSize[] = []
  let handler: ((event: { name: string; payload: unknown }) => void) | undefined
  const feed: PanelEventFeed = {
    subscribe: (h) => {
      handler = h
      return () => {
        handler = undefined
      }
    },
  }
  const controller = new PanelController(panel, { apply: (size) => applied.push(size) }, feed)
  return { controller, applied, emit: (name: string) => handler?.({ name, payload: undefined }) }
}

test('panelSize sizes the edge axis only — height for below, width for right', () => {
  assert.deepEqual(panelSize(below, false), { height: 120 })
  assert.deepEqual(panelSize(below, true), { height: 432 })
  assert.deepEqual(panelSize(sidebar, false), { width: 0 })
  assert.deepEqual(panelSize(sidebar, true), { width: 320 })
})

test('matchesTrigger is exact-or-prefix and tolerant of an unset/empty trigger', () => {
  assert.equal(matchesTrigger('entity.updated', 'entity.updated'), true)
  assert.equal(matchesTrigger('entity.updated', 'moment.created'), false)
  assert.equal(matchesTrigger('orientation.', 'orientation.suggested'), true) // prefix — tolerates the unlanded #131 name
  assert.equal(matchesTrigger('orientation.', 'orientationx'), false)
  assert.equal(matchesTrigger(undefined, 'anything'), false)
  assert.equal(matchesTrigger('', 'anything'), false)
})

test('start applies the initial collapsed extent; expand/collapse drive real size reports', () => {
  const { controller, applied } = harness(below)
  controller.start()
  assert.deepEqual(applied, [{ height: 120 }]) // collapsed floor
  controller.expand()
  assert.deepEqual(applied.at(-1), { height: 432 })
  assert.equal(controller.state().expanded, true)
  controller.collapse()
  assert.deepEqual(applied.at(-1), { height: 120 })
  assert.equal(controller.state().expanded, false)
})

test('startExpanded seeds the expanded extent', () => {
  const { controller, applied } = harness({ ...below, startExpanded: true })
  controller.start()
  assert.deepEqual(applied, [{ height: 432 }])
})

test('a matching trigger opens the sidebar as a dismissible SUGGESTION (never modal), once', () => {
  const { controller, applied, emit } = harness(sidebar)
  controller.start()
  assert.deepEqual(applied, [{ width: 0 }]) // starts hidden
  emit('entity.updated')
  assert.deepEqual(applied.at(-1), { width: 320 }) // suggested open → expanded width
  assert.deepEqual(controller.state(), { expanded: true, suggested: true })
  // a second trigger while already open is a no-op (never re-nags)
  const count = applied.length
  emit('entity.updated')
  assert.equal(applied.length, count)
})

test('a non-matching event never opens the sidebar (tolerates the unlanded trigger)', () => {
  const { controller, applied, emit } = harness(sidebar)
  controller.start()
  emit('moment.created')
  assert.deepEqual(controller.state(), { expanded: false, suggested: false })
  assert.deepEqual(applied, [{ width: 0 }])
})

test('dismissing a suggestion collapses it and suppresses further suggestions this session', () => {
  const { controller, applied, emit } = harness(sidebar)
  controller.start()
  emit('entity.updated')
  assert.equal(controller.state().expanded, true)
  controller.dismissSuggestion()
  assert.deepEqual(applied.at(-1), { width: 0 })
  assert.deepEqual(controller.state(), { expanded: false, suggested: false })
  // will not re-suggest after dismissal
  emit('entity.updated')
  assert.equal(controller.state().expanded, false)
})

test('a user expand is authoritative: a later suggestion never overrides an open panel', () => {
  const { controller, emit } = harness(sidebar)
  controller.start()
  controller.expand()
  assert.deepEqual(controller.state(), { expanded: true, suggested: false })
  emit('entity.updated') // already open ⇒ no suggestion flag flips on
  assert.deepEqual(controller.state(), { expanded: true, suggested: false })
})

test('reveal:user does not subscribe — no event opens it', () => {
  const { controller, emit } = harness(below) // reveal:'user'
  controller.start()
  emit('entity.updated')
  assert.equal(controller.state().expanded, false)
})
