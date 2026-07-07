import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Entity, Moment, QueryResult, RelevantEntity, Surface } from '@openinfo/contracts'
import { renderSurface, renderToHtml, type NowContext } from './index.js'
import { defaultBlockRegistry } from '../blocks/index.js'

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

test('an unknown/future block type degrades via the custom fallback instead of breaking the render', () => {
  const surface: Surface = {
    id: 's', name: 's', context: 'any', version: 1,
    stack: [{ block: 'now' }, { block: 'pinned-doc', query: { source: 'pins', params: { doc: 'soc2' } } }],
  }
  const html = renderToHtml(renderSurface({ surface, now: { live: false }, results: [undefined, result('pins', [])] }, defaultBlockRegistry))
  assert.match(html, /class="livedot off"/) // no live session → dead heartbeat
  assert.match(html, /soc2/) // pinned-doc shows its configured reference (ingestion is P3)
})
