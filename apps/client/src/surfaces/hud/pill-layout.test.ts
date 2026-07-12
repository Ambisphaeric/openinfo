import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Surface } from '@openinfo/contracts'
import { renderToHtml, type NowContext, type SurfaceRenderInput } from '../block-renderer/index.js'
import { defaultBlockRegistry } from '../blocks/index.js'
import { createPillRenderer, type PillFaceSources } from './pill-layout.js'
import type { PillState } from './pill.js'

/**
 * The pill layout (the-pill), DRIVEN through the real renderer + the default block registry: the header
 * rectangle (Listen / Ask / Show-Hide / settings) + the docked panel that switches between the Listen glance
 * (this surface's own stack) and the Ask face (the bundle-resolved chat surface). It FORKS NOTHING — each
 * face body is the same generic renderSurface. Honesty is asserted end-to-end (no silent dead buttons; the
 * Ask affordance disabled until its bundle face resolves; a blank Ask panel is never shipped).
 */

const now: NowContext = { live: true, workspace: 'acme', title: 'Q3 renewal', topic: 'pricing', elapsed: '5m' }

const pillSurface: Surface = {
  id: 'surf-openinfo-pill',
  name: 'openinfo',
  context: 'meeting',
  version: 1,
  panel: { edge: 'below', collapsed: 56, expanded: 432, reveal: 'user', startExpanded: true },
  stack: [
    { block: 'now', id: 'pill-listen-now' },
    { block: 'moments', id: 'pill-listen-moments', query: { source: 'moments', params: {}, top: 20 } },
  ],
}

const chatSurface: Surface = {
  id: 'surf-openinfo-chat',
  name: 'Chat',
  context: 'any',
  version: 1,
  panel: { edge: 'below', collapsed: 120, expanded: 432, reveal: 'user', startExpanded: false },
  stack: [{ block: 'now' }, { block: 'input', input: { target: 'chat', submit: '/chat', mode: 'both' } }],
}

const input: SurfaceRenderInput = { surface: pillSurface, now, results: [undefined, { source: 'moments', items: [], truncated: false }] }

const render = (state: PillState, sources: PillFaceSources): string =>
  renderToHtml(createPillRenderer(() => state, () => sources)(input, defaultBlockRegistry))

const resolved: PillFaceSources = { chat: chatSurface, resolving: false }
const unresolved: PillFaceSources = { chat: null, resolving: true }

// --- the honesty predicate, copied from hud-interaction-lint (a live-looking button with no wired verb) ---
const buttonTags = (html: string): string[] => html.match(/<button\b[^>]*>/g) ?? []
const hasDisabled = (tag: string): boolean => /\sdisabled(?=[\s>])/.test(tag)
const classList = (tag: string): string[] => (tag.match(/\bclass="([^"]*)"/)?.[1] ?? '').split(/\s+/).filter(Boolean)
const dataVerb = (tag: string): string | null => tag.match(/\bdata-verb="([^"]*)"/)?.[1] ?? null

test('the header rectangle carries Listen / Ask / Show-Hide / settings', () => {
  const html = render({ face: 'listen', open: true, askAvailable: true }, resolved)
  assert.match(html, /class="pill-bar"/)
  assert.match(html, /data-verb="pill-face" data-face="listen"[^>]*>Listen/)
  assert.match(html, /data-face="ask"[^>]*>Ask/)
  assert.match(html, /data-verb="pill-toggle"/)
  assert.match(html, /data-verb="pill-settings"/)
  assert.match(html, /class="pill-name">openinfo/) // the window names itself in-content (from surface.name)
})

test('the Listen face renders this surface own glance stack; NO chat input block', () => {
  const html = render({ face: 'listen', open: true, askAvailable: true }, resolved)
  assert.match(html, /Moments · this session/) // the moments glance block rendered (its label, empty here)
  assert.match(html, /class="nowline"/) // the now context line rendered
  assert.doesNotMatch(html, /class="input-block"/) // the Ask input is not in the Listen face
})

test('the Ask face mounts the bundle-resolved chat surface (its input block), not a fork', () => {
  const html = render({ face: 'ask', open: true, askAvailable: true }, resolved)
  assert.match(html, /class="input-block"/)
  assert.match(html, /data-verb="input-submit"/) // the shipped chat submit organ
  assert.match(html, /data-submit="\/chat"/)
})

test('Show-Hide off (collapsed) shows only the bar — neither face body renders', () => {
  const html = render({ face: 'listen', open: false, askAvailable: true }, resolved)
  assert.match(html, /data-open="false"/)
  assert.match(html, /class="hud pill-collapsed"/)
  assert.doesNotMatch(html, /class="mo /)
  assert.doesNotMatch(html, /class="input-block"/)
})

test('Ask is honestly disabled (not a silent dead button) until the bundle chat face resolves', () => {
  const html = render({ face: 'listen', open: true, askAvailable: false }, unresolved)
  const askTag = buttonTags(html).find((t) => /data-face="ask"/.test(t))!
  assert.ok(hasDisabled(askTag), 'the Ask affordance is disabled while unresolved')
  assert.equal(dataVerb(askTag), null, 'a disabled Ask carries no live verb')
})

test('the disabled Ask tooltip states the TRUE current reason — never the static no-chat-face lie', () => {
  // While the resolve loop is still working (the engine-spawn race), the reason is "catching up" — the
  // resolve retries until the engine answers, so claiming "no chat face" here would be a lie.
  const resolving = render({ face: 'listen', open: true, askAvailable: false }, unresolved)
  const resolvingTag = buttonTags(resolving).find((t) => /data-face="ask"/.test(t))!
  assert.match(resolvingTag, /title="Ask — catching up, chat will be ready in a moment"/)
  assert.doesNotMatch(resolvingTag, /no chat face/)
  // Only the TERMINAL data answer (GET /bundles succeeded, no chat face) earns the no-chat-face wording.
  const terminal = render(
    { face: 'listen', open: true, askAvailable: false },
    { chat: null, resolving: false, chatError: 'this app has no chat face' },
  )
  const terminalTag = buttonTags(terminal).find((t) => /data-face="ask"/.test(t))!
  assert.match(terminalTag, /title="Ask — this app has no chat face"/)
})

test('an unresolved / absent chat face paints an HONEST Ask panel, never a blank one', () => {
  assert.match(render({ face: 'ask', open: true, askAvailable: false }, unresolved), /Catching up — chat will be ready in a moment\./)
  assert.match(
    render({ face: 'ask', open: true, askAvailable: false }, { chat: null, resolving: false, chatError: 'this app has no chat face' }),
    /this app has no chat face/,
  )
})

test('every header button is HONEST — wired verb, ghost, or disabled (no silent dead button)', () => {
  for (const state of [
    { face: 'listen' as const, open: true, askAvailable: true },
    { face: 'ask' as const, open: true, askAvailable: true },
    { face: 'listen' as const, open: false, askAvailable: false },
  ]) {
    const html = render(state, state.askAvailable ? resolved : unresolved)
    const dishonest = buttonTags(html).filter(
      (tag) => !hasDisabled(tag) && !classList(tag).includes('ghost') && dataVerb(tag) === null,
    )
    assert.deepEqual(dishonest, [], `honest header for ${JSON.stringify(state)}`)
  }
})
