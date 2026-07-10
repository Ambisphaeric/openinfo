import type { Distillate, EgressDecision, InvokeUsage, OcrResult } from '@openinfo/contracts'
import { escapeHtml, type SetupData } from '../../setup/view.js'

/**
 * The Audit ledger (#65) — the inspectable answer to "what data went where, how much, and what filtered
 * it." It renders the hop trail of each pipeline pass already recorded in provenance: stage → endpoint →
 * model → tokens in/out → guard verdict → egress. Transparency is a core product property (principle 1):
 * provenance is stamped on records throughout the pipeline but rendered almost nowhere; token accounting
 * (#65) completes it and this surface makes it visible and auditable.
 *
 * HONEST ABSENCES, not fabricated data:
 *  - GUARD: no guard slot exists yet (#63). The column renders "—" ("no guard configured") for every hop.
 *  - EGRESS (#64): the egress column now renders from REAL decision provenance when a record carries it —
 *    "local" (with the deciding layer when it stayed local BY POLICY) or "egress → endpoint" when content
 *    actually left. A record predating #64 has no decision, so it falls back to the honest local default
 *    (every invoke in that era was local). With a factory posture (no egress endpoint configured) nothing
 *    can leave, so the column stays "local" — but truthfully, from data, not hardcoded.
 *  - Token counts are shown with an `est` marker when the server reported no usage and the invoke layer
 *    estimated them (chars/4) — a measurement is never impersonated.
 *
 * Pure: `buildLedger` turns persisted records into passes (testable headless), `renderLedger` turns passes
 * into HTML. The route assembles `data.ledger` from the store (default workspace); the section reads it.
 */

/** One hop in a pass's trail — a single invoke and everything provenance knows about where it went. */
export interface LedgerHop {
  /** the pipeline stage this hop served — `distill` (llm summary) or `screen` (ocr/vlm recognition). */
  stage: 'distill' | 'screen'
  /** the fabric capability slot that answered (llm/ocr/vlm) — never a secret. */
  slot: string
  /** the fabric endpoint NAME (never a url/secret). */
  endpoint: string
  /** the model that answered, when the endpoint names one. */
  model?: string
  /** token accounting for this invoke, when it was recorded (#65). */
  usage?: InvokeUsage
  /** the resolved egress decision this hop ran under (#64), when it was recorded. */
  egress?: EgressDecision
}

/** One pipeline pass — today a single record ⇒ a single-hop trail; ready for multi-hop (the judge, #62). */
export interface LedgerPass {
  id: string
  /** ISO time the pass's record was created — the pass ordering key (newest first). */
  at: string
  windowStart?: string
  windowEnd?: string
  hops: LedgerHop[]
}

/** The most passes we render at once — the ledger is a recent-activity audit, not an unbounded log. */
const MAX_PASSES = 100

/**
 * Turn persisted records into ledger passes, newest first. A distill pass is an llm-slot Distillate; a
 * screen pass is an OcrResult. The screen path persists BOTH an OcrResult and a mirror Distillate (slot
 * ocr/vlm) — so we take screen passes from OcrResults and SKIP ocr/vlm distillates to avoid double
 * counting. Pure — no I/O.
 */
export const buildLedger = (distillates: readonly Distillate[], ocrResults: readonly OcrResult[]): LedgerPass[] => {
  const passes: LedgerPass[] = []
  for (const d of distillates) {
    if (d.provenance.slot !== 'llm') continue // ocr/vlm distillates are screen-pass mirrors — counted below
    passes.push({
      id: d.id,
      at: d.createdAt,
      windowStart: d.windowStart,
      windowEnd: d.windowEnd,
      hops: [
        {
          stage: 'distill',
          slot: d.provenance.slot,
          endpoint: d.provenance.endpoint,
          ...(d.provenance.model !== undefined ? { model: d.provenance.model } : {}),
          ...(d.provenance.usage !== undefined ? { usage: d.provenance.usage } : {}),
          ...(d.provenance.egress !== undefined ? { egress: d.provenance.egress } : {}),
        },
      ],
    })
  }
  for (const o of ocrResults) {
    passes.push({
      id: o.id,
      at: o.createdAt,
      hops: [
        {
          stage: 'screen',
          slot: o.provenance.slot,
          endpoint: o.provenance.endpoint,
          ...(o.provenance.model !== undefined ? { model: o.provenance.model } : {}),
          ...(o.provenance.usage !== undefined ? { usage: o.provenance.usage } : {}),
          ...(o.provenance.egress !== undefined ? { egress: o.provenance.egress } : {}),
        },
      ],
    })
  }
  passes.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)) // newest first
  return passes.slice(0, MAX_PASSES)
}

/** A grouped-thousands integer ("2,440") — small honest formatting, no library. */
const fmt = (n: number): string => n.toLocaleString('en-US')

/** The tokens-in / tokens-out cell for a hop's usage: "210 in · 34 out" (+ an `est` marker when estimated). */
const tokensCell = (usage: InvokeUsage | undefined): string => {
  if (usage === undefined) return '<span class="ldg-absent">not recorded</span>'
  const inTok = usage.promptTokens ?? 0
  const outTok = usage.completionTokens ?? 0
  const est = usage.estimated ? ' <span class="ldg-est" title="estimated (chars/4) — the server reported no usage">est</span>' : ''
  const dur = usage.durationMs !== undefined ? ` <span class="ldg-model">· ${fmt(usage.durationMs)}ms</span>` : ''
  return `<span class="ldg-tok">${fmt(inTok)} in · ${fmt(outTok)} out</span>${est}${dur}`
}

/**
 * The egress cell for a hop (#64), rendered from the recorded decision:
 *  - no decision (a record predating #64) ⇒ the honest local default;
 *  - `reach:'egress'` ⇒ content LEFT the machine — flagged distinctly (`ldg-egress`), with the reason on hover;
 *  - `reach:'local'` and denied ⇒ "local · <layer>" so the WHY-it-stayed-local is visible;
 *  - `reach:'local'` and allowed ⇒ plain "local".
 */
const egressCell = (egress: EgressDecision | undefined): string => {
  if (egress === undefined) {
    return '<span class="ldg-local" title="no egress decision recorded for this hop — it ran locally">local</span>'
  }
  if (egress.reach === 'egress') {
    return `<span class="ldg-egress" title="${escapeHtml(egress.reason)}">egress</span>`
  }
  if (!egress.allowed) {
    return `<span class="ldg-local" title="${escapeHtml(egress.reason)}">local <span class="ldg-model">· ${escapeHtml(egress.decidedBy)}</span></span>`
  }
  return '<span class="ldg-local" title="egress was allowed; a local endpoint answered">local</span>'
}

/** Totals across all passes' hops: in/out token sums, whether any count was estimated, and egress-hop count. */
const totals = (passes: readonly LedgerPass[]): { in: number; out: number; anyEstimated: boolean; hops: number; egressed: number } => {
  let inTok = 0
  let outTok = 0
  let anyEstimated = false
  let hops = 0
  let egressed = 0
  for (const pass of passes) {
    for (const hop of pass.hops) {
      hops++
      if (hop.egress?.reach === 'egress') egressed++
      if (hop.usage) {
        inTok += hop.usage.promptTokens ?? 0
        outTok += hop.usage.completionTokens ?? 0
        if (hop.usage.estimated) anyEstimated = true
      }
    }
  }
  return { in: inTok, out: outTok, anyEstimated, hops, egressed }
}

const rowHtml = (pass: LedgerPass): string =>
  pass.hops
    .map(
      (hop) =>
        '<tr>' +
        `<td class="ldg-when">${escapeHtml(pass.at)}</td>` +
        `<td class="ldg-stage">${escapeHtml(hop.stage)}</td>` +
        `<td class="ldg-ep">${escapeHtml(hop.endpoint)}${hop.model ? ` <span class="ldg-model">${escapeHtml(hop.model)}</span>` : ''}</td>` +
        `<td>${tokensCell(hop.usage)}</td>` +
        '<td class="ldg-absent" title="no guard slot yet (#63)">— no guard</td>' +
        `<td>${egressCell(hop.egress)}</td>` +
        '</tr>',
    )
    .join('')

/**
 * The Audit-ledger section body. Pure — reads only `data.ledger` (assembled by the settings route from the
 * default workspace's persisted records). Empty ⇒ an honest "nothing recorded yet" card, never a blank.
 */
export const renderLedger = (data: SetupData): string => {
  const passes = data.ledger ?? []
  const intro =
    '<div class="sub">Every pass the pipeline ran, newest first — the hop trail already stamped in each ' +
    'record’s provenance: stage → endpoint → model → tokens in/out → guard verdict → egress. ' +
    'This is the audit answer to “what data went where, how much, and what filtered it.”</div>'

  if (passes.length === 0) {
    return (
      intro +
      '<div class="card"><div class="stat-title">Audit ledger</div>' +
      '<div class="stat-note">No passes recorded yet in this workspace. Run a distill pass (Try it, or start a ' +
      'session and speak) and every invoke’s token accounting and hop trail appears here.</div></div>' +
      footerNote()
    )
  }

  const t = totals(passes)
  const summary =
    '<div class="ldg-summary">' +
    `<span><span class="n">${fmt(passes.length)}</span> pass${passes.length === 1 ? '' : 'es'}</span>` +
    `<span><span class="n">${fmt(t.hops)}</span> hop${t.hops === 1 ? '' : 's'}</span>` +
    `<span><span class="n">${fmt(t.in)}</span> tokens in</span>` +
    `<span><span class="n">${fmt(t.out)}</span> tokens out</span>` +
    `<span><span class="n">${fmt(t.egressed)}</span> egress hop${t.egressed === 1 ? '' : 's'}</span>` +
    (t.anyEstimated ? '<span class="ldg-est">some estimated</span>' : '') +
    '</div>'

  const table =
    '<div class="ldg-scroll"><table class="ldg-table"><thead><tr>' +
    '<th>when</th><th>stage</th><th>endpoint / model</th><th>tokens</th><th>guard</th><th>egress</th>' +
    '</tr></thead><tbody>' +
    passes.map(rowHtml).join('') +
    '</tbody></table></div>'

  return intro + summary + table + footerNote()
}

/** The honest disclosure footer — what each column carries, and this ledger's scope. */
const footerNote = (): string =>
  '<div class="ldg-note">Guard verdicts (#63) are not built yet, so that column renders honestly as absent — ' +
  'no guard is configured. The egress column (#64) renders from each pass’s recorded decision: a hop shows ' +
  '<span class="ldg-egress">egress</span> only when content actually left the machine, and “local · &lt;layer&gt;” ' +
  'when it stayed local because a layer (mode / workspace / prompt / content-class) denied egress. A fresh ' +
  'install has no egress-capable endpoint configured, so nothing can leave — the column stays local, truthfully ' +
  'from data. Token counts marked <span class="ldg-est">est</span> were estimated (chars/4) because the server ' +
  'reported no usage. This view reads the default workspace’s recorded passes (most recent 100).</div>'
