import type { Endpoint, Fabric, FabricProfile } from '@openinfo/contracts'
import { SETUP_CSS, SETUP_SCRIPT } from './assets.js'

/**
 * The setup surface — forms over the profile + secret documents (ARCHITECTURE §8), served by the
 * engine as a self-contained HTML page (GET /setup). This module is PURE: given the live data it
 * returns the page string, with no I/O and no DOM — so the first-run logic and the rendered skeleton
 * are asserted headless under node:test, mirroring the client's pure-renderer discipline. The
 * interactive behaviour is the thin browser script in assets.ts; it only composes existing routes
 * (profiles CRUD/clone/activate, secrets write/delete/list-refs, /fabric, /fabric/test) — no new
 * engine capability, per the P6 "forms over documents" rule.
 *
 * A user's rig is never their last (config 1 → clone → a 27B on another host → STT elsewhere): this
 * page names/clones/activates profiles and wires slot→endpoint rows across hosts. It is deliberately
 * barebones — the FIRST setting, not a settings empire.
 */

/** The slots that actually drive processing today (fully editable); the rest are shown inert. */
const LIVE_SLOTS: ReadonlyArray<keyof Fabric['slots']> = ['llm', 'stt']
const INERT_SLOTS: ReadonlyArray<keyof Fabric['slots']> = ['tts', 'vlm', 'ocr', 'embed']

const INERT_NOTE: Record<string, string> = {
  tts: 'text-to-speech — not wired to processing yet (P5 whisper chain).',
  vlm: 'vision — not wired yet.',
  ocr: 'screen OCR — not wired yet (P3).',
  embed: 'embeddings — not wired yet (P3 recall/vector search).',
}

export interface SetupData {
  /** All fabric profiles (latest version of each). */
  profiles: FabricProfile[]
  /** The active profile id (the live fabric), or undefined when none is active. */
  activeId: string | undefined
  /** The LIVE fabric (active profile's map, else legacy/empty) — drives the first-run notice. */
  liveFabric: Fabric
  /** The profile currently open in the editor; undefined ⇒ the editor edits the legacy live fabric. */
  editing: FabricProfile | undefined
  /** Stored secret refs (names only — values are never sent to a UI). */
  secretRefs: string[]
}

/** Escape for safe interpolation into HTML text or a (single- or double-quoted) attribute. */
export const escapeHtml = (raw: string): string =>
  raw.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

/**
 * The plain-language first-run notice: when the LIVE fabric's llm slot is empty, nothing can
 * distill, so the page says so at the top — the page IS the onboarding. Returns null once an llm
 * endpoint exists (nothing to nag about). Pure and exported so it is asserted directly.
 */
export const firstRunNotice = (liveFabric: Fabric): string | null =>
  liveFabric.slots.llm.length === 0
    ? 'Nothing configured yet — distill won’t run until an llm endpoint exists. Add one to a profile below and activate it.'
    : null

const keyrefOptions = (selected: string | undefined, refs: string[]): string =>
  ['<option value="">(no key)</option>']
    .concat(refs.map((r) => `<option value="${escapeHtml(r)}"${r === selected ? ' selected' : ''}>${escapeHtml(r)}</option>`))
    .join('')

/** One editable endpoint row. http endpoints get fields; other kinds are read-only but round-trip. */
const endpointRowHtml = (ep: Endpoint, refs: string[]): string => {
  if (ep.kind !== 'http') {
    return (
      `<div class="row readonly" data-kind="${escapeHtml(ep.kind)}" data-json='${escapeHtml(JSON.stringify(ep))}'>` +
      `<span class="ro">${escapeHtml(ep.kind)}: ${escapeHtml(ep.name)} — edit ${escapeHtml(ep.kind)} endpoints via the API</span>` +
      `<div class="rowbtns"><button data-act="up" title="up">↑</button><button data-act="down" title="down">↓</button><button data-act="remove" title="remove">✕</button></div>` +
      `</div>`
    )
  }
  return (
    `<div class="row" data-kind="http" data-api="${escapeHtml(ep.api)}">` +
    `<input class="f-name" value="${escapeHtml(ep.name)}" placeholder="name" />` +
    `<input class="f-url" value="${escapeHtml(ep.url)}" placeholder="http://host:port" />` +
    `<input class="f-model" value="${escapeHtml(ep.model ?? '')}" placeholder="model (optional)" />` +
    `<select class="f-keyref" title="key reference">${keyrefOptions(ep.auth?.keyRef, refs)}</select>` +
    `<div class="rowbtns"><button data-act="test">Test</button><button data-act="up" title="up">↑</button>` +
    `<button data-act="down" title="down">↓</button><button data-act="remove" title="remove">✕</button></div>` +
    `<div class="probe"></div></div>`
  )
}

const liveSlotHtml = (key: string, endpoints: Endpoint[], refs: string[]): string =>
  `<div class="slot" data-slot="${escapeHtml(key)}">` +
  `<div class="slk">${escapeHtml(key)}</div>` +
  `<div class="rows">${endpoints.map((ep) => endpointRowHtml(ep, refs)).join('')}</div>` +
  `<div style="margin-top:9px"><button data-act="addrow" data-slot="${escapeHtml(key)}">+ add endpoint</button></div>` +
  `</div>`

const inertSlotHtml = (key: string, endpoints: Endpoint[]): string =>
  `<div class="slot">` +
  `<div class="slk">${escapeHtml(key)}</div>` +
  `<div class="note">${escapeHtml(INERT_NOTE[key] ?? 'not wired yet.')}` +
  (endpoints.length ? ` <span class="mono">(${endpoints.length} endpoint${endpoints.length === 1 ? '' : 's'} kept)</span>` : '') +
  `</div></div>`

/** The profile list: name/id/description, the active + editing badges, and the per-profile actions. */
const profilesHtml = (data: SetupData): string => {
  if (data.profiles.length === 0) return '<div class="sub">No profiles yet — editing the live fabric directly below.</div>'
  return data.profiles
    .map((p) => {
      const isActive = p.id === data.activeId
      const isEditing = data.editing?.id === p.id
      const badges =
        (isActive ? '<span class="badge active">active · live</span>' : '') +
        (isEditing ? '<span class="badge editing">editing</span>' : '')
      const actions =
        (isActive ? '' : `<button data-act="activate" data-id="${escapeHtml(p.id)}">Activate</button>`) +
        `<button data-act="clone" data-id="${escapeHtml(p.id)}">Clone</button>` +
        (isEditing ? '' : `<a href="/setup?edit=${encodeURIComponent(p.id)}">edit</a>`) +
        (isActive ? '' : `<button data-act="delete" data-id="${escapeHtml(p.id)}">Delete</button>`)
      return (
        `<div class="card"><div class="prow">` +
        `<span class="pname">${escapeHtml(p.name)}</span> <span class="pid">${escapeHtml(p.id)} · v${p.version}</span>` +
        badges +
        `<span class="spacer"></span>${actions}</div>` +
        (p.description ? `<div class="pdesc">${escapeHtml(p.description)}</div>` : '') +
        `</div>`
      )
    })
    .join('')
}

/** The editor: edits `editing.fabric` (a profile) or the legacy live fabric when no profile is open. */
const editorHtml = (data: SetupData): string => {
  const editing = data.editing
  const fabric = editing ? editing.fabric : data.liveFabric
  const refs = data.secretRefs
  const target = editing
    ? `<span class="mono">${escapeHtml(editing.name)} (${escapeHtml(editing.id)} · v${editing.version})</span>`
    : '<span class="mono">the live fabric (no profile active)</span>'
  const meta = editing
    ? escapeHtml(JSON.stringify({ id: editing.id, name: editing.name, version: editing.version, description: editing.description }))
    : ''
  const base = escapeHtml(JSON.stringify(fabric))
  const live = LIVE_SLOTS.map((k) => liveSlotHtml(k, fabric.slots[k], refs)).join('')
  const inert = INERT_SLOTS.map((k) => inertSlotHtml(k, fabric.slots[k])).join('')
  return (
    `<form id="editor" data-target-id="${editing ? escapeHtml(editing.id) : ''}" data-profile='${meta}'>` +
    `<div class="sub">Editing ${target}. Add/reorder endpoints, wire a key by reference, then Save.</div>` +
    `<script type="application/json" id="base-fabric">${base}</script>` +
    live +
    inert +
    `<div style="margin-top:12px"><button class="primary" data-act="save">Save profile</button></div>` +
    `</form>`
  )
}

const secretsHtml = (refs: string[]): string => {
  const list = refs.length
    ? refs
        .map(
          (r) =>
            `<div class="row"><span class="ro">${escapeHtml(r)}</span><div class="rowbtns">` +
            `<button data-act="delsecret" data-ref="${escapeHtml(r)}">Forget</button></div></div>`,
        )
        .join('')
    : '<div class="note" style="color:var(--faint)">No keys stored. Values are write-only — never shown here.</div>'
  return (
    `<div class="card secrets"><div class="slk" style="color:var(--accent)">keys (by reference)</div>` +
    list +
    `<div class="row" style="border-top:1px solid var(--line);margin-top:6px;padding-top:10px">` +
    `<input id="secret-ref" placeholder="keyRef (e.g. remote-llm-key)" />` +
    `<input id="secret-val" type="password" placeholder="value (stored, never re-shown)" />` +
    `<div class="rowbtns"><button data-act="addsecret">Add key</button></div></div></div>`
  )
}

/** The hidden <template> the browser clones for a fresh endpoint row (keyRef options current). */
const rowTemplateHtml = (refs: string[]): string =>
  `<template id="row-tpl">` +
  `<div class="row" data-kind="http" data-api="openai-compat">` +
  `<input class="f-name" placeholder="name" /><input class="f-url" placeholder="http://host:port" />` +
  `<input class="f-model" placeholder="model (optional)" />` +
  `<select class="f-keyref" title="key reference">${keyrefOptions(undefined, refs)}</select>` +
  `<div class="rowbtns"><button data-act="test">Test</button><button data-act="up" title="up">↑</button>` +
  `<button data-act="down" title="down">↓</button><button data-act="remove" title="remove">✕</button></div>` +
  `<div class="probe"></div></div></template>`

/** Render the whole self-contained setup page. Pure — the engine route just hands it live data. */
export const renderSetupPage = (data: SetupData): string => {
  const notice = firstRunNotice(data.liveFabric)
  const banner = notice ? `<div class="banner">⚠ ${escapeHtml(notice)}</div>` : ''
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8" />' +
    '<meta name="viewport" content="width=device-width, initial-scale=1" />' +
    '<title>openinfo · model setup</title>' +
    `<style>${SETUP_CSS}</style></head><body>` +
    '<h1>openinfo · model setup</h1>' +
    '<p class="sub">Your first setting, not your last. Point a slot at a model server, save it as a profile, clone/switch as your rig changes.</p>' +
    banner +
    '<h2>Profiles</h2>' +
    profilesHtml(data) +
    '<h2>Edit endpoints</h2>' +
    editorHtml(data) +
    '<h2>Keys</h2>' +
    secretsHtml(data.secretRefs) +
    rowTemplateHtml(data.secretRefs) +
    `<script>${SETUP_SCRIPT}</script>` +
    '</body></html>'
  )
}
