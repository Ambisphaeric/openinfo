import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Distillate, FieldValue, QueryResult, Surface } from '@openinfo/contracts'
import { renderSurface, renderToHtml, type NowContext } from '../block-renderer/index.js'
import { defaultBlockRegistry } from './index.js'

/**
 * The #100 fields-panel app, DRIVEN end-to-end through the real block renderer: the actual shipped
 * surface DOCUMENT (templates/openinfo-fields/surface.json — the byte-for-byte mirror of the engine's
 * seeded `defaultFieldsSurface`; the engine documents test pins the seeded stack to the same shape)
 * rendered by `renderSurface` + `defaultBlockRegistry` with FieldValues shaped exactly like the seeded
 * fast-field prompt bundle produces (topic / entities-mentioned / work-items, provisional, full
 * provenance). No hand-rolled surface stub — if the shipped document and the renderer drift apart,
 * THIS test breaks, which is the point (the served-UI-must-be-driven rule).
 */

// clockLabel renders viewer-local; pin this process to UTC so the clock assertion below is host-stable.
process.env.TZ = 'UTC'

// dist/surfaces/blocks → dist/surfaces → dist → apps/client → apps → repo root
const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), '../../../../..', 'templates/openinfo-fields/surface.json')

const loadFieldsApp = async (): Promise<Surface> => JSON.parse(await readFile(TEMPLATE, 'utf8')) as Surface

const now: NowContext = { live: true, workspace: 'acme', title: 'Renewal — security review', topic: 'Q3 renewal', elapsed: '12m' }

/** A FieldValue exactly as the #61 fan-out lands it for one of the seeded prompt documents. */
const seededFieldValue = (fieldId: string, label: string, value: string): FieldValue => ({
  id: `fv:default:ses-1:${fieldId}`,
  fieldId,
  workspaceId: 'default',
  sessionId: 'ses-1',
  label,
  value,
  state: 'provisional',
  provenance: {
    templateId: `tpl-${fieldId}`,
    slot: 'llm',
    endpoint: 'this-mac',
    model: 'qwen2.5-7b',
    windowStart: '2026-07-10T12:00:00Z',
    windowEnd: '2026-07-10T12:00:30Z',
  },
  updatedAt: '2026-07-10T12:00:31Z',
  schemaVersion: 1,
})

const seededFields: FieldValue[] = [
  seededFieldValue('field-topic', 'topic', 'Q3 renewal pricing'),
  seededFieldValue('field-entities', 'entities-mentioned', 'Dana, security review doc, SOC 2'),
  seededFieldValue('field-work-items', 'work-items', 'send updated quote'),
]

const distillate: Distillate = {
  id: 'dist-1',
  workspaceId: 'default',
  sessionId: 'ses-1',
  windowStart: '2026-07-10T12:00:00Z',
  windowEnd: '2026-07-10T12:00:30Z',
  sourceChunks: ['chunk-1'],
  text: 'Discussed Q3 renewal pricing; Dana to review the security doc.',
  voice: { scope: 'global', dials: { tone: 5, warmth: 5, wit: 2, charm: 2, specificity: 7, brevity: 7 } },
  provenance: { slot: 'llm', endpoint: 'this-mac', model: 'qwen2.5-7b' },
  schemaVersion: 1,
  createdAt: '2026-07-10T12:00:31Z',
}

/** Hydrated results parallel to the document's stack: [now (query-less), fields, distillates]. */
const results = (fields: FieldValue[], suppressed?: number): (QueryResult | undefined)[] => [
  undefined,
  { source: 'fields', items: fields, truncated: false, ...(suppressed !== undefined ? { suppressed } : {}) },
  { source: 'distillates', items: [distillate], truncated: false },
]

test('the SHIPPED fields-app document renders the fast-fields canon through the real block renderer', async () => {
  const surface = await loadFieldsApp()
  assert.equal(surface.id, 'surf-openinfo-fields')
  const html = renderToHtml(renderSurface({ surface, now, results: results(seededFields) }, defaultBlockRegistry))

  // every seeded fast field renders: label, value, human recency why-line, provisional micro-state dot
  assert.match(html, /class="mk t">topic</)
  assert.match(html, /Q3 renewal pricing/)
  assert.match(html, /class="mk t">entities-mentioned</)
  assert.match(html, /Dana, security review doc, SOC 2/)
  assert.match(html, /class="mk t">work-items</)
  assert.match(html, /send updated quote/)
  assert.match(html, /class="why">updated 12:00p</)
  // #118 REGRESSION: the app is a human-facing tier — no endpoint, model id, or template id may render,
  // nor the old `via …` machine phrasing; the full trail stays on diagnostics surfaces + the ledger.
  assert.doesNotMatch(html, /this-mac|qwen2\.5-7b|tpl-field-/)
  assert.doesNotMatch(html, /class="why">via /)
  assert.equal((html.match(/class="dot provisional"/g) ?? []).length, 3, 'one provisional dot per field (#66)')

  // the glyph verb strip on each field row: dismiss LIVE with the fields-source suppression payload
  assert.match(html, /class="gverb" data-verb="dismiss"[^>]*data-workspace="default" data-source="fields" data-item="field-topic"/)
  // pin / mark-for-follow-up have no write path — visible-but-inert ghosts (the #15 honesty pattern)
  assert.match(html, /class="gverb ghost" data-verb="pin"/)
  assert.match(html, /class="gverb ghost" data-verb="mark-for-follow-up"/)
  // copy is live text, carrying the exact field value (the app prepares; verbs never send)
  assert.match(html, /data-copy="Q3 renewal pricing"/)

  // the distillate/transcript stream block renders beneath the fields with its own human why-line
  assert.match(html, /class="glbl">Transcript</)
  assert.match(html, /Dana to review the security doc/)
  assert.match(html, /from what was captured/)
})

test('the shipped fields-app document is honest when the fields feature is OFF: points at the fix, never blank', async () => {
  const surface = await loadFieldsApp()
  const fieldsBlock = surface.stack.find((b) => b.block === 'fields')
  assert.equal(fieldsBlock?.show, 'always', 'the app must not vanish when empty (unlike the HUD ride-along)')

  const html = renderToHtml(renderSurface({ surface, now, results: results([]) }, defaultBlockRegistry))
  assert.match(html, /class="glbl">Fields</) // the card is present…
  assert.match(html, /No fields yet/) // …and explains itself…
  assert.match(html, /turn on Fields in Settings → Features/) // …pointing at the toggle in human terms
  assert.doesNotMatch(html, /distill\.fields/) // …never the raw flag key (#118)
})
