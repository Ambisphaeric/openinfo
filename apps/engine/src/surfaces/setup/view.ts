import type { DiscoverResult, Endpoint, Fabric, FabricProfile } from '@openinfo/contracts'
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
  /**
   * Discovery result — present ⇒ show the Get-Started capability lens FIRST (first run, or a re-detect).
   * Absent ⇒ render the page exactly as before (llm already configured, not re-detecting).
   */
  discovery?: DiscoverResult
}

/** Escape for safe interpolation into HTML text or a (single- or double-quoted) attribute. */
export const escapeHtml = (raw: string): string =>
  raw.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

/**
 * Serialize an object for embedding in a `<script type="application/json">` blob. A script element is a
 * RAW-text element (HTML entities are NOT decoded inside it), so the JSON must be embedded verbatim — NOT
 * html-escaped — and only `<` neutralized so a value can never terminate the script (`</script>`) or open
 * a tag. This is the JSON-in-script convention (cf. JSON-LD), distinct from escapeHtml for markup/attrs.
 */
export const jsonForScript = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c')

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
      `<div class="rowbtns"><button type="button" data-act="up" title="up">↑</button><button type="button" data-act="down" title="down">↓</button><button type="button" data-act="remove" title="remove">✕</button></div>` +
      `</div>`
    )
  }
  return (
    `<div class="row" data-kind="http" data-api="${escapeHtml(ep.api)}">` +
    `<input class="f-name" autocomplete="off" value="${escapeHtml(ep.name)}" placeholder="name" />` +
    `<input class="f-url" autocomplete="off" value="${escapeHtml(ep.url)}" placeholder="http://host:port" />` +
    `<input class="f-model" autocomplete="off" value="${escapeHtml(ep.model ?? '')}" placeholder="model (optional)" />` +
    `<select class="f-keyref" title="key reference">${keyrefOptions(ep.auth?.keyRef, refs)}</select>` +
    `<div class="rowbtns"><button type="button" data-act="test">Test</button><button type="button" data-act="up" title="up">↑</button>` +
    `<button type="button" data-act="down" title="down">↓</button><button type="button" data-act="remove" title="remove">✕</button></div>` +
    `<div class="probe"></div></div>`
  )
}

const liveSlotHtml = (key: string, endpoints: Endpoint[], refs: string[]): string =>
  `<div class="slot" data-slot="${escapeHtml(key)}">` +
  `<div class="slk">${escapeHtml(key)}</div>` +
  `<div class="rows">${endpoints.map((ep) => endpointRowHtml(ep, refs)).join('')}</div>` +
  `<div style="margin-top:9px"><button type="button" data-act="addrow" data-slot="${escapeHtml(key)}">+ add endpoint</button></div>` +
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
        (isActive ? '' : `<button type="button" data-act="activate" data-id="${escapeHtml(p.id)}">Activate</button>`) +
        `<button type="button" data-act="clone" data-id="${escapeHtml(p.id)}">Clone</button>` +
        (isEditing ? '' : `<a href="/setup?edit=${encodeURIComponent(p.id)}">edit</a>`) +
        (isActive ? '' : `<button type="button" data-act="delete" data-id="${escapeHtml(p.id)}">Delete</button>`)
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
    `<div style="margin-top:12px"><button type="button" class="primary" data-act="save">Save profile</button></div>` +
    `</form>`
  )
}

const secretsHtml = (refs: string[]): string => {
  const list = refs.length
    ? refs
        .map(
          (r) =>
            `<div class="row"><span class="ro">${escapeHtml(r)}</span><div class="rowbtns">` +
            `<button type="button" data-act="delsecret" data-ref="${escapeHtml(r)}">Forget</button></div></div>`,
        )
        .join('')
    : '<div class="note" style="color:var(--faint)">No keys stored. Values are write-only — never shown here.</div>'
  return (
    `<div class="card secrets"><div class="slk" style="color:var(--accent)">keys (by reference)</div>` +
    list +
    `<div class="row" style="border-top:1px solid var(--line);margin-top:6px;padding-top:10px">` +
    `<input id="secret-ref" autocomplete="off" placeholder="keyRef (e.g. remote-llm-key)" />` +
    `<input id="secret-val" type="password" autocomplete="new-password" placeholder="value (stored, never re-shown)" />` +
    `<div class="rowbtns"><button type="button" data-act="addsecret">Add key</button></div></div></div>`
  )
}

/** The hidden <template> the browser clones for a fresh endpoint row (keyRef options current). */
const rowTemplateHtml = (refs: string[]): string =>
  `<template id="row-tpl">` +
  `<div class="row" data-kind="http" data-api="openai-compat">` +
  `<input class="f-name" autocomplete="off" placeholder="name" /><input class="f-url" autocomplete="off" placeholder="http://host:port" />` +
  `<input class="f-model" autocomplete="off" placeholder="model (optional)" />` +
  `<select class="f-keyref" title="key reference">${keyrefOptions(undefined, refs)}</select>` +
  `<div class="rowbtns"><button type="button" data-act="test">Test</button><button type="button" data-act="up" title="up">↑</button>` +
  `<button type="button" data-act="down" title="down">↓</button><button type="button" data-act="remove" title="remove">✕</button></div>` +
  `<div class="probe"></div></div></template>`

/**
 * The Get-Started capability lens (ARCHITECTURE §8) — shown FIRST when discovery ran (first run, or a
 * re-detect). It speaks capabilities, not plumbing: Hearing (stt) · Thinking (llm) · Reading the screen
 * (ocr/vlm, later) · Speaking (tts, later). Each row shows what was found (model · server) or an honest
 * missing line. One primary button "Use this setup" writes+activates a config-1 profile from the
 * suggestion (through the existing profile routes — the browser reads the embedded suggestion blob).
 * When nothing usable was found (no llm), there is nothing to apply — the copy says so and points to
 * Advanced. Pure and exported so the states (nothing / partial / full) are asserted headless.
 */
interface CapabilityRow {
  /** the slot(s) that satisfy this capability; found = any has a suggested endpoint */
  slots: ReadonlyArray<keyof Fabric['slots']>
  title: string
  what: string
  /** honest copy when the capability was not detected */
  missing: string
  /** capabilities not yet wired to processing (shown, but labelled) */
  later?: boolean
}

const CAPABILITY_ROWS: readonly CapabilityRow[] = [
  { slots: ['llm'], title: 'Thinking', what: 'chat, distill, drafts — the core pass' , missing: 'no language model found — distill can’t run until one exists' },
  { slots: ['stt'], title: 'Hearing', what: 'transcribe what is said in a call', missing: 'no transcription server found — openinfo can still distill typed/text capture; audio needs one' },
  { slots: ['ocr', 'vlm'], title: 'Reading the screen', what: 'read text/UI off the screen', missing: 'no screen-reading model found', later: true },
  { slots: ['tts'], title: 'Speaking', what: 'read results back aloud', missing: 'no speech model found', later: true },
]

/** One suggested endpoint's "model on server" label, or '' if the slot has no suggestion. */
const foundLabel = (fabric: Fabric, slots: ReadonlyArray<keyof Fabric['slots']>): string => {
  for (const slot of slots) {
    const ep = fabric.slots[slot][0]
    if (ep) return `${ep.kind === 'http' && ep.model ? ep.model : ep.name} · ${ep.kind === 'http' ? ep.url : ep.kind}`
  }
  return ''
}

const capabilityRowHtml = (fabric: Fabric, row: CapabilityRow): string => {
  const found = foundLabel(fabric, row.slots)
  const mark = found ? '<span class="cap-mark ok">✓</span>' : '<span class="cap-mark no">○</span>'
  const later = row.later ? ' <span class="cap-later">(not used yet)</span>' : ''
  const detail = found
    ? `<span class="cap-found">${escapeHtml(found)}</span>`
    : `<span class="cap-missing">${escapeHtml(row.missing)}</span>`
  return (
    `<div class="cap${found ? ' has' : ''}">${mark}` +
    `<div class="cap-body"><div class="cap-title">${escapeHtml(row.title)}${later}` +
    ` <span class="cap-what">— ${escapeHtml(row.what)}</span></div>${detail}</div></div>`
  )
}

const getStartedHtml = (discovery: DiscoverResult): string => {
  const reachable = discovery.servers.filter((s) => s.reachable)
  const modelCount = reachable.reduce((n, s) => n + s.models.length, 0)
  const canApply = discovery.suggestion.slots.llm.length > 0
  const summary = reachable.length
    ? `Found ${reachable.length} server${reachable.length === 1 ? '' : 's'} with ${modelCount} model${modelCount === 1 ? '' : 's'} on this machine.`
    : 'No local model server responded.'
  const rows = CAPABILITY_ROWS.map((row) => capabilityRowHtml(discovery.suggestion, row)).join('')
  const action = canApply
    ? '<button type="button" class="primary" data-act="use-setup">Use this setup</button>' +
      '<button type="button" data-act="redetect">Re-run detection</button>'
    : '<div class="sub">Start LM Studio or Ollama (or add a remote host in Advanced setup), then re-run detection.</div>' +
      '<button type="button" data-act="redetect">Re-run detection</button>'
  return (
    '<div class="card getstarted"><div class="gs-head">Get started</div>' +
    `<div class="sub">${escapeHtml(summary)} openinfo detects what it can do — no ports or model trivia to configure.</div>` +
    `<div class="caps">${rows}</div>` +
    `<script type="application/json" id="suggestion">${jsonForScript(discovery.suggestion)}</script>` +
    `<div class="gs-actions">${action}</div>` +
    '<div class="sub gs-adv">Want full control? <a href="#advanced" data-act="show-advanced">Advanced setup</a> — profiles, cross-host endpoints, keys.</div>' +
    '</div>'
  )
}

/** Render the whole self-contained setup page. Pure — the engine route just hands it live data. */
export const renderSetupPage = (data: SetupData): string => {
  const notice = firstRunNotice(data.liveFabric)
  const banner = notice ? `<div class="banner">⚠ ${escapeHtml(notice)}</div>` : ''
  const lens = data.discovery ? getStartedHtml(data.discovery) : ''
  const advanced =
    '<h2>Profiles</h2>' +
    profilesHtml(data) +
    '<h2>Edit endpoints</h2>' +
    editorHtml(data) +
    '<h2>Keys</h2>' +
    secretsHtml(data.secretRefs)
  // When the lens leads (first run / re-detect) the full editor lives behind an "Advanced setup"
  // disclosure — one decision at a time. Otherwise the page is exactly as before (sections open).
  const body = data.discovery
    ? `<details id="advanced" class="advanced"><summary>Advanced setup</summary>${advanced}</details>`
    : advanced
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8" />' +
    '<meta name="viewport" content="width=device-width, initial-scale=1" />' +
    '<title>openinfo · model setup</title>' +
    `<style>${SETUP_CSS}</style></head><body>` +
    '<h1>openinfo · model setup</h1>' +
    '<p class="sub">Your first setting, not your last. Point a slot at a model server, save it as a profile, clone/switch as your rig changes.</p>' +
    banner +
    lens +
    body +
    rowTemplateHtml(data.secretRefs) +
    `<script>${SETUP_SCRIPT}</script>` +
    '</body></html>'
  )
}
