import { escapeHtml, getStartedHtml, editorHtml, hudLayoutSection, localRuntimesHtml, profilesHtml, secretsHtml, starterOfferHtml, tryItHtml, type SetupData } from '../setup/view.js'
import { renderBenchmarks } from './sections/benchmarks.js'
import { renderFeatures } from './sections/features.js'
import { renderLedger } from './sections/ledger.js'
import { renderPrivacy } from './sections/privacy.js'
import { renderStatus } from './sections/status.js'

/**
 * The Settings section registry — the spine of the sidebar: many nested configuration
 * options behind a grouped sidebar (the glass/openwebui shape). It mirrors the client's block-renderer
 * registry: each section is one pure render function registered in ONE table. The shell
 * (shell.ts) walks this table to build the grouped sidebar + the active section body.
 *
 * Adding a section later is one module + one line here (CONTRIBUTING "Add a settings section" recipe).
 * A render function is PURE: (SetupData) → HTML fragment, no I/O, no DOM — so every section is asserted
 * headless. The optional liveDot yields a cheap, server-rendered state dot for the sidebar (no polling).
 */

/** Sidebar groups, in display order. Ungrouped ('top', 'bottom') carry no header. */
export const GROUP_ORDER = ['top', 'models', 'pipeline', 'surfaces', 'diagnostics', 'bottom'] as const
export type SettingsGroup = (typeof GROUP_ORDER)[number]

/** Human header for a grouped block ('' ⇒ no header, items sit at the top level). */
export const GROUP_LABEL: Record<SettingsGroup, string> = {
  top: '',
  models: 'Models',
  pipeline: 'Pipeline',
  surfaces: 'Surfaces',
  diagnostics: 'Diagnostics',
  bottom: '',
}

/** A cheap sidebar state dot: whether it's lit, plus an optional short suffix (e.g. a count). */
export interface LiveDot {
  on: boolean
  suffix?: string
}

export interface SettingsSection {
  id: string
  group: SettingsGroup
  label: string
  /** the content-pane body for this section — pure, given the assembled data */
  render: (data: SetupData) => string
  /** an optional sidebar dot, server-rendered from data the shell already holds */
  liveDot?: (data: SetupData) => LiveDot
}

const llmOn = (data: SetupData): boolean => data.liveFabric.slots.llm.length > 0
const flagsOn = (data: SetupData): number => (data.flags ?? []).filter((f) => f.default === true).length

/** Get-started body: the capability lens when discovery ran, else a detect prompt. */
const getStartedBody = (data: SetupData): string =>
  data.discovery
    ? getStartedHtml(data.discovery, data.localModels ?? [])
    : '<div class="card"><div class="sub">Detect the local model servers on this machine and get a one-click setup.</div>' +
      '<div style="margin-top:10px"><button type="button" data-act="redetect">Detect local models</button></div></div>'

/** Endpoints body: the all-slot fabric editor, plus the intro that used to head the page. */
const endpointsBody = (data: SetupData): string =>
  '<div class="sub">Point each slot at a model server, wire a key by reference, then Save. This edits the ' +
  'active profile (or the live fabric when none is active).</div>' +
  editorHtml(data)

/** Profiles body: the list/clone/activate view, with a nudge to the editor. */
const profilesBody = (data: SetupData): string =>
  '<div class="sub">A profile is a saved fabric (config-1 → clone → a 27B on another host → STT elsewhere). ' +
  'Activate one to make it the live fabric; edit endpoints under Endpoints.</div>' +
  profilesHtml(data)

/**
 * Local-runtimes body: the runtime servers discovery FOUND on this machine (adopted mlx/omlx etc., with
 * their parakeet-style stt models grouped by slot) FIRST, then the starter-model catalog (download/run
 * llama.cpp / whisper.cpp). The discovered block only appears when discovery ran for this section (the
 * route runs it for get-started AND local-runtimes) and something answered.
 */
const localRuntimesBody = (data: SetupData): string => {
  const detected = data.discovery ? localRuntimesHtml(data.discovery.servers) : ''
  const offer = starterOfferHtml(data.localModels ?? [])
  return (
    '<div class="sub">Runtimes openinfo can use locally: servers already running on this machine (adopted over ' +
    'HTTP), and starter models openinfo can fetch and run for you (llama.cpp for chat, whisper.cpp for audio — ' +
    'downloaded models become <span class="mono">local</span> endpoints). The starter path is a CPU-friendly ' +
    'tier-zero warm-up; the real-time loop needs a serving runtime with model residency, concurrency, and current ' +
    'throughput optimizations (mlx/omlx on Apple silicon, a CUDA equivalent elsewhere) — see the model support matrix.</div>' +
    detected +
    (offer || (detected ? '' : '<div class="card"><div class="note">No runtimes detected and no starter models are catalogued.</div></div>'))
  )
}

/** HUD-layout body: the surface list + per-surface edit links. */
const hudLayoutBody = (data: SetupData): string =>
  '<div class="sub">The HUD is <span class="mono">render(surfaceDocument)</span>. Pick a surface to edit its ' +
  'blocks; the one the HUD renders by default is marked.</div>' +
  (data.surfaces && data.surfaces.length ? hudLayoutSection(data.surfaces, data.defaultSurfaceId) : '<div class="card"><div class="note">No surfaces yet.</div></div>')

/** Try-it body: the "watch it become a moment" loop, or a nudge to configure a model first. */
const tryItBody = (data: SetupData): string => {
  const html = tryItHtml(data)
  return (
    html ||
    '<div class="card"><div class="sub">Configure a language model first (Get started, or Endpoints), then ' +
    'come back here to type a sentence and watch it become a moment.</div></div>'
  )
}

/**
 * THE REGISTRY. Order here is display order within each group; groups are ordered by GROUP_ORDER.
 * Add a section = add a module under sections/ and one entry here.
 */
export const SECTIONS: readonly SettingsSection[] = [
  { id: 'status', group: 'top', label: 'Status', render: renderStatus, liveDot: (d) => ({ on: !!d.liveSession }) },
  { id: 'get-started', group: 'top', label: 'Get started', render: getStartedBody, liveDot: (d) => ({ on: llmOn(d) }) },
  { id: 'endpoints', group: 'models', label: 'Endpoints', render: endpointsBody, liveDot: (d) => ({ on: llmOn(d) }) },
  { id: 'profiles', group: 'models', label: 'Profiles', render: profilesBody },
  { id: 'keys', group: 'models', label: 'Keys', render: (d) => secretsHtml(d.secretRefs) },
  { id: 'local-runtimes', group: 'models', label: 'Local runtimes', render: localRuntimesBody },
  { id: 'features', group: 'pipeline', label: 'Features', render: renderFeatures, liveDot: (d) => ({ on: flagsOn(d) > 0, suffix: String(flagsOn(d)) }) },
  { id: 'hud-layout', group: 'surfaces', label: 'HUD layout', render: hudLayoutBody },
  // DIAGNOSTICS: Status ships now; the Audit ledger (#65) renders each pass's hop trail + token accounting
  // from provenance; Benchmarks reserves the home for the coming capability-benchmarking system (hardware
  // envelope → measured tok/s per endpoint → queue policies). Its own later slice.
  { id: 'ledger', group: 'diagnostics', label: 'Audit ledger', render: renderLedger, liveDot: (d) => ({ on: (d.ledger?.length ?? 0) > 0, suffix: String(d.ledger?.length ?? 0) }) },
  { id: 'benchmarks', group: 'diagnostics', label: 'Benchmarks', render: renderBenchmarks },
  { id: 'try-it', group: 'bottom', label: 'Try it', render: tryItBody },
  { id: 'privacy', group: 'bottom', label: 'Privacy', render: renderPrivacy },
]

/** Find a section by id. Unknown id ⇒ undefined (the route 404s a browser page). */
export const sectionById = (id: string): SettingsSection | undefined => SECTIONS.find((s) => s.id === id)

/**
 * The section to show for a bare GET /settings: Get started when the live llm slot is empty (the
 * first-run condition — the page IS the onboarding), else Status (the at-a-glance home).
 */
export const defaultSectionId = (data: SetupData): string => (data.liveFabric.slots.llm.length === 0 ? 'get-started' : 'status')

/** A humanized page title for a section (used in the <title> and the H1). */
export const sectionTitle = (section: SettingsSection): string => escapeHtml(section.label)
