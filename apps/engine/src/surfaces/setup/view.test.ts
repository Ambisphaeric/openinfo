import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DiscoverResult, Fabric, FabricProfile } from '@openinfo/contracts'
import { escapeHtml, firstRunNotice, jsonForScript, renderSetupPage, type SetupData } from './view.js'

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
