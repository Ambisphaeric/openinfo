import { Type, type Static } from '@sinclair/typebox'
import { Id, IsoTime } from '../common.js'
import { Entity } from '../records/entity.js'
import { Moment } from '../records/moment.js'
import { StarterModel } from '../config/local.js'
import { AttributionPattern } from '../config/hints.js'
import { EgressDecision } from '../config/egress.js'

export const Health = Type.Object(
  {
    ok: Type.Boolean(),
    phase: Type.Integer({ minimum: 0, maximum: 7 }),
    uptimeMs: Type.Number({ minimum: 0 }),
    checkedAt: IsoTime,
    // Additive version handshake: the engine's own package version, read at startup, so the client can
    // surface WHICH engine it adopted/spawned and flag skew against its own app version. Optional — an
    // older engine that predates this field simply omits it (itself a signal the client renders honestly).
    version: Type.Optional(Type.String({ description: "the engine's package version, read at startup from its own package.json" })),
    build: Type.Optional(Type.String({ description: 'an optional build id (e.g. a git short sha) when the build stamped one via OPENINFO_BUILD' })),
  },
  { $id: 'Health', additionalProperties: false },
)
export type Health = Static<typeof Health>

export const JsonSchema = Type.Record(Type.String(), Type.Unknown(), { $id: 'JsonSchema' })
export type JsonSchema = Static<typeof JsonSchema>

export const CaptureSource = Type.Union(
  ['mic', 'screen', 'calendar', 'repo', 'camera', 'system-audio', 'focus'].map((s) => Type.Literal(s)),
  { $id: 'CaptureSource', description: 'mic = the user; system-audio = the far side of a call (loopback) — the free me/them split; focus = foreground-window context (P3 context-switch detection), utf8 JSON FocusSignal, never a transcript' },
)
export type CaptureSource = Static<typeof CaptureSource>

/**
 * The decoded payload of a `source: 'focus'` CaptureChunk (Phase 3 context-switch detection). Focus
 * chunks travel as ORDINARY CaptureChunks — `encoding: 'utf8'`, `contentType: 'application/json'`,
 * `data` = JSON.stringify(FocusSignal) — so the client, spool, and drain need no new transport; the
 * route/detector decodes them here. It is machine-global foreground context (which app/window/repo is
 * in front), NOT speech: the drain routes it to the detector and EXCLUDES it from distill transcripts,
 * moments, and entity extraction (a focus signal is evidence for *where* a session belongs, never
 * content *in* one). v0 signals are `app`, `windowTitle`, `repoPath`; calendar/voice-presence signals
 * arrive as their own sources in later slices.
 */
export const FocusSignal = Type.Object(
  {
    app: Type.String({ minLength: 1, description: 'foreground application name, e.g. "Code", "Slack", "zoom.us"' }),
    windowTitle: Type.Optional(Type.String({ description: 'the active window title, e.g. "detector.ts — openinfo"' })),
    repoPath: Type.Optional(Type.String({ description: 'git repo root of the foreground editor/terminal, when derivable' })),
  },
  { $id: 'FocusSignal', additionalProperties: false, description: 'decoded content of a source:"focus" CaptureChunk — foreground context, not a transcript' },
)
export type FocusSignal = Static<typeof FocusSignal>

/**
 * A calendar routing signal (Phase 4 context-switch detection — the SECOND staged routing signal after
 * focus). The title + attendees of the current/imminent Calendar.app event, decoded by route/calendar.ts
 * and fed to the SAME detector as focus: it is routing CONTEXT (evidence for *which meeting* — hence which
 * workspace — the user is in), never content *in* a session, so the drain excludes it from transcripts/
 * moments/entities exactly as it does a FocusSignal. `attendees` are display names and/or emails as
 * Calendar.app exposes them (matched case-insensitively against `attendee` hint patterns); `eventTitle`
 * matches `eventTitle` patterns. Optional fields are OMITTED when unknown so the payload stays minimal.
 *
 * Unlike a FocusSignal (client-collected, carried as a `source:'focus'` CaptureChunk), v0 calendar signals
 * are collected ENGINE-side (route/calendar-collector.ts polls Calendar.app via osascript) and fed
 * DIRECTLY to the detector — the `calendar` CaptureSource stays reserved for a later chunk-transported path.
 */
export const CalendarSignal = Type.Object(
  {
    eventTitle: Type.String({ minLength: 1, description: 'the event title/summary, e.g. "openinfo weekly sync"' }),
    attendees: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: 'attendee display names and/or emails, as Calendar.app exposes them' })),
    calendarName: Type.Optional(Type.String({ description: 'the calendar the event belongs to, e.g. "Work"' })),
    startsAt: Type.Optional(IsoTime),
    endsAt: Type.Optional(IsoTime),
  },
  { $id: 'CalendarSignal', additionalProperties: false, description: 'decoded content of a calendar routing signal — meeting context, not a transcript' },
)
export type CalendarSignal = Static<typeof CalendarSignal>

export const CaptureChunk = Type.Object(
  {
    id: Id,
    sessionId: Id,
    workspaceId: Id,
    source: CaptureSource,
    sequence: Type.Integer({ minimum: 0 }),
    capturedAt: IsoTime,
    contentType: Type.String({ minLength: 1 }),
    encoding: Type.Union([Type.Literal('utf8'), Type.Literal('base64')]),
    data: Type.String(),
  },
  { $id: 'CaptureChunk', additionalProperties: false },
)
export type CaptureChunk = Static<typeof CaptureChunk>

export const Ack = Type.Object(
  {
    ok: Type.Boolean(),
    chunkId: Id,
    sequence: Type.Integer({ minimum: 0 }),
    receivedAt: IsoTime,
  },
  { $id: 'Ack', additionalProperties: false },
)
export type Ack = Static<typeof Ack>

/**
 * An EPHEMERAL live-transcript update — the transcript fast-path (#58). Published on the bus (and
 * broadcast over the WS event feed) IMMEDIATELY after the transcribe drain stage succeeds, so raw
 * spoken words reach a surface within one WS hop instead of waiting for the slower distill pass. It is
 * NOT persisted anywhere: the durable record still comes only from distill (the distillate/moments).
 * A mid-crash therefore loses only the undistilled live tail — the raw audio chunks remain the durable
 * source, re-transcribed on the next drain. `text` aggregates the chunks transcribed in one drain for a
 * single (session, source) pair; `capturedAtRange` is the capturedAt span of those chunks. `source`
 * carries the free me/them split (mic = me, system-audio = them) so the HUD can attribute the speaker.
 */
export const TranscriptUpdate = Type.Object(
  {
    sessionId: Id,
    source: CaptureSource,
    text: Type.String({ description: 'raw transcribed text for this drain window — a live feed, never persisted' }),
    capturedAtRange: Type.Object(
      { start: IsoTime, end: IsoTime },
      { additionalProperties: false, description: 'the capturedAt span of the chunks aggregated into this update' },
    ),
  },
  { $id: 'TranscriptUpdate', additionalProperties: false },
)
export type TranscriptUpdate = Static<typeof TranscriptUpdate>

/** One endpoint currently occupying the stt slot — its name and (when the endpoint names one) model. */
export const SttSlotEndpoint = Type.Object(
  {
    endpoint: Type.String({ description: 'the stt endpoint name (never a secret)' }),
    model: Type.Optional(Type.String({ description: 'the model the endpoint serves, when it names one' })),
  },
  { $id: 'SttSlotEndpoint', additionalProperties: false },
)
export type SttSlotEndpoint = Static<typeof SttSlotEndpoint>

/**
 * The transcription-inspector snapshot (#101) — the ONE row the `transcript` query source returns, the
 * headline of the diagnostics app. Composes the two HONESTLY-KNOWN facts the transcript-garbage QA needed
 * on a surface instead of over ssh:
 *
 * - `chunks`: the most recent EPHEMERAL TranscriptUpdates, newest-first, drawn from an in-memory ring the
 *   engine keeps (fed off the transcript.updated bus). Each carries its stream (mic = me / system-audio =
 *   them), captured-at span (⇒ a duration), and raw text. Like the live feed itself, this is NOT persisted:
 *   the ring holds only the last `ringLimit` updates for the running process, cleared on restart.
 * - `sttSlot`: the CURRENT stt slot configuration (endpoint · model). This is DELIBERATELY separate from the
 *   chunks: per-chunk stt provenance is NOT recorded anywhere (the disclosed #65 gap — STT invokes persist
 *   no provenance row, unlike DISTILLATE records). So the inspector renders the slot as the current config,
 *   NOT as a claim about which endpoint served any specific chunk. The block discloses this limit in text.
 *
 * Operational/config state, not a store record — injected by the /query route (the `queue` pattern).
 */
export const TranscriptInspector = Type.Object(
  {
    chunks: Type.Array(TranscriptUpdate, { description: 'recent transcript updates, newest-first, from the in-memory ring — NOT persisted' }),
    sttSlot: Type.Array(SttSlotEndpoint, {
      description: 'the CURRENT stt slot endpoints (endpoint · model). NOT per-chunk provenance — per-chunk stt provenance is the disclosed #65 gap',
    }),
    ringLimit: Type.Integer({ minimum: 1, description: 'how many recent updates the ephemeral ring retains for this process (retention disclosure)' }),
  },
  {
    $id: 'TranscriptInspector',
    additionalProperties: false,
    description:
      'the transcript-inspector snapshot (#101): recent ephemeral transcript chunks + the current stt slot config. Per-chunk stt endpoint/model is NOT recorded (#65 gap); sttSlot is the current configuration, not a per-chunk claim.',
  },
)
export type TranscriptInspector = Static<typeof TranscriptInspector>

/**
 * A classified drain failure (INVOKE-RESILIENCE) — the LAST time the drain processor could not process a
 * spooled file because an invoke failed. It names WHICH endpoint, WHAT went wrong (the class the engine
 * detected: an unreachable server vs a timeout vs a rejected key vs a model that won't load vs a garbled
 * reply), the server's own message when it gave one, and a one-line troubleshoot `hint`. This is the
 * honest signal behind the user's mandate — the drain no longer re-queues silently forever; GET /queue,
 * the Status section, and the Try-it card read this to say exactly why nothing arrived. Carries a keyRef,
 * NEVER a key value (the never-echo discipline).
 */
export const QueueFailure = Type.Object(
  {
    class: Type.Union(
      ['unreachable', 'timeout', 'auth', 'model-load', 'bad-response', 'reasoning-exhausted', 'egress-denied', 'guard-held'].map((c) => Type.Literal(c)),
      { description: 'the detected failure class — the difference the user asked the system to tell apart (egress-denied #64: an egress endpoint was skipped because this content may not leave the machine; guard-held #63: the egress guard suspended the hop — flagged content in strict mode, or a fail-closed empty guard slot)' },
    ),
    endpoint: Type.String({ description: 'the endpoint name the invoke failed on (never a secret value)' }),
    model: Type.Optional(Type.String({ description: 'the model that was asked for, when the endpoint names one' })),
    keyRef: Type.Optional(Type.String({ description: 'the auth keyRef involved on an auth failure — the REFERENCE, never the value' })),
    serverMessage: Type.Optional(Type.String({ description: "the server's own error text (e.g. LM Studio's \"Model … failed to load\"), captured verbatim" })),
    hint: Type.String({ description: 'the one-line "what to do about it" step' }),
    at: IsoTime,
  },
  { $id: 'QueueFailure', additionalProperties: false },
)
export type QueueFailure = Static<typeof QueueFailure>

/**
 * The kind of work a spooled chunk represents — the typed-queue classification (P4A slice 3). A chunk
 * is classified by its `source`/`contentType` (queue/kinds.ts), NOT by importing any capture producer:
 * `audio` = mic/system-audio (the me/them split); `screen` = screen/camera frames (P4B adds the
 * producers — a `screen` source or an image/* contentType lands here without the queue knowing about
 * P4B); `llm-work` = text/utf8 work destined for distill (calendar/repo/typed text). `source: 'focus'`
 * chunks are DELIBERATELY not a kind here — they are ephemeral routing context (consumed by the
 * detector, never distilled, never a meaningful backlog), so they are excluded from per-kind depth and
 * the backlog ETA (see queue/kinds.ts and PHASE4-NOTES).
 */
export const QueueKind = Type.Union(
  ['audio', 'screen', 'llm-work'].map((k) => Type.Literal(k)),
  { $id: 'QueueKind', description: 'the work kind of a spooled chunk (audio | screen | llm-work); focus chunks are excluded — ephemeral routing context' },
)
export type QueueKind = Static<typeof QueueKind>

/** Pending depth for ONE queue kind — how much of that kind is spooled and not yet drained. */
export const QueueKindDepth = Type.Object(
  {
    pendingChunks: Type.Integer({ minimum: 0, description: 'spooled chunks of this kind not yet drained' }),
    pendingBytes: Type.Integer({ minimum: 0, description: 'their on-disk JSONL bytes' }),
  },
  { $id: 'QueueKindDepth', additionalProperties: false },
)
export type QueueKindDepth = Static<typeof QueueKindDepth>

/**
 * The backlog projection (P4A slice 3, the P3 `eta.ts` design — ARCHITECTURE §7 "Backlog analytics
 * project when the queue clears at current drain rate"). `basis` is HONEST about where the number comes
 * from: `observed` = projected from recent measured drain durations; `none` = not enough data to
 * project, so NO `etaMs`/`caughtUpBy` is invented (an unknown is unknown). `etaMs`/`caughtUpBy` are the
 * projected time-to-clear at the current observed drain rate. `measuredTokPerSec` echoes the active llm
 * endpoint's benchmarked throughput (fabric §8 `measured`) as the envelope's measured side — surfaced
 * context, not (in v0) itself the ETA basis (converting tok/s to a chunk ETA needs a tokens-per-chunk
 * model — deferred). The ETA is OVERALL, not per-kind: the drain processes whole files that mix kinds,
 * so the observed rate is a mixed-kind rate (per-kind ETA is deferred with per-kind drain accounting).
 */
export const BacklogEta = Type.Object(
  {
    basis: Type.Union(['observed', 'none'].map((b) => Type.Literal(b)), {
      description: 'observed = projected from recent drain durations; none = insufficient data, no fabricated ETA',
    }),
    etaMs: Type.Optional(Type.Number({ minimum: 0, description: 'projected ms until the backlog clears at the current drain rate (0 = already caught up)' })),
    caughtUpBy: Type.Optional(IsoTime),
    drainRateChunksPerSec: Type.Optional(Type.Number({ minimum: 0, description: 'the observed drain rate the projection used' })),
    measuredTokPerSec: Type.Optional(Type.Number({ minimum: 0, description: "the active llm endpoint's MEASURED tok/s (envelope §8) — context, not the ETA basis in v0" })),
  },
  { $id: 'BacklogEta', additionalProperties: false },
)
export type BacklogEta = Static<typeof BacklogEta>

/**
 * How far BEHIND THE PRESENT the pipeline is (#102 "keep time") — the BACKWARD-looking companion to the
 * forward-looking BacklogEta. Where the ETA projects when the backlog will CLEAR, the lag reports how old
 * the oldest still-unprocessed capture is RIGHT NOW: `behindMs` = now − the oldest pending WORK chunk's
 * true capture time (`CaptureChunk.capturedAt`). This is the measurable half of the guarantee that delayed
 * data is never presented as real-time — a surface can honestly say "processing ~Ns behind".
 *
 * `basis` is HONEST about where the number comes from: `capture-time` = computed from the pending chunks'
 * own `capturedAt` (the normal case — every chunk carries it); `unknown` = a backlog exists but no pending
 * capture time was recoverable (all pending files unreadable/corrupt this pass), so `behindMs` is 0 and no
 * lag is claimed rather than fabricated. `oldestPendingCapturedAt` is that oldest capture instant when
 * known. The whole object is ABSENT from QueueStatus when the pipeline is caught up (no pending work) —
 * absence means "0 behind", so nothing false renders. Focus chunks (routing context) are excluded, exactly
 * as they are from byKind/BacklogEta.
 */
export const BacklogLag = Type.Object(
  {
    behindMs: Type.Number({ minimum: 0, description: 'now − oldest-pending capture time; 0 when the basis is unknown' }),
    oldestPendingCapturedAt: Type.Optional(IsoTime),
    basis: Type.Union(['capture-time', 'unknown'].map((b) => Type.Literal(b)), {
      description: 'capture-time = computed from pending chunks capturedAt; unknown = a backlog exists but no capture time was recoverable (behindMs 0, nothing claimed)',
    }),
  },
  { $id: 'BacklogLag', additionalProperties: false },
)
export type BacklogLag = Static<typeof BacklogLag>

/**
 * The overflow policy in effect for the queue (ARCHITECTURE §7 hardware envelope). `policy` is the
 * DECLARED intent, read from the active mode's `overflow` field (`queue`→`queue-for-idle`,
 * `degrade`→`degrade-cadence`, `drop`). `enforced` is HONEST about what the engine actually does in v0:
 * `queue-for-idle` IS today's behavior (append + drain at idle, never lose capture) so it is enforced;
 * `degrade-cadence` is a client-side capture concern (not the engine's to control) and `drop` would
 * deliberately violate the never-lose-capture guarantee — both are recorded-but-inert signals in v0
 * (enforced=false), pending explicit product sign-off. See PHASE4-NOTES for what is real vs declared.
 */
export const OverflowState = Type.Object(
  {
    policy: Type.Union(['queue-for-idle', 'degrade-cadence', 'drop'].map((p) => Type.Literal(p)), {
      description: 'the declared overflow policy (from the active mode) when the mode exceeds measured hardware',
    }),
    enforced: Type.Boolean({ description: 'true only for queue-for-idle in v0 — degrade-cadence/drop are declared-but-inert (see PHASE4-NOTES)' }),
  },
  { $id: 'OverflowState', additionalProperties: false },
)
export type OverflowState = Static<typeof OverflowState>

export const QueueStatus = Type.Object(
  {
    pendingFiles: Type.Integer({ minimum: 0 }),
    pendingBytes: Type.Integer({ minimum: 0 }),
    drainedFiles: Type.Integer({ minimum: 0 }),
    updatedAt: IsoTime,
    /** the last classified drain failure — present once a drain has failed (the honest "why nothing arrived"). */
    lastFailure: Type.Optional(QueueFailure),
    /** ISO time of the last file the drain processed successfully — present once one has drained. */
    lastSuccessAt: Type.Optional(IsoTime),
    /**
     * Count of spool files DROPPED by the age-shed policy (#70) — backlog older than the configured
     * freshness horizon, dropped-not-processed so a live session renders the present. Additive: present
     * once at least one file has been shed (absent = nothing ever shed). Never silent — each shed also
     * emits a log line with count + age range. Distinct from drainedFiles (processed) and re-queues.
     */
    shedFiles: Type.Optional(Type.Integer({ minimum: 0 })),
    /**
     * Per-kind pending depth (P4A slice 3, additive). Present once the queue tallies kinds; sums may be
     * LESS than pendingBytes because focus chunks (routing context) are deliberately excluded.
     */
    byKind: Type.Optional(
      Type.Object(
        { audio: QueueKindDepth, screen: QueueKindDepth, 'llm-work': QueueKindDepth },
        { additionalProperties: false },
      ),
    ),
    /** the backlog projection at the current drain rate (additive) — `basis: 'none'` when unknowable. */
    eta: Type.Optional(BacklogEta),
    /**
     * How far behind the present the pipeline is (#102, additive) — now − the oldest pending capture's
     * true `capturedAt`. Present only while a work backlog exists; ABSENT when caught up (absence = 0
     * behind). The measurable half of "delayed data is never presented as real-time".
     */
    lag: Type.Optional(BacklogLag),
    /** the overflow policy in effect (additive) — declared intent + whether the engine enforces it in v0. */
    overflow: Type.Optional(OverflowState),
  },
  { $id: 'QueueStatus', additionalProperties: false },
)
export type QueueStatus = Static<typeof QueueStatus>

/**
 * The screen-OCR processor's status (GET /screen/status; P4B). The screen processor rides capture
 * ingest (NOT the queue drain — it is not owned by queue/), so its health has no home on QueueStatus;
 * this is that home. `enabled` echoes the `screen.ocr` flag (read per-frame). The counters are the
 * frames the processor has seen since the engine started: `processed` produced an OcrResult + a
 * distillate; `blank` were recognized as empty (a blank frame — persisted as neither, see PHASE4-NOTES);
 * `skipped` were the companion ScreenFrameMeta chunks (utf8/json) it correctly ignores; `failed` threw
 * an invoke error. `lastFailures` is a bounded ring of the most-recent classified failures — the same
 * QueueFailure taxonomy the drain records, so "why nothing was recognized" reads identically. In-memory
 * (resets on restart), value-free re keys (a QueueFailure carries a keyRef, never a value).
 */
export const ScreenStatus = Type.Object(
  {
    enabled: Type.Boolean({ description: 'the screen.ocr flag state (read per-frame)' }),
    processed: Type.Integer({ minimum: 0, description: 'frames that produced an OcrResult + distillate' }),
    blank: Type.Integer({ minimum: 0, description: 'frames recognized as empty (a blank frame; no record persisted)' }),
    skipped: Type.Integer({ minimum: 0, description: 'companion ScreenFrameMeta (utf8/json) chunks correctly ignored' }),
    failed: Type.Integer({ minimum: 0, description: 'frames whose OCR/VLM invoke threw (recorded in lastFailures)' }),
    lastFailures: Type.Array(QueueFailure, { description: 'bounded ring of the most-recent classified frame failures (newest last)' }),
  },
  { $id: 'ScreenStatus', additionalProperties: false },
)
export type ScreenStatus = Static<typeof ScreenStatus>

/**
 * One row of the relevant-now join (Index v0): a ranked entity together with the recent moments
 * that reference it. The score is the recency×frequency rank at query time; the joined moments
 * carry their own provenance so a surfaced entity's relevance is inspectable (product principle 1).
 * Served by GET /relevant.
 */
export const RelevantEntity = Type.Object(
  {
    entity: Entity,
    score: Type.Number({ minimum: 0, description: 'recency×frequency rank score at query time' }),
    moments: Type.Array(Moment, { description: 'recent moments referencing this entity — the inspectable join' }),
  },
  { $id: 'RelevantEntity', additionalProperties: false },
)
export type RelevantEntity = Static<typeof RelevantEntity>

/**
 * A SUGGESTED attribution-hint pattern derived from a workspace's teaching signals (the teach loop's
 * `deriveHintCandidates`, ARCHITECTURE §10 item 2) — the GET /teach/candidates read, the inspectable
 * "these corrections suggest this rule" chip a surface renders. It is CONSUMABLE OUTPUT ONLY: never
 * auto-applied to `route/hints` (a human reviews a candidate and, if right, adds it — the loop suggests,
 * the user applies). `supportCount` is how many distinct reroutes back the exact (field, contains);
 * `sampleSessionIds` are the corrections behind it, so a candidate is always traceable to its evidence.
 */
export const HintCandidate = Type.Object(
  {
    workspaceId: Id,
    pattern: AttributionPattern,
    supportCount: Type.Integer({ minimum: 1, description: 'distinct reroutes supporting this exact (field, contains)' }),
    sampleSessionIds: Type.Array(Id, { description: 'the reroutes behind the candidate — always traceable to its corrections' }),
  },
  { $id: 'HintCandidate', additionalProperties: false },
)
export type HintCandidate = Static<typeof HintCandidate>

/**
 * The result of compiling a BlockQuery server-side (POST /query). A BlockQuery is "compiled
 * server-side to store calls" (the Phase-0 surface.ts decision), so the client never owns data —
 * every built-in block is an API call against this endpoint. `items` are the hydrated rows; their
 * element shape is keyed by `source` (relevant-now→RelevantEntity, moments→Moment, sessions→
 * Session, entities→Entity, ledger→Commitment, pins→Pin), which is why it is `unknown[]` rather
 * than one over-broad union. `top` echoes the requested cap; `truncated` is true when more rows
 * existed than were returned (the HUD shows top-K, the workbench holds the rest — surface.ts).
 * Sources whose backing store does not exist yet (ledger P4, pins P3) return `[]`, not an error.
 */
export const QueryResult = Type.Object(
  {
    source: Type.Union(
      ['relevant-now', 'moments', 'ledger', 'sessions', 'pins', 'entities', 'todos', 'drafts', 'teach', 'distillates', 'fields', 'queue', 'transcript', 'senses'].map((s) => Type.Literal(s)),
    ),
    items: Type.Array(Type.Unknown(), { description: 'hydrated rows; element shape is keyed by `source` (fields → FieldValue, #61; transcript → TranscriptInspector, #101; senses → SenseGateChain, #7/#101)' }),
    top: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    truncated: Type.Boolean({ description: 'true when more rows existed than were returned under `top`' }),
    suppressed: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          'how many rows a user DISMISSED were excluded from these results (#66). Present only when > 0, so a block that emptied purely via suppression can disclose it in its empty-state — explainable, not mysterious.',
      }),
    ),
  },
  { $id: 'QueryResult', additionalProperties: false },
)
export type QueryResult = Static<typeof QueryResult>

/**
 * The body of POST /sessions — a manual session START request. The caller supplies only what it
 * knows (which workspace, which mode, optionally a register override and a title); the engine
 * stamps id/startedAt/attribution and returns the full Session. A dedicated payload (not a partial
 * Session) so the caller never invents server-owned fields, mirroring RelevantEntity's precedent.
 */
export const StartSessionRequest = Type.Object(
  {
    workspaceId: Id,
    modeId: Id,
    registerId: Type.Optional(Id),
    title: Type.Optional(Type.String()),
  },
  { $id: 'StartSessionRequest', additionalProperties: false },
)
export type StartSessionRequest = Static<typeof StartSessionRequest>

/**
 * The body of `POST /sessions/:id/reroute` — the one-click retroactive reroute (Phase 3). The caller
 * supplies ONLY the destination (`toWorkspaceId`); the session is addressed by the route id and its
 * current workspace is read server-side (a session carries its own workspaceId). This is the
 * correction loop the router's mistakes require (IMPLEMENTATION §3 risk register): moving a session
 * — with everything keyed to it (distillates, moments, drafts) — between workspace DBs. The engine
 * stamps `reroutedFrom` and appends a `manual` attribution-evidence entry; the caller invents nothing.
 * A dedicated payload (not a partial Session), mirroring StartSessionRequest's precedent.
 */
export const RerouteRequest = Type.Object(
  {
    toWorkspaceId: Id,
  },
  { $id: 'RerouteRequest', additionalProperties: false },
)
export type RerouteRequest = Static<typeof RerouteRequest>

/**
 * The body of `POST /fabric/profiles/:id/clone` — the new profile's id (+ optional name). Cloning is
 * copying a document (ARCHITECTURE §2/§8): the engine reads the source profile, restamps id/name/
 * version, and writes a fresh document. Kept as a route (not client GET+PUT) so a clone is atomic.
 */
export const CloneProfileRequest = Type.Object(
  {
    id: Id,
    name: Type.Optional(Type.String({ minLength: 1 })),
  },
  { $id: 'CloneProfileRequest', additionalProperties: false },
)
export type CloneProfileRequest = Static<typeof CloneProfileRequest>

/**
 * The body of `POST /teach/entity` — the #75 clarify affordance's answer. When the resolver flagged a
 * mention AMBIGUOUS (a rival within the margin), the user's verdict on the affected row lands here and the
 * engine turns it into BOTH a labeled `TeachSignal` (audit + teach loop) AND a sovereign `EntityOverride`
 * (the durable resolver short-circuit) — never model-trusted, always the user's explicit action.
 *
 * `verdict` names the choice: `confirm` (the mention IS the linked candidate `entityId` — an `alias-confirm`
 * that pins `heard` to it and REJECTS the rival) or `disambiguate` (it is the rival `rivalId` instead — pins
 * `heard` to the rival and rejects the linked candidate). `heard` is the surface form being settled;
 * `rivalId`/`rivalName` name the resolver's flagged rival. A rejection always records `rejectedRivalId`
 * server-side so the same wrong rival is never re-offered. `correctedAt`/the signal id/the override
 * provenance are ALL engine-stamped — the caller invents no ids or timestamps (mirrors RerouteRequest).
 */
export const EntityCorrection = Type.Object(
  {
    workspaceId: Id,
    entityId: Id,
    heard: Type.String({ minLength: 1, description: 'the heard surface form the verdict settles' }),
    verdict: Type.Union(['confirm', 'disambiguate'].map((v) => Type.Literal(v)), {
      description: 'confirm = it is the linked candidate (alias-confirm) · disambiguate = it is the rival instead',
    }),
    rivalId: Type.Optional(Id),
    rivalName: Type.Optional(Type.String()),
  },
  { $id: 'EntityCorrection', additionalProperties: false },
)
export type EntityCorrection = Static<typeof EntityCorrection>

/**
 * A secret REFERENCE — the ONLY secret-shaped thing that ever leaves the engine. `GET /fabric/secrets`
 * returns these (the refs that have a stored value), and write/delete echo back the ref they touched.
 * It carries NO value field, by design: no route, event, GET response, document, or export ever
 * returns key material (the never-echo-to-UI discipline). The value is set via SecretValue (inbound
 * only) and resolved server-side at invoke time.
 */
export const SecretRef = Type.Object(
  { ref: Type.String({ minLength: 1, description: 'the keyRef an endpoint auth block points at' }) },
  { $id: 'SecretRef', additionalProperties: false },
)
export type SecretRef = Static<typeof SecretRef>

/**
 * The body of `PUT /fabric/secrets/:ref` — the write-only inbound path for a secret value. This is
 * the one schema that carries key material, and it is REQUEST-ONLY: it is never used as a response,
 * never persisted in a document, never echoed. The engine stores the value in the secret store and
 * replies with a bare SecretRef.
 */
export const SecretValue = Type.Object(
  { value: Type.String({ minLength: 1, description: 'the secret value — inbound only, never returned' }) },
  { $id: 'SecretValue', additionalProperties: false },
)
export type SecretValue = Static<typeof SecretValue>

/**
 * The result of a connectivity probe against ONE endpoint (POST /fabric/test) — the setup page's
 * "Test" button backing. It is the existing health check (fabric/health.ts) exposed as a thin,
 * read-only helper: reachable? + latency, with a human `hint` on a failure the user can act on (a
 * 401/403 → set a key and reference it via keyRef; an unresolved keyRef → store its value below).
 * If the endpoint carries a previously MEASURED throughput (tools/bench, on the endpoint doc), it is
 * echoed as `tokPerSec` — this probe pings, it does not itself benchmark generation. Request-shaped
 * body is an Endpoint (the row's current — possibly unsaved — values), so a user can test before saving.
 */
/**
 * The result of a REAL-generation probe (INVOKE-RESILIENCE) — `POST /fabric/test` with `probe: 'generate'`
 * runs a minimal 1-token completion through the actual invoke path, so a server that pings 200 but can't
 * load its model (the user's LM Studio 400) is caught HONESTLY. `ok` = a completion came back; on
 * failure `class`/`error`/`hint` carry the classified reason (the same taxonomy the drain records). For an
 * stt endpoint it is `skipped` with a `note` (a generation probe needs audio — out of scope). Value-free re keys.
 */
export const GenerateProbe = Type.Object(
  {
    ok: Type.Boolean(),
    latencyMs: Type.Optional(Type.Number({ minimum: 0 })),
    class: Type.Optional(
      Type.Union(['unreachable', 'timeout', 'auth', 'model-load', 'bad-response', 'reasoning-exhausted'].map((c) => Type.Literal(c)), {
        description: 'the classified failure reason when generation failed',
      }),
    ),
    error: Type.Optional(Type.String({ description: "the server's own message when generation failed, captured verbatim" })),
    hint: Type.Optional(Type.String({ description: 'the one-line troubleshoot step (incl. the loaded-model suggestion on a model-load failure)' })),
    skipped: Type.Optional(Type.Boolean({ description: 'true when generation was not run (e.g. an stt endpoint)' })),
    note: Type.Optional(Type.String({ description: 'why it was skipped' })),
    // The model's ACTUAL reply text (truncated), so Test shows proof it can hear us — not a checkmark. The
    // probe now sends a real prompt at a real token budget ("reply 'yes' if you can hear us", ~128 tokens),
    // so most models return genuine text; present on a successful generation, absent on failure/skip.
    sample: Type.Optional(Type.String({ description: "the model's actual reply text (truncated), rendered in the Test area as proof of a live completion" })),
  },
  { $id: 'GenerateProbe', additionalProperties: false },
)
export type GenerateProbe = Static<typeof GenerateProbe>

export const EndpointProbe = Type.Object(
  {
    ok: Type.Boolean(),
    latencyMs: Type.Optional(Type.Number({ minimum: 0 })),
    tokPerSec: Type.Optional(Type.Number({ minimum: 0, description: 'last MEASURED tok/s from the endpoint doc — not measured by this probe' })),
    error: Type.Optional(Type.String()),
    hint: Type.Optional(Type.String({ description: 'an actionable next step when the probe fails (e.g. a keyRef hint on 401)' })),
    /** the REAL-generation result, present only when the request asked for `probe: 'generate'`. */
    generate: Type.Optional(GenerateProbe),
  },
  { $id: 'EndpointProbe', additionalProperties: false },
)
export type EndpointProbe = Static<typeof EndpointProbe>

/**
 * The runtime state of ONE starter model (GET /fabric/local/models) — the tier-zero "no server at all"
 * offer's backing (ARCHITECTURE §8, slice c). It joins the catalog entry with what the engine can see
 * locally: whether the runtime binary is present (`runtimeAvailable`, with an `installHint` when not),
 * whether the model file is downloaded/downloading/absent, and download progress. The Get-Started lens
 * renders one row per model from this; the browser polls it during a download for progress.
 */
export const LocalModelStatus = Type.Object(
  {
    model: StarterModel,
    runtimeAvailable: Type.Boolean({ description: 'the runtime binary (e.g. llama-server) was found on this machine' }),
    installHint: Type.Optional(Type.String({ description: 'how to get the runtime binary when missing (e.g. brew install llama.cpp)' })),
    state: Type.Union(['absent', 'downloading', 'ready', 'error'].map((s) => Type.Literal(s))),
    downloadedBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    totalBytes: Type.Optional(Type.Integer({ minimum: 0, description: 'the download Content-Length, once known' })),
    error: Type.Optional(Type.String()),
  },
  { $id: 'LocalModelStatus', additionalProperties: false },
)
export type LocalModelStatus = Static<typeof LocalModelStatus>

/**
 * The body of POST /fabric/local/download — the explicit user click that acquires ONE starter model.
 * Never auto-downloaded; the engine streams the file into the data root models/ dir with resume + a
 * size sanity check, and returns the model's LocalModelStatus (poll GET /fabric/local/models for progress).
 */
export const LocalDownloadRequest = Type.Object(
  { modelId: Type.String({ minLength: 1, description: 'the StarterModel id to download' }) },
  { $id: 'LocalDownloadRequest', additionalProperties: false },
)
export type LocalDownloadRequest = Static<typeof LocalDownloadRequest>

/** One prior turn of a chat exchange (#134) — role + text. `assistant` turns are the engine's prior replies. */
export const ChatTurn = Type.Object(
  {
    role: Type.Union([Type.Literal('user'), Type.Literal('assistant')]),
    content: Type.String({ minLength: 1 }),
  },
  { $id: 'ChatTurn', additionalProperties: false },
)
export type ChatTurn = Static<typeof ChatTurn>

/**
 * The body of POST /chat (#134) — the below-HUD chat shell's turn. The engine answers WITH THE CORPUS IN
 * HAND (relevant entities + cited pin chunks when a document is attached), not vanilla completion. `pinId`
 * attaches an INGESTED pin whose page-anchored chunks become the citable context; `history` carries prior
 * turns so the honest turn budget can be computed and disclosed. Small local models get few useful turns
 * against a big document, so context enters DISTILLED/CHUNKED (cited excerpts, capped), never raw-stuffed.
 */
export const ChatRequest = Type.Object(
  {
    message: Type.String({ minLength: 1 }),
    workspace: Type.Optional(Id),
    pinId: Type.Optional(Id),
    history: Type.Optional(Type.Array(ChatTurn)),
  },
  { $id: 'ChatRequest', additionalProperties: false },
)
export type ChatRequest = Static<typeof ChatRequest>

/** A page-anchored citation the chat answer stands on (#134) — the pin chunk it drew from, cite-ready ("p. 42"). */
export const ChatCitation = Type.Object(
  {
    pinId: Id,
    pinTitle: Type.Optional(Type.String()),
    ordinal: Type.Integer({ minimum: 0, description: 'the cited chunk ordinal within the pin' }),
    page: Type.Optional(Type.Integer({ minimum: 1, description: '1-based source page anchor; absent for pageless sources' })),
    excerpt: Type.String({ minLength: 1, description: 'the cited excerpt (capped) — proof, not the whole chunk' }),
  },
  { $id: 'ChatCitation', additionalProperties: false },
)
export type ChatCitation = Static<typeof ChatCitation>

/**
 * The HONEST, VISIBLE turn/context budget (#134) — disclosed to the user, never a silent truncation. Small
 * local models get ~3-4 useful turns against a big document, so the reply states the estimated context
 * tokens, the invoke's max output tokens, how many turns are estimated to remain at this rate, and whether
 * the attached context had to be TRUNCATED to fit (with a human `note` naming what was dropped).
 */
export const ChatBudget = Type.Object(
  {
    contextTokens: Type.Integer({ minimum: 0, description: 'estimated tokens the assembled context + history occupy (chars/4)' }),
    maxTokens: Type.Integer({ minimum: 1, description: 'the max output tokens this invoke ran under' }),
    turnsRemaining: Type.Integer({ minimum: 0, description: 'estimated useful turns left at this context rate before the window fills' }),
    truncated: Type.Boolean({ description: 'true ⇒ attached context was capped/dropped to fit — see note' }),
    note: Type.String({ minLength: 1, description: 'one-line honest disclosure of the budget/truncation, safe to surface' }),
  },
  { $id: 'ChatBudget', additionalProperties: false },
)
export type ChatBudget = Static<typeof ChatBudget>

/**
 * The reply of POST /chat (#134) — the model's answer, the page-anchored citations it stands on, the honest
 * turn/context budget, and the egress decision this hop ran under (every hop is egress-gated). A failed hop
 * does NOT come back here — the route returns a 4xx/5xx whose body the input block paints as visible text.
 */
export const ChatReply = Type.Object(
  {
    answer: Type.String({ minLength: 1 }),
    citations: Type.Array(ChatCitation),
    budget: ChatBudget,
    endpoint: Type.Optional(Type.String({ description: 'the fabric endpoint that answered' })),
    egress: Type.Optional(EgressDecision),
  },
  { $id: 'ChatReply', additionalProperties: false },
)
export type ChatReply = Static<typeof ChatReply>
