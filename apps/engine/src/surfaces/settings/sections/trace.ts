import type { Distillate, EgressDecision, FieldValue, GuardHold, GuardVerdict, InvokeUsage, Moment, OcrResult, SttSegment } from '@openinfo/contracts'
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

/** The moments joined to a distillate — spanId when both sides carry it, else the distillateId parent. */
const momentsOf = (d: Distillate, moments: readonly Moment[]): Moment[] =>
  moments.filter((m) => (m.spanId !== undefined && d.spanId !== undefined ? m.spanId === d.spanId : m.provenance?.distillateId === d.id))

const momentHop = (m: Moment): TraceHop => ({
  stage: 'moment',
  at: m.at,
  title: `Noted a ${m.kind}`,
  body: excerpt(m.text),
  ...(m.provenance !== undefined ? { meta: metaLine(m.provenance.endpoint, m.provenance.model) } : {}),
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
})

const fieldHops = (v: FieldValue): TraceHop[] => {
  const hops: TraceHop[] = [
    {
      stage: 'field',
      at: v.updatedAt,
      title: `Field “${v.label}” updated · ${v.state}`,
      body: excerpt(v.value),
      meta: metaLine(v.provenance.endpoint, v.provenance.model, v.provenance.usage?.durationMs),
      ...(v.provenance.usage !== undefined ? { usage: v.provenance.usage } : {}),
    },
  ]
  const judge = v.provenance.judge
  if (judge !== undefined) {
    const changed = judge.verdict === 'correct' && judge.priorValue !== undefined ? ` — was “${excerpt(judge.priorValue, 80)}”` : ''
    hops.push({
      stage: 'judge',
      at: judge.judgedAt,
      title: `Judge ${judge.verdict === 'confirm' ? 'confirmed it' : judge.verdict === 'correct' ? 'corrected it' : 'flagged it'}`,
      ...(judge.note !== undefined || changed !== '' ? { body: excerpt(`${judge.note ?? ''}${changed}`.trim()) } : {}),
      meta: metaLine(judge.endpoint, judge.model, judge.usage?.durationMs),
      ...(judge.usage !== undefined ? { usage: judge.usage } : {}),
    })
  }
  return hops
}

const heldHop = (h: GuardHold): TraceHop => ({
  stage: 'held',
  at: h.createdAt,
  title:
    h.status === 'held'
      ? 'Held by the guard — nothing left this Mac, awaiting release or deny'
      : h.status === 'released'
        ? 'Held by the guard, then released'
        : 'Held by the guard, then denied',
  body: h.verdict.reason,
  ...(h.verdict.guardEndpoint !== undefined ? { meta: metaLine(h.verdict.guardEndpoint, undefined) } : {}),
  guard: h.verdict,
})

/**
 * Walk one input to everything the pipeline recorded from it. Returns undefined when the id matches no
 * recorded input (the caller renders the honest not-found state). Pure — no I/O.
 */
export const buildTrace = (inputId: string, records: TraceRecords): TraceTrail | undefined => {
  const segment = records.sttSegments.find((s) => s.id === inputId)
  if (segment !== undefined) {
    const hops: TraceHop[] = []
    // Windows this chunk fed: the persisted sourceChunks parent link (never fuzzy time-matching).
    const windows = records.distillates.filter((d) => d.provenance.slot === 'llm' && d.sourceChunks.includes(segment.chunkId))
    for (const d of windows) {
      hops.push(summaryHop(d))
      hops.push(...momentsOf(d, records.moments).map(momentHop))
    }
    // Fields drawn from a material window containing this chunk (#116 sourceChunks), plus their judge hops.
    for (const v of records.fieldValues) {
      if (v.provenance.sourceChunks?.includes(segment.chunkId)) hops.push(...fieldHops(v))
    }
    // A window the guard SUSPENDED — the trail still reaches the verdict via the hold's own chunk links.
    for (const h of records.guardHolds) {
      if (h.sourceChunks?.includes(segment.chunkId)) hops.push(heldHop(h))
    }
    hops.sort((a, b) => ((a.at ?? '') < (b.at ?? '') ? -1 : (a.at ?? '') > (b.at ?? '') ? 1 : 0)) // oldest first — the walk order
    return { input: utteranceInput(segment), hops }
  }

  const capture = records.ocrResults.find((o) => o.id === inputId)
  if (capture !== undefined) {
    const hops: TraceHop[] = [
      {
        stage: 'seen',
        at: capture.createdAt,
        title: 'Recognized what was on screen',
        body: excerpt(capture.text),
        meta: metaLine(capture.provenance.endpoint, capture.provenance.model, capture.provenance.usage?.durationMs),
        ...(capture.provenance.usage !== undefined ? { usage: capture.provenance.usage } : {}),
        ...(capture.provenance.egress !== undefined ? { egress: capture.provenance.egress } : {}),
      },
    ]
    return { input: captureInput(capture), hops }
  }
  return undefined
}

// ---------------------------------------------------------------------------------------------- render

/** The root hop of an utterance/capture — rendered from the input itself (STT provenance, #116). */
const rootHtml = (trail: TraceTrail): string => {
  const input = trail.input
  const title = input.kind === 'utterance' ? `Heard · ${escapeHtml(input.label)}` : escapeHtml(input.label)
  const segment = input.kind === 'utterance' ? ' — transcribed by ' + escapeHtml(input.meta || 'an unrecorded endpoint') : input.meta ? ` — recognized by ${escapeHtml(input.meta)}` : ''
  return (
    '<div class="trc-hop trc-root">' +
    `<div class="trc-title">${title}<span class="ldg-model">${segment}</span></div>` +
    `<div class="trc-meta"><span class="ldg-when">${escapeHtml(input.at)}</span></div>` +
    '</div>'
  )
}

const hopHtml = (hop: TraceHop): string => {
  // Pass the hop's recorded egress alongside the verdict (#206): a recorded device-local destination is
  // the fact that makes the guard's absence "not applicable" rather than merely "not recorded".
  const guard = hop.guard !== undefined || hop.egress !== undefined ? `<div class="trc-verdicts">${guardCell(hop.guard, hop.egress)} ${egressCell(hop.egress)}</div>` : ''
  return (
    `<div class="trc-hop trc-${escapeHtml(hop.stage)}">` +
    `<div class="trc-title">${escapeHtml(hop.title)}</div>` +
    (hop.body !== undefined && hop.body !== '' ? `<div class="trc-body">${escapeHtml(hop.body)}</div>` : '') +
    `<div class="trc-meta">${hop.at !== undefined ? `<span class="ldg-when">${escapeHtml(hop.at)}</span>` : ''}${hop.meta ? ` <span class="ldg-model">${escapeHtml(hop.meta)}</span>` : ''}</div>` +
    guard +
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
    'verdict and where the content was allowed to go.</div>'

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
