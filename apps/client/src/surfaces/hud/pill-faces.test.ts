import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Bundle, Surface } from '@openinfo/contracts'
import { chatFaceRefForPill, resolvePillAskSurface } from './dev-entry.js'

/**
 * The pill's Ask face resolves FROM THE BUNDLE (the-pill) — data, not a hardcoded window. These assert the
 * pure face-picking (which chat surfaceRef backs this pill, per the bundle document) and the over-the-wire
 * resolver (GET /bundles → surfaceRef → GET /layouts/surfaces/:ref), including the HONEST failures the pill
 * paints as text: no bundle opens this pill, the bundle has no chat face, and a non-ok read.
 */

const bundle = (hudRef: string, faces: Bundle['faces'] = []): Bundle => ({
  id: 'bundle-standard-app',
  name: 'Standard App',
  version: 1,
  faces: [{ kind: 'hud', surfaceRef: hudRef }, ...faces],
})

test('chatFaceRefForPill: the chat face of the bundle whose hud face opens this pill', () => {
  const bundles = [bundle('surf-openinfo-pill', [{ kind: 'chat', surfaceRef: 'surf-openinfo-chat' }, { kind: 'support', surfaceRef: 'surf-x' }])]
  assert.equal(chatFaceRefForPill(bundles, 'surf-openinfo-pill'), 'surf-openinfo-chat')
})

test('chatFaceRefForPill: a DIFFERENT bundle produces a different Ask panel (data-driven, not hardcoded)', () => {
  const bundles = [bundle('surf-openinfo-pill', [{ kind: 'chat', surfaceRef: 'surf-my-custom-chat' }])]
  assert.equal(chatFaceRefForPill(bundles, 'surf-openinfo-pill'), 'surf-my-custom-chat')
})

test('chatFaceRefForPill: undefined when no bundle opens this pill, or its bundle has no chat face', () => {
  assert.equal(chatFaceRefForPill([bundle('surf-other')], 'surf-openinfo-pill'), undefined)
  assert.equal(chatFaceRefForPill([bundle('surf-openinfo-pill')], 'surf-openinfo-pill'), undefined)
})

const chatSurface: Surface = {
  id: 'surf-openinfo-chat',
  name: 'Chat',
  context: 'any',
  version: 1,
  stack: [{ block: 'input', input: { target: 'chat', submit: '/chat' } }],
}

const fakeFetch = (body: unknown, ok = true, status = 200): typeof fetch =>
  (async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch

const transport = { surface: async (id: string): Promise<Surface> => ({ ...chatSurface, id }) }

test('resolvePillAskSurface: reads the bundle, then fetches the resolved chat surface', async () => {
  const bundles = [bundle('surf-openinfo-pill', [{ kind: 'chat', surfaceRef: 'surf-openinfo-chat' }])]
  const surface = await resolvePillAskSurface('http://e', transport, fakeFetch(bundles))('surf-openinfo-pill')
  assert.equal(surface.id, 'surf-openinfo-chat')
  assert.equal(surface.stack[0]!.block, 'input')
})

test('resolvePillAskSurface: HONEST failure when the bundle has no chat face', async () => {
  const bundles = [bundle('surf-openinfo-pill')]
  await assert.rejects(resolvePillAskSurface('http://e', transport, fakeFetch(bundles))('surf-openinfo-pill'), /no chat face/)
})

test('resolvePillAskSurface: HONEST failure when /bundles is not ok', async () => {
  await assert.rejects(resolvePillAskSurface('http://e', transport, fakeFetch({}, false, 503))('surf-openinfo-pill'), /HTTP 503/)
})
