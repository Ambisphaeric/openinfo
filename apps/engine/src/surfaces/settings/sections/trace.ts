import type { Distillate, EgressDecision, FieldValue, GuardHold, GuardVerdict, InvokeUsage, Moment, OcrResult, SttSegment } from '@openinfo/contracts'
import { groupFieldValuePasses, type FieldValuePassHistory } from '../../../distill/field-values.js'
import { escapeHtml, type SetupData } from '../../setup/view.js'
import { egressCell, guardCell } from './ledger.js'

/**
 * The Trace section (#116) — pick ONE input (a transcribed utterance segment, or a screen capture) and
 * walk it through every engine step to its rendered output: heard → summary → moments → fields → judge,
 * with each hop's guard verdict (#63) and egress decision (#64) alongside. The Audit ledger answers
 * "what ran, newest first"; this answers "what happened to THIS input".
 *
 * It walks only PERSISTED links — SttSegment.chunkId ↔ Distillate.sourceChunks ↔
 * FieldValueProvenance.sourceChunks, the moment/entity distillateId parents, and the #116 spanId
 * correlation ids — never fuzzy time matching. Records made before #116 don't carry these links; the
 * footer says so instead of pretending they are traceable.
 *
 * Pure: `buildTraceInputs`/`buildTrace` turn persisted records into a trail (testable headless),
 * `renderTrace` turns it into HTML. The route assembles `data.trace` from the store (default workspace)
 * inside a try/catch, so an assembly failure surfaces as visible text on this page — never a blank.
 */

/** The record streams a trace reads — assembled by the settings route from the default workspace. */
export interface TraceRecords {
  sttSegments: readonly SttSegment[]
  distillates: readonly Distillate[]
  moments: readonly Moment[]
  fieldValues: readonly FieldValue[]
  guardHolds: readonly GuardHold[]
  ocrResults: readonly OcrResult[]
}

/** One selectable input — an utterance segment (SttSegment) or a screen capture (OcrResult). */
export interface TraceInput {
  id: string
  kind: 'utterance' | 'capture'
  /** ISO time the input was captured — the list ordering key (newest first). */
  at: string
  /** the human headline for the picker ("Microphone · 118 characters heard"). */
  label: string
  /** the system-register second line (endpoint · model · timing) — diagnostics detail, never HUD-tier. */
  meta: string
  /** the input invoke's recorded destination decision (STT root today); absent for legacy records. */
  egress?: EgressDecision
}

/** One hop on a trail — a step the input actually took, with everything provenance recorded about it. */
export interface TraceHop {
  stage: 'heard' | 'seen' | 'summary' | 'moment' | 'field' | 'judge' | 'held'
  /** ISO time this hop's record was created, when the record carries one. */
  at?: string
  /** the human headline ("Summarized", "Noted a commitment", "Field “Topic” updated"). */
  title: string
  /** the produced text (summary excerpt, moment text, field value) — absent when none is persisted. */
  body?: string
  /** the system-register detail line (endpoint · model · tokens/duration). */
  meta?: string
  usage?: InvokeUsage
  guard?: GuardVerdict
  egress?: EgressDecision
  /** An actual invoke needs an explicit policy row; a blocked hop names that no target was reached. */
  policy?: 'invoke' | 'blocked' | 'delivery-failure'
}

/** The full walk for one selected input. `hops` excludes the root (rendered from the input itself). */
export interface TraceTrail {
  input: TraceInput
  hops: TraceHop[]
}

/** What the settings route assembles for this section. `problem` carries an assembly failure's true reason. */
export interface TraceData {
  inputs: TraceInput[]
  selectedId?: string
  /** the selected input's walk; undefined WITH a selectedId ⇒ the id matched no recorded input. */
  trail?: TraceTrail
  problem?: string
}

/** The most inputs offered at once — the picker is a recent-activity list, not an unbounded log. */
const MAX_INPUTS = 30

/** Truncate a produced text for the trail (full text lives on the record; this is a walk, not a reader). */
const excerpt = (text: string, max = 240): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

const lane = (source: string): string => (source === 'mic' ? 'Microphone' : source === 'system-audio' ? 'System audio' : source)

/** "endpoint · model · 940ms" — the system-register meta line composed from what was actually recorded. */
const metaLine = (endpoint: string | undefined, model: string | undefined, durationMs?: number): string =>
  [endpoint, model, durationMs !== undefined ? `${durationMs.toLocaleString('en-US')}ms` : undefined].filter((p): p is string => p !== undefined && p !== '').join(' · ')

const utteranceInput = (s: SttSegment): TraceInput => ({
  id: s.id,
  kind: 'utterance',
  at: s.capturedAt,
  label: `${lane(s.source)} · ${s.textChars.toLocaleString('en-US')} characters heard`,
  meta: metaLine(s.provenance.endpoint, s.provenance.model, s.provenance.durationMs),
  ...(s.provenance.egress !== undefined ? { egress: s.provenance.egress } : {}),
})

const captureInput = (o: OcrResult): TraceInput => ({
  id: o.id,
  kind: 'capture',
  at: o.capturedAt ?? o.createdAt,
  label: `Screen · ${o.text.length.toLocaleString('en-US')} characters recognized`,
  meta: metaLine(o.provenance.endpoint, o.provenance.model),
})

/** The selectable inputs, newest first, capped — utterance segments and screen captures. Pure. */
export const buildTraceInputs = (records: TraceRecords): TraceInput[] => {
  const inputs = [...records.sttSegments.map(utteranceInput), ...records.ocrResults.map(captureInput)]
  inputs.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  return inputs.slice(0, MAX_INPUTS)
}

interface TraceScope {
  workspaceId: string
  sessionId: string
}

const inSession = (scope: TraceScope, record: { workspaceId: string; sessionId: string }): boolean =>
  record.workspaceId === scope.workspaceId && record.sessionId === scope.sessionId

const inOptionalSession = (scope: TraceScope, record: { workspaceId: string; sessionId?: string }): boolean =>
  record.workspaceId === scope.workspaceId && (record.sessionId === undefined || record.sessionId === scope.sessionId)

/** The moments joined to a distillate — same session, then spanId or the legacy distillateId parent. */
const momentsOf = (scope: TraceScope, d: Distillate, moments: readonly Moment[]): Moment[] =>
  moments.filter(
    (m) =>
      inSession(scope, m) &&
      (m.spanId !== undefined && d.spanId !== undefined ? m.spanId === d.spanId : m.provenance?.distillateId === d.id),
  )

const momentHop = (m: Moment): TraceHop => ({
  stage: 'moment',
  at: m.at,
  title: `Noted a ${m.kind}`,
  body: excerpt(m.text),
  ...(m.provenance !== undefined ? { meta: metaLine(m.provenance.endpoint, m.provenance.model, m.provenance.usage?.durationMs) } : {}),
  ...(m.provenance?.usage !== undefined ? { usage: m.provenance.usage } : {}),
  ...(m.provenance?.guard !== undefined ? { guard: m.provenance.guard } : {}),
  ...(m.provenance?.egress !== undefined ? { egress: m.provenance.egress } : {}),
  policy: 'invoke',
})

const summaryHop = (d: Distillate): TraceHop => ({
  stage: 'summary',
  at: d.createdAt,
  title: 'Summarized',
  body: excerpt(d.text),
  meta: metaLine(d.provenance.endpoint, d.provenance.model, d.provenance.usage?.durationMs),
  ...(d.provenance.usage !== undefined ? { usage: d.provenance.usage } : {}),
  ...(d.provenance.guard !== undefined ? { guard: d.provenance.guard } : {}),
  ...(d.provenance.egress !== undefined ? { egress: d.provenance.egress } : {}),
  policy: 'invoke',
})

/** A screen mirror is a second durable record from the SAME recognition pass, not another model call. */
const screenMirrorHop = (d: Distillate): TraceHop => ({
  stage: 'summary',
  at: d.createdAt,
  title: 'Published to the summary stream',
  body: excerpt(d.text),
  meta: 'mirror of the screen pass · no second model call',
})

const fieldHop = (v: FieldValue): TraceHop => {
  // Field/Judge policy provenance is additive. This structural view keeps the Trace repair independently
  // cherry-pickable from the privacy repair while rendering those persisted fields as soon as they exist.
  const fieldPolicy = v.provenance as typeof v.provenance & { egress?: EgressDecision; guard?: GuardVerdict }
  return {
    stage: 'field',
    at: v.updatedAt,
    title: `Field “${v.label}” updated · ${v.state}`,
    body: excerpt(v.value),
    meta: metaLine(v.provenance.endpoint, v.provenance.model, v.provenance.usage?.durationMs),
    ...(v.provenance.usage !== undefined ? { usage: v.provenance.usage } : {}),
    ...(fieldPolicy.guard !== undefined ? { guard: fieldPolicy.guard } : {}),
    ...(fieldPolicy.egress !== undefined ? { egress: fieldPolicy.egress } : {}),
    policy: 'invoke',
  }
}

const judgeHops = (pass: FieldValuePassHistory): TraceHop[] => {
  const hops: TraceHop[] = []
  for (const reviewed of pass.reviews) {
    const judge = reviewed.provenance.judge!
    const judgePolicy = judge as typeof judge & { egress?: EgressDecision; guard?: GuardVerdict }
    const changed =
      judge.verdict === 'correct'
        ? `Changed to “${excerpt(reviewed.value, 80)}”${judge.priorValue !== undefined ? ` — was “${excerpt(judge.priorValue, 80)}”` : ''}`
        : ''
    hops.push({
      stage: 'judge',
      at: judge.judgedAt,
      title: `Judge ${judge.verdict === 'confirm' ? 'confirmed it' : judge.verdict === 'correct' ? 'corrected it' : 'flagged it'}`,
      ...(judge.note !== undefined || changed !== '' ? { body: excerpt([judge.note, changed].filter((part): part is string => part !== undefined && part !== '').join(' — ')) } : {}),
      meta: metaLine(judge.endpoint, judge.model, judge.usage?.durationMs),
      ...(judge.usage !== undefined ? { usage: judge.usage } : {}),
      ...(judgePolicy.guard !== undefined ? { guard: judgePolicy.guard } : {}),
      ...(judgePolicy.egress !== undefined ? { egress: judgePolicy.egress } : {}),
      policy: 'invoke',
    })
  }
  return hops
}

type DeliveryAwareHold = GuardHold & {
  target?: {
    endpoint: string
    model?: string
    destination?: string
    delivery?: 'possible' | 'confirmed'
    failureClass?: string
  }
}

const heldHop = (h: GuardHold): TraceHop => {
  // The privacy repair adds target-delivery truth. Keep this structural so the commits remain independently
  // cherry-pickable, while rendering it immediately once that additive contract lands.
  const target = (h as DeliveryAwareHold).target
  const delivery = target?.delivery
  const deliveryPrefix =
    delivery === 'confirmed'
      ? 'Target received the request but failed'
      : delivery === 'possible'
        ? 'Target may have received the request before failing'
        : undefined
  const title =
    deliveryPrefix !== undefined
      ? h.status === 'held'
        ? `${deliveryPrefix} — fallback held by the guard at ${h.stage}`
        : h.status === 'released'
          ? `${deliveryPrefix}; release approval recorded — the original fallback was not rerun`
          : `${deliveryPrefix}; fallback denied`
      : h.status === 'held'
        ? `Held by the guard at ${h.stage} — the target model was not called, awaiting release or deny`
        : h.status === 'released'
          ? 'Release approval recorded — the original held pass was not rerun'
          : 'Held by the guard, then denied'
  const targetMeta = target !== undefined
    ? [metaLine(target.endpoint, target.model), target.destination, target.failureClass].filter((part): part is string => part !== undefined && part !== '').join(' · ')
    : undefined
  return {
    stage: 'held',
    at: h.createdAt,
    title,
    body: h.verdict.reason,
    ...(targetMeta !== undefined && targetMeta !== ''
      ? { meta: targetMeta }
      : h.verdict.guardEndpoint !== undefined
        ? { meta: metaLine(h.verdict.guardEndpoint, undefined) }
        : {}),
    guard: h.verdict,
    policy: delivery === undefined ? 'blocked' : 'delivery-failure',
  }
}

const olderFirst = <T>(at: (value: T) => string, id: (value: T) => string) => (a: T, b: T): number => {
  const aa = at(a)
  const ba = at(b)
  return aa < ba ? -1 : aa > ba ? 1 : id(a).localeCompare(id(b))
}

const causalFieldValues = (scope: TraceScope, sourceChunks: ReadonlySet<string>, versions: readonly FieldValue[]): FieldValuePassHistory[] => {
  return groupFieldValuePasses(
    versions.filter(
      (value) =>
        inOptionalSession(scope, value) &&
        (value.provenance.sourceChunks?.some((chunkId) => sourceChunks.has(chunkId)) ?? false),
    ),
  )
}

type HoldBand = 'before-fields' | 'field' | 'review' | 'later'

const holdBand = (hold: GuardHold): HoldBand => {
  const stage = hold.stage.toLowerCase()
  if (stage.includes('field')) return 'field'
  if (stage.includes('judge') || stage.includes('orientation')) return 'review'
  if (
    stage.includes('distill') ||
    stage.includes('summary') ||
    stage.includes('moment') ||
    stage.includes('entit') ||
    stage.includes('screen') ||
    stage.includes('ocr') ||
    stage.includes('vlm')
  ) return 'before-fields'
  return 'later'
}

/** Build downstream hops in causal link order, never by comparing timestamps from different clocks. */
const downstreamHops = (scope: TraceScope, sourceChunkIds: readonly string[], windows: readonly Distillate[], records: TraceRecords): TraceHop[] => {
  const hops: TraceHop[] = []
  const sortedWindows = [...windows].sort(olderFirst((d) => d.createdAt, (d) => d.id))
  for (const distillate of sortedWindows) {
    // `Moment.at` is the material/event instant (normally windowEnd), while Distillate.createdAt is the
    // processing instant. The parent summary MUST therefore be appended before its child moments.
    hops.push(distillate.provenance.slot === 'ocr' || distillate.provenance.slot === 'vlm' ? screenMirrorHop(distillate) : summaryHop(distillate))
    const moments = momentsOf(scope, distillate, records.moments).sort(olderFirst((moment) => moment.at, (moment) => moment.id))
    hops.push(...moments.map(momentHop))
  }
  const sourceChunks = new Set(sourceChunkIds)
  const holds = records.guardHolds
    .filter(
      (hold) =>
        inOptionalSession(scope, hold) &&
        (hold.sourceChunks?.some((chunkId) => sourceChunks.has(chunkId)) ?? false),
    )
    .sort(olderFirst((hold) => hold.createdAt, (hold) => hold.id))
  const appendHolds = (band: HoldBand): void => {
    hops.push(...holds.filter((hold) => holdBand(hold) === band).map(heldHop))
  }
  // These are sibling branches linked to the same material, not a cross-clock timestamp chain. Preserve
  // pipeline stage order: summary/extraction outcomes, distill holds, fields/field holds, reviews, then late
  // task/draft/unknown stages. Within one band, GuardHold.createdAt is a comparable record clock.
  appendHolds('before-fields')
  const fieldPasses = causalFieldValues(scope, sourceChunks, records.fieldValues)
  for (const pass of fieldPasses) hops.push(fieldHop(pass.producer))
  appendHolds('field')
  for (const pass of fieldPasses) hops.push(...judgeHops(pass))
  appendHolds('review')
  appendHolds('later')
  return hops
}

/** The OcrResult's standard-surface mirror: shared span is authoritative; sourceChunks is legacy fallback. */
const screenMirrors = (capture: OcrResult, distillates: readonly Distillate[]): Distillate[] => {
  const chunks = new Set(capture.sourceChunks)
  const scope: TraceScope = capture
  const candidates = distillates.filter(
    (distillate) =>
      inSession(scope, distillate) &&
      (distillate.provenance.slot === 'ocr' || distillate.provenance.slot === 'vlm'),
  )
  const dedupe = (values: readonly Distillate[]): Distillate[] => [...new Map(values.map((value) => [value.id, value])).values()]
  if (capture.spanId !== undefined) {
    const exact = dedupe(candidates.filter((distillate) => distillate.spanId === capture.spanId))
    if (exact.length > 0) return exact
  }
  // A spanless surviving half is possible when the screen processor repairs a pre-#116 incomplete pair.
  // Never let a known mismatching span override correlation merely because its source chunk overlaps.
  return dedupe(
    candidates.filter(
      (distillate) =>
        (capture.spanId === undefined || distillate.spanId === undefined) &&
        distillate.sourceChunks.some((chunkId) => chunks.has(chunkId)),
    ),
  )
}

/**
 * Walk one input to everything the pipeline recorded from it. Returns undefined when the id matches no
 * recorded input (the caller renders the honest not-found state). Pure — no I/O.
 */
export const buildTrace = (inputId: string, records: TraceRecords): TraceTrail | undefined => {
  const segment = records.sttSegments.find((s) => s.id === inputId)
  if (segment !== undefined) {
    const scope: TraceScope = segment
    // Windows this chunk fed: the persisted sourceChunks parent link (never fuzzy time-matching).
    const windows = records.distillates.filter(
      (d) => inSession(scope, d) && d.provenance.slot === 'llm' && d.sourceChunks.includes(segment.chunkId),
    )
    return { input: utteranceInput(segment), hops: downstreamHops(scope, [segment.chunkId], windows, records) }
  }

  const capture = records.ocrResults.find((o) => o.id === inputId)
  if (capture !== undefined) {
    const scope: TraceScope = capture
    const seen: TraceHop =
      {
        stage: 'seen',
        at: capture.createdAt,
        title: 'Recognized what was on screen',
        body: excerpt(capture.text),
        meta: metaLine(capture.provenance.endpoint, capture.provenance.model, capture.provenance.usage?.durationMs),
        ...(capture.provenance.usage !== undefined ? { usage: capture.provenance.usage } : {}),
        ...(capture.provenance.egress !== undefined ? { egress: capture.provenance.egress } : {}),
        policy: 'invoke',
      }
    // Screen recognition persists an OcrResult plus a standard-surface mirror Distillate with the same
    // span. Follow that exact pair into every child record just like an utterance window.
    const mirrors = screenMirrors(capture, records.distillates)
    const sourceChunks = [...new Set([...capture.sourceChunks, ...mirrors.flatMap((mirror) => mirror.sourceChunks)])]
    return { input: captureInput(capture), hops: [seen, ...downstreamHops(scope, sourceChunks, mirrors, records)] }
  }
  return undefined
}

// ---------------------------------------------------------------------------------------------- render

/** The root hop of an utterance/capture — rendered from the input itself (STT provenance, #116). */
const unknownPolicyCell = (what: string): string =>
  `<span class="ldg-absent" title="${escapeHtml(what)} provenance was not recorded for this legacy invoke">${escapeHtml(what)} not recorded</span>`

const policyHtml = (guard: GuardVerdict | undefined, egress: EgressDecision | undefined, mode: 'invoke' | 'blocked' | 'delivery-failure'): string => {
  // #206: pass the recorded egress alongside the verdict — a recorded device-local destination renders
  // the guard's absence as "not applicable · device-local" rather than merely "not recorded".
  const guardMarkup = guard !== undefined ? guardCell(guard, egress) : egress !== undefined ? guardCell(undefined, egress) : unknownPolicyCell('guard')
  const egressMarkup =
    egress !== undefined
      ? egressCell(egress)
      : mode === 'blocked'
        ? '<span class="ldg-guard-held" title="the guard suspended this hop before its target was called">blocked before target</span>'
        : mode === 'delivery-failure'
          ? '<span class="ldg-guard-held" title="the target was attempted; its failure suspended fallback routing">target attempted · fallback blocked</span>'
          : unknownPolicyCell('destination')
  return `<div class="trc-verdicts">${guardMarkup} ${egressMarkup}</div>`
}

const rootHtml = (trail: TraceTrail): string => {
  const input = trail.input
  const title = input.kind === 'utterance' ? `Heard · ${escapeHtml(input.label)}` : escapeHtml(input.label)
  const segment = input.kind === 'utterance' ? ' — transcribed by ' + escapeHtml(input.meta || 'an unrecorded endpoint') : input.meta ? ` — recognized by ${escapeHtml(input.meta)}` : ''
  // An utterance root IS the STT invoke. A capture's OCR invoke is the explicit `seen` hop below, so the
  // picker/root label must not duplicate its policy row.
  const verdicts = input.kind === 'utterance' ? policyHtml(undefined, input.egress, 'invoke') : ''
  return (
    '<div class="trc-hop trc-root">' +
    `<div class="trc-title">${title}<span class="ldg-model">${segment}</span></div>` +
    `<div class="trc-meta"><span class="ldg-when">${escapeHtml(input.at)}</span></div>` +
    verdicts +
    '</div>'
  )
}

const hopHtml = (hop: TraceHop): string => {
  const policy = hop.policy !== undefined ? policyHtml(hop.guard, hop.egress, hop.policy) : ''
  return (
    `<div class="trc-hop trc-${escapeHtml(hop.stage)}">` +
    `<div class="trc-title">${escapeHtml(hop.title)}</div>` +
    (hop.body !== undefined && hop.body !== '' ? `<div class="trc-body">${escapeHtml(hop.body)}</div>` : '') +
    `<div class="trc-meta">${hop.at !== undefined ? `<span class="ldg-when">${escapeHtml(hop.at)}</span>` : ''}${hop.meta ? ` <span class="ldg-model">${escapeHtml(hop.meta)}</span>` : ''}</div>` +
    policy +
    '</div>'
  )
}

const inputRow = (input: TraceInput, selected: boolean): string =>
  `<a class="trc-input${selected ? ' sel' : ''}" href="/settings/trace?input=${encodeURIComponent(input.id)}">` +
  `<span class="trc-input-label">${escapeHtml(input.label)}</span>` +
  `<span class="ldg-when">${escapeHtml(input.at)}</span>` +
  (input.meta ? `<span class="ldg-model">${escapeHtml(input.meta)}</span>` : '') +
  '</a>'

/** The honest per-page footer — what this view can and cannot walk, and why. */
const traceFooter = (): string =>
  '<div class="ldg-note">This view walks only recorded links — which capture chunk fed which summary, moment, ' +
  'field, and review — never a guess from timestamps. Records made before tracing landed don’t carry those ' +
  'links, so they appear in the Audit ledger but can’t be walked here. The transcript text itself is not ' +
  'stored with an utterance (spoken words stay ephemeral until summarized); an utterance is identified by ' +
  'its stream, time, and size. This view reads the default workspace’s most recent ' +
  `${MAX_INPUTS} inputs.</div>`

/**
 * The Trace section body. Pure — reads `data.trace` assembled by the settings route. Every state renders
 * text: empty (nothing captured yet), a failed assembly (the true reason), an unknown selection, a
 * selected input with no downstream hops, and the full walk.
 */
export const renderTrace = (data: SetupData): string => {
  const trace = data.trace
  const intro =
    '<div class="sub">Follow one input through the engine: pick something that was heard or seen, and this ' +
    'shows every step it took — summary, moments, fields, the judge’s review — with each step’s guard ' +
    'verdict and destination when recorded, and an explicit “not recorded” when legacy provenance is absent.</div>'

  if (trace === undefined || trace.problem !== undefined) {
    const reason = trace?.problem ?? 'the route did not assemble trace data for this page'
    return (
      intro +
      '<div class="card"><div class="stat-title">Trace unavailable</div>' +
      `<div class="stat-note">The recorded trail can’t be read right now — ${escapeHtml(reason)}. ` +
      'The records themselves are untouched; fix the cause and reload.</div></div>' +
      traceFooter()
    )
  }

  if (trace.inputs.length === 0) {
    return (
      intro +
      '<div class="card"><div class="stat-title">Nothing to trace yet</div>' +
      '<div class="stat-note">No transcribed utterances or screen captures are recorded in this workspace. ' +
      'Start a session and speak (or enable screen understanding) and each input appears here, ready to walk.</div></div>' +
      traceFooter()
    )
  }

  const picker =
    '<div class="card"><div class="stat-title">Pick an input</div>' +
    trace.inputs.map((input) => inputRow(input, input.id === trace.selectedId)).join('') +
    '</div>'

  if (trace.selectedId === undefined) {
    return intro + picker + traceFooter()
  }

  if (trace.trail === undefined) {
    return (
      intro +
      picker +
      '<div class="card"><div class="stat-title">That input isn’t in the recorded trail</div>' +
      '<div class="stat-note">Nothing recorded in this workspace has that id — it may have been made before ' +
      'tracing landed, or it belongs to another workspace. Pick an input from the list above.</div></div>' +
      traceFooter()
    )
  }

  const trail = trace.trail
  const chain =
    trail.hops.length === 0
      ? '<div class="card"><div class="stat-title">No steps recorded from this input yet</div>' +
        '<div class="stat-note">It was transcribed, but no summary, moment, or field has been recorded from it. ' +
        'The distill pass releases material in windows, so a fresh utterance can take a little while to appear — ' +
        'or its window may have been filtered before distilling.</div></div>'
      : `<div class="card trc-trail">${rootHtml(trail)}${trail.hops.map(hopHtml).join('')}</div>`

  return intro + picker + chain + traceFooter()
}
