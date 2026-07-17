import type { ContextPacket, ContextPacketGap, Moment, OcrResult } from '@openinfo/contracts'
import type { PacketBuildAttempt } from '../../../index/produce-packets.js'
import { escapeHtml, type SetupData } from '../../setup/view.js'

/**
 * The Context packets section (#176 slice 2) — the diagnostics surface that renders a converged slice of
 * activity so a human can SEE what openinfo grouped together and, just as important, what it left out and
 * why. It answers the issue's last unmet criterion: packet membership (which observations, per sense lane),
 * exclusions (the honest gaps — what was NOT included and the reason), timing (the window bounds and each
 * observation's instant), and confidence — with the append-only supersession chain visible.
 *
 * REFS, NOT CONTENT: a packet stores only references to immutable source records. This view resolves the
 * displayed text by reading the SOURCE records at render time (an OcrResult's recognized text, a Moment's
 * noted text) — never by trusting content persisted into the packet (there is none). Spoken words are not
 * stored with an utterance, so an audio ref shows its lane, time, and count, with its record id on
 * inspection — never a fabricated quote.
 *
 * Pure: `buildContextPacketViews` turns raw packets + their source records into view models (testable
 * headless), `renderContextPackets` turns the assembled data into HTML. The route assembles
 * `data.contextPackets` from the default workspace inside a try/catch, so an assembly failure surfaces as
 * visible text (`problem`) — never a blank. A LIVE producer failure surfaces separately as the honest
 * "last update didn't finish" line from the build log, so a contained build failure is never invisible.
 */

/** What the settings route assembles for this section — raw records + the live producer's last outcome. */
export interface ContextPacketsData {
  /** the default workspace's packets, INCLUDING superseded revisions (the chain is rendered). */
  packets: readonly ContextPacket[]
  /** source records for render-time text resolution — refs are resolved against these, never persisted. */
  ocrResults: readonly OcrResult[]
  moments: readonly Moment[]
  /** the live producer's most recent build attempt for this workspace (any session) — the "last update" line. */
  lastBuild?: PacketBuildAttempt
  /** an assembly failure's true reason — rendered as visible text instead of the packet list. */
  problem?: string
}

/** One resolved source reference: the record id (for inspection), its instant, and any text the source carries. */
export interface PacketRefView {
  id: string
  at: string
  /** resolved from the SOURCE record at render time; absent when the source stores no text (audio lanes). */
  text?: string
}

/** One candidate entity the window's evidence names, with its mention + screen-corroboration provenance. */
export interface PacketCandidateView {
  entityId: string
  name: string
  /** the in-window moments that named the entity, resolved to their noted text (kept traceable by id). */
  mentions: PacketRefView[]
  /** present ONLY when an in-window screen observation independently corroborated the entity (#74). */
  seenOnScreen?: { ocrId: string; form: string; similarity: number }
}

/** One window's converged view — its live head packet, the prior revisions it supersedes, and resolved refs. */
export interface PacketWindowView {
  head: ContextPacket
  /** prior revisions this window's chain superseded, newest first (empty ⇒ built once, never revised). */
  superseded: ContextPacket[]
  microphone: PacketRefView[]
  systemAudio: PacketRefView[]
  screen: PacketRefView[]
  candidates: PacketCandidateView[]
  gaps: readonly ContextPacketGap[]
  /** count of sense lanes that contributed observations (1–3) — the confidence framing. */
  laneCount: number
}

/** The most window groups rendered at once — a recent-activity view, not an unbounded log (cf. Trace). */
const MAX_WINDOWS = 40

/** Truncate resolved source text for the view (the full text lives on the source record). */
const excerpt = (text: string, max = 200): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

const ocrAt = (ocr: OcrResult): string => ocr.capturedAt ?? ocr.createdAt

/**
 * Compose one window's view: resolve every lane ref against its source record (screen refs carry text,
 * audio refs do not), resolve each candidate's moments to their noted text, and keep the superseded chain.
 * Pure — no I/O.
 */
const windowView = (head: ContextPacket, superseded: ContextPacket[], ocrById: Map<string, OcrResult>, momentById: Map<string, Moment>): PacketWindowView => {
  const screen: PacketRefView[] = head.screen.map((ref) => {
    const ocr = ocrById.get(ref.id)
    return { id: ref.id, at: ref.at, ...(ocr !== undefined ? { text: excerpt(ocr.text) } : {}) }
  })
  const audio = (refs: ContextPacket['microphone']): PacketRefView[] => refs.map((ref) => ({ id: ref.id, at: ref.at }))
  const candidates: PacketCandidateView[] = head.candidates.map((candidate) => ({
    entityId: candidate.entityId,
    name: candidate.name,
    mentions: candidate.momentRefs.map((id) => {
      const moment = momentById.get(id)
      return { id, at: moment?.at ?? head.windowStart, ...(moment !== undefined ? { text: excerpt(moment.text) } : {}) }
    }),
    ...(candidate.seenOnScreen !== undefined ? { seenOnScreen: candidate.seenOnScreen } : {}),
  }))
  const laneCount = [head.microphone.length, head.systemAudio.length, head.screen.length].filter((n) => n > 0).length
  return { head, superseded, microphone: audio(head.microphone), systemAudio: audio(head.systemAudio), screen, candidates, gaps: head.gaps, laneCount }
}

/**
 * Group a workspace's packets into per-window views: within each session+window the not-superseded packet
 * is the head and the rest are its ordered revision history. Newest window first, capped. Pure.
 */
export const buildContextPacketViews = (data: Pick<ContextPacketsData, 'packets' | 'ocrResults' | 'moments'>): PacketWindowView[] => {
  const superseded = new Set(data.packets.map((p) => p.supersedes).filter((id): id is string => id !== undefined))
  const ocrById = new Map(data.ocrResults.map((o) => [o.id, o]))
  const momentById = new Map(data.moments.map((m) => [m.id, m]))
  const groups = new Map<string, ContextPacket[]>()
  for (const packet of data.packets) {
    const key = `${packet.sessionId}|${packet.windowStart}|${packet.windowEnd}`
    groups.set(key, [...(groups.get(key) ?? []), packet])
  }
  const views: PacketWindowView[] = []
  for (const chain of groups.values()) {
    const head = chain.find((p) => !superseded.has(p.id)) ?? [...chain].sort((a, b) => b.revision - a.revision)[0]!
    const priors = chain.filter((p) => p.id !== head.id).sort((a, b) => b.revision - a.revision)
    views.push(windowView(head, priors, ocrById, momentById))
  }
  views.sort((a, b) => (a.head.windowStart < b.head.windowStart ? 1 : a.head.windowStart > b.head.windowStart ? -1 : 0))
  return views.slice(0, MAX_WINDOWS)
}

// ---------------------------------------------------------------------------------------------- render

const LANE_LABEL = { microphone: 'Microphone', systemAudio: 'System audio', screen: 'Screen' } as const

/** The confidence framing (hud-voice: no raw score in headline position) — the raw value rides the title. */
const confidencePhrase = (laneCount: number): string =>
  laneCount >= 3 ? 'three senses agree' : laneCount === 2 ? 'two senses agree' : laneCount === 1 ? 'one sense' : 'nothing yet'

/** A missing sense, in calm human words — the reason, never a raw enum. */
const gapPhrase = (gap: ContextPacketGap): string => {
  const lane = LANE_LABEL[gap.lane === 'mic' ? 'microphone' : gap.lane === 'system-audio' ? 'systemAudio' : 'screen']
  return gap.reason === 'no-observations-this-session'
    ? `${lane} — nothing captured this session`
    : `${lane} — nothing this minute`
}

/** "HH:MM:SS" clock time from an ISO instant (diagnostics detail; the full ISO rides the title). */
const clock = (iso: string): string => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toISOString().slice(11, 19)
}

/** One audio lane row: count + each ref's time; the source stores no words, so the record id is on inspection. */
const audioLaneHtml = (label: string, refs: PacketRefView[]): string => {
  if (refs.length === 0) return ''
  const times = refs
    .map((ref) => `<span class="ldg-when" title="${escapeHtml(ref.id)} · ${escapeHtml(ref.at)}">${escapeHtml(clock(ref.at))}</span>`)
    .join('')
  return (
    `<div class="cpk-lane"><span class="cpk-lane-name">${escapeHtml(label)}</span>` +
    `<span class="cpk-lane-count">${refs.length} heard</span>${times}</div>`
  )
}

/** The screen lane: count + each recognized frame's text (resolved from the OcrResult at render time). */
const screenLaneHtml = (refs: PacketRefView[]): string => {
  if (refs.length === 0) return ''
  const rows = refs
    .map(
      (ref) =>
        `<div class="cpk-seen"><span class="ldg-when" title="${escapeHtml(ref.id)} · ${escapeHtml(ref.at)}">${escapeHtml(clock(ref.at))}</span>` +
        (ref.text !== undefined && ref.text !== ''
          ? `<span class="cpk-seen-text">${escapeHtml(ref.text)}</span>`
          : `<span class="ldg-absent">the recognized frame is no longer on file</span>`) +
        '</div>',
    )
    .join('')
  return `<div class="cpk-lane"><span class="cpk-lane-name">Screen</span><span class="cpk-lane-count">${refs.length} seen</span></div>${rows}`
}

const candidateHtml = (candidate: PacketCandidateView): string => {
  const mention = candidate.mentions.find((m) => m.text !== undefined && m.text !== '')
  const seen =
    candidate.seenOnScreen !== undefined
      ? `<span class="cpk-corr" title="matched on screen as “${escapeHtml(candidate.seenOnScreen.form)}” · similarity ${candidate.seenOnScreen.similarity} · ${escapeHtml(candidate.seenOnScreen.ocrId)}">also on screen</span>`
      : ''
  return (
    `<div class="cpk-cand"><span class="cpk-cand-name" title="${escapeHtml(candidate.entityId)}">${escapeHtml(candidate.name)}</span>${seen}` +
    (mention !== undefined ? `<span class="cpk-cand-note">${escapeHtml(mention.text!)}</span>` : '') +
    '</div>'
  )
}

/** The append-only revision history line — a later observation arrived after the first version was built. */
const supersessionHtml = (view: PacketWindowView): string => {
  if (view.superseded.length === 0) return ''
  const priors = view.superseded
    .map((prior) => `<span class="ldg-when" title="${escapeHtml(prior.id)}">version ${prior.revision} · ${escapeHtml(clock(prior.createdAt))}</span>`)
    .join('')
  return `<div class="cpk-rev">Updated after a later observation arrived — now version ${view.head.revision}. ${priors}</div>`
}

const windowHtml = (view: PacketWindowView): string => {
  const head = view.head
  const start = clock(head.windowStart)
  const end = clock(head.windowEnd)
  const gaps = view.gaps.length > 0 ? `<div class="cpk-gaps">${view.gaps.map((gap) => `<span class="cpk-gap">${escapeHtml(gapPhrase(gap))}</span>`).join('')}</div>` : ''
  const candidates =
    view.candidates.length > 0
      ? `<div class="cpk-cands"><div class="cpk-sub">Named here</div>${view.candidates.map(candidateHtml).join('')}</div>`
      : ''
  return (
    '<div class="card cpk-window">' +
    `<div class="cpk-head"><span class="cpk-when" title="${escapeHtml(head.windowStart)} → ${escapeHtml(head.windowEnd)}">${escapeHtml(start)}–${escapeHtml(end)}</span>` +
    `<span class="cpk-conf" title="confidence ${head.confidence} · ${escapeHtml(head.provenance.builder)}">${escapeHtml(confidencePhrase(view.laneCount))}</span></div>` +
    audioLaneHtml('Microphone', view.microphone) +
    audioLaneHtml('System audio', view.systemAudio) +
    screenLaneHtml(view.screen) +
    gaps +
    candidates +
    supersessionHtml(view) +
    '</div>'
  )
}

/** The honest "last update" line from the live producer's most recent attempt — success, failure, or none. */
const lastBuildHtml = (attempt: PacketBuildAttempt | undefined): string => {
  if (attempt === undefined) return ''
  if (attempt.error !== undefined) {
    return (
      '<div class="card cpk-status cpk-status-warn"><div class="stat-title">Last update didn’t finish</div>' +
      `<div class="stat-note">The most recent attempt to group this activity stopped — ${escapeHtml(attempt.error)}. ` +
      'The packets below are the last good version; the recorded observations are untouched.</div></div>'
    )
  }
  const built = attempt.created > 0 ? `grouped ${attempt.created} new ${attempt.created === 1 ? 'window' : 'windows'}` : 'nothing changed'
  return (
    '<div class="cpk-note">Last update ' +
    `<span class="ldg-when" title="${escapeHtml(attempt.at)}">${escapeHtml(clock(attempt.at))}</span> · ${escapeHtml(built)}.</div>`
  )
}

const footer = (): string =>
  '<div class="ldg-note">A packet is one minute of a session, grouped from what was heard and seen — built from ' +
  'references to the recorded observations, never a copy of them. Spoken words aren’t stored with an utterance, so ' +
  'an audio line shows its time and count with the record id on hover; a screen line shows the recognized text read ' +
  'from its source. A later observation never rewrites a packet — it appends a new version, and the older one stays ' +
  'listed. This view reads the default workspace’s most recent ' +
  `${MAX_WINDOWS} windows.</div>`

/**
 * The Context packets section body. Pure — reads `data.contextPackets` assembled by the settings route.
 * Every state renders text: empty (nothing grouped yet), a failed assembly (the true reason), a contained
 * live-producer failure (the "last update didn’t finish" line), and the full membership/exclusions/timing/
 * confidence view with the supersession chain.
 */
export const renderContextPackets = (data: SetupData): string => {
  const packets = data.contextPackets
  const intro =
    '<div class="sub">See how openinfo grouped a session’s activity: each minute becomes a packet showing what was ' +
    'heard and seen together, what was missing and why, and how sure it is — every line traceable to the observation ' +
    'it came from. Packets appear on their own as a session records; you don’t have to build them by hand.</div>'

  if (packets === undefined || packets.problem !== undefined) {
    const reason = packets?.problem ?? 'the route did not assemble packet data for this page'
    return (
      intro +
      '<div class="card"><div class="stat-title">Context packets unavailable</div>' +
      `<div class="stat-note">The grouped activity can’t be read right now — ${escapeHtml(reason)}. ` +
      'The recorded observations are untouched; fix the cause and reload.</div></div>' +
      footer()
    )
  }

  const views = buildContextPacketViews(packets)

  if (views.length === 0) {
    return (
      intro +
      lastBuildHtml(packets.lastBuild) +
      '<div class="card"><div class="stat-title">No context packets yet</div>' +
      '<div class="stat-note">Nothing has been grouped in this workspace. Start a session with listening or screen ' +
      'understanding on, and when it ends each minute of activity appears here — the senses that contributed, what ' +
      'was missing, and what was named.</div></div>' +
      footer()
    )
  }

  return intro + lastBuildHtml(packets.lastBuild) + views.map(windowHtml).join('') + footer()
}
