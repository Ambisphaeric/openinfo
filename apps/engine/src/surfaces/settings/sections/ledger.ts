import type { Distillate, EgressDecision, FieldValue, GuardHold, GuardVerdict, InvokeUsage, Moment, OcrResult } from '@openinfo/contracts'
import { collapseFieldValuePasses } from '../../../distill/field-values.js'
import { escapeHtml, type SetupData } from '../../setup/view.js'

/**
 * The Audit ledger (#65) — the inspectable answer to "what data went where, how much, and what filtered
 * it." It renders the hop trail of each pipeline pass already recorded in provenance: stage → endpoint →
 * model → tokens in/out → guard verdict → egress. Transparency is a core product property (principle 1):
 * provenance is stamped on records throughout the pipeline but rendered almost nowhere; token accounting
 * (#65) completes it and this surface makes it visible and auditable.
 *
 * HONEST ABSENCES, not fabricated data:
 *  - GUARD (#63, now BUILT): renders each hop's recorded verdict — clean · redacted·N · unguarded — and
 *    "—" ("no hosted/public guard") only for hops that genuinely carry no guard verdict
 *    (device/LAN-local, or pre-#63).
 *  - DESTINATION / EGRESS (#64/#196): newly recorded hops distinguish `device-local`, explicitly trusted
 *    `LAN-local`, and `hosted/public`. Older provenance without the additive destination field renders
 *    "local · scope not recorded" instead of pretending network-local proves on-device. No URL or secret
 *    enters the decision or this view.
 *  - Token counts are shown with an `est` marker when the server reported no usage and the invoke layer
 *    estimated them (chars/4) — a measurement is never impersonated.
 *
 * Pure: `buildLedger` turns persisted records into passes (testable headless), `renderLedger` turns passes
 * into HTML. The route assembles `data.ledger` from the store (default workspace); the section reads it.
 */

/** One hop in a pass's trail — a single invoke and everything provenance knows about where it went. */
export interface LedgerHop {
  /**
   * the pipeline stage this hop served — `distill` (llm summary), `screen` (ocr/vlm recognition),
   * `moments` (typed-moment extraction riding a distill window, #116), `field` (a fast-field value, #61),
   * `judge` (the dual-input review of a field, #62), or `held` (an egress hop the guard suspended, #63).
   */
  stage: 'distill' | 'screen' | 'moments' | 'field' | 'judge' | 'held'
  /** the fabric capability slot that answered (llm/ocr/vlm/guard) — never a secret. */
  slot: string
  /** the fabric endpoint NAME (never a url/secret). Absent ONLY for a held hop that never reached one. */
  endpoint?: string
  /** the model that answered, when the endpoint names one. */
  model?: string
  /** token accounting for this invoke, when it was recorded (#65). */
  usage?: InvokeUsage
  /** the resolved egress decision this hop ran under (#64), when it was recorded. */
  egress?: EgressDecision
  /** the egress guard verdict this hop ran under (#63), when it was recorded — clean/redacted/held/unguarded. */
  guard?: GuardVerdict
  /** a short human what-this-hop-produced note (e.g. "3 moments", a field's label + state, a verdict). */
  detail?: string
}

/** One pipeline pass — a trail of one or more hops sharing a correlation id (#116 multi-hop). */
export interface LedgerPass {
  id: string
  /** ISO time the pass's record was created — the pass ordering key (newest first). */
  at: string
  /** the #116 correlation id shared by every record this pass produced, when the records carry one. */
  spanId?: string
  windowStart?: string
  windowEnd?: string
  hops: LedgerHop[]
}

/** The extra record streams buildLedger ingests for multi-hop trails (#116) — all optional/additive. */
export interface LedgerExtras {
  moments?: readonly Moment[]
  fieldValues?: readonly FieldValue[]
  guardHolds?: readonly GuardHold[]
}

/** The most passes we render at once — the ledger is a recent-activity audit, not an unbounded log. */
const MAX_PASSES = 100

/**
 * Turn persisted records into ledger passes, newest first. A distill pass is an llm-slot Distillate; a
 * screen pass is an OcrResult. The screen path persists BOTH an OcrResult and a mirror Distillate (slot
 * ocr/vlm) — so we take screen passes from OcrResults and SKIP ocr/vlm distillates to avoid double
 * counting. Pure — no I/O.
 *
 * MULTI-HOP (#116): `extras` folds the other pipeline records onto their trails instead of new flat rows:
 *  - moments join their window's distill pass (spanId, or the provenance.distillateId parent link) as ONE
 *    aggregated `moments` hop — the extraction was a second invoke over the same window;
 *  - a FieldValue is its own pass (its own fan-out invoke) whose trail gains a `judge` hop once a review
 *    (#62) has stamped it — the dual-input chain in one trail;
 *  - a GuardHold is its own pass with a single `held` hop: the window ran and was SUSPENDED, so the trail
 *    honestly shows the guard endpoint (when one classified) and no model endpoint (nothing was sent).
 * All extras are optional — the existing flat "all passes" behavior is byte-identical without them.
 */
export const buildLedger = (distillates: readonly Distillate[], ocrResults: readonly OcrResult[], extras: LedgerExtras = {}): LedgerPass[] => {
  const passes: LedgerPass[] = []
  const moments = extras.moments ?? []
  for (const d of distillates) {
    if (d.provenance.slot !== 'llm') continue // ocr/vlm distillates are screen-pass mirrors — counted below
    const hops: LedgerHop[] = [
      {
        stage: 'distill',
        slot: d.provenance.slot,
        endpoint: d.provenance.endpoint,
        ...(d.provenance.model !== undefined ? { model: d.provenance.model } : {}),
        ...(d.provenance.usage !== undefined ? { usage: d.provenance.usage } : {}),
        ...(d.provenance.egress !== undefined ? { egress: d.provenance.egress } : {}),
        ...(d.provenance.guard !== undefined ? { guard: d.provenance.guard } : {}),
      },
    ]
    // #116: this window's extracted moments ride the SAME pass as one aggregated hop (a second invoke
    // over the same window). Joined by spanId when both sides carry it, else the distillateId parent link.
    const windowMoments = moments.filter((m) =>
      m.spanId !== undefined && d.spanId !== undefined ? m.spanId === d.spanId : m.provenance?.distillateId === d.id,
    )
    if (windowMoments.length > 0) {
      const p = windowMoments[0]!.provenance
      hops.push({
        stage: 'moments',
        slot: p?.slot ?? 'llm',
        ...(p !== undefined ? { endpoint: p.endpoint } : {}),
        ...(p?.model !== undefined ? { model: p.model } : {}),
        ...(p?.usage !== undefined ? { usage: p.usage } : {}),
        ...(p?.egress !== undefined ? { egress: p.egress } : {}),
        ...(p?.guard !== undefined ? { guard: p.guard } : {}),
        detail: `${windowMoments.length} moment${windowMoments.length === 1 ? '' : 's'}`,
      })
    }
    passes.push({
      id: d.id,
      at: d.createdAt,
      ...(d.spanId !== undefined ? { spanId: d.spanId } : {}),
      windowStart: d.windowStart,
      windowEnd: d.windowEnd,
      hops,
    })
  }
  for (const o of ocrResults) {
    passes.push({
      id: o.id,
      at: o.createdAt,
      ...(o.spanId !== undefined ? { spanId: o.spanId } : {}),
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
  // #116: each fast-field value is its own pass; a judge review (#62) is a second hop on the SAME trail.
  for (const v of collapseFieldValuePasses(extras.fieldValues ?? [])) {
    const fieldPolicy = v.provenance as typeof v.provenance & { egress?: EgressDecision; guard?: GuardVerdict }
    const hops: LedgerHop[] = [
      {
        stage: 'field',
        slot: v.provenance.slot,
        endpoint: v.provenance.endpoint,
        ...(v.provenance.model !== undefined ? { model: v.provenance.model } : {}),
        ...(v.provenance.usage !== undefined ? { usage: v.provenance.usage } : {}),
        ...(fieldPolicy.egress !== undefined ? { egress: fieldPolicy.egress } : {}),
        ...(fieldPolicy.guard !== undefined ? { guard: fieldPolicy.guard } : {}),
        detail: `${v.label} · ${v.state}`,
      },
    ]
    const judge = v.provenance.judge
    if (judge !== undefined) {
      const judgePolicy = judge as typeof judge & { egress?: EgressDecision; guard?: GuardVerdict }
      hops.push({
        stage: 'judge',
        slot: 'llm',
        endpoint: judge.endpoint,
        ...(judge.model !== undefined ? { model: judge.model } : {}),
        ...(judge.usage !== undefined ? { usage: judge.usage } : {}),
        ...(judgePolicy.egress !== undefined ? { egress: judgePolicy.egress } : {}),
        ...(judgePolicy.guard !== undefined ? { guard: judgePolicy.guard } : {}),
        detail: judge.verdict,
      })
    }
    passes.push({
      id: v.id,
      at: v.updatedAt,
      ...(v.spanId !== undefined ? { spanId: v.spanId } : {}),
      ...(v.provenance.windowStart !== undefined ? { windowStart: v.provenance.windowStart } : {}),
      ...(v.provenance.windowEnd !== undefined ? { windowEnd: v.provenance.windowEnd } : {}),
      hops,
    })
  }
  // #116: a SUSPENDED window is a pass too — its trail is the single held hop. No model endpoint is named
  // because none was reached (fail closed); the guard endpoint that classified is named when one ran.
  for (const h of extras.guardHolds ?? []) {
    passes.push({
      id: h.id,
      at: h.createdAt,
      ...(h.spanId !== undefined ? { spanId: h.spanId } : {}),
      hops: [
        {
          stage: 'held',
          slot: 'guard',
          ...(h.verdict.guardEndpoint !== undefined ? { endpoint: h.verdict.guardEndpoint } : {}),
          guard: h.verdict,
          detail: h.status === 'held' ? `${h.stage} · awaiting release/deny` : `${h.stage} · ${h.status}`,
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

/** The destination/egress cell (#64/#196), rendered only from persisted, payload-free provenance.
 * Exported for the Trace section (#116) so both diagnostics views speak the same egress language. */
export const egressCell = (egress: EgressDecision | undefined): string => {
  if (egress === undefined) {
    return '<span class="ldg-local" title="destination scope was not recorded for this legacy hop">local <span class="ldg-model">· scope not recorded</span></span>'
  }
  if (egress.destination === 'hosted-public' || (egress.destination === undefined && egress.reach === 'egress')) {
    return `<span class="ldg-egress" title="${escapeHtml(egress.reason)}">hosted/public</span>`
  }
  if (egress.destination === 'lan-local') {
    const label = egress.rawFrameTrust === 'explicit' ? 'trusted LAN' : 'LAN-local'
    const trust = egress.rawFrameTrust === 'explicit' ? ' <span class="ldg-model">· explicit raw-frame trust</span>' : ''
    return `<span class="ldg-lan" title="${escapeHtml(egress.reason)}">${label}${trust}</span>`
  }
  if (egress.destination === 'device-local') {
    const layer = !egress.allowed ? ` <span class="ldg-model">· ${escapeHtml(egress.decidedBy)}</span>` : ''
    return `<span class="ldg-local" title="${escapeHtml(egress.reason)}">device-local${layer}</span>`
  }
  // A #64 record can carry reach without the additive #196 destination detail. `local` cannot tell us
  // whether that older endpoint was loopback or LAN, so preserve the uncertainty visibly.
  return `<span class="ldg-local" title="${escapeHtml(egress.reason)}">local <span class="ldg-model">· scope not recorded</span></span>`
}

/**
 * The guard cell for a hop (#63), rendered from the recorded verdict:
 *  - no verdict (a local hop, or a record predating #63) ⇒ the honest "— no guard" absence;
 *  - `clean` ⇒ the guard ran and flagged nothing;
 *  - `redacted` ⇒ N spans masked before the content left (the span kinds on hover — never the raw value);
 *  - `unguarded` ⇒ no guard was active and egress proceeded under an explicit acknowledgment (flagged distinctly).
 */
export const guardCell = (guard: GuardVerdict | undefined): string => {
  if (guard === undefined) return '<span class="ldg-absent" title="no hosted/public egress guard verdict for this hop (device/LAN-local, or predates #63)">— no guard</span>'
  const spanKinds = guard.spans && guard.spans.length > 0 ? guard.spans.map((s) => s.kind).join(', ') : ''
  if (guard.outcome === 'redacted') {
    return `<span class="ldg-guard-redacted" title="${escapeHtml(guard.reason)}${spanKinds ? ` — kinds: ${escapeHtml(spanKinds)}` : ''}">redacted · ${guard.maskedSpanCount}</span>`
  }
  if (guard.outcome === 'unguarded') {
    return `<span class="ldg-guard-unguarded" title="${escapeHtml(guard.reason)}">unguarded</span>`
  }
  if (guard.outcome === 'held') {
    return `<span class="ldg-guard-held" title="${escapeHtml(guard.reason)}${spanKinds ? ` — kinds: ${escapeHtml(spanKinds)}` : ''}">held</span>`
  }
  return `<span class="ldg-guard-clean" title="${escapeHtml(guard.reason)}">clean</span>`
}

/** Totals across all passes, including physical device-boundary hops (LAN + hosted/public). */
const totals = (passes: readonly LedgerPass[]): { in: number; out: number; anyEstimated: boolean; hops: number; boundaryHops: number } => {
  let inTok = 0
  let outTok = 0
  let anyEstimated = false
  let hops = 0
  let boundaryHops = 0
  for (const pass of passes) {
    for (const hop of pass.hops) {
      hops++
      if (
        hop.egress?.destination === 'lan-local' ||
        hop.egress?.destination === 'hosted-public' ||
        (hop.egress?.destination === undefined && hop.egress?.reach === 'egress')
      ) {
        boundaryHops++
      }
      if (hop.usage) {
        inTok += hop.usage.promptTokens ?? 0
        outTok += hop.usage.completionTokens ?? 0
        if (hop.usage.estimated) anyEstimated = true
      }
    }
  }
  return { in: inTok, out: outTok, anyEstimated, hops, boundaryHops }
}

/** The endpoint/model cell. A held hop that reached NO endpoint says so honestly instead of blanking. */
const endpointCell = (hop: LedgerHop): string => {
  if (hop.endpoint === undefined) {
    return '<span class="ldg-absent" title="the guard suspended this hop before any model endpoint was called — nothing was sent">held before send</span>'
  }
  return `${escapeHtml(hop.endpoint)}${hop.model ? ` <span class="ldg-model">${escapeHtml(hop.model)}</span>` : ''}`
}

const rowHtml = (pass: LedgerPass): string =>
  pass.hops
    .map(
      (hop) =>
        '<tr>' +
        `<td class="ldg-when">${escapeHtml(pass.at)}</td>` +
        `<td class="ldg-stage">${escapeHtml(hop.stage)}${hop.detail ? ` <span class="ldg-model">· ${escapeHtml(hop.detail)}</span>` : ''}</td>` +
        `<td class="ldg-ep">${endpointCell(hop)}</td>` +
        `<td>${tokensCell(hop.usage)}</td>` +
        `<td>${guardCell(hop.guard)}</td>` +
        `<td>${egressCell(hop.egress)}</td>` +
        '</tr>',
    )
    .join('')

/** One held egress hop (#63): when · stage · reason (+ masked-span kinds, never the raw value) · a
 * release/deny affordance while still held, else the resolved status. */
const heldRow = (h: GuardHold): string => {
  const kinds = h.verdict.spans && h.verdict.spans.length > 0 ? ` (kinds: ${escapeHtml(h.verdict.spans.map((s) => s.kind).join(', '))})` : ''
  const controls =
    h.status === 'held'
      ? `<button type="button" class="ldg-held-act" data-guard-hold="${escapeHtml(h.id)}" data-guard-action="release">Release</button>` +
        `<button type="button" class="ldg-held-act deny" data-guard-hold="${escapeHtml(h.id)}" data-guard-action="deny">Deny</button>`
      : `<span class="ldg-held-status">${escapeHtml(h.status)}</span>`
  return (
    '<div class="ldg-held-row">' +
    `<span class="ldg-held-when">${escapeHtml(h.createdAt)}</span>` +
    `<span class="ldg-stage">${escapeHtml(h.stage)}</span>` +
    `<span class="ldg-guard-held">held</span>` +
    `<span class="ldg-held-reason">${escapeHtml(h.verdict.reason)}${kinds}</span>` +
    controls +
    '</div>'
  )
}

/** The client wiring for the release/deny buttons — a POST /guard-holds/resolve then reload. Inline in the
 * section (the Settings surface is server-rendered per request, so this executes on load). */
const HELD_SCRIPT =
  '<script>(function(){' +
  "document.querySelectorAll('.ldg-held-act').forEach(function(b){b.addEventListener('click',function(){" +
  "var id=b.getAttribute('data-guard-hold');var action=b.getAttribute('data-guard-action');b.disabled=true;" +
  "fetch('/guard-holds/resolve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({workspaceId:'default',id:id,action:action})})" +
  '.then(function(r){if(r.ok){location.reload();}else{b.disabled=false;}}).catch(function(){b.disabled=false;});' +
  '});});})();</script>'

/**
 * The held-egress-hops block (#63) — a durable audit of every hop the guard SUSPENDED, each with its
 * verdict (span descriptors, never the raw value) and, while still held, a release/deny affordance. Empty
 * ⇒ '' (nothing held). Kept SEPARATE from the completed-pass table (a held hop produced no distillate).
 */
const heldBlock = (holds: readonly GuardHold[]): string => {
  if (holds.length === 0) return ''
  const active = holds.filter((h) => h.status === 'held').length
  return (
    '<div class="ldg-held">' +
    `<div class="ldg-held-title">${active > 0 ? `${fmt(active)} egress hop${active === 1 ? '' : 's'} held by the guard — release or deny` : 'held egress hops (resolved)'}</div>` +
    holds.map(heldRow).join('') +
    '</div>' +
    HELD_SCRIPT
  )
}

/**
 * The Audit-ledger section body. Pure — reads `data.ledger` (completed passes) and `data.guardHolds` (held
 * egress hops), assembled by the settings route from the default workspace. Empty of both ⇒ an honest
 * "nothing recorded yet" card, never a blank.
 */
export const renderLedger = (data: SetupData): string => {
  const passes = data.ledger ?? []
  const held = heldBlock(data.guardHolds ?? [])
  const intro =
    '<div class="sub">Every pass the pipeline ran, newest first — the hop trail already stamped in each ' +
    'record’s provenance: stage → endpoint → model → tokens in/out → guard verdict → egress. ' +
    'This is the audit answer to “what data went where, how much, and what filtered it.”</div>'

  if (passes.length === 0) {
    return (
      intro +
      held +
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
    `<span><span class="n">${fmt(t.boundaryHops)}</span> device-boundary hop${t.boundaryHops === 1 ? '' : 's'}</span>` +
    (t.anyEstimated ? '<span class="ldg-est">some estimated</span>' : '') +
    '</div>'

  const table =
    '<div class="ldg-scroll"><table class="ldg-table"><thead><tr>' +
    '<th>when</th><th>stage</th><th>endpoint / model</th><th>tokens</th><th>guard</th><th>egress</th>' +
    '</tr></thead><tbody>' +
    passes.map(rowHtml).join('') +
    '</tbody></table></div>'

  return intro + held + summary + table + footerNote()
}

/** The honest disclosure footer — what each column carries, and this ledger's scope. */
const footerNote = (): string =>
  '<div class="ldg-note">A pass can carry several hops (#116): a distill window lists its summary call and, when moment ' +
  'extraction ran, a second <span class="ldg-stage">moments</span> row; a field lists its fast call and, once reviewed, a ' +
  '<span class="ldg-stage">judge</span> row; a window the guard suspended appears as a <span class="ldg-stage">held</span> row ' +
  'that names no model endpoint — nothing was sent. To follow ONE input through its hops, use the Trace section. ' +
  'The guard column (#63) renders from each pass’s recorded verdict: ' +
  '<span class="ldg-guard-clean">clean</span> (guard ran, nothing flagged), ' +
  '<span class="ldg-guard-redacted">redacted · N</span> (N spans masked before the content left — kinds on hover, never the raw value), ' +
  '<span class="ldg-guard-unguarded">unguarded</span> (no guard active, hosted/public egress acknowledged), or “— no guard” for a device/LAN-local hop (the hosted/public guard does not run). ' +
  'A SUSPENDED egress hop (strict mode, or a fail-closed empty guard slot) surfaces in the held block above with a release/deny affordance. ' +
  'The destination/egress column (#64/#196) distinguishes <span class="ldg-local">device-local</span>, ' +
  '<span class="ldg-lan">trusted LAN</span> (raw bytes crossed this device’s boundary under an explicit endpoint opt-in), and ' +
  '<span class="ldg-egress">hosted/public</span>. Older rows that lack additive destination detail say “scope not recorded”; ' +
  'they are never relabeled device-local. The summary counts both LAN and hosted/public calls as device-boundary hops. ' +
  'A fresh install has no hosted/public endpoint and raw frames default to device-local. Token counts marked ' +
  '<span class="ldg-est">est</span> were estimated (chars/4) because the server ' +
  'reported no usage. This view reads the default workspace’s recorded passes (most recent 100).</div>'
