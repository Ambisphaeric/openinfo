import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DiscoverResult, Fabric, FabricProfile, Moment } from '@openinfo/contracts'
import {
  bareHostOf,
  capabilitySummary,
  editorHtml,
  escapeHtml,
  firstRunNotice,
  getStartedHtml,
  groupModelsForSlot,
  jsonForScript,
  modelDropdownHtml,
  momentGlyph,
  momentProvenanceLine,
  momentResultHtml,
  profilesHtml,
  rowTemplateHtml,
  scanStatusLine,
  secretsHtml,
  tryItHtml,
  tryItDiagnosis,
  type ScannedHost,
  type ScannedModel,
  type SetupData,
} from './view.js'

/**
 * The setup views are now re-homed behind the Settings section registry (settings/shell.ts). These
 * tests exercise the PURE section fragments directly — same coverage as when they composed one page,
 * pointed at the exported fns instead. The shell/registry behaviour (sidebar grouping, active state,
 * default section, live dots, Status/Features/Privacy) is asserted in settings/shell.test.ts.
 */

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

test('the endpoints editor emits the round-trip skeleton (base-fabric blob + save)', () => {
  const html = editorHtml(data())
  assert.match(html, /id="base-fabric"/) // the round-trip fabric blob
  assert.match(html, /data-act="save"/) // the save button
  assert.match(rowTemplateHtml([]), /id="row-tpl"/) // the add-row template
})

test('the active profile is marked, and a non-active profile offers Activate + Delete', () => {
  const two = [profile(), profile({ id: 'ollama-local', name: 'Ollama' })]
  const html = profilesHtml(data({ profiles: two, activeId: 'lm-studio-local' }))
  assert.match(html, /badge active/)
  assert.match(html, /data-act="activate" data-id="ollama-local"/)
  assert.match(html, /data-act="delete" data-id="ollama-local"/)
  // the active one must NOT offer delete/activate (guarded — you can't delete what invoke runs against)
  assert.doesNotMatch(html, /data-act="delete" data-id="lm-studio-local"/)
  assert.doesNotMatch(html, /data-act="activate" data-id="lm-studio-local"/)
})

test('ALL SIX slots are fully editable containers with an add-endpoint button', () => {
  const html = editorHtml(data())
  for (const slot of ['llm', 'stt', 'tts', 'vlm', 'ocr', 'embed']) {
    assert.match(html, new RegExp(`data-slot="${slot}"`)) // every slot is an editable container
    assert.match(html, new RegExp(`data-act="addrow" data-slot="${slot}"`)) // every slot can add endpoints
  }
})

test('the endpoint row trends toward set → connect → test → benchmark (Test live, Benchmark disabled)', () => {
  const html = editorHtml(data())
  assert.match(html, /data-act="test">Test</)
  assert.match(html, /<button type="button" disabled title="Benchmark[^>]*>Benchmark<\/button>/)
})

test('each slot carries an honest usage note — informational, never gating', () => {
  const html = editorHtml(data())
  // llm/stt say what they power today
  assert.match(html, /powers distill, drafts, and the core pass today/)
  assert.match(html, /powers call transcription today/)
  // the not-yet-invoked slots say "stored … wired in a later phase … configure freely"
  assert.match(html, /speech .*wired in a later phase \(P5\)\. Configure it freely/)
  assert.match(html, /vision is wired in a later phase\. Configure it freely/)
  assert.match(html, /screen reading is wired in a later phase \(P3\)\. Configure it freely/)
  assert.match(html, /recall \/ vector search is wired in a later phase \(P3\)\. Configure it freely/)
  // the old inert language is gone — nothing is "not wired" / inert on the page
  assert.doesNotMatch(html, /not wired/)
})

test('adding an endpoint to tts is possible (the founder repro): tts is an editable slot with add-row', () => {
  // The tts slot renders as a full editable container (data-slot + add-endpoint), exactly like llm —
  // the browser clones #row-tpl into it, so kokoro can be added from the page (no raw API calls).
  const html = editorHtml(data())
  assert.match(html, /<div class="slot" data-slot="tts">/)
  assert.match(html, /data-act="addrow" data-slot="tts"/)
  assert.match(rowTemplateHtml([]), /id="row-tpl"/) // the template the add-row clones a fresh editable http row from
})

test('a full fabric (endpoints in EVERY slot) renders each slot as editable rows the save path reads', () => {
  const full: Fabric = {
    slots: {
      llm: [{ kind: 'http', name: 'llm-a', url: 'http://h1:1234', api: 'openai-compat', model: 'qwen' }],
      stt: [{ kind: 'http', name: 'stt-a', url: 'http://h2:9000', api: 'openai-compat', model: 'whisper' }],
      tts: [{ kind: 'http', name: 'kokoro', url: 'http://h3:8880', api: 'openai-compat', model: 'kokoro' }],
      vlm: [{ kind: 'http', name: 'vlm-a', url: 'http://h4:1235', api: 'openai-compat', model: 'qwen-vl' }],
      ocr: [{ kind: 'http', name: 'ocr-a', url: 'http://h5:1236', api: 'openai-compat' }],
      embed: [{ kind: 'http', name: 'emb-a', url: 'http://h6:1237', api: 'openai-compat', model: 'nomic' }],
    },
  }
  const html = editorHtml(data({ editing: profile({ fabric: full }) }))
  // each slot's own URL field is present (the row the save path reads back)
  for (const url of ['http://h1:1234', 'http://h2:9000', 'http://h3:8880', 'http://h4:1235', 'http://h5:1236', 'http://h6:1237'])
    assert.match(html, new RegExp(`value="${url.replace(/[.]/g, '\\.')}"`))
  // the base-fabric blob carries the whole map (memoryBudgetMb + any slot the DOM might not rewrite);
  // it is html-escaped (attr-safe), so unescape before parsing
  const blob = extractBlob(html, 'base-fabric').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  const parsed = JSON.parse(blob) as Fabric
  assert.equal(parsed.slots.tts[0]!.name, 'kokoro')
  assert.equal(parsed.slots.embed[0]!.name, 'emb-a')
})

test('a non-http (local) endpoint renders as a read-only row that round-trips via data-json', () => {
  const local = { kind: 'local' as const, name: 'starter-llm', runtime: 'llama.cpp' as const, model: 'qwen2.5-1.5b' }
  const withLocal: Fabric = { slots: { ...emptyFabric().slots, llm: [local] } }
  const html = editorHtml(data({ editing: profile({ fabric: withLocal }) }))
  assert.match(html, /class="row readonly" data-kind="local"/)
  // the data-json attribute holds the exact endpoint, html-escaped; unescaping + parse yields it back
  const m = html.match(/data-json='([^']*)'/)
  assert.ok(m, 'the local row must carry a data-json blob')
  const roundTripped = JSON.parse(m![1]!.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))
  assert.deepEqual(roundTripped, local)
})

test('keyRef dropdown offers the stored refs; the editable http row carries the endpoint fields', () => {
  const html = editorHtml(data({ secretRefs: ['remote-llm-key'] }))
  assert.match(html, /<option value="remote-llm-key"/)
  assert.match(html, /class="f-url" autocomplete="off" value="http:\/\/localhost:1234"/)
})

test('secrets section lists refs (names only) and never a value; empty shows the write-only note', () => {
  assert.match(secretsHtml(['k1']), /data-act="delsecret" data-ref="k1"/)
  assert.match(secretsHtml([]), /write-only/)
})

// --- The Get-Started capability lens ---

const httpEp = (model: string) => ({ kind: 'http' as const, name: 'lm-studio', url: 'http://localhost:1234', api: 'openai-compat' as const, model })

const discover = (over: Partial<DiscoverResult> = {}): DiscoverResult => ({
  probedAt: '2026-07-07T15:00:00Z',
  servers: [{ name: 'lm-studio', url: 'http://localhost:1234', reachable: true, models: [{ id: 'qwen3-8b', slots: ['llm'] }] }],
  suggestion: { slots: { stt: [], tts: [], llm: [httpEp('qwen3-8b')], vlm: [], ocr: [], embed: [] } },
  ...over,
})

test('lens speaks capabilities, not plumbing (Thinking/Hearing/Reading/Speaking)', () => {
  const html = getStartedHtml(discover(), [])
  assert.match(html, /Get started/)
  assert.match(html, /Thinking/)
  assert.match(html, /Hearing/)
  assert.match(html, /Reading the screen/)
  assert.match(html, /Speaking/)
})

test('lens FULL: llm found ⇒ Use this setup + the suggestion blob is embedded (script-safe JSON)', () => {
  const html = getStartedHtml(discover(), [])
  assert.match(html, /data-act="use-setup"/)
  assert.match(html, /id="suggestion"/)
  assert.match(html, /Found 1 server with 1 model/)
  const json = extractBlob(html, 'suggestion')
  assert.doesNotMatch(json, /&quot;/)
  assert.equal(JSON.parse(json).slots.llm[0].model, 'qwen3-8b')
  assert.equal(json, jsonForScript(discover().suggestion))
})

test('lens PARTIAL: llm found, stt missing ⇒ Hearing shows the honest missing line', () => {
  const html = getStartedHtml(discover(), [])
  assert.match(html, /qwen3-8b/) // Thinking found
  assert.match(html, /no transcription server found/) // Hearing missing, honest copy
  assert.match(html, /not used yet/) // Reading/Speaking labelled as later
})

test('lens NOTHING found ⇒ no Use button, honest "start a server" copy, re-detect offered', () => {
  const empty = discover({
    servers: [{ name: 'lm-studio', url: 'http://localhost:1234', reachable: false, models: [], error: 'fetch failed' }],
    suggestion: { slots: { stt: [], tts: [], llm: [], vlm: [], ocr: [], embed: [] } },
  })
  const html = getStartedHtml(empty, [])
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

test('starter offer: binary present ⇒ Download button with honest size', () => {
  const html = getStartedHtml(nothingFound(), [{ model: starterModel(), runtimeAvailable: true, state: 'absent' }])
  assert.match(html, /Or download a starter model/)
  assert.match(html, /data-act="download-model"/)
  assert.match(html, /Download \(~1\.1 GB\)/)
  assert.match(html, /llm · llama\.cpp · ~1\.1 GB/)
})

test('starter offer: binary MISSING ⇒ the brew line + re-check, no download', () => {
  const html = getStartedHtml(nothingFound(), [{ model: starterModel(), runtimeAvailable: false, installHint: 'brew install llama.cpp', state: 'absent' }])
  assert.match(html, /brew install llama\.cpp/)
  assert.match(html, /data-act="redetect"/)
  assert.doesNotMatch(html, /data-act="download-model"/)
})

test('starter offer: downloading shows progress; ready shows "Use this model"', () => {
  const downloading = getStartedHtml(nothingFound(), [{ model: starterModel(), runtimeAvailable: true, state: 'downloading', downloadedBytes: 560_000_000, totalBytes: 1_120_000_000 }])
  assert.match(downloading, /downloading… 50%/)
  const ready = getStartedHtml(nothingFound(), [{ model: starterModel(), runtimeAvailable: true, state: 'ready' }])
  assert.match(ready, /data-act="use-starter"/)
  assert.match(ready, /data-runtime="llama\.cpp"/)
  assert.match(ready, /Use this model/)
})

test('starter offer: only shown in the NOTHING-found state (not when a suggestion applies)', () => {
  const html = getStartedHtml(discover(), [{ model: starterModel(), runtimeAvailable: true, state: 'absent' }])
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
  const html = tryItHtml(data({ liveFabric: emptyFabric() }))
  assert.equal(html, '')
})

test('Try-it TYPE-ONLY when llm exists but no stt: type path + honest no-voice line, no voice button', () => {
  const html = tryItHtml(data({ liveFabric: withLlm() }))
  assert.match(html, /class="card tryit"/)
  assert.match(html, /data-act="tryit-type"/)
  assert.match(html, /tryit-novoice/)
  assert.match(html, /audio arrives once you add/)
  assert.doesNotMatch(html, /data-act="tryit-voice"/)
  const consent = extractConsent(html)
  assert.match(consent, /distill\.enabled/)
  assert.match(consent, /distill\.moments/)
  assert.doesNotMatch(consent, /distill\.transcribe/)
  const cfg = JSON.parse(extractBlob(html, 'tryit-config'))
  assert.deepEqual(cfg, { workspaceId: 'default', modeId: 'mode-meeting', hasStt: false })
})

test('Try-it BOTH PATHS when llm + stt exist: voice button + distill.transcribe named in consent', () => {
  const html = tryItHtml(data({ liveFabric: withSttLlm() }))
  assert.match(html, /data-act="tryit-type"/)
  assert.match(html, /data-act="tryit-voice"/)
  assert.match(extractConsent(html), /distill\.transcribe/)
  assert.equal(JSON.parse(extractBlob(html, 'tryit-config')).hasStt, true)
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

// --- The Try-it card's THREE TRUTHS (the founder's mandate: three truths, three messages) ---

test('three truths #1 REAL FAILURE: a model-load on the current endpoint shows the real error + hint + link', () => {
  const d = tryItDiagnosis({
    hasMoment: false,
    distillReady: true,
    llmEndpointName: 'lm-studio',
    llmEndpointUrl: 'http://127.0.0.1:1234',
    lastFailure: { class: 'model-load', endpoint: 'lm-studio', hint: 'model "big" failed to load — pick a smaller/loaded model in Settings → Endpoints', serverMessage: 'Model "big" failed to load' },
    pendingFiles: 0,
  })
  assert.equal(d.kind, 'real-failure')
  assert.match(d.message, /model-load/)
  assert.match(d.message, /failed to load/)
  assert.match(d.hint ?? '', /pick a smaller\/loaded model/)
  assert.equal(d.link, true)
})

test('three truths #2 STILL QUEUED: pending with no matching failure is a distinct, reassuring state', () => {
  const d = tryItDiagnosis({ hasMoment: false, distillReady: true, llmEndpointName: 'lm', llmEndpointUrl: 'http://x', pendingFiles: 1 })
  assert.equal(d.kind, 'queued')
  assert.match(d.message, /your text is safe/)
  assert.notEqual(d.link, true)
})

test('three truths #3 NO MOMENTS: a healthy queue with nothing pending means the input had none', () => {
  const d = tryItDiagnosis({ hasMoment: false, distillReady: true, llmEndpointName: 'lm', llmEndpointUrl: 'http://x', pendingFiles: 0 })
  assert.equal(d.kind, 'none')
  assert.match(d.message, /No moments found in your input/)
})

test('a failure on a DIFFERENT endpoint does not masquerade as the current one', () => {
  const d = tryItDiagnosis({
    hasMoment: false,
    distillReady: true,
    llmEndpointName: 'current',
    llmEndpointUrl: 'http://current',
    lastFailure: { class: 'unreachable', endpoint: 'some-other', hint: 'check the URL http://other' },
    pendingFiles: 1,
  })
  assert.equal(d.kind, 'queued') // falls through to the still-queued truth, not the stale failure
})

test('the arrived moment and the flag/no-llm guards precede the three truths', () => {
  assert.equal(tryItDiagnosis({ hasMoment: true, distillReady: true, pendingFiles: 0 }).kind, 'arrived')
  assert.equal(tryItDiagnosis({ hasMoment: false, distillReady: false, pendingFiles: 0 }).kind, 'flags')
  assert.equal(tryItDiagnosis({ hasMoment: false, distillReady: true, pendingFiles: 0 }).kind, 'no-llm')
})

// --- HOST-SCAN + MODEL-DROPDOWN: the pure scan-result views the browser mirrors ---

const m = (id: string, slots: ScannedModel['slots']): ScannedModel => ({ id, slots })

const scannedHost = (over: Partial<ScannedHost> = {}): ScannedHost => ({
  url: 'http://localhost:1234', reachable: true, authRequired: false, models: [], ...over,
})

test('capabilitySummary: counts per slot, largest first, llm reads as chat, multi-slot counts in each', () => {
  const models = [
    m('a-7b', ['llm']), m('b-3b', ['llm']), m('c-1b', ['llm']),
    m('glm-ocr', ['ocr']), m('qwen-vl', ['llm', 'vlm']),
    m('nomic-embed', ['embed']), m('whisper', ['stt']),
  ]
  // llm: 4 (incl. the vl model) · then ties (1 each) in canonical slot order: stt, vlm, ocr, embed
  assert.equal(capabilitySummary(models), '4 chat · 1 stt · 1 vlm · 1 ocr · 1 embed')
  assert.equal(capabilitySummary([]), '')
})

test('groupModelsForSlot: slot-matching models first, others separate, alphabetical within groups', () => {
  const models = [m('zeta-9b', ['llm']), m('whisper-v3', ['stt']), m('alpha-3b', ['llm']), m('kokoro', ['tts'])]
  const groups = groupModelsForSlot(models, 'llm')
  assert.deepEqual(groups.matching.map((x) => x.id), ['alpha-3b', 'zeta-9b'])
  assert.deepEqual(groups.other.map((x) => x.id), ['kokoro', 'whisper-v3'])
})

test('modelDropdownHtml: matching optgroup leads, divider for others, capability chips, custom escape', () => {
  const models = [m('ornith-1.0-9b', ['llm']), m('glm-ocr', ['ocr']), m('qwen-vl', ['llm', 'vlm'])]
  const html = modelDropdownHtml(models, 'llm', 'ornith-1.0-9b')
  // a real select with the row's field class — the save path reads .f-model unchanged
  assert.match(html, /<select class="f-model"/)
  // grouping: the slot-matching group appears before the "other models" divider
  const matchAt = html.indexOf('llm — matches this slot')
  const otherAt = html.indexOf('other models')
  assert.ok(matchAt >= 0 && otherAt > matchAt)
  // capability chips ride each option label
  assert.match(html, /ornith-1\.0-9b — llm</)
  assert.match(html, /qwen-vl — llm\/vlm</)
  assert.match(html, /glm-ocr — ocr</)
  // the current model is selected; the escape hatch is always last
  assert.match(html, /value="ornith-1\.0-9b" selected/)
  assert.match(html, /<option value="__custom__">custom…<\/option><\/select>$/)
})

test('modelDropdownHtml: empty current gets a placeholder; an unknown current is kept, never dropped', () => {
  const models = [m('a-7b', ['llm'])]
  assert.match(modelDropdownHtml(models, 'llm', ''), /<option value="" selected>\(pick a model\)<\/option>/)
  const kept = modelDropdownHtml(models, 'llm', 'my-custom-model')
  assert.match(kept, /value="my-custom-model" selected>my-custom-model \(current — not reported by this server\)/)
})

test('modelDropdownHtml escapes hostile model ids', () => {
  const html = modelDropdownHtml([m('<script>alert(1)</script>', ['llm'])], 'llm', '')
  assert.ok(!html.includes('<script>'))
  assert.match(html, /&lt;script&gt;/)
})

test('scanStatusLine ok: found-count + the capabilities summary (the founder\'s list)', () => {
  const status = scanStatusLine(scannedHost({
    models: [m('a-7b', ['llm']), m('b-3b', ['llm']), m('glm-ocr', ['ocr']), m('whisper', ['stt'])],
  }))
  assert.equal(status.kind, 'ok')
  assert.equal(status.text, 'found 4 models — 2 chat · 1 stt · 1 ocr — pick one in the model dropdown')
})

test('scanStatusLine: reachable-but-empty, authRequired (hint + rescan nudge), and dead (class: message — hint)', () => {
  assert.equal(scanStatusLine(scannedHost()).kind, 'none')
  const auth = scanStatusLine(scannedHost({
    authRequired: true,
    error: { class: 'auth', hint: 'add a key in Settings → Keys and reference it via keyRef' },
  }))
  assert.equal(auth.kind, 'auth')
  assert.match(auth.text, /^this server wants a key — add a key in Settings → Keys/)
  assert.match(auth.text, /then Scan again$/)
  const dead = scanStatusLine(scannedHost({
    reachable: false,
    error: { class: 'unreachable', message: 'ECONNREFUSED', hint: 'is the server running? check the URL http://localhost:9' },
  }))
  assert.equal(dead.kind, 'dead')
  assert.equal(dead.text, 'unreachable: ECONNREFUSED — is the server running? check the URL http://localhost:9')
})

test('bareHostOf: full URLs yield the hostname; bare values yield the host; junk yields undefined', () => {
  assert.equal(bareHostOf('http://192.168.1.40:1234'), '192.168.1.40')
  assert.equal(bareHostOf('localhost'), 'localhost')
  assert.equal(bareHostOf('myhost:1234'), 'myhost')
  assert.equal(bareHostOf('rig.local/path'), 'rig.local')
  assert.equal(bareHostOf(''), undefined)
  assert.equal(bareHostOf('http://'), undefined)
})

test('every http endpoint row (and the template) carries the Scan button beside the URL field', () => {
  const html = editorHtml(data())
  const scanAt = html.indexOf('data-act="scan"')
  assert.ok(scanAt >= 0, 'the editor row must offer Scan')
  // beside the URL field: Scan sits between f-url and f-model in the row
  const urlAt = html.indexOf('class="f-url"')
  const modelAt = html.indexOf('class="f-model"')
  assert.ok(urlAt < scanAt && scanAt < modelAt)
  assert.match(rowTemplateHtml([]), /data-act="scan"/)
})
