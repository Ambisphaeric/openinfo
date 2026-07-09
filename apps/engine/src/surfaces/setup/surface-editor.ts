import type { Block, Surface } from '@openinfo/contracts'
import { BlockTypeName } from '@openinfo/contracts'
import { escapeHtml, jsonForScript } from './view.js'
import { SURFACE_EDITOR_CSS, SURFACE_EDITOR_SCRIPT } from './editor-assets.js'

/**
 * The HUD-layout editor — forms over surface DOCUMENTS (closing the HUD-customization gap).
 * Architecturally the HUD always was `render(surfaceDocument)`; this is the human affordance
 * to edit that document without hand-writing JSON. Engine-served on /setup?surface=<id>, mirroring how
 * the fabric editor opens a profile with ?edit=<id> — same page family, same discipline: this module is
 * PURE (given the live data it returns the page string, no I/O, no DOM), so every state is asserted
 * headless under node:test; the thin browser script (editor-assets.ts) composes only the existing
 * surface routes (GET/PUT /layouts/surfaces[/:id]) — no new engine capability, the P6 "forms over
 * documents" rule. This is the v0.5 forms editor, NOT the P6 WYSIWYG/drag-drop (still deferred).
 */

/** The append-only BlockTypeName union, as the editor's add-block picker. Derived from the contract. */
export const blockTypeNames = (): string[] =>
  (BlockTypeName.anyOf as ReadonlyArray<{ const: string }>).map((m) => m.const)

/**
 * A sensible default block for each type — the seed the "add block" picker splices in, mirroring the
 * shipped documents (defaults.ts / surface.hud-meeting.json): data blocks get a default query (params
 * stay as defaults — free-form query editing is out of scope), layout blocks get none. The user then
 * tunes top/collapsed/show through the form; params/use/actions/custom are preserved on save.
 */
export const defaultBlockFor = (type: string): Block => {
  switch (type) {
    case 'now':
      return { block: 'now' }
    case 'moments':
      return { block: 'moments', collapsed: false, query: { source: 'moments', params: { session: 'current' }, top: 20 } }
    case 'relevant-now':
      return { block: 'relevant-now', show: 'always', top: 4, query: { source: 'relevant-now', params: { session: 'current' }, top: 4 } }
    case 'ledger':
      return { block: 'ledger', show: 'on-match', top: 2, query: { source: 'ledger', params: {}, top: 2 } }
    case 'pinned-doc':
      return { block: 'pinned-doc', show: 'on-match', query: { source: 'pins', params: {}, top: 1 } }
    case 'hint':
      return { block: 'hint', show: 'on-match', query: { source: 'pins', params: {}, top: 1 } }
    case 'todos':
      return { block: 'todos', show: 'on-match', query: { source: 'todos', params: { session: 'current' }, top: 20 } }
    case 'drafts':
      return { block: 'drafts', show: 'on-match', query: { source: 'drafts', params: { session: 'current' }, top: 3 } }
    case 'teach':
      return { block: 'teach', show: 'on-match', query: { source: 'teach', params: {}, top: 5 } }
    case 'distillates':
      return { block: 'distillates', collapsed: false, query: { source: 'distillates', params: { session: 'current' }, top: 20 } }
    case 'ask':
      return { block: 'ask' }
    case 'custom':
      return { block: 'custom', show: 'manual', custom: { htmlEndpoint: '/custom/example.html' } }
    default:
      return { block: 'custom', custom: { htmlEndpoint: '/custom/example.html' } }
  }
}

/**
 * Honest "the backing store lands later" note for block types whose source has no store yet (same
 * present-but-future copy style the fabric slots use). Keyed by block type: ledger (P4). The pins store
 * has landed, so pinned-doc / hint now hydrate and carry no future-store note. Absent ⇒ no note.
 */
const FUTURE_STORE_NOTE: Record<string, string> = {
  ledger: 'ledger store lands in P4 — renders empty-but-explainable until then.',
}

/** A one-line summary of the fields the form does NOT expose but preserves verbatim on save. */
const preservedChips = (block: Block): string => {
  const chips: string[] = []
  if (block.query) chips.push(`source ${block.query.source}`)
  if (block.use) chips.push('use')
  if (block.actions?.length) chips.push(`${block.actions.length} action${block.actions.length === 1 ? '' : 's'}`)
  if (block.custom) chips.push('custom')
  return chips.length ? `<span class="bchips">${chips.map((c) => `<span class="bchip">${escapeHtml(c)}</span>`).join('')}</span>` : ''
}

const showOptions = (selected: string | undefined): string =>
  ['', 'always', 'on-match', 'manual']
    .map((v) => `<option value="${v}"${v === (selected ?? '') ? ' selected' : ''}>${v === '' ? '(show: default)' : `show: ${v}`}</option>`)
    .join('')

/** One editable block row. `data-idx` ties it back to the original block so save preserves it verbatim. */
export const blockRowHtml = (block: Block, index: number): string => {
  const hasQuery = block.query !== undefined
  const note = FUTURE_STORE_NOTE[block.block]
  const topValue = block.top ?? block.query?.top
  const topField = hasQuery
    ? `<label class="bfield">top <input class="b-top" type="number" min="1" max="50" value="${topValue ?? ''}" placeholder="—" /></label>`
    : ''
  return (
    `<div class="blockrow" data-idx="${index}" data-block="${escapeHtml(block.block)}">` +
    `<div class="bmove"><button type="button" data-act="block-up" title="move up">↑</button>` +
    `<button type="button" data-act="block-down" title="move down">↓</button></div>` +
    `<div class="bmain"><div class="btype">${escapeHtml(block.block)}${preservedChips(block)}</div>` +
    (note ? `<div class="bnote">${escapeHtml(note)}</div>` : '') +
    `<div class="bctrls">` +
    `<label class="bfield"><input class="b-collapsed" type="checkbox"${block.collapsed ? ' checked' : ''} /> collapsed</label>` +
    topField +
    `<select class="b-show" title="visibility">${showOptions(block.show)}</select>` +
    `</div></div>` +
    `<div class="bdel"><button type="button" data-act="block-remove" title="remove">✕</button></div>` +
    `</div>`
  )
}

/** The add-block picker: the BlockTypeName union as a select + an Add button (splices a default block). */
const addBlockHtml = (): string =>
  `<div class="addblock"><select id="add-block-type">` +
  blockTypeNames().map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('') +
  `</select><button type="button" data-act="block-add">+ add block</button></div>`

export interface SurfaceEditorData {
  /** the surface being edited */
  surface: Surface
  /** all surfaces (for the quick-switch list) */
  surfaces: Surface[]
  /** the surface id the HUD renders by default (client config; marked in the list) */
  defaultSurfaceId: string
}

/** The other-surfaces quick switch — links to edit each, marking the current + the HUD default. */
const otherSurfacesHtml = (data: SurfaceEditorData): string => {
  const items = data.surfaces
    .map((s) => {
      const current = s.id === data.surface.id
      const isDefault = s.id === data.defaultSurfaceId
      const badge = isDefault ? '<span class="badge active">HUD default</span>' : ''
      const label = `${escapeHtml(s.name)} <span class="pid">${escapeHtml(s.id)} · v${s.version}</span>`
      return current
        ? `<div class="srow current">${label}${badge}<span class="badge editing">editing</span></div>`
        : `<div class="srow">${label}${badge}<a href="/settings/hud-layout?surface=${encodeURIComponent(s.id)}">edit</a></div>`
    })
    .join('')
  return `<div class="card">${items}</div>`
}

/**
 * The whole self-contained HUD-layout editor page. Pure — the engine route hands it live data. The
 * base surface is embedded as a JSON blob; the browser rebuilds the surface on save by taking each
 * row's ORIGINAL block (by data-idx) and overwriting ONLY the form-managed fields (collapsed/top/show),
 * so query.params/use/actions/custom survive untouched (the round-trip guarantee). Added blocks come
 * from the embedded defaults map. A collapsed "advanced: raw JSON" textarea is the escape hatch.
 */
export const renderSurfaceEditorPage = (data: SurfaceEditorData): string => {
  const s = data.surface
  const isDefault = s.id === data.defaultSurfaceId
  const defaults: Record<string, Block> = {}
  for (const t of blockTypeNames()) defaults[t] = defaultBlockFor(t)
  const rows = s.stack.map((b, i) => blockRowHtml(b, i)).join('')
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8" />' +
    '<meta name="viewport" content="width=device-width, initial-scale=1" />' +
    '<title>openinfo · HUD layout</title>' +
    `<style>${SURFACE_EDITOR_CSS}</style></head><body>` +
    '<h1>openinfo · HUD layout</h1>' +
    '<p class="sub">The HUD is <span class="mono">render(surfaceDocument)</span> — edit that document here. ' +
    '<a href="/settings/hud-layout">← HUD layout</a></p>' +
    `<form id="surface-editor" data-id="${escapeHtml(s.id)}">` +
    `<div class="card"><div class="prow"><input id="surf-name" autocomplete="off" value="${escapeHtml(s.name)}" placeholder="surface name" />` +
    `<span class="pid">${escapeHtml(s.id)} · v${s.version} · context ${escapeHtml(s.context)}</span>` +
    (isDefault ? '<span class="badge active">HUD default</span>' : '') +
    '<span class="spacer"></span>' +
    '<button type="button" data-act="surface-clone">Clone</button>' +
    '<button type="button" class="primary" data-act="surface-save">Save</button></div></div>' +
    `<script type="application/json" id="base-surface">${jsonForScript(s)}</script>` +
    `<script type="application/json" id="block-defaults">${jsonForScript(defaults)}</script>` +
    `<h2>Blocks</h2><div id="blocks">${rows}</div>` +
    addBlockHtml() +
    '<details class="advanced" id="raw"><summary>Advanced — edit raw JSON</summary>' +
    '<p class="sub">The escape hatch: edit the whole document and Save from JSON. The form Save above ' +
    'preserves query params, actions, and use verbatim — this replaces them wholesale, so use it only ' +
    'when the form cannot express your edit.</p>' +
    `<textarea id="raw-json" spellcheck="false">${escapeHtml(JSON.stringify(s, null, 2))}</textarea>` +
    '<div class="rawbtns"><button type="button" data-act="surface-save-json">Save from JSON</button></div>' +
    '</details>' +
    '</form>' +
    '<h2>Other surfaces</h2>' +
    otherSurfacesHtml(data) +
    `<script>${SURFACE_EDITOR_SCRIPT}</script>` +
    '</body></html>'
  )
}
