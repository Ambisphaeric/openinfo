import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Fabric, FabricProfile } from '@openinfo/contracts'
import { escapeHtml, firstRunNotice, renderSetupPage, type SetupData } from './view.js'

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
  assert.match(html, /class="f-url" value="http:\/\/localhost:1234"/)
})

test('secrets section lists refs (names only) and never a value; empty shows the write-only note', () => {
  assert.match(renderSetupPage(data({ secretRefs: ['k1'] })), /data-act="delsecret" data-ref="k1"/)
  assert.match(renderSetupPage(data({ secretRefs: [] })), /write-only/)
})
