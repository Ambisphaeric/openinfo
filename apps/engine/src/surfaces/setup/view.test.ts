import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DiscoverResult, Fabric, FabricProfile, Moment } from '@openinfo/contracts'
import {
  escapeHtml,
  firstRunNotice,
  jsonForScript,
  momentGlyph,
  momentProvenanceLine,
  momentResultHtml,
  renderSetupPage,
  type SetupData,
} from './view.js'

const emptyFabric = (): Fabric => ({ slots: { stt: [], tts: [], llm: [], vlm: [], ocr: [], embed: [] } })

const withLlm = (): Fabric => ({
  slots: { ...emptyFabric().slots, llm: [{ kind: 'http', name: 'lm', url: 'http://localhost:1234', api: 'openai-compat', model: 'local' }] },
})

const profile = (over: Partial<FabricProfile> = {}): FabricProfile => ({
  id: 'lm-studio-local', name: 'LM Studio (local)', version: 1, fabric: withLlm(), ...over,
})

const data = (over: Partial<SetupData> = {}): SetupData => ({
  profiles: [profile()],
  activeId: undefined,
  liveFabric: emptyFabric(),
  editing: profile(),
  secretRefs: [],
  ...over,
})

/** Pull the raw JSON text out of a `<script type="application/json" id="X">…</script>` blob. */
const extractBlob = (html: string, id: string): string => {
  const open = `id="${id}">`
  const start = html.indexOf(open) + open.length
  return html.slice(start, html.indexOf('</script>', start))
}

/** Pull the Try-it consent line's text (scoped so page-wide script mentions don't leak into asserts). */
const extractConsent = (html: string): string => {
  const open = 'class="tryit-consent">'
  const start = html.indexOf(open) + open.length
  return html.slice(start, html.indexOf('</div>', start))
}

test('firstRunNotice fires only when the live llm slot is empty', () => {
  const n = firstRunNotice(emptyFabric())
  assert.ok(n && /distill/.test(n) && /llm endpoint/.test(n))
  assert.equal(firstRunNotice(withLlm()), null)
})

test('escapeHtml neutralises markup and quotes', () => {
  assert.equal(escapeHtml(`<a href="x" o='y'>&`), '&lt;a href=&quot;x&quot; o=&#39;y&#39;&gt;&amp;')
})

test('renderSetupPage emits the expected skeleton', () => {
  const html = renderSetupPage(data())
  assert.match(html, /^<!doctype html>/)
  assert.match(html, /<title>openinfo · model setup<\/title>/)
  assert.match(html, />Profiles</)
  assert.match(html, />Edit endpoints</)
  assert.match(html, />Keys</)
  assert.match(html, /id="row-tpl"/) // the add-row template
  assert.match(html, /id="base-fabric"/) // the round-trip fabric blob
  assert.match(html, /data-act="save"/) // the save button
})

test('the first-run banner shows when the live fabric has no llm, and not otherwise', () => {
  assert.match(renderSetupPage(data({ liveFabric: emptyFabric() })), /class="banner"/)
  assert.doesNotMatch(renderSetupPage(data({ liveFabric: withLlm() })), /class="banner"/)
})

test('the active profile is marked, and a non-active profile offers Activate + Delete', () => {
  const two = [profile(), profile({ id: 'ollama-local', name: 'Ollama' })]
  const html = renderSetupPage(data({ profiles: two, activeId: 'lm-studio-local' }))
  assert.match(html, /badge active/)
  assert.match(html, /data-act="activate" data-id="ollama-local"/)
  assert.match(html, /data-act="delete" data-id="ollama-local"/)
  // the active one must NOT offer delete/activate (guarded — you can't delete what invoke runs against)
  assert.doesNotMatch(html, /data-act="delete" data-id="lm-studio-local"/)
  assert.doesNotMatch(html, /data-act="activate" data-id="lm-studio-local"/)
})

test('llm + stt are editable rows; tts/vlm/ocr/embed are present-but-inert with a note', () => {
  const html = renderSetupPage(data())
  assert.match(html, /data-slot="llm"/)
  assert.match(html, /data-slot="stt"/)
  assert.doesNotMatch(html, /data-slot="tts"/) // inert slots are not editable containers
  assert.match(html, /not wired/) // the inert note
})

test('keyRef dropdown offers the stored refs; the editable http row carries the endpoint fields', () => {
  const html = renderSetupPage(data({ secretRefs: ['remote-llm-key'] }))
  assert.match(html, /<option value="remote-llm-key"/)
  assert.match(html, /class="f-url" autocomplete="off" value="http:\/\/localhost:1234"/)
})

test('secrets section lists refs (names only) and never a value; empty shows the write-only note', () => {
  assert.match(renderSetupPage(data({ secretRefs: ['k1'] })), /data-act="delsecret" data-ref="k1"/)
  assert.match(renderSetupPage(data({ secretRefs: [] })), /write-only/)
})

// --- The Get-Started capability lens (discover present) ---

const httpEp = (model: string) => ({ kind: 'http' as const, name: 'lm-studio', url: 'http://localhost:1234', api: 'openai-compat' as const, model })

const discover = (over: Partial<DiscoverResult> = {}): DiscoverResult => ({
  probedAt: '2026-07-07T15:00:00Z',
  servers: [{ name: 'lm-studio', url: 'http://localhost:1234', reachable: true, models: [{ id: 'qwen3-8b', slots: ['llm'] }] }],
  suggestion: { slots: { stt: [], tts: [], llm: [httpEp('qwen3-8b')], vlm: [], ocr: [], embed: [] } },
  ...over,
})

test('no discovery ⇒ page renders exactly as before (no lens, sections open, no Advanced disclosure)', () => {
  const html = renderSetupPage(data())
  assert.doesNotMatch(html, /Get started/)
  assert.doesNotMatch(html, /details id="advanced"/)
  assert.match(html, />Profiles</) // sections are directly present
})

test('discovery present ⇒ the Get-Started lens leads and the editor moves behind Advanced setup', () => {
  const html = renderSetupPage(data({ discovery: discover() }))
  assert.match(html, /class="card getstarted"/)
  assert.match(html, /Get started/)
  // capability lens speaks capabilities, not plumbing
  assert.match(html, /Thinking/)
  assert.match(html, /Hearing/)
  assert.match(html, /Reading the screen/)
  assert.match(html, /Speaking/)
  // the full editor is now behind the Advanced disclosure
  assert.match(html, /<details id="advanced"/)
  // the lens leads the body (Get started appears before the Advanced section)
  assert.ok(html.indexOf('Get started') < html.indexOf('details id="advanced"'))
})

test('lens FULL: llm found ⇒ Use this setup + the suggestion blob is embedded (script-safe JSON)', () => {
  const html = renderSetupPage(data({ discovery: discover() }))
  assert.match(html, /data-act="use-setup"/)
  assert.match(html, /id="suggestion"/)
  assert.match(html, /Found 1 server with 1 model/)
  // the embedded blob is real JSON (not html-escaped) so JSON.parse works in the browser
  const blob = html.slice(html.indexOf('id="suggestion">') + 'id="suggestion">'.length)
  const json = blob.slice(0, blob.indexOf('</script>'))
  assert.doesNotMatch(json, /&quot;/)
  assert.equal(JSON.parse(json).slots.llm[0].model, 'qwen3-8b')
  assert.equal(json, jsonForScript(discover().suggestion))
})

test('lens PARTIAL: llm found, stt missing ⇒ Hearing shows the honest missing line', () => {
  const html = renderSetupPage(data({ discovery: discover() }))
  assert.match(html, /qwen3-8b/) // Thinking found
  assert.match(html, /no transcription server found/) // Hearing missing, honest copy
  assert.match(html, /not used yet/) // Reading/Speaking labelled as later
})

test('lens NOTHING found ⇒ no Use button, honest "start a server" copy, re-detect offered', () => {
  const empty = discover({
    servers: [{ name: 'lm-studio', url: 'http://localhost:1234', reachable: false, models: [], error: 'fetch failed' }],
    suggestion: { slots: { stt: [], tts: [], llm: [], vlm: [], ocr: [], embed: [] } },
  })
  const html = renderSetupPage(data({ discovery: empty }))
  assert.doesNotMatch(html, /data-act="use-setup"/)
  assert.match(html, /No local model server responded/)
  assert.match(html, /Start LM Studio or Ollama/)
  assert.match(html, /data-act="redetect"/)
})

// --- Tier zero: the starter-model offer in the NOTHING-found state (slice c) ---

const nothingFound = () =>
  discover({
    servers: [{ name: 'lm-studio', url: 'http://localhost:1234', reachable: false, models: [], error: 'fetch failed' }],
    suggestion: { slots: { stt: [], tts: [], llm: [], vlm: [], ocr: [], embed: [] } },
  })

const starterModel = (over: Partial<import('@openinfo/contracts').StarterModel> = {}): import('@openinfo/contracts').StarterModel => ({
  id: 'qwen2.5-1.5b', slot: 'llm', runtime: 'llama.cpp', name: 'Qwen2.5 1.5B',
  filename: 'q.gguf', url: 'https://x/q.gguf', sizeBytes: 1_120_000_000, ...over,
})

test('starter offer: binary present + absent ⇒ Download button with honest size', () => {
  const html = renderSetupPage(data({
    discovery: nothingFound(),
    localModels: [{ model: starterModel(), runtimeAvailable: true, state: 'absent' }],
  }))
  assert.match(html, /Or download a starter model/)
  assert.match(html, /data-act="download-model"/)
  assert.match(html, /Download \(~1\.1 GB\)/)
  assert.match(html, /llm · llama\.cpp · ~1\.1 GB/)
})

test('starter offer: binary MISSING ⇒ the brew line + re-check, no download', () => {
  const html = renderSetupPage(data({
    discovery: nothingFound(),
    localModels: [{ model: starterModel(), runtimeAvailable: false, installHint: 'brew install llama.cpp', state: 'absent' }],
  }))
  assert.match(html, /brew install llama\.cpp/)
  assert.match(html, /data-act="redetect"/)
  assert.doesNotMatch(html, /data-act="download-model"/)
})

test('starter offer: downloading shows progress; ready shows "Use this model"', () => {
  const downloading = renderSetupPage(data({
    discovery: nothingFound(),
    localModels: [{ model: starterModel(), runtimeAvailable: true, state: 'downloading', downloadedBytes: 560_000_000, totalBytes: 1_120_000_000 }],
  }))
  assert.match(downloading, /downloading… 50%/)
  const ready = renderSetupPage(data({
    discovery: nothingFound(),
    localModels: [{ model: starterModel(), runtimeAvailable: true, state: 'ready' }],
  }))
  assert.match(ready, /data-act="use-starter"/)
  assert.match(ready, /data-runtime="llama\.cpp"/)
  assert.match(ready, /Use this model/)
})

test('starter offer: only shown in the NOTHING-found state (not when a suggestion applies)', () => {
  const html = renderSetupPage(data({
    discovery: discover(), // has a usable llm suggestion
    localModels: [{ model: starterModel(), runtimeAvailable: true, state: 'absent' }],
  }))
  assert.doesNotMatch(html, /Or download a starter model/)
  assert.match(html, /data-act="use-setup"/) // the found suggestion leads instead
})

// --- The Try-it loop (slice b): say something, watch it become a moment ---

const withSttLlm = (): Fabric => ({
  slots: {
    ...emptyFabric().slots,
    llm: [{ kind: 'http', name: 'lm', url: 'http://localhost:1234', api: 'openai-compat', model: 'qwen3-8b' }],
    stt: [{ kind: 'http', name: 'whisper', url: 'http://localhost:9000', api: 'openai-compat', model: 'whisper-1' }],
  },
})

const moment = (over: Partial<Moment> = {}): Moment => ({
  id: 'm1', sessionId: 's1', workspaceId: 'default', at: '2026-07-07T15:00:00Z',
  kind: 'commitment', text: 'we will ship on Thursday', refs: [], source: 'mic', confidence: 0.85,
  provenance: { slot: 'llm', endpoint: 'llm.fast', model: 'qwen3-8b' }, ...over,
})

test('Try-it HIDDEN when no llm endpoint exists (the lens/banner leads instead)', () => {
  const html = renderSetupPage(data({ liveFabric: emptyFabric() }))
  assert.doesNotMatch(html, /class="card tryit"/)
  assert.doesNotMatch(html, /data-act="tryit-type"/)
})

test('Try-it TYPE-ONLY when llm exists but no stt: type path + honest no-voice line, no voice button', () => {
  const html = renderSetupPage(data({ liveFabric: withLlm() }))
  assert.match(html, /class="card tryit"/)
  assert.match(html, /data-act="tryit-type"/)
  assert.match(html, /tryit-novoice/)
  assert.match(html, /audio arrives once you add/)
  assert.doesNotMatch(html, /data-act="tryit-voice"/)
  // the consent copy names the flags it flips; distill.transcribe is NOT promised without stt
  const consent = extractConsent(html)
  assert.match(consent, /distill\.enabled/)
  assert.match(consent, /distill\.moments/)
  assert.doesNotMatch(consent, /distill\.transcribe/)
  // the embedded config carries the seeded meeting mode + default workspace, hasStt false
  const cfg = JSON.parse(extractBlob(html, 'tryit-config'))
  assert.deepEqual(cfg, { workspaceId: 'default', modeId: 'mode-meeting', hasStt: false })
})

test('Try-it BOTH PATHS when llm + stt exist: voice button + distill.transcribe named in consent', () => {
  const html = renderSetupPage(data({ liveFabric: withSttLlm() }))
  assert.match(html, /data-act="tryit-type"/)
  assert.match(html, /data-act="tryit-voice"/)
  assert.match(extractConsent(html), /distill\.transcribe/)
  assert.equal(JSON.parse(extractBlob(html, 'tryit-config')).hasStt, true)
  // the glyph map is embedded (single source the browser reads to render the arrived moment)
  assert.equal(JSON.parse(extractBlob(html, 'moment-glyphs')).commitment, '●')
})

test('momentGlyph maps every kind and falls back to a dot', () => {
  assert.equal(momentGlyph('commitment'), '●')
  assert.equal(momentGlyph('question'), '◆')
  assert.equal(momentGlyph('decision'), '▲')
  assert.equal(momentGlyph('artifact'), '✱')
  assert.equal(momentGlyph('note'), '·')
  assert.equal(momentGlyph('unknown-kind'), '·')
})

test('momentProvenanceLine is the one-line why (endpoint · model), model optional', () => {
  assert.equal(momentProvenanceLine(moment()), 'via llm.fast · qwen3-8b')
  assert.equal(momentProvenanceLine(moment({ provenance: { slot: 'llm', endpoint: 'llm.fast' } })), 'via llm.fast')
  assert.equal(momentProvenanceLine({}), '')
})

test('momentResultHtml renders glyph, text, kind, provenance and elapsed seconds; escapes text', () => {
  const html = momentResultHtml(moment({ text: '<b>ship</b> Thursday' }), 3.14159)
  assert.match(html, /moment-glyph">●</)
  assert.match(html, /&lt;b&gt;ship&lt;\/b&gt; Thursday/) // text is escaped
  assert.match(html, /moment-kind">commitment</)
  assert.match(html, /via llm\.fast · qwen3-8b/)
  assert.match(html, /3\.1s<\/span>/) // elapsed, one decimal
})
