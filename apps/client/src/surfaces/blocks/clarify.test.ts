import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Entity, RelevantEntity, Surface } from '@openinfo/contracts'
import { renderSurface, renderToHtml, type NowContext } from '../block-renderer/index.js'
import { defaultBlockRegistry } from './index.js'
import { clarifyGlyph, clarifyAsk, isClarifiable, heardForm, CLARIFY_GLYPH } from './clarify.js'

/**
 * #75 clarify affordance renderer coverage. The ≟ is ambiguity-gated, the ask is one inline human line
 * (no model/endpoint/template ids), it expands only for the one open entity, and an answered/dismissed
 * entity (in the session `suppressed` set) or a confirmed record renders NO ≟ — the ask-once law.
 */

const ambiguous = (over: Partial<Entity> = {}): Entity => ({
  id: 'ent-mercury', workspaceId: 'ws', kind: 'artifact', name: 'Mercury', aliases: [], momentRefs: [], outboundCount: 0, mentions: 2,
  firstSeen: '2026-07-08T09:00:00Z', lastSeen: '2026-07-08T09:02:00Z',
  state: 'provisional',
  ambiguity: { rivalId: 'ent-mercury-bank', rivalName: 'Mercury Bank', margin: 0.2 },
  resolutions: [{ at: '2026-07-08T09:02:00Z', heard: 'Mercury', score: 0.9, band: 'auto', phoneticFuzzy: 0.9, corpusPrior: 1, crossSourceCorroboration: 1, personAffinity: 1, ambiguous: true, rivalName: 'Mercury Bank' }],
  ...over,
})

/** Drop the ambiguity marker (omit the key — exactOptionalPropertyTypes forbids setting it undefined). */
const settled = (e: Entity): Entity => {
  const { ambiguity: _drop, ...rest } = e
  return rest as Entity
}

test('isClarifiable gates on a named rival, an unconfirmed state, and the session suppressed set', () => {
  const e = ambiguous()
  assert.equal(isClarifiable(e), true)
  assert.equal(isClarifiable({ ...e, state: 'confirmed' }), false) // a settled override never re-asks
  assert.equal(isClarifiable(settled(e)), false) // no rival ⇒ no ask
  assert.equal(isClarifiable(e, { suppressed: new Set(['ent-mercury']) }), false) // dismissed/answered this session
})

test('clarifyGlyph renders the ≟ mark (or null) — the collapsed ambiguity ask', () => {
  const glyph = clarifyGlyph(ambiguous())
  assert.ok(glyph)
  const html = renderToHtml(glyph!)
  assert.match(html, /data-verb="clarify-open"/)
  assert.match(html, /data-entity="ent-mercury"/)
  assert.ok(html.includes(CLARIFY_GLYPH))
  assert.equal(clarifyGlyph(ambiguous({ state: 'confirmed' })), null) // gone once settled
})

test('clarifyAsk expands ONE inline human line only for the open entity — no robot ids', () => {
  const e = ambiguous()
  assert.equal(clarifyAsk(e, 'ws', { suppressed: new Set() }), null) // collapsed unless expanded
  const ask = clarifyAsk(e, 'ws', { suppressed: new Set(), expanded: 'ent-mercury' })
  assert.ok(ask)
  const html = renderToHtml(ask!)
  assert.match(html, /Heard .Mercury. — which one\?/) // human copy
  assert.match(html, /data-verb="clarify-confirm"/)
  assert.match(html, /data-verb="clarify-rival"/)
  assert.match(html, /data-verb="clarify-dismiss"/)
  assert.match(html, /Mercury Bank<\/button>/) // the rival named by its human name
  assert.match(html, /data-rival-id="ent-mercury-bank"/)
  // #117 humans-not-robots: the ask carries NO model/endpoint/template id
  assert.doesNotMatch(html, /endpoint|model|template|tpl-|dst-/i)
})

test('a rival-less ambiguity offers confirm + dismiss only (the disambiguate write needs a rival id)', () => {
  const ask = clarifyAsk(ambiguous({ ambiguity: { rivalName: 'Mercury Bank' } }), 'ws', { suppressed: new Set(), expanded: 'ent-mercury' })
  const html = renderToHtml(ask!)
  assert.match(html, /data-verb="clarify-confirm"/)
  assert.doesNotMatch(html, /data-verb="clarify-rival"/) // no rival id ⇒ no unresolvable disambiguate button
  assert.match(html, /data-verb="clarify-dismiss"/)
})

test('heardForm prefers the latest ambiguous resolution surface form, else the entity name', () => {
  assert.equal(heardForm(ambiguous()), 'Mercury')
  assert.equal(heardForm(ambiguous({ resolutions: [] })), 'Mercury') // falls back to the name, never a robot id
})

// ---- integration through the real relevant-now renderer + surface ----
const rel = (e: Entity): RelevantEntity => ({ entity: e, score: 1, moments: [] })
const now: NowContext = { live: true }
const surface: Surface = {
  id: 'surf-openinfo-hud', name: 'HUD', context: 'meeting', version: 1,
  stack: [{ block: 'relevant-now', query: { source: 'relevant-now', params: {} }, actions: [] }],
}
const renderHud = (e: Entity, clarify?: { suppressed: ReadonlySet<string>; expanded?: string }): string =>
  renderToHtml(
    renderSurface(
      { surface, now, results: [{ source: 'relevant-now', items: [rel(e)], truncated: false }], ...(clarify ? { clarify } : {}) },
      defaultBlockRegistry,
    ),
  )

test('relevant-now grows the ≟ on an ambiguous row, expands the ask when open, and goes quiet once suppressed', () => {
  const collapsed = renderHud(ambiguous(), { suppressed: new Set() })
  assert.match(collapsed, /clarify-open/)
  assert.doesNotMatch(collapsed, /clarify-confirm/) // collapsed — no ask line yet

  const open = renderHud(ambiguous(), { suppressed: new Set(), expanded: 'ent-mercury' })
  assert.match(open, /clarify-confirm/)
  assert.match(open, /which one\?/)

  const suppressed = renderHud(ambiguous(), { suppressed: new Set(['ent-mercury']), expanded: 'ent-mercury' })
  assert.doesNotMatch(suppressed, /clarify-open/) // answered/dismissed this session ⇒ no ≟, no ask (ask-once)
  assert.doesNotMatch(suppressed, /clarify-confirm/)

  const confirmed = renderHud(settled(ambiguous({ state: 'confirmed' })))
  assert.doesNotMatch(confirmed, /clarify-open/) // a settled override ⇒ the ask is gone across reloads too
})
