import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Fabric } from '@openinfo/contracts'
import type { SetupData } from '../setup/view.js'
import { renderSettingsPage } from './shell.js'
import { SECTIONS, defaultSectionId, sectionById } from './registry.js'

const emptyFabric = (): Fabric => ({ slots: { stt: [], tts: [], llm: [], vlm: [], ocr: [], embed: [] } })
const withLlm = (): Fabric => ({
  slots: { ...emptyFabric().slots, llm: [{ kind: 'http', name: 'lm', url: 'http://localhost:1234', api: 'openai-compat', model: 'q' }] },
})

const data = (over: Partial<SetupData> = {}): SetupData => ({
  profiles: [],
  activeId: undefined,
  liveFabric: withLlm(),
  editing: undefined,
  secretRefs: [],
  flags: [],
  surfaces: [],
  ...over,
})

test('the shell renders the grouped sidebar (Models / Pipeline / Surfaces / Diagnostics headers)', () => {
  const html = renderSettingsPage(data())
  for (const label of ['Models', 'Pipeline', 'Surfaces', 'Diagnostics']) {
    assert.match(html, new RegExp(`class="nav-glabel">${label}<`))
  }
  // every registered section has a nav link
  for (const section of SECTIONS) {
    assert.match(html, new RegExp(`href="/settings/${section.id}"`))
  }
})

test('default section is Get started when the llm slot is empty, else Status', () => {
  assert.equal(defaultSectionId(data({ liveFabric: emptyFabric() })), 'get-started')
  assert.equal(defaultSectionId(data({ liveFabric: withLlm() })), 'status')
  // and the shell marks that section active
  const empty = renderSettingsPage(data({ liveFabric: emptyFabric() }))
  assert.match(empty, /class="nav-item active" href="\/settings\/get-started" aria-current="page"/)
  const configured = renderSettingsPage(data({ liveFabric: withLlm() }))
  assert.match(configured, /class="nav-item active" href="\/settings\/status" aria-current="page"/)
})

test('an explicit active section id is honored; an unknown id falls back to the default', () => {
  assert.match(renderSettingsPage(data(), 'features'), /class="nav-item active" href="\/settings\/features"/)
  // unknown id ⇒ default (Status here, llm present) — never a dead end
  assert.match(renderSettingsPage(data(), 'no-such-section'), /class="nav-item active" href="\/settings\/status"/)
})

test('sidebar live dots: features-on count, llm dot on endpoints, live-session dot on status', () => {
  const html = renderSettingsPage(
    data({
      liveFabric: withLlm(),
      flags: [
        { key: 'distill.enabled', default: true, scope: 'engine', description: 'x' },
        { key: 'act.enabled', default: false, scope: 'engine', description: 'y' },
      ],
      liveSession: { id: 's1', workspaceId: 'default', modeId: 'm', startedAt: '2026-07-07T00:00:00Z', attribution: { evidence: [], confidence: 1 } },
    }),
    'privacy', // render a dot-less section active so the status/features/endpoints links carry no aria-current
  )
  // Features shows the on-count (1)
  assert.match(html, /href="\/settings\/features"><span class="nav-label">Features<\/span><span class="nav-count on">1<\/span>/)
  // Endpoints carries an lit llm dot (llm configured)
  assert.match(html, /href="\/settings\/endpoints"><span class="nav-label">Endpoints<\/span><span class="nav-dot on"/)
  // Status carries a lit live-session dot
  assert.match(html, /href="\/settings\/status"><span class="nav-label">Status<\/span><span class="nav-dot on"/)
})

test('the first-run nudge banner rides non-get-started sections when the llm is empty, not get-started', () => {
  const onStatus = renderSettingsPage(data({ liveFabric: emptyFabric() }), 'features')
  assert.match(onStatus, /class="banner"/)
  const onGetStarted = renderSettingsPage(data({ liveFabric: emptyFabric() }), 'get-started')
  assert.doesNotMatch(onGetStarted, /class="banner"/)
  // configured ⇒ no banner anywhere
  assert.doesNotMatch(renderSettingsPage(data({ liveFabric: withLlm() }), 'features'), /class="banner"/)
})

test('the shell embeds the engine label + the add-row template + the browser script', () => {
  const html = renderSettingsPage(data({ engineLabel: 'localhost:8920' }))
  assert.match(html, /class="brand-engine">localhost:8920</)
  assert.match(html, /id="row-tpl"/) // the endpoints editor's add-row template
  assert.match(html, /flag-toggle/) // the features toggle wiring is present (FEATURES_SCRIPT)
})

test('every registered section renders a non-empty body (no dead sections)', () => {
  for (const section of SECTIONS) {
    const body = section.render(data({ localModels: [], surfaces: [] }))
    assert.ok(typeof body === 'string')
    // try-it renders a "configure first" card when no llm+... but it is still non-empty here (llm present)
    assert.ok(body.length > 0, `section ${section.id} rendered empty`)
  }
})

test('the Status section reports the active profile, slot occupancy and flags-on count', () => {
  const html = sectionById('status')!.render(
    data({
      liveFabric: withLlm(),
      profiles: [{ id: 'config-1', name: 'Config 1', version: 2, fabric: withLlm() }],
      activeId: 'config-1',
      flags: [{ key: 'distill.enabled', default: true, scope: 'engine', description: 'x' }],
      uptimeMs: 65_000,
    }),
  )
  assert.match(html, /Config 1/)
  assert.match(html, /1 of 1 on/) // flags-on count
  assert.match(html, /llm configured/)
  assert.match(html, /1m/) // humanized uptime
})

test('the Privacy section is static-honest: names the panes and says state cannot be detected here', () => {
  const html = sectionById('privacy')!.render(data())
  assert.match(html, /Microphone/)
  assert.match(html, /Accessibility/)
  assert.match(html, /Local Network/)
  assert.match(html, /can’t (read|detect)/)
})

test('the Benchmarks section is an honest present-but-future placeholder (no faked numbers)', () => {
  const html = sectionById('benchmarks')!.render(data())
  assert.match(html, /Coming soon/)
  assert.match(html, /tok\/s/)
  assert.match(html, /queue polic/i)
})
