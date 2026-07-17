import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Entity, RelevantEntity, Surface } from '@openinfo/contracts'
import { renderSurface, renderToHtml, type NowContext } from '../block-renderer/index.js'
import { defaultBlockRegistry } from './index.js'

/**
 * copy-value-only regression (#118): the copy affordance puts EXACTLY the entity value on the clipboard —
 * `entity.name` — never the display why-line (source kind + recency). The why is display context, already
 * rendered on the row; provenance/recency stays on the row and the inspection surfaces, never in the copy
 * payload. This pins the fix for the rig defect where clicking Copy on a link put `mylink.com — heard ·
 * 7:57p` on the clipboard: the "— heard …" metadata rode into the payload.
 */

const now: NowContext = { live: true }

// A link entity carrying a recorded heard trail, so its why-line reads "heard · <clock>".
const linkEntity: Entity = {
  id: 'ent-link', workspaceId: 'ws', kind: 'artifact', name: 'mylink.com',
  aliases: [], momentRefs: [], outboundCount: 0, mentions: 3,
  firstSeen: '2026-07-16T19:57:00Z', lastSeen: '2026-07-16T19:57:00Z',
  provenance: [{ slot: 'llm', endpoint: 'dev-mac-omlx', windowEnd: '2026-07-16T19:57:00Z' }],
  sightings: [{ via: 'heard', at: '2026-07-16T19:57:00Z' }],
}

const rel = (e: Entity): RelevantEntity => ({ entity: e, score: 1, moments: [] })

const surface: Surface = {
  id: 'surf-openinfo-hud', name: 'HUD', context: 'meeting', version: 1,
  stack: [
    {
      block: 'relevant-now', show: 'always',
      query: { source: 'relevant-now', params: {} },
      actions: [{ id: 'a-copy', label: 'Copy', verb: 'copy', params: {} }],
    },
  ],
}

const renderHud = (e: Entity): string =>
  renderToHtml(
    renderSurface(
      { surface, now, results: [{ source: 'relevant-now', items: [rel(e)], truncated: false }] },
      defaultBlockRegistry,
    ),
  )

/** Pull the copy payload the mount layer would read for the first live copy button. */
const copyPayload = (html: string): string | undefined => html.match(/data-copy="([^"]*)"/)?.[1]

test('relevant-now copy payload is the entity VALUE ONLY — the why-line never rides in', () => {
  const html = renderHud(linkEntity)
  // The row still DISPLAYS its why (source kind + recency) — display context is not removed…
  assert.match(html, /heard/)
  // …but the clipboard payload is exactly the bare value.
  const payload = copyPayload(html)
  assert.equal(payload, 'mylink.com')
  // A hard guard against re-appending metadata: no em-dash join, no why-line text in the payload.
  assert.doesNotMatch(payload ?? '', /—/) // no "name — why" decoration
  assert.doesNotMatch(payload ?? '', /heard| · /) // no source kind / recency separator
})

test('relevant-now heuristic-why row also copies the bare value (no "Referenced 3×" decoration)', () => {
  // No recorded trail ⇒ the heuristic why-line ("Referenced 3× · last seen …"). It must still not leak.
  const { provenance: _p, sightings: _s, ...bare } = linkEntity
  const html = renderHud(bare as Entity)
  const payload = copyPayload(html)
  assert.equal(payload, 'mylink.com')
  assert.doesNotMatch(payload ?? '', /Referenced|—| · /)
})
