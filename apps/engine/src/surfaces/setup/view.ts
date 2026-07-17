import type { DiscoverResult, Endpoint, Fabric, FabricProfile, Flag, LocalModelStatus, Moment, QueueStatus, ScanResult, Session, Surface, WorkflowSpec } from '@openinfo/contracts'

/**
 * The setup views — forms over the profile + secret documents (ARCHITECTURE §8), served by the engine
 * as sections of the Settings sidebar (GET /settings). This module is PURE: each exported section
 * function returns its HTML fragment with no I/O and no DOM, so the states are asserted headless under
 * node:test (mirroring the client's pure-renderer discipline). The Settings shell (settings/shell.ts)
 * composes these fragments behind the section registry; the interactive behaviour is the thin browser
 * script in assets.ts, which only composes existing routes (profiles CRUD/clone/activate, secrets
 * write/delete/list-refs, /fabric, /fabric/test) — no new engine capability, per the P6 "forms over
 * documents" rule.
 *
 * A user's rig is never their last (config 1 → clone → a 27B on another host → STT elsewhere): these
 * views name/clone/activate profiles and wire slot→endpoint rows across hosts. Deliberately barebones —
 * the FIRST setting, not a settings empire — now re-homed into a sidebar so the vision's many
 * configuration surfaces have somewhere to live.
 */

/**
 * EVERY slot is a fully editable document field. A profile is a document that legitimately holds
 * endpoints in all six slots (the user's own rig configures tts/vlm/ocr), so the page does not gate
 * DOCUMENT editing on whether the engine invokes a slot yet. v0 shipped llm+stt editable with
 * tts/vlm/ocr/embed present-but-inert; that scope line outgrew its use (see PHASE2-NOTES). Each slot
 * now carries an honest, INFORMATIONAL usage note — never a gate — naming what is wired today and what
 * remains stored for a later phase.
 */
/** The six capability slots shown in the occupancy/health/editor surfaces. Excludes the optional `guard`
 * slot (#63) — an egress content filter, not a capability endpoint the onboarding lists occupy — and
 * excluding it keeps indexed access `fabric.slots[k]` a concrete `Endpoint[]` (guard is optional). */
export type DisplaySlot = Exclude<keyof Fabric['slots'], 'guard'>
export const ALL_SLOTS: ReadonlyArray<DisplaySlot> = ['llm', 'stt', 'tts', 'vlm', 'ocr', 'embed']

const SLOT_NOTE: Record<string, string> = {
  llm: 'powers distill, drafts, and the core pass today.',
  stt: 'powers call transcription today.',
  tts: 'stored — speech (reading results aloud) is wired in a later phase (P5). Configure it freely now.',
  vlm: 'powers prompted screen understanding from an enabled workflow VLM step today.',
  ocr: 'powers screen reading today, through legacy ingest or an enabled workflow OCR step.',
  embed: 'stored — recall / vector search is wired in a later phase (P3). Configure it freely now.',
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
  /**
   * Starter-model catalog + local state (tier zero) — shown in the lens's NOTHING-FOUND state so a user
   * with no server can still reach a working setup: "No local model server responded → download a
   * starter model". Present only alongside `discovery`.
   */
  localModels?: LocalModelStatus[]
  /** All surface (HUD layout) documents, for the "HUD layout" section's list + edit links. */
  surfaces?: Surface[]
  /** The surface id the HUD renders by default (client config) — marked in the list. */
  defaultSurfaceId?: string
  /**
   * All feature flags (GET /flags — every seeded default plus any hand-set doc), driving the Features
   * section and the sidebar's features-on dot. Absent ⇒ Features renders an honest "no flags" note.
   */
  flags?: Flag[]
  /** The executor's active workflow, used by Status to derive the screen slot(s) it actually runs. */
  activeWorkflow?: WorkflowSpec
  /** Engine uptime in ms (from GET /health) — the Status section's version/uptime line. */
  uptimeMs?: number
  /** The live (unended) session for the default workspace, if any — the Status section's live line. */
  liveSession?: Session
  /** Capture-queue status (pending/drained) — a cheap existing signal for the Status section. */
  queue?: QueueStatus
  /** A short label for the engine host (e.g. ":8920") shown in the sidebar brand. */
  engineLabel?: string
  /**
   * The audit-ledger passes (#65) — the default workspace's recorded pipeline passes (distill + screen),
   * newest first, each a hop trail with token accounting. Assembled by the settings route (buildLedger over
   * the store); read only by the Audit-ledger section. Absent ⇒ that section renders its empty state.
   */
  ledger?: import('../settings/sections/ledger.js').LedgerPass[]
  /**
   * Held egress hops (#63) the guard suspended — the durable audit of every block, each carrying the
   * verdict (span descriptors, never the raw value). Assembled by the settings route (guardHolds.list) for
   * the Audit-ledger section, rendered as held rows with a release/deny affordance. Absent ⇒ none held.
   */
  guardHolds?: import('@openinfo/contracts').GuardHold[]
  /**
   * The Trace section's data (#116) — the selectable inputs (recent utterance segments + screen captures)
   * and, when one is selected, its walked trail. Assembled by the settings route ONLY when that section is
   * active (the ledger's read discipline); an assembly failure lands here as `problem` so the page shows
   * the true reason as text, never a blank. Absent ⇒ the section renders its unavailable state.
   */
  trace?: import('../settings/sections/trace.js').TraceData
  /**
   * The Context packets section's data (#176) — the default workspace's packets (with supersession chains),
   * their source records for render-time text resolution, and the live producer's last build outcome.
   * Assembled by the settings route ONLY when that section is active (the ledger/trace read discipline);
   * an assembly failure lands here as `problem` so the page shows the true reason as text, never a blank.
   */
  contextPackets?: import('../settings/sections/packets.js').ContextPacketsData
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

// --- The host-scan → model-dropdown views (HOST-SCAN + MODEL-DROPDOWN slice) -----------------------
// Typing a full model id by hand is error-prone — scan the server, list its
// models, pick from a dropdown, see a capabilities list. These are the PURE decisions the browser
// mirrors (the same discipline as tryItDiagnosis / MOMENT_GLYPHS): grouping, labels, summary, and the
// row states — asserted headless here, rebuilt as DOM by the thin script in assets.ts.

/** One scanned host / one scanned model, as POST /fabric/scan returns them. */
export type ScannedHost = ScanResult['hosts'][number]
export type ScannedModel = ScannedHost['models'][number]

/** The dropdown's escape-hatch option value — choosing it restores the free-text model input. */
export const CUSTOM_MODEL_OPTION = '__custom__'

/** Slot → the human word the capabilities summary uses (llm reads as chat; the rest keep their name). */
const SUMMARY_LABEL: Record<string, string> = { llm: 'chat' }

/**
 * The capabilities summary, compacted: "30 chat · 3 vlm · 2 ocr · 1 embed". Counts models per
 * classified slot (a multi-slot model counts in each), largest first, ties in canonical slot order.
 * Empty models ⇒ '' (the caller says "no models loaded" instead). Pure.
 */
export const capabilitySummary = (models: ScannedModel[]): string => {
  const counts = new Map<string, number>()
  for (const model of models) for (const slot of model.slots) counts.set(slot, (counts.get(slot) ?? 0) + 1)
  const order = (slot: string): number => {
    const at = ALL_SLOTS.indexOf(slot as (typeof ALL_SLOTS)[number])
    return at === -1 ? ALL_SLOTS.length : at
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || order(a[0]) - order(b[0]))
    .map(([slot, n]) => `${n} ${SUMMARY_LABEL[slot] ?? slot}`)
    .join(' · ')
}

/**
 * Group scanned models for ONE slot's dropdown: models whose classified slots match the row's slot
 * FIRST, everything else under the divider — alphabetical within each group (36 models must scan by
 * eye). Pure.
 */
export const groupModelsForSlot = (models: ScannedModel[], slot: string): { matching: ScannedModel[]; other: ScannedModel[] } => {
  const sorted = [...models].sort((a, b) => a.id.localeCompare(b.id))
  return {
    matching: sorted.filter((m) => m.slots.includes(slot as ScannedModel['slots'][number])),
    other: sorted.filter((m) => !m.slots.includes(slot as ScannedModel['slots'][number])),
  }
}

/** A dropdown option's text: the model id plus its capability chips — "ornith-1.0-9b — llm". Pure. */
export const modelOptionLabel = (model: ScannedModel): string =>
  model.slots.length > 0 ? `${model.id} — ${model.slots.join('/')}` : model.id

/**
 * The discovered-model dropdown that replaces the free-text model field after a scan. Slot-matching
 * models lead, the rest sit under an "other models" divider, every option carries its capability
 * chips, and the final "custom…" option restores free text — the user is never trapped. A current
 * value the server did not report is kept as its own selected option (never silently dropped); an
 * empty current gets a "(pick a model)" placeholder. Pure — the browser builds the same shape via DOM.
 */
export const modelDropdownHtml = (models: ScannedModel[], slot: string, current: string): string => {
  const { matching, other } = groupModelsForSlot(models, slot)
  const known = models.some((m) => m.id === current)
  const option = (m: ScannedModel): string =>
    `<option value="${escapeHtml(m.id)}"${m.id === current ? ' selected' : ''}>${escapeHtml(modelOptionLabel(m))}</option>`
  const head =
    current === ''
      ? '<option value="" selected>(pick a model)</option>'
      : known
        ? ''
        : `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)} (current — not reported by this server)</option>`
  return (
    '<select class="f-model" title="model — discovered by scan">' +
    head +
    (matching.length ? `<optgroup label="${escapeHtml(slot)} — matches this slot">${matching.map(option).join('')}</optgroup>` : '') +
    (other.length ? `<optgroup label="other models">${other.map(option).join('')}</optgroup>` : '') +
    `<option value="${CUSTOM_MODEL_OPTION}">custom…</option></select>`
  )
}

export interface ScanStatus {
  kind: 'ok' | 'none' | 'auth' | 'dead'
  text: string
}

/**
 * The row-detail line for ONE scanned host — the same copy discipline as the generation probe (class:
 * message — hint). ok ⇒ the found-count + the capabilities summary; authRequired ⇒ "this server wants
 * a key" + the classified hint (the keyRef selector is highlighted beside it); dead ⇒ the classified
 * error + hint. Pure — the browser mirrors this branch order.
 */
export const scanStatusLine = (host: ScannedHost): ScanStatus => {
  if (host.reachable && !host.authRequired) {
    if (host.models.length === 0) return { kind: 'none', text: 'reachable — no models loaded on this server' }
    const n = host.models.length
    return { kind: 'ok', text: `found ${n} model${n === 1 ? '' : 's'} — ${capabilitySummary(host.models)} — pick one in the model dropdown` }
  }
  if (host.authRequired) {
    const hint = host.error?.hint ?? 'add a key in Settings → Keys and reference it via keyRef'
    return { kind: 'auth', text: `this server wants a key — ${hint} — then Scan again` }
  }
  const e = host.error
  if (!e) return { kind: 'dead', text: 'no answer from this server' }
  return { kind: 'dead', text: `${e.class}${e.message ? `: ${e.message}` : ''} — ${e.hint}` }
}

/**
 * The bare host in a URL-field value, for the "scan common ports on <host>" offer: a full URL yields
 * its hostname; a schemeless value yields everything before the first '/' or ':'. Empty/unreadable ⇒
 * undefined (no offer). Pure — the browser mirrors it.
 */
export const bareHostOf = (value: string): string | undefined => {
  const v = value.trim()
  if (v === '') return undefined
  if (/^https?:\/\//i.test(v)) {
    try {
      return new URL(v).hostname || undefined
    } catch {
      return undefined
    }
  }
  const host = v.split('/')[0]!.split(':')[0]!
  return host || undefined
}

// --- Endpoint URL ⇄ host/port (ENDPOINT-HOST-PORT slice) -------------------------------------------
// The editor exposes an endpoint's URL as SEPARATE scheme/host/port fields so the owner's real workflow
// works cleanly: testing an "upgrade" from LM Studio to omlx on the SAME host is a PORT swap under the same
// reference name, host unchanged. The stored Endpoint shape is UNCHANGED — `url` stays a single string;
// this is purely a UI affordance, so it needs a lossless parse (url → fields, for rendering) and compose
// (fields → url, mirrored by the browser on save). Pure and exported so the round-trip is asserted headless.

export interface EndpointUrlParts {
  /** 'http' | 'https' (endpoints match ^https?://); default 'http' for a schemeless value. */
  scheme: string
  /** the hostname — IPv6 keeps its brackets ("[::1]"). '' when unreadable. */
  host: string
  /** the port as text, '' when none (a default-port URL like https://host). */
  port: string
  /** any trailing path/query/hash, preserved verbatim so a URL with a path round-trips losslessly ('' normally). */
  rest: string
}

/** Split a `host[:port]` authority (IPv6-aware: "[::1]:8000" → host "[::1]", port "8000"). */
const splitAuthority = (authority: string): { host: string; port: string } => {
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']')
    if (close !== -1) {
      const after = authority.slice(close + 1)
      return { host: authority.slice(0, close + 1), port: after.startsWith(':') ? after.slice(1) : '' }
    }
  }
  const colon = authority.lastIndexOf(':')
  return colon === -1 ? { host: authority, port: '' } : { host: authority.slice(0, colon), port: authority.slice(colon + 1) }
}

/** Parse an endpoint URL into scheme/host/port/rest. A schemeless value defaults to http. Lossless with composeEndpointUrl. Pure. */
export const parseEndpointUrl = (url: string): EndpointUrlParts => {
  const trimmed = (url ?? '').trim()
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([/?#].*)?$/i.exec(trimmed)
  if (m) {
    const { host, port } = splitAuthority(m[2]!)
    return { scheme: m[1]!.toLowerCase(), host, port, rest: m[3] ?? '' }
  }
  const slash = trimmed.indexOf('/')
  const authority = slash === -1 ? trimmed : trimmed.slice(0, slash)
  const { host, port } = splitAuthority(authority)
  return { scheme: 'http', host, port, rest: slash === -1 ? '' : trimmed.slice(slash) }
}

/** Compose scheme/host/port(/rest) back into the stored URL string. Empty host ⇒ '' (an unfilled row). Pure. */
export const composeEndpointUrl = (parts: { scheme?: string; host: string; port?: string; rest?: string }): string => {
  const host = (parts.host ?? '').trim()
  if (host === '') return ''
  const scheme = (parts.scheme ?? '').trim() || 'http'
  const port = (parts.port ?? '').trim()
  return `${scheme}://${host}${port ? `:${port}` : ''}${parts.rest ?? ''}`
}

const keyrefOptions = (selected: string | undefined, refs: string[]): string =>
  ['<option value="">(no key)</option>']
    .concat(refs.map((r) => `<option value="${escapeHtml(r)}"${r === selected ? ' selected' : ''}>${escapeHtml(r)}</option>`))
    .join('')

/**
 * Serialize an http endpoint's request extras (chatTemplateKwargs / responseFormat) to the JSON the
 * advanced field shows — only the keys that are set, '' when neither. Round-trips through rowToEndpoint.
 */
const endpointExtrasValue = (ep: Extract<Endpoint, { kind: 'http' }>): string => {
  const extras: Record<string, unknown> = {}
  if (ep.chatTemplateKwargs !== undefined) extras['chatTemplateKwargs'] = ep.chatTemplateKwargs
  if (ep.responseFormat !== undefined) extras['responseFormat'] = ep.responseFormat
  return Object.keys(extras).length > 0 ? JSON.stringify(extras) : ''
}

const EXTRAS_PLACEHOLDER = 'advanced JSON — e.g. {"chatTemplateKwargs":{"enable_thinking":false}}'

/**
 * The scheme + host + port fields that COMPOSE the endpoint URL (the stored `url` shape is unchanged; the
 * browser recomposes on save). Scheme defaults to http with an inline advanced override; host + port are
 * separate so a same-host port swap (LM Studio → omlx) is a one-field edit. Shared by the row + add-row template.
 */
const hostPortFieldsHtml = (parts: EndpointUrlParts): string =>
  `<select class="f-scheme" title="scheme (advanced — default http)">` +
  `<option value="http"${parts.scheme === 'https' ? '' : ' selected'}>http</option>` +
  `<option value="https"${parts.scheme === 'https' ? ' selected' : ''}>https</option></select>` +
  `<input class="f-host" autocomplete="off" value="${escapeHtml(parts.host)}" placeholder="host (or a bare host to scan)" />` +
  `<input class="f-port" autocomplete="off" value="${escapeHtml(parts.port)}" placeholder="port" />`

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
  // Split the stored url into scheme/host/port for the fields; `rest` (any path/query) rides a data attribute
  // so the browser can recompose the exact url losslessly on save.
  const parts = parseEndpointUrl(ep.url)
  return (
    `<div class="row" data-kind="http" data-api="${escapeHtml(ep.api)}" data-urlrest="${escapeHtml(parts.rest)}">` +
    `<input class="f-name" autocomplete="off" value="${escapeHtml(ep.name)}" placeholder="name" />` +
    hostPortFieldsHtml(parts) +
    `<button type="button" data-act="scan" title="Scan this server: list its models and see what it can do — no typing model names">Scan</button>` +
    `<input class="f-model" autocomplete="off" value="${escapeHtml(ep.model ?? '')}" placeholder="model (optional — Scan fills a dropdown)" />` +
    `<select class="f-keyref" title="key reference">${keyrefOptions(ep.auth?.keyRef, refs)}</select>` +
    `<div class="rowbtns"><button type="button" data-act="test">Test</button>` +
    `<button type="button" disabled title="Benchmark measures real tok/s on this hardware — coming with the capability-benchmarking system (see Diagnostics → Benchmarks).">Benchmark</button>` +
    `<button type="button" data-act="up" title="up">↑</button>` +
    `<button type="button" data-act="down" title="down">↓</button><button type="button" data-act="remove" title="remove">✕</button></div>` +
    // Advanced (optional): per-endpoint request extras threaded into the completions body. Blank ⇒ nothing
    // sent (the common case); a reasoning model that burns the token budget gets {"enable_thinking":false}.
    `<input class="f-extras" autocomplete="off" spellcheck="false" title="${escapeHtml(EXTRAS_PLACEHOLDER)}" value="${escapeHtml(endpointExtrasValue(ep))}" placeholder="${escapeHtml(EXTRAS_PLACEHOLDER)}" />` +
    `<div class="probe"></div></div>`
  )
}

/** One fully editable slot: the honest usage note, its endpoint rows, and "+ add endpoint". */
const slotHtml = (key: string, endpoints: Endpoint[], refs: string[]): string =>
  `<div class="slot" data-slot="${escapeHtml(key)}">` +
  `<div class="slk">${escapeHtml(key)}</div>` +
  `<div class="note">${escapeHtml(SLOT_NOTE[key] ?? 'stored — configure it freely.')}</div>` +
  `<div class="rows">${endpoints.map((ep) => endpointRowHtml(ep, refs)).join('')}</div>` +
  `<div style="margin-top:9px"><button type="button" data-act="addrow" data-slot="${escapeHtml(key)}">+ add endpoint</button></div>` +
  `</div>`

/** The profile list: name/id/description, the active + editing badges, and the per-profile actions. */
export const profilesHtml = (data: SetupData): string => {
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
        (isEditing ? '' : `<a href="/settings/endpoints?edit=${encodeURIComponent(p.id)}">edit</a>`) +
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
export const editorHtml = (data: SetupData): string => {
  const editing = data.editing
  const fabric = editing ? editing.fabric : data.liveFabric
  const refs = data.secretRefs
  const target = editing
    ? `<span class="mono">${escapeHtml(editing.name)} (${escapeHtml(editing.id)} · v${editing.version})</span>`
    : '<span class="mono">the live fabric (no profile active)</span>'
  const meta = editing
    ? escapeHtml(JSON.stringify({ id: editing.id, name: editing.name, version: editing.version, description: editing.description }))
    : ''
  // base-fabric is JSON embedded in a RAW-text <script>, so it MUST be jsonForScript (verbatim, only `<`
  // neutralized) — NOT escapeHtml. A script element does not decode HTML entities, so an html-escaped blob
  // (`{&quot;slots&quot;…`) reaches the browser literally and JSON.parse(textContent) throws BEFORE the save
  // fetch — the silent no-op that broke Save. (data-profile above is an ATTRIBUTE, where escapeHtml is right.)
  const base = jsonForScript(fabric)
  const slots = ALL_SLOTS.map((k) => slotHtml(k, fabric.slots[k], refs)).join('')
  return (
    `<form id="editor" data-target-id="${editing ? escapeHtml(editing.id) : ''}" data-profile='${meta}'>` +
    `<div class="sub">Editing ${target}. Add/reorder endpoints, wire a key by reference, then Save.</div>` +
    `<script type="application/json" id="base-fabric">${base}</script>` +
    slots +
    `<div style="margin-top:12px"><button type="button" class="primary" data-act="save">Save profile</button>` +
    `<div class="save-error" id="save-error" role="alert"></div></div>` +
    `</form>`
  )
}

export const secretsHtml = (refs: string[]): string => {
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
export const rowTemplateHtml = (refs: string[]): string =>
  `<template id="row-tpl">` +
  `<div class="row" data-kind="http" data-api="openai-compat" data-urlrest="">` +
  `<input class="f-name" autocomplete="off" placeholder="name" />` +
  hostPortFieldsHtml(parseEndpointUrl('')) +
  `<button type="button" data-act="scan" title="Scan this server: list its models and see what it can do — no typing model names">Scan</button>` +
  `<input class="f-model" autocomplete="off" placeholder="model (optional — Scan fills a dropdown)" />` +
  `<select class="f-keyref" title="key reference">${keyrefOptions(undefined, refs)}</select>` +
  `<div class="rowbtns"><button type="button" data-act="test">Test</button>` +
  `<button type="button" disabled title="Benchmark measures real tok/s on this hardware — coming with the capability-benchmarking system (see Diagnostics → Benchmarks).">Benchmark</button>` +
  `<button type="button" data-act="up" title="up">↑</button>` +
  `<button type="button" data-act="down" title="down">↓</button><button type="button" data-act="remove" title="remove">✕</button></div>` +
  `<input class="f-extras" autocomplete="off" spellcheck="false" title="${escapeHtml(EXTRAS_PLACEHOLDER)}" placeholder="${escapeHtml(EXTRAS_PLACEHOLDER)}" />` +
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
  slots: ReadonlyArray<DisplaySlot>
  title: string
  what: string
  /** honest copy when the capability was not detected */
  missing: string
  /** capabilities not yet wired to processing (shown, but labelled) */
  later?: boolean
}

const CAPABILITY_ROWS: readonly CapabilityRow[] = [
  { slots: ['llm'], title: 'Thinking', what: 'chat, distill, drafts — the core pass; a current-generation ~8B-class model keeps the loop real-time' , missing: 'no language model found — distill can’t run until one exists' },
  { slots: ['stt'], title: 'Hearing', what: 'transcribe what is said in a call; parakeet-class STT keeps up in real time, whisper is a slower fallback', missing: 'no transcription server found — openinfo can still distill typed/text capture; audio needs one' },
  { slots: ['ocr', 'vlm'], title: 'Reading the screen', what: 'read text/UI off the screen', missing: 'no screen-reading model found', later: true },
  { slots: ['tts'], title: 'Speaking', what: 'read results back aloud', missing: 'no speech model found', later: true },
]

/** One suggested endpoint's "model on server" label, or '' if the slot has no suggestion. */
const foundLabel = (fabric: Fabric, slots: ReadonlyArray<DisplaySlot>): string => {
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

/** Human size label from bytes ("~1.1 GB", "~148 MB") — honest approximate sizing in the offer. */
const humanSize = (bytes: number): string =>
  bytes >= 1_000_000_000 ? `~${(bytes / 1_000_000_000).toFixed(1)} GB` : `~${Math.round(bytes / 1_000_000)} MB`

/** One starter-model row: download / progress / ready+use / brew-hint-when-binary-missing / error. */
const starterRowHtml = (m: LocalModelStatus): string => {
  const model = m.model
  const meta = `<span class="starter-meta">${escapeHtml(model.slot)} · ${escapeHtml(model.runtime)} · ${humanSize(model.sizeBytes)}</span>`
  const dataAttrs =
    `data-id="${escapeHtml(model.id)}" data-runtime="${escapeHtml(model.runtime)}" data-slot="${escapeHtml(model.slot)}" data-name="${escapeHtml(model.name)}"`
  let control: string
  if (!m.runtimeAvailable) {
    // The binary is missing — show exactly how to get it, plus a re-check (no silent failure).
    control =
      `<div class="starter-hint">needs <span class="mono">${escapeHtml(model.runtime)}</span> — run <code>${escapeHtml(m.installHint ?? '')}</code>, then ` +
      '<button type="button" data-act="redetect">re-check</button></div>'
  } else if (m.state === 'ready') {
    control = `<button type="button" class="primary" data-act="use-starter" ${dataAttrs}>Use this model</button>`
  } else if (m.state === 'downloading') {
    const pct = m.totalBytes ? Math.floor(((m.downloadedBytes ?? 0) / m.totalBytes) * 100) : undefined
    control = `<span class="starter-progress" data-id="${escapeHtml(model.id)}">downloading… ${pct !== undefined ? `${pct}%` : `${Math.round((m.downloadedBytes ?? 0) / 1_000_000)} MB`}</span>`
  } else if (m.state === 'error') {
    control =
      `<span class="starter-error">${escapeHtml(m.error ?? 'download failed')}</span> ` +
      `<button type="button" data-act="download-model" ${dataAttrs}>Retry</button>`
  } else {
    control = `<button type="button" data-act="download-model" ${dataAttrs}>Download (${humanSize(model.sizeBytes)})</button>`
  }
  return (
    `<div class="starter" data-id="${escapeHtml(model.id)}">` +
    `<div class="starter-body"><div class="starter-name">${escapeHtml(model.name)} ${meta}</div>` +
    (model.description ? `<div class="starter-desc">${escapeHtml(model.description)}</div>` : '') +
    `</div><div class="starter-control">${control}</div></div>`
  )
}

/**
 * Tier-zero offer (ARCHITECTURE §8 slice c): shown in the NOTHING-FOUND state so a user with no model
 * server still reaches a working setup. Lists vetted small models with honest sizes + runtime
 * availability; one click downloads (progress polled), then "Use this model" writes a `local` endpoint
 * into config-1 (via the existing profile routes) and the engine spawns it. Binary missing ⇒ the brew
 * line + a re-check instead of a dead end.
 */
export const starterOfferHtml = (models: LocalModelStatus[]): string => {
  if (models.length === 0) return ''
  return (
    '<div class="starter-offer"><div class="starter-head">Or download a starter model</div>' +
    '<div class="sub">No server needed — openinfo can fetch a small model and run it for you (llama.cpp for chat, ' +
    'whisper.cpp for audio). These are tier-zero warm-up models: enough for a first moment on CPU, not the ' +
    'real-time fast tier. For that, serve a current-generation ~8B-class chat model plus parakeet-class STT on a ' +
    'runtime with model residency and concurrency (mlx/omlx on Apple silicon, a CUDA equivalent elsewhere) — see the ' +
    'model support matrix.</div>' +
    models.map(starterRowHtml).join('') +
    '</div>'
  )
}

// --- Detected runtime servers in "Local runtimes" (RUNTIME-TRUTH slice) ----------------------------
// The Local-runtimes section used to render ONLY the download catalog (starterOfferHtml), so a discovered
// mlx/omlx server — and its parakeet-class stt models — was invisible there. These render the servers
// discovery already found (the SAME DiscoverResult the Get-started lens uses): each with its name/flavor,
// reachable / needs-key state, and its models grouped by the slot the capability map guessed. They are
// ADOPTED (managed externally over HTTP), never downloaded/spawned here — the honest contrast with the
// starter catalog below. Pure and exported so the states are asserted headless.

export type DiscoveredRuntime = DiscoverResult['servers'][number]

/** A discovered server's state chip: reachable (ok), reachable-but-wants-a-key (warn), or no answer (bad). Pure. */
export const runtimeStateChip = (server: DiscoveredRuntime): { cls: 'ok' | 'warn' | 'bad'; text: string } => {
  if (server.reachable && !server.authRequired) return { cls: 'ok', text: 'reachable' }
  if (server.authRequired) return { cls: 'warn', text: 'reachable · needs a key' }
  return { cls: 'bad', text: server.error ? `no answer — ${server.error}` : 'no answer' }
}

/** Group a server's discovered models by slot (canonical ALL_SLOTS order); a multi-slot model appears under each. Pure. */
export const runtimeModelsBySlot = (models: DiscoveredRuntime['models']): Array<{ slot: string; ids: string[] }> =>
  ALL_SLOTS.map((slot) => ({ slot: String(slot), ids: models.filter((m) => (m.slots as readonly string[]).includes(slot)).map((m) => m.id) })).filter((g) => g.ids.length > 0)

/** One discovered runtime server card: name/flavor · url · state, then its models grouped by slot guess. */
const runtimeCardHtml = (server: DiscoveredRuntime): string => {
  const chip = runtimeStateChip(server)
  const groups = runtimeModelsBySlot(server.models)
  const slotLines = groups.length
    ? `<div class="rt-slots">${groups.map((g) => `<div class="rt-slot"><b>${escapeHtml(g.slot)}</b>${escapeHtml(g.ids.join(', '))}</div>`).join('')}</div>`
    : server.reachable && !server.authRequired
      ? '<div class="rt-slot" style="color:var(--faint)">reachable — no models loaded on this server</div>'
      : ''
  return (
    `<div class="runtime">` +
    `<div class="runtime-head"><span class="runtime-name">${escapeHtml(server.name)}</span>` +
    `<span class="runtime-url">${escapeHtml(server.url)}</span>` +
    `<span class="rt-state ${chip.cls}">${escapeHtml(chip.text)}</span>` +
    `<span class="badge">adopted · managed externally</span></div>` +
    slotLines +
    `</div>`
  )
}

/**
 * The detected-runtimes block for the Local-runtimes section: every server discovery found that ANSWERED
 * (reachable, or present-but-wants-a-key like omlx) rendered as an adopted runtime with its models grouped
 * by slot — so parakeet-style stt on an mlx/omlx server is finally visible here. Servers that did not answer
 * are omitted (the Get-started lens is where "nothing responded" is diagnosed). '' when none answered — the
 * caller then leads with the download catalog. Pure.
 */
export const localRuntimesHtml = (servers: DiscoveredRuntime[]): string => {
  const detected = servers.filter((s) => s.reachable || s.authRequired)
  if (detected.length === 0) return ''
  return (
    '<div class="card runtimes"><div class="starter-head">Detected runtimes</div>' +
    '<div class="sub">Model servers running on this machine, adopted over HTTP — openinfo talks to them, it does not download or ' +
    'spawn them (an mlx/omlx server is managed externally). Their models are grouped by the capability slot their names classified into.</div>' +
    detected.map(runtimeCardHtml).join('') +
    '</div>'
  )
}

export const getStartedHtml = (discovery: DiscoverResult, localModels: LocalModelStatus[]): string => {
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
    : '<div class="sub">Start LM Studio or Ollama (or add a remote host in Advanced setup), then re-run detection — or download a starter model below.</div>' +
      '<button type="button" data-act="redetect">Re-run detection</button>'
  // Tier zero leads the nothing-found state — a dead end becomes an offer.
  const starter = canApply ? '' : starterOfferHtml(localModels)
  return (
    '<div class="card getstarted"><div class="gs-head">Get started</div>' +
    `<div class="sub">${escapeHtml(summary)} openinfo detects what it can do — no ports or model trivia to configure.</div>` +
    `<div class="caps">${rows}</div>` +
    `<script type="application/json" id="suggestion">${jsonForScript(discovery.suggestion)}</script>` +
    `<div class="gs-actions">${action}</div>` +
    starter +
    '<div class="sub gs-rec">Recommended for the real-time loop: a current-generation ~8B-class chat model plus ' +
    'parakeet-class STT, served on a runtime with model residency, concurrency, and current throughput ' +
    'optimizations (speculative-decoding-class features) — mlx/omlx on Apple silicon, a CUDA equivalent elsewhere. ' +
    'Runtimes without those will not sustain the cadence. Add a judge-tier endpoint (a 27B / 35B-A3B-class model on ' +
    'any OpenAI-compatible host) to light up the judging layer. See the model support matrix for the full ladder.</div>' +
    '<div class="sub gs-adv">Want full control? <a href="/settings/endpoints">Advanced setup</a> — profiles, cross-host endpoints, keys.</div>' +
    '</div>'
  )
}

/**
 * The Try-it card — slice (b), "say something, watch it become a moment" (ARCHITECTURE §8, principle
 * 5). Onboarding's last step is not a Test button, it is the product: after config-1 is active (an llm
 * endpoint exists) the user types a sentence (or speaks, when an stt endpoint exists) and watches it
 * become a typed moment, live. The loop lives on /setup — engine-served inside an authenticated browser
 * session — so the browser owns the mic-permission UX. A remote browser additionally requires the trusted
 * HTTPS tunnel; direct LAN access is refused. Pure and exported so its states are asserted headless.
 *
 * States: llm empty ⇒ '' (hidden — the Get-Started lens/banner leads instead); llm present, stt empty
 * ⇒ the type path only, with an honest no-voice line; llm+stt ⇒ both paths. The card states plainly
 * that trying it turns on distillation — the user's click IS the consent (the browser flips the needed
 * flags via the existing PUT /flags/:key on first use; nothing is flipped silently outside the card).
 */

/** Moment kind → glyph (ARCHITECTURE §3). The single source; embedded into the page so the browser
 * (which builds the arrived moment's DOM live) reads the same map — no divergent second glyph table. */
export const MOMENT_GLYPHS: Record<string, string> = {
  commitment: '●',
  question: '◆',
  decision: '▲',
  artifact: '✱',
  mention: '＠',
  note: '·',
}

export const momentGlyph = (kind: string): string => MOMENT_GLYPHS[kind] ?? '·'

/** The one-line provenance a surfaced moment must carry (product principle 1): "via <endpoint> · <model>". */
export const momentProvenanceLine = (moment: Pick<Moment, 'provenance'>): string => {
  const p = moment.provenance
  if (!p) return ''
  return p.model ? `via ${p.endpoint} · ${p.model}` : `via ${p.endpoint}`
}

/**
 * Pure render of the arrived moment as it appears in the Try-it result — glyph, text, provenance line,
 * elapsed seconds. Tested headless; the browser builds the SAME shape via DOM (textContent, so no
 * escaping duplication) reading MOMENT_GLYPHS from the embedded blob and this same provenance format.
 */
export const momentResultHtml = (moment: Moment, elapsedSec: number): string => {
  const prov = momentProvenanceLine(moment)
  return (
    `<div class="moment-card kind-${escapeHtml(moment.kind)}">` +
    `<span class="moment-glyph">${momentGlyph(moment.kind)}</span>` +
    `<div class="moment-body"><div class="moment-text">${escapeHtml(moment.text)}</div>` +
    `<div class="moment-meta"><span class="moment-kind">${escapeHtml(moment.kind)}</span>` +
    (prov ? ` <span class="moment-prov">${escapeHtml(prov)}</span>` : '') +
    ` <span class="moment-elapsed">${elapsedSec.toFixed(1)}s</span></div></div></div>`
  )
}

/**
 * The Try-it card's THREE TRUTHS decision (three truths, three messages), pure
 * and exported so it is asserted headless; the browser `diagnose` in assets.ts mirrors this exact branch
 * order over live GET /flags + /fabric + /moments + /queue. The card STOPS guessing: instead of pinging
 * and inferring "the model may be slow", it reads the drain's recorded reason.
 *
 * Order (first match wins): the moment arrived · the distill flags didn't stick · no llm configured ·
 * a REAL classified failure on the current llm endpoint (show it + hint + a link) · the chunk is still
 * pending with no failure ("still queued — your text is safe") · a healthy queue with nothing ("no
 * moments found in your input"). The last three are the three truths (real-failure / queued / none).
 */
export interface TryItState {
  hasMoment: boolean
  /** distill.enabled AND distill.moments are both on */
  distillReady: boolean
  /** the current (first) llm endpoint's name, or undefined when none is configured */
  llmEndpointName?: string
  llmEndpointUrl?: string
  /** the queue's last classified drain failure, if any */
  lastFailure?: { class: string; endpoint: string; hint: string; serverMessage?: string }
  /** files still pending in the queue */
  pendingFiles: number
}

export interface TryItDiagnosis {
  kind: 'arrived' | 'flags' | 'no-llm' | 'real-failure' | 'queued' | 'none'
  message: string
  /** an actionable hint (the classified failure's troubleshoot line), for real-failure */
  hint?: string
  /** true ⇒ offer a link to Settings → Endpoints */
  link?: boolean
}

/** True when a recorded failure is on the endpoint we are actually using (by name, or url in its hint). */
const failureMatchesEndpoint = (
  f: NonNullable<TryItState['lastFailure']>,
  name: string | undefined,
  url: string | undefined,
): boolean => (name !== undefined && f.endpoint === name) || (url !== undefined && url !== '' && f.hint.includes(url))

export const tryItDiagnosis = (s: TryItState): TryItDiagnosis => {
  if (s.hasMoment) return { kind: 'arrived', message: 'The moment arrived.' }
  if (!s.distillReady) {
    return { kind: 'flags', message: 'The distillation flags did not stick — open Advanced setup and check distill.enabled and distill.moments.' }
  }
  if (s.llmEndpointName === undefined) {
    return { kind: 'no-llm', message: 'No language model is configured — add one under Advanced setup and activate it.' }
  }
  const f = s.lastFailure
  if (f && failureMatchesEndpoint(f, s.llmEndpointName, s.llmEndpointUrl)) {
    return {
      kind: 'real-failure',
      message: `The model couldn’t answer — ${f.class}${f.serverMessage ? `: ${f.serverMessage}` : ''}.`,
      hint: f.hint,
      link: true,
    }
  }
  if (s.pendingFiles > 0) {
    return { kind: 'queued', message: 'Still queued — the model is slow, but your text is safe and will process. Give it a moment.' }
  }
  return { kind: 'none', message: 'No moments found in your input — try a clear commitment or decision, e.g. "we will ship on Thursday".' }
}

export const tryItHtml = (data: SetupData): string => {
  if (data.liveFabric.slots.llm.length === 0) return ''
  const hasStt = data.liveFabric.slots.stt.length > 0
  const config = { workspaceId: 'default', modeId: 'mode-meeting', hasStt }
  const consentFlags =
    '<span class="mono">distill.enabled</span>, <span class="mono">distill.moments</span>' +
    (hasStt ? ', <span class="mono">distill.transcribe</span> (for voice)' : '')
  const voice = hasStt
    ? '<button type="button" data-act="tryit-voice">Or speak (~6s)</button>' +
      '<span class="tryit-voicenote">the browser will ask for your microphone</span>'
    : '<span class="tryit-novoice">No transcription server yet — type above; audio arrives once you add ' +
      'a Hearing (stt) endpoint under Endpoints.</span>'
  return (
    '<div class="card tryit"><div class="gs-head">Try it — say something, watch it become a moment</div>' +
    '<div class="sub">This is the product, not a test button: type a sentence and watch openinfo turn it ' +
    'into a typed moment, live.</div>' +
    `<div class="tryit-consent">Trying it turns on distillation (${consentFlags}). Turn it back off any ` +
    'time under Features → the flags it lists.</div>' +
    '<form class="tryit-form"><input id="tryit-text" autocomplete="off" ' +
    'placeholder="Type a sentence — watch it become a moment." />' +
    '<button type="button" class="primary" data-act="tryit-type">Watch it become a moment</button></form>' +
    `<div class="tryit-voicebar">${voice}</div>` +
    '<div class="tryit-status" id="tryit-status"></div>' +
    '<div class="tryit-result" id="tryit-result"></div>' +
    `<script type="application/json" id="tryit-config">${jsonForScript(config)}</script>` +
    `<script type="application/json" id="moment-glyphs">${jsonForScript(MOMENT_GLYPHS)}</script>` +
    '</div>'
  )
}

/**
 * The HUD-layout section — closes the HUD-customization gap, made discoverable from
 * /setup. Lists every surface (seeded + user), marks the one the HUD renders by default, and links each
 * to its forms editor (/setup?surface=<id>). Pure and exported so its states are asserted headless.
 */
export const hudLayoutSection = (surfaces: Surface[], defaultSurfaceId: string | undefined): string => {
  if (surfaces.length === 0) return ''
  const rows = surfaces
    .map((s) => {
      const isDefault = s.id === defaultSurfaceId
      const badge = isDefault ? '<span class="badge active">HUD default</span>' : ''
      return (
        `<div class="prow"><span class="pname">${escapeHtml(s.name)}</span> ` +
        `<span class="pid">${escapeHtml(s.id)} · v${s.version} · ${escapeHtml(s.context)} · ${s.stack.length} block${s.stack.length === 1 ? '' : 's'}</span>` +
        badge +
        `<span class="spacer"></span><a href="/settings/hud-layout?surface=${encodeURIComponent(s.id)}">edit layout</a></div>`
      )
    })
    .join('')
  return `<div class="card">${rows}</div>`
}
