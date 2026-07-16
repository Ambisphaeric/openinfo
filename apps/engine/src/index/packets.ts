import { createHash } from 'node:crypto'
import type {
  ContextPacket,
  ContextPacketCandidate,
  ContextPacketGap,
  ContextPacketRef,
  Entity,
  Moment,
  OcrResult,
  Session,
  SttSegment,
} from '@openinfo/contracts'
import { CONTEXT_PACKET_SCHEMA_VERSION } from '@openinfo/contracts'
import { correlate, ocrForms, overlapsWindow, DEFAULT_CORRELATION_CONFIG, type CorrelationConfig } from './correlate.js'

/**
 * The deterministic ContextPacket builder (#176) — engine-side correlation over ALREADY-STORED records,
 * extending the #74 correlator from one entity mention to a whole converged window. Like every module in
 * index/, the core is a PURE function of its inputs: no DB, no model, no clock beyond the timestamps and
 * the injectable `now` handed in — so it is fixture-testable, and replaying the same observations yields
 * byte-identical packets (the #32 record/replay guarantee).
 *
 * CORRELATION INPUTS, per the issue's four axes:
 *  - TIME: observations bucket into fixed windows aligned to the epoch (`windowMs`, default 60s) by their
 *    TRUE capture instant (#102 keep-time) — an unparseable timestamp is SKIPPED, never guessed into a
 *    window (the correlator's NaN-flooring discipline).
 *  - SESSION: the builder is session-scoped; every ref shares the packet's sessionId.
 *  - FOREGROUND CONTEXT: the session record's window/repo attribution evidence lands on the packet's
 *    optional `focus` field — sourced from the Session (via sessionId), never model-derived.
 *  - ENTITY EVIDENCE: in-window moments' `refs` name candidate entities; each candidate is additionally
 *    checked against the in-window screen forms with the #74 correlator, so a heard entity the screen
 *    independently shows carries `seenOnScreen` evidence (exact OcrResult + form + similarity).
 *
 * SOURCE IDENTITY (non-negotiable): the three lanes are separate ref arrays end to end. A window that
 * holds a screen observation plus BOTH audio lanes correlates all three WITHOUT merging attribution —
 * refs never change lanes, and nothing is copied out of a source record beyond its id + instant.
 *
 * SUPERSESSION is append-only: when a rebuild sees DIFFERENT content for a window that already has a
 * packet (a late/out-of-order observation arrived), it appends a NEW packet with `revision + 1` and
 * `supersedes` naming the prior — the prior is never mutated. When content is UNCHANGED the existing
 * packet is kept untouched (idempotence): ids are content-derived, so "same observations in ⇒ same
 * packet out" holds bit-for-bit.
 */

export interface PacketBuilderConfig {
  /** Correlation window length (ms): observations bucket into epoch-aligned windows of this size. */
  windowMs: number
  /** The #74 correlator config used for per-candidate screen corroboration. */
  correlation: CorrelationConfig
}

export const DEFAULT_PACKET_BUILDER_CONFIG: PacketBuilderConfig = {
  windowMs: 60_000,
  correlation: DEFAULT_CORRELATION_CONFIG,
}

/**
 * Deterministic packet confidence from the count of INDEPENDENT sense lanes contributing to the window —
 * each additional independent sense corroborates the slice (the #74 design rule, lifted from one mention
 * to the window). A fixed, inspectable map — never a model score, never fabricated for missing senses.
 */
const LANE_CONFIDENCE: Record<number, number> = { 1: 0.4, 2: 0.7, 3: 0.9 }

const PACKET_LANES = ['mic', 'system-audio', 'screen'] as const
type PacketLane = (typeof PACKET_LANES)[number]

export interface PacketBuildInput {
  workspaceId: string
  sessionId: string
  /** The session record — supplies the optional focus/app evidence. Absent ⇒ `focus` omitted, never guessed. */
  session?: Session | undefined
  sttSegments: readonly SttSegment[]
  ocrResults: readonly OcrResult[]
  moments: readonly Moment[]
  entities: readonly Entity[]
  /** The session's existing packets — the append-only chain idempotence and supersession are decided against. */
  existing: readonly ContextPacket[]
  config?: PacketBuilderConfig
  /** Injectable clock for `createdAt` on NEWLY appended packets (fixture replay hands in the replay clock). */
  now?: () => Date
}

export interface PacketBuildResult {
  /** Packets this run APPENDED (new windows + new supersession revisions). Empty ⇒ idempotent no-op. */
  created: ContextPacket[]
  /** Existing latest packets whose windows rebuilt identical — kept untouched, byte-for-byte. */
  unchanged: ContextPacket[]
}

/** JSON with code-point-sorted object keys — the canonical form the content-derived packet id hashes. */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** The instant an OCR pass saw the screen — true capture time (#102) when carried, else when recognition finished. */
const ocrAt = (ocr: OcrResult): string => ocr.capturedAt ?? ocr.createdAt

/** Deterministic ref order: by instant, then id — so packet bytes never depend on read order. */
const byAtThenId = (a: ContextPacketRef, b: ContextPacketRef): number =>
  a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0

/** Everything id/chain-position/creation-time are derived FROM — the comparable content of one window. */
interface WindowContent {
  workspaceId: string
  sessionId: string
  windowStart: string
  windowEnd: string
  microphone: ContextPacketRef[]
  systemAudio: ContextPacketRef[]
  screen: ContextPacketRef[]
  focus?: Session['attribution']['evidence']
  candidates: ContextPacketCandidate[]
  gaps: ContextPacketGap[]
  confidence: number
  provenance: ContextPacket['provenance']
  schemaVersion: number
}

/** Content-derived packet id: a hash over the canonical window content + chain position. */
const packetId = (content: WindowContent, revision: number, supersedes: string | undefined): string =>
  `cp-${createHash('sha256')
    .update(canonicalJson({ ...content, revision, ...(supersedes !== undefined ? { supersedes } : {}) }))
    .digest('hex')
    .slice(0, 32)}`

/** Parse an instant; NaN (unparseable) reads as undefined — an observation is never guessed into a window. */
const instant = (iso: string): number | undefined => {
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? t : undefined
}

/** The latest (not-superseded) packet per window key among a session's existing chain. */
const latestByWindow = (existing: readonly ContextPacket[]): Map<string, ContextPacket> => {
  const superseded = new Set(existing.map((p) => p.supersedes).filter((id): id is string => id !== undefined))
  const latest = new Map<string, ContextPacket>()
  for (const packet of existing) {
    if (superseded.has(packet.id)) continue
    const key = `${packet.windowStart}|${packet.windowEnd}`
    const prior = latest.get(key)
    // Two live heads for one window cannot arise from this builder (each revision supersedes the prior);
    // keep the higher revision deterministically if a store ever presents one.
    if (prior === undefined || packet.revision > prior.revision) latest.set(key, packet)
  }
  return latest
}

/**
 * Build (or converge) the session's ContextPackets from its stored observations. Pure — the caller does
 * all reads and writes. Returns only appended + kept packets; it never mutates `existing` members.
 */
export const buildContextPackets = (input: PacketBuildInput): PacketBuildResult => {
  const config = input.config ?? DEFAULT_PACKET_BUILDER_CONFIG
  const now = input.now ?? (() => new Date())

  // 1) Gather lane observations as refs, keyed by their true capture instant.
  const observations: { lane: PacketLane; ref: ContextPacketRef; t: number }[] = []
  for (const segment of input.sttSegments) {
    if (segment.sessionId !== input.sessionId) continue
    if (segment.source !== 'mic' && segment.source !== 'system-audio') continue
    const t = instant(segment.capturedAt)
    if (t === undefined) continue
    observations.push({ lane: segment.source, ref: { record: 'stt-segment', id: segment.id, at: segment.capturedAt }, t })
  }
  for (const ocr of input.ocrResults) {
    if (ocr.sessionId !== input.sessionId) continue
    const at = ocrAt(ocr)
    const t = instant(at)
    if (t === undefined) continue
    observations.push({ lane: 'screen', ref: { record: 'ocr-result', id: ocr.id, at }, t })
  }

  // Which lanes produced ANYTHING this session — the gap-reason split (absent lane vs silent window).
  const lanesThisSession = new Set(observations.map((o) => o.lane))

  // 2) Bucket into epoch-aligned windows.
  const buckets = new Map<number, { lane: PacketLane; ref: ContextPacketRef }[]>()
  for (const o of observations) {
    const start = Math.floor(o.t / config.windowMs) * config.windowMs
    const bucket = buckets.get(start) ?? []
    bucket.push(o)
    buckets.set(start, bucket)
  }

  // Foreground/app evidence: the session's window/repo attribution entries, when the record carries any.
  const focus = (input.session?.attribution.evidence ?? []).filter((e) => e.kind === 'window' || e.kind === 'repo')

  const entityById = new Map(input.entities.map((e) => [e.id, e]))
  const latest = latestByWindow(input.existing)
  const created: ContextPacket[] = []
  const unchanged: ContextPacket[] = []

  for (const start of [...buckets.keys()].sort((a, b) => a - b)) {
    const members = buckets.get(start)!
    const windowStart = new Date(start).toISOString()
    const windowEnd = new Date(start + config.windowMs).toISOString()

    const lane = (l: PacketLane): ContextPacketRef[] => members.filter((m) => m.lane === l).map((m) => m.ref).sort(byAtThenId)
    const microphone = lane('mic')
    const systemAudio = lane('system-audio')
    const screen = lane('screen')

    // 3) Honest gaps: a missing sense degrades to a partial packet with a machine-readable reason.
    const present: Record<PacketLane, boolean> = { mic: microphone.length > 0, 'system-audio': systemAudio.length > 0, screen: screen.length > 0 }
    const gaps: ContextPacketGap[] = PACKET_LANES.filter((l) => !present[l]).map((l) => ({
      lane: l,
      reason: lanesThisSession.has(l) ? 'no-observations-in-window' : 'no-observations-this-session',
    }))

    // 4) Entity evidence: in-window moments name candidates; the #74 correlator checks each against the
    //    in-window screen forms (same window slack the entity path uses). Refs only — attribution stays
    //    on the source moment/OcrResult records.
    const inWindowMoments = input.moments
      .filter((m) => m.sessionId === input.sessionId)
      .filter((m) => {
        const t = instant(m.at)
        return t !== undefined && t >= start && t < start + config.windowMs
      })
    const screenInWindow = input.ocrResults
      .filter((o) => o.sessionId === input.sessionId)
      .filter((o) => overlapsWindow(ocrAt(o), windowStart, windowEnd, config.correlation.windowMs))
      .sort((a, b) => (ocrAt(a) < ocrAt(b) ? -1 : ocrAt(a) > ocrAt(b) ? 1 : a.id < b.id ? -1 : 1))
    const candidateMoments = new Map<string, string[]>()
    for (const moment of inWindowMoments) {
      for (const entityId of moment.refs) {
        if (!entityById.has(entityId)) continue // a dangling ref has no record to trace to — never fabricated
        candidateMoments.set(entityId, [...(candidateMoments.get(entityId) ?? []), moment.id])
      }
    }
    const candidates: ContextPacketCandidate[] = [...candidateMoments.keys()]
      .sort()
      .map((entityId) => {
        const entity = entityById.get(entityId)!
        const momentRefs = [...new Set(candidateMoments.get(entityId)!)].sort()
        let seenOnScreen: ContextPacketCandidate['seenOnScreen']
        for (const ocr of screenInWindow) {
          const result = correlate({ name: entity.name, aliases: entity.aliases }, ocrForms(ocr), config.correlation)
          if (result.corroborated && result.matchedForm !== undefined) {
            seenOnScreen = { ocrId: ocr.id, form: result.matchedForm, similarity: result.similarity }
            break
          }
        }
        return { entityId, name: entity.name, momentRefs, ...(seenOnScreen !== undefined ? { seenOnScreen } : {}) }
      })

    const laneCount = PACKET_LANES.filter((l) => present[l]).length
    const content: WindowContent = {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      windowStart,
      windowEnd,
      microphone,
      systemAudio,
      screen,
      ...(focus.length > 0 ? { focus } : {}),
      candidates,
      gaps,
      confidence: LANE_CONFIDENCE[laneCount] ?? LANE_CONFIDENCE[3]!,
      provenance: { builder: 'deterministic-correlation', windowMs: config.windowMs },
      schemaVersion: CONTEXT_PACKET_SCHEMA_VERSION,
    }

    // 5) Idempotence / append-only supersession against the window's existing chain head.
    const head = latest.get(`${windowStart}|${windowEnd}`)
    if (head !== undefined) {
      const { id: _i, revision: _r, supersedes: _s, createdAt: _c, ...headContent } = head
      if (canonicalJson(headContent) === canonicalJson(content)) {
        unchanged.push(head)
        continue
      }
    }
    const revision = head === undefined ? 1 : head.revision + 1
    const supersedes = head?.id
    created.push({
      id: packetId(content, revision, supersedes),
      ...content,
      revision,
      ...(supersedes !== undefined ? { supersedes } : {}),
      createdAt: now().toISOString(),
    })
  }

  return { created, unchanged }
}
