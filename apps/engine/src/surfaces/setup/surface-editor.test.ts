import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Surface } from '@openinfo/contracts'
import { blockRowHtml, blockTypeNames, defaultBlockFor, renderSurfaceEditorPage } from './surface-editor.js'
import { hudLayoutSection } from './view.js'

const richSurface: Surface = {
  id: 'surf-rich', name: 'Rich HUD', context: 'deep-work', version: 3,
  stack: [
    { block: 'now' },
    {
      block: 'relevant-now', id: 'blk-rel', top: 4, show: 'always',
      query: { source: 'relevant-now', params: { session: 'current', k: 'v' }, top: 4 },
      use: { llm: 'llm.smart', register: 'reg-boardroom' },
      actions: [{ id: 'a1', label: 'Copy', verb: 'copy', params: {} }],
    },
    { block: 'ledger', show: 'on-match', top: 2, query: { source: 'ledger', params: {}, top: 2 } },
    { block: 'custom', id: 'blk-c', show: 'manual', custom: { htmlEndpoint: '/custom/x.html' } },
  ],
}

/** Pull an embedded JSON blob back out (jsonForScript only neutralizes `<`, none here → parseable). */
const blob = (html: string, id: string): unknown => {
  const m = html.match(new RegExp(`id="${id}">([^]*?)</script>`))
  assert.ok(m, `blob ${id} missing`)
  return JSON.parse(m![1]!)
}

test('blockTypeNames enumerates the append-only BlockTypeName union', () => {
  assert.deepEqual(blockTypeNames(), ['now', 'moments', 'relevant-now', 'ledger', 'pinned-doc', 'hint', 'ask', 'todos', 'drafts', 'teach', 'distillates', 'fields', 'queue', 'transcript-inspector', 'sense-gates', 'custom'])
})

test('defaultBlockFor gives sensible per-type seeds mirroring the shipped docs', () => {
  assert.deepEqual(defaultBlockFor('now'), { block: 'now' })
  assert.deepEqual(defaultBlockFor('moments').query, { source: 'moments', params: { session: 'current' }, top: 20 })
  const rel = defaultBlockFor('relevant-now')
  assert.equal(rel.show, 'always')
  assert.deepEqual(rel.query, { source: 'relevant-now', params: { session: 'current' }, top: 4 })
  assert.equal(defaultBlockFor('ledger').query?.source, 'ledger')
  assert.equal(defaultBlockFor('pinned-doc').query?.source, 'pins')
  assert.equal(defaultBlockFor('hint').query?.source, 'pins')
  assert.equal(defaultBlockFor('ask').query, undefined)
  assert.equal(defaultBlockFor('todos').query?.source, 'todos')
  assert.equal(defaultBlockFor('todos').show, 'on-match')
  assert.equal(defaultBlockFor('drafts').query?.source, 'drafts')
  assert.equal(defaultBlockFor('drafts').show, 'on-match')
  assert.equal(defaultBlockFor('teach').query?.source, 'teach')
  assert.equal(defaultBlockFor('teach').show, 'on-match')
  assert.equal(defaultBlockFor('distillates').query?.source, 'distillates')
  assert.equal(defaultBlockFor('distillates').query?.params['session'], 'current')
  assert.equal(defaultBlockFor('fields').query?.source, 'fields')
  assert.equal(defaultBlockFor('fields').show, 'on-match')
  assert.equal(defaultBlockFor('queue').query?.source, 'queue')
  assert.equal(defaultBlockFor('queue').show, 'always')
  assert.equal(defaultBlockFor('custom').custom?.htmlEndpoint, '/custom/example.html')
})

test('blockRowHtml renders the per-block controls and reflects current values', () => {
  const row = blockRowHtml({ block: 'moments', collapsed: true, query: { source: 'moments', params: {}, top: 7 } }, 2)
  assert.match(row, /data-idx="2"/)
  assert.match(row, /data-act="block-up"/)
  assert.match(row, /data-act="block-down"/)
  assert.match(row, /data-act="block-remove"/)
  assert.match(row, /class="b-collapsed" type="checkbox" checked/) // collapsed on
  assert.match(row, /class="b-top" type="number" min="1" max="50" value="7"/) // top bounded, prefilled
  assert.match(row, /class="b-show"/)
  // a layout block with no query has no top field
  assert.doesNotMatch(blockRowHtml({ block: 'now' }, 0), /class="b-top"/)
})

test('blockRowHtml notes future-store block types and chips preserved fields', () => {
  assert.match(blockRowHtml({ block: 'ledger', query: { source: 'ledger', params: {} } }, 0), /ledger store lands in P4/)
  // the pins store has landed (#8) → pinned-doc hydrates and carries no future-store note
  assert.doesNotMatch(blockRowHtml({ block: 'pinned-doc', query: { source: 'pins', params: {} } }, 0), /lands in P/)
  // the preserved (form-invisible) fields are surfaced as chips so the user knows they survive
  const rel = blockRowHtml(richSurface.stack[1]!, 1)
  assert.match(rel, /source relevant-now/)
  assert.match(rel, /bchip">use/)
  assert.match(rel, /1 action/)
  assert.match(blockRowHtml(richSurface.stack[3]!, 3), /bchip">custom/)
})

test('renderSurfaceEditorPage embeds the base surface verbatim (use/actions/custom) + the defaults map', () => {
  const html = renderSurfaceEditorPage({ surface: richSurface, surfaces: [richSurface], defaultSurfaceId: 'surf-openinfo-hud' })
  // the round-trip mechanism: the whole document is embedded, and each row ties back via data-idx
  const base = blob(html, 'base-surface') as Surface
  assert.deepEqual(base, richSurface) // nothing dropped — use/actions/custom/params all present
  assert.match(html, /data-idx="0"/)
  assert.match(html, /data-idx="3"/)
  // the defaults map (for added blocks) carries one entry per union member
  const defs = blob(html, 'block-defaults') as Record<string, unknown>
  assert.deepEqual(Object.keys(defs).sort(), blockTypeNames().slice().sort())
  // the add-block picker offers every type; save + clone affordances present
  assert.match(html, /id="add-block-type"/)
  for (const t of blockTypeNames()) assert.match(html, new RegExp(`<option value="${t}"`))
  assert.match(html, /data-act="surface-save"/)
  assert.match(html, /data-act="surface-clone"/)
  assert.match(html, /data-act="surface-save-json"/) // the raw-JSON escape hatch
  assert.match(html, /id="raw-json"/)
  // rename field seeded with the current name
  assert.match(html, /id="surf-name" autocomplete="off" value="Rich HUD"/)
})

test('renderSurfaceEditorPage marks the HUD default + the surface being edited in the switch list', () => {
  const other: Surface = { ...richSurface, id: 'surf-openinfo-hud', name: 'openinfo HUD' }
  const html = renderSurfaceEditorPage({ surface: richSurface, surfaces: [richSurface, other], defaultSurfaceId: 'surf-openinfo-hud' })
  assert.match(html, /class="srow current"[^]*Rich HUD[^]*editing/)
  assert.match(html, /HUD default/)
  assert.match(html, /href="\/settings\/hud-layout\?surface=surf-openinfo-hud"/)
})

test('hudLayoutSection lists surfaces, marks the HUD default, and links each to its editor', () => {
  const s2: Surface = { ...richSurface, id: 'surf-openinfo-hud', name: 'openinfo HUD' }
  const html = hudLayoutSection([richSurface, s2], 'surf-openinfo-hud')
  assert.match(html, /Rich HUD/)
  assert.match(html, /href="\/settings\/hud-layout\?surface=surf-rich"/)
  assert.match(html, /openinfo HUD[^]*HUD default/)
  assert.equal(hudLayoutSection([], 'surf-openinfo-hud'), '')
})
