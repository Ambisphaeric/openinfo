import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Entity, Moment, QueryResult, RelevantEntity, Surface } from '@openinfo/contracts'
import { renderSurface, renderToHtml, clockLabel, type NowContext } from './index.js'
import { defaultBlockRegistry } from '../blocks/index.js'

// clockLabel renders viewer-local; pin this process to UTC so the integration assertions below are
// stable on any host. The seam itself (explicit-zone parameterisation) is proven directly further down.
process.env.TZ = 'UTC'

const entity = (kind: Entity['kind'], name: string, mentions: number): Entity => ({
  id: `ent-${name}`, workspaceId: 'ws', kind, name, aliases: [], momentRefs: [], outboundCount: 0, mentions,
  firstSeen: '2026-07-07T14:00:00Z', lastSeen: '2026-07-07T14:40:00Z',
})
const moment = (kind: Moment['kind'], text: string, at: string, extra: Partial<Moment> = {}): Moment => ({
  id: `mom-${text}`, sessionId: 'ses', workspaceId: 'ws', at, kind, text, refs: [], source: 'mic', confidence: 0.8, ...extra,
})
const rel = (e: Entity, moments: Moment[]): RelevantEntity => ({ entity: e, score: 1, moments })
const result = (source: QueryResult['source'], items: unknown[]): QueryResult => ({ source, items, truncated: false })

const hudSurface: Surface = {
  id: 'surf-openinfo-hud', name: 'openinfo HUD', context: 'meeting', version: 1,
  stack: [
    { block: 'now' },
    {
      block: 'relevant-now', top: 2, show: 'always',
      query: { source: 'relevant-now', params: {}, top: 4 },
      actions: [
        { id: 'a-copy', label: 'Copy', verb: 'copy', params: {} },
        { id: 'a-open', label: 'Open', verb: 'open', params: {} },
      ],
    },
    { block: 'moments', query: { source: 'moments', params: {} } },
  ],
}

const now: NowContext = { live: true, workspace: 'acme', title: 'Renewal — security review', topic: 'derived-data retention', elapsed: '2:47p · 31m' }

test('renderSurface is document-driven: renders the HUD stack with glyphs, why-lines and actions', () => {
  const relItems = [
    rel(entity('person', 'Dana', 4), [moment('question', 'can you guarantee 30-day deletion?', '2026-07-07T14:43:00Z')]),
    rel(entity('artifact', 'SOC 2 report', 3), [moment('artifact', 'SOC 2 referenced again', '2026-07-07T14:41:00Z')]),
    rel(entity('topic', 'retention', 2), []),
  ]
  const moItems = [
    moment('commitment', 'written answer to Dana by Thursday', '2026-07-07T14:44:00Z', { speaker: 'You' }),
    moment('question', 'guarantee derived-data deletion?', '2026-07-07T14:43:00Z'),
    moment('decision', 'redlines route through legal', '2026-07-07T14:36:00Z'),
    moment('artifact', 'SOC 2 report referenced', '2026-07-07T14:41:00Z'),
  ]
  const html = renderToHtml(
    renderSurface({ surface: hudSurface, now, results: [undefined, result('relevant-now', relItems), result('moments', moItems)] }, defaultBlockRegistry),
  )

  // panel + now block: the one place context is named, the heartbeat, the Now line
  assert.match(html, /class="hud"/)
  assert.match(html, /class="ws">acme \//)
  assert.match(html, /Renewal — security review/)
  assert.match(html, /class="livedot"/) // live (not .off)
  assert.match(html, /class="nowline">Now: <b>derived-data retention<\/b>/)
  assert.match(html, /2:47p · 31m/)

  // relevant-now: entity glyphs ◉ person / ✱ artifact, top:2 caps the list (topic row dropped)
  assert.match(html, /class="mk p">◉/)
  assert.match(html, /class="mk a">✱/)
  assert.doesNotMatch(html, /retention<\/span>/) // 3rd row cut by top:2
  assert.equal((html.match(/class="rel"/g) ?? []).length, 2)
  // every card states its why, built from real index data (mentions + latest moment)
  assert.match(html, /Referenced 4× · can you guarantee 30-day deletion\?/)

  // actions: copy is wired (data-copy present), open is inert (ghost, no data-copy)
  assert.match(html, /<button class="mini" data-verb="copy" data-action="a-copy" data-copy="Dana — Referenced 4×/)
  assert.match(html, /<button class="mini ghost" data-verb="open" data-action="a-open">Open<\/button>/)

  // moments: the four typed glyphs, newest-first clock labels, speaker bold, unanswered marker
  assert.match(html, /class="g mk c">●/)
  assert.match(html, /class="g mk q">◆/)
  assert.match(html, /class="g mk d">▲/)
  assert.match(html, /class="g mk a">✱/)
  assert.match(html, /class="t">2:44p<\/span><span class="g mk c">●<\/span><span class="x"><b>You: <\/b>/)
  assert.match(html, /class="unans">unanswered/)
})

test('show/collapsed/top are honoured, and two different documents produce two different layouts', () => {
  // on-match with an empty result hides the block; collapsed renders only the group label
  const onMatchSurface: Surface = {
    id: 's', name: 's', context: 'meeting', version: 1,
    stack: [
      { block: 'relevant-now', show: 'on-match', query: { source: 'relevant-now', params: {} } },
      { block: 'moments', collapsed: true, query: { source: 'moments', params: {} } },
    ],
  }
  const html = renderToHtml(
    renderSurface({ surface: onMatchSurface, now, results: [result('relevant-now', []), result('moments', [moment('decision', 'x', '2026-07-07T14:00:00Z')])] }, defaultBlockRegistry),
  )
  assert.doesNotMatch(html, /Relevant now/) // hidden: on-match + no items
  assert.match(html, /Moments · this session/) // collapsed: label present
  assert.doesNotMatch(html, /streamwrap/) // collapsed: body absent

  // the SAME renderer + registry, a DIFFERENT document → a different layout (no HUD-specific branching)
  const glass: Surface = {
    id: 'surf-glass-minimal', name: 'Glass Minimal', context: 'any', version: 1,
    stack: [{ block: 'now' }, { block: 'moments', collapsed: true, query: { source: 'moments', params: {} } }],
  }
  const glassHtml = renderToHtml(renderSurface({ surface: glass, now, results: [undefined, result('moments', [])] }, defaultBlockRegistry))
  assert.match(glassHtml, /class="hud"/)
  assert.doesNotMatch(glassHtml, /Relevant now/)
  assert.notEqual(glassHtml, renderToHtml(renderSurface({ surface: hudSurface, now, results: [undefined, result('relevant-now', []), result('moments', [])] }, defaultBlockRegistry)))
})

test('a pinned-doc block renders the hydrated pin from the store, and hides (on-match) when it is empty', () => {
  // The render half of the pins reconnect (#8 wired the store): the pinned-doc renderer now reads the
  // hydrated `result.items` — one row per Pin with its store-derived title, kind and ingest state — not
  // the static `query.params.doc`. The configured reference stays only as the empty/fallback body.
  const surface: Surface = {
    id: 's', name: 's', context: 'meeting', version: 1,
    stack: [{ block: 'now' }, { block: 'pinned-doc', show: 'on-match', query: { source: 'pins', params: { doc: 'configured placeholder' } }, actions: [{ id: 'a-copy', label: 'Copy', verb: 'copy', params: {} }] }],
  }
  // the seeded pin's title deliberately differs from `params.doc` so a pass proves store-derived content
  const soc2Pin = { id: 'pin-soc2', workspaceId: 'ws', uri: 'file:///soc2.pdf', title: 'SOC 2 Type II report', kind: 'pdf', ingest: { status: 'ingested', pages: 42 }, createdAt: '2026-07-07T14:00:00Z' }

  // hydrated: the on-match block becomes visible and renders the PIN's title (not the configured doc)
  const hydrated = renderToHtml(renderSurface({ surface, now: { live: true }, results: [undefined, result('pins', [soc2Pin])] }, defaultBlockRegistry))
  assert.match(hydrated, /Pinned/)
  assert.match(hydrated, /SOC 2 Type II report/) // store-derived title
  assert.doesNotMatch(hydrated, /configured placeholder/) // the static reference is NOT what rendered
  assert.match(hydrated, /ingested · 42 pages/) // why-line built from the Pin's ingest state
  assert.match(hydrated, /data-copy="SOC 2 Type II report — file:\/\/\/soc2\.pdf"/) // copy carries title + uri

  // empty backing store: on-match + zero items hides the block — explainable-empty, never a broken card
  const empty = renderToHtml(renderSurface({ surface, now: { live: true }, results: [undefined, result('pins', [])] }, defaultBlockRegistry))
  assert.doesNotMatch(empty, /Pinned/)
})

test('relevant-now why line (#117): recorded provenance renders a HUMAN source+recency why (no endpoint/model), else the mention/moment heuristic, and a why-less row renders no card', () => {
  // A block over relevant-now with no cap — one card per row that can state a why.
  const surface: Surface = {
    id: 's', name: 's', context: 'meeting', version: 1,
    stack: [{ block: 'relevant-now', show: 'always', query: { source: 'relevant-now', params: {} } }],
  }

  // Row 1: the pipeline RECORDED provenance on the entity (endpoint/model/window in the DATA) → the HUD
  // why line derives from that trail but states only the human slice: source kind (heard) + when. It must
  // NOT leak the endpoint or model id (#117) and must NOT re-guess a mention count.
  const withProvenance: RelevantEntity = {
    entity: { ...entity('person', 'Dana', 9), provenance: [
      { slot: 'llm', endpoint: 'distill-fast', model: 'qwen3-4b', windowStart: '2026-07-07T14:40:00Z', windowEnd: '2026-07-07T14:43:00Z' },
      { slot: 'llm', endpoint: 'distill-fast', model: 'qwen3-4b', windowStart: '2026-07-07T14:43:00Z', windowEnd: '2026-07-07T14:46:00Z' },
    ] },
    score: 1, moments: [moment('question', 'guarantee 30-day deletion?', '2026-07-07T14:45:00Z')],
  }
  // Row 2: a SEEN entity — its typed sighting names the source kind ("on screen"), recency from its trail.
  const seenEntity: RelevantEntity = {
    entity: { ...entity('artifact', 'dashboard.png', 2),
      sightings: [{ via: 'seen', at: '2026-07-07T14:44:00Z' }],
      provenance: [{ slot: 'vlm', endpoint: 'ocr-local', model: 'florence-2', windowEnd: '2026-07-07T14:44:00Z' }] },
    score: 1, moments: [],
  }
  // Row 3: no recorded trail anywhere (Phase-0 row) → falls back to the mention + latest-moment heuristic.
  const withoutProvenance = rel(entity('artifact', 'SOC 2 report', 3), [moment('artifact', 'SOC 2 referenced again', '2026-07-07T14:41:00Z')])
  // Row 4: no provenance, no mentions, no moments, an UNPARSEABLE lastSeen → can state no why → no card.
  const whyless: RelevantEntity = { entity: { ...entity('topic', 'ghost', 0), lastSeen: 'not-a-date' }, score: 0, moments: [] }

  const html = renderToHtml(renderSurface(
    { surface, now, results: [result('relevant-now', [withProvenance, seenEntity, withoutProvenance, whyless])] },
    defaultBlockRegistry,
  ))

  // recorded-provenance path: human source kind + most-recent window end (2:46p), NO mention-count phrasing
  assert.match(html, /class="why">heard · 2:46p<\/span>/)
  // seen path: the typed sighting drives "on screen" + its recency
  assert.match(html, /class="why">on screen · 2:44p<\/span>/)
  assert.doesNotMatch(html, /Referenced 9×/)
  // #117 REGRESSION: the HUD-tier render must not leak any endpoint, model id, or template id, nor the
  // old `via …` machine phrasing — the full trail stays on diagnostics surfaces + the ledger, not here.
  assert.doesNotMatch(html, /distill-fast|qwen3-4b|ocr-local|florence-2/)
  assert.doesNotMatch(html, /class="why">via /)
  // heuristic fallback path for the row with no recorded trail
  assert.match(html, /Referenced 3× · SOC 2 referenced again/)
  // display rule #1: the why-less row is DROPPED, only the three whyable rows render cards
  assert.doesNotMatch(html, /ghost<\/span>/)
  assert.equal((html.match(/class="rel"/g) ?? []).length, 3)
})

test('relevant-now #66 state dot (#73): renders ONLY for an entity carrying a resolution `state`, none otherwise', () => {
  const surface: Surface = {
    id: 's', name: 's', context: 'meeting', version: 1,
    stack: [{ block: 'relevant-now', show: 'always', query: { source: 'relevant-now', params: {} } }],
  }
  // A user-confirmed entity carries state:'confirmed' → a real dot lights up (no new renderer work — the
  // field threads through the query source into the existing #66 micro-state carrier).
  const confirmed: RelevantEntity = rel(
    { ...entity('person', 'Sam Rivera', 4), state: 'confirmed', confidence: 1 },
    [moment('question', 'can Sam ship by Friday?', '2026-07-07T14:43:00Z')],
  )
  // An unresolved entity (plain extraction, no resolver) carries NO state → NO dot (nothing pretends resolved).
  const unresolved = rel(entity('artifact', 'SOC 2 report', 3), [moment('artifact', 'SOC 2 referenced again', '2026-07-07T14:41:00Z')])

  const html = renderToHtml(renderSurface(
    { surface, now, results: [result('relevant-now', [confirmed, unresolved])] },
    defaultBlockRegistry,
  ))
  assert.match(html, /class="dot confirmed" title="confirmed"/) // the confirmed row lights its dot
  assert.equal((html.match(/class="dot/g) ?? []).length, 1) // and ONLY that row — the unresolved row has none
})

test('an unknown/future block type degrades via the custom fallback instead of breaking the render', () => {
  const surface: Surface = {
    id: 's', name: 's', context: 'any', version: 1,
    stack: [{ block: 'now' }, { block: 'pinned-doc', query: { source: 'pins', params: { doc: 'soc2' } } }],
  }
  const html = renderToHtml(renderSurface({ surface, now: { live: false }, results: [undefined, result('pins', [])] }, defaultBlockRegistry))
  assert.match(html, /class="livedot off"/) // no live session → dead heartbeat
  assert.match(html, /soc2/) // empty pins store → pinned-doc falls back to its configured reference
})

test('clockLabel renders in the viewer timezone: one instant, two explicit zones, two clocks (#55)', () => {
  const iso = '2026-07-07T14:44:00Z'
  // Same instant, different wall-clocks — the seam that lets a human read local time, not UTC.
  assert.equal(clockLabel(iso, 'UTC'), '2:44p')
  assert.equal(clockLabel(iso, 'America/New_York'), '10:44a') // UTC-4 in July
  assert.notEqual(clockLabel(iso, 'UTC'), clockLabel(iso, 'America/New_York'))
  // shape is preserved for edge instants: midnight/noon read 12, minutes stay 2-digit
  assert.equal(clockLabel('2026-07-07T00:05:00Z', 'UTC'), '12:05a')
  assert.equal(clockLabel('2026-07-07T12:00:00Z', 'UTC'), '12:00p')
  assert.equal(clockLabel('not-a-date', 'UTC'), '') // unparseable stays empty
})
