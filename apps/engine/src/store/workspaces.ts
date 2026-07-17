import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { ChatTurn, ContextPacket, Distillate, Draft, Entity, EntityProvenance, EntityOverride, EntityResolution, EgressPolicy, FieldValue, GuardHold, HeardAs, Moment, OcrResult, Pin, PinChunk, Session, SessionAnnotation, SessionTitling, Sighting, SttSegment, Summary, SummaryLevel, TodoList, Workspace } from '@openinfo/contracts'
import { ChatTurn as ChatTurnSchema, ContextPacket as ContextPacketSchema, Entity as EntitySchema, Pin as PinSchema, PinChunk as PinChunkSchema, Summary as SummarySchema } from '@openinfo/contracts'
import { Value } from '@sinclair/typebox/value'
import { DEFAULT_RESOLVER_CONFIG, resolveEntity, type Resolution, type ResolutionSignals, type ResolverConfig } from '../index/resolve.js'
import { DEFAULT_GAZETTEER, GAZETTEER_KEY, GAZETTEER_KIND, gazetteerRivals, type GazetteerDocument } from '../index/gazetteer.js'
import { LayoutStore } from './layouts.js'
import { resolveDataDir } from './paths.js'

/**
 * Create-marking policy (#94, owner-reviewed rule). A `new`-band create is stamped `provisional` ONLY when
 * the best same-kind rival landed NEAR the provisional band — i.e. its score ≥ `provisionalBand − margin`.
 * The old rule marked provisional whenever ANY same-kind record existed, so after the first record per kind
 * a clean create (rival score 0.0) was almost never silent. The near-band rule keeps the review dot for the
 * genuine near-namesake collisions it was meant to catch and lets an unrelated create (e.g. a CJK name vs an
 * existing Latin entity, rival ≈0) stay silent.
 */
const CREATE_PROVISIONAL_MARGIN = 0.1

const FIELD_VALUE_KIND = 'field-value'
const GUARD_HOLDS_KIND = 'guard-holds'
const SESSION_ANNOTATION_KIND = 'session-annotation'
const TODO_LIST_KIND = 'todo-list'

interface GuardHoldsDocument {
  workspaceId: string
  holds: GuardHold[]
}

interface HistoricalDocument<T> {
  key: string
  version: number
  body: T
  createdAt: string
}

interface HistoricalDocumentRow {
  key: string
  version: number
  body: string
  created_at: string
}

/**
 * Normalize an entity name for the v0 resolution match key: trim, lowercase, collapse internal
 * whitespace. Deliberately simple — case/whitespace-insensitive only, no fuzzy or coreference
 * matching (documented weakness in PHASE2-NOTES). Kept identical to distill/entities.ts's alias
 * normalization; store owns the match key so it stays decoupled from the (DB-free) extractor.
 */
const normalizeEntityName = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * Reconcile the two lifecycle copies an interrupted cross-workspace move can temporarily expose.
 * A completed decision always outranks `held`. If the duplicated copies were resolved in opposite
 * ways, deny wins: the conflict is exceptional, and the only deterministic fail-closed outcome is to
 * avoid turning an explicit denial into permission. Returning the winning record also preserves its
 * exact `resolvedAt` rather than manufacturing a new resolution time during recovery.
 */
const reconcileMovedGuardHold = (destination: GuardHold, source: GuardHold): GuardHold => {
  if (destination.status === source.status) return destination
  if (destination.status === 'held') return source
  if (source.status === 'held') return destination
  return destination.status === 'denied' ? destination : source
}

/**
 * The fields the distiller hands store to merge into a canonical entity record. Ids, timestamps,
 * mention counts and the provenance trail are store-owned; the model never controls them.
 */
export interface EntityUpsert {
  workspaceId: string
  kind: Entity['kind']
  name: string
  aliases?: string[]
  /** window end of the mention — advances lastSeen, seeds firstSeen on creation */
  seenAt: string
  provenance?: EntityProvenance
  momentRefs?: string[]
  /**
   * Contract v2 (#73) evidence for this mention. `sighting` is one typed evidence entry (heard/seen/
   * calendar) appended to the trail; `heardAs` is the ASR surface form that resolved here (accumulated,
   * deduped). Both are OPTIONAL — a caller with no evidence signal simply omits them and the record's
   * trails stay as-is. Ids/state/confidence remain store-/resolver-owned; the model never controls them.
   */
  sighting?: Sighting
  heardAs?: HeardAs
  /**
   * Cross-source corroboration evidence (#74). The correlator (`index/correlate.ts`), run at the distiller
   * seam, produces a `seen` (or `calendar`) Sighting when an INDEPENDENT sense named the same concept in the
   * same window as this heard mention. It is appended to the trail exactly like `sighting`, and its presence
   * (paired with a >1 `signals.crossSourceCorroboration`) is what PROMOTES a link to `confirmed` with no user
   * ask (see `stampResolution`). Absent ⇒ no cross-source corroboration this window (the common case).
   */
  crossSighting?: Sighting
  /**
   * Resolver (#72) inputs. `signals` carries the cross-source / person-affinity INPUT MULTIPLIERS (person
   * affinity still defaults to the neutral 1.0 — no producer yet; #74's correlator now feeds
   * `crossSourceCorroboration` at the distiller seam); `resolverConfig` overrides the band/margin thresholds
   * for tests. Omitted ⇒ the deterministic defaults.
   */
  signals?: ResolutionSignals
  resolverConfig?: ResolverConfig
}

/**
 * One moved session's contribution to a single source entity — the provenance entries (keyed by a
 * moved distillate) it added, plus the moved moment refs and the entity's kind/name/aliases/window.
 * Carried from the source read into moveSession's destination upsert (and its source→dest id remap).
 */
interface Contribution {
  sourceId: string
  kind: Entity['kind']
  name: string
  aliases: string[]
  provenance: EntityProvenance[]
  momentRefs: string[]
  firstSeen: string
  lastSeen: string
}

interface WorkspaceRow {
  id: string
  name: string
  db_file: string
  color: string | null
  retention_days: number | null
  // Layer 3 of the egress-consent policy (#64/#128): the workspace's wholesale egress denial, stored as
  // the JSON-serialized EgressPolicy. null ⇒ this workspace does not deny (defers to the other layers).
  egress: string | null
  created_at: string
}

export class WorkspaceRegistry {
  readonly dataDir: string
  readonly layouts: LayoutStore
  private readonly metaDb: Database.Database
  private readonly workspaceHandles = new Map<string, Database.Database>()

  constructor(dataDir?: string) {
    this.dataDir = resolveDataDir(dataDir)
    mkdirSync(this.dataDir, { recursive: true })
    this.metaDb = new Database(join(this.dataDir, '_meta.db'))
    this.metaDb.pragma('journal_mode = WAL')
    this.createMetaTables()
    this.layouts = new LayoutStore(this.metaDb)
    this.ensureWorkspace({ id: 'default', name: 'Default' })
  }

  all(): Workspace[] {
    const rows = this.metaDb
      .prepare('select id, name, db_file, color, retention_days, egress, created_at from workspaces order by created_at')
      .all() as WorkspaceRow[]
    return rows.map((row) => this.fromRow(row))
  }

  ensureWorkspace(input: { id: string; name: string; color?: string; retentionDays?: number }): Workspace {
    const dbFile = `${input.id}.db`
    const existing = this.metaDb
      .prepare('select id, name, db_file, color, retention_days, egress, created_at from workspaces where id = ?')
      .get(input.id) as WorkspaceRow | undefined
    if (existing) return this.fromRow(existing)

    const createdAt = new Date().toISOString()
    this.metaDb
      .prepare('insert into workspaces (id, name, db_file, color, retention_days, egress, created_at) values (?, ?, ?, ?, ?, ?, ?)')
      .run(input.id, input.name, dbFile, input.color ?? null, input.retentionDays ?? null, null, createdAt)
    this.openWorkspace(input.id)
    const workspace: Workspace = { id: input.id, name: input.name, dbFile, createdAt }
    if (input.color !== undefined) workspace.color = input.color
    if (input.retentionDays !== undefined) workspace.retentionDays = input.retentionDays
    return workspace
  }

  /**
   * Set (or clear) a workspace's layer-3 egress-deny policy (#64/#128) — the ONLY write path for the
   * broadest content-side egress layer. `deny:true` denies egress wholesale for everything the workspace
   * scopes; `undefined` clears it (the workspace defers to the other layers). The row round-trips through
   * `fromRow`, so the distiller's consent resolver reads the live policy on its next pass. The workspace is
   * created on demand (mirrors the other writers). No UI yet — the Settings toggle is a later slice.
   */
  setEgressPolicy(id: string, egress: EgressPolicy | undefined): Workspace {
    this.ensureWorkspace({ id, name: id })
    this.metaDb
      .prepare('update workspaces set egress = ? where id = ?')
      .run(egress !== undefined ? JSON.stringify(egress) : null, id)
    return this.all().find((workspace) => workspace.id === id)!
  }

  /**
   * Read a workspace's ACTIVE context-preset selection (pill P2) — the id of the `preset`-kind
   * prompt-template document whose body is prepended to this workspace's distill pass, or `undefined`
   * when unset (⇒ no injection, today's behavior). This is the ONE narrow read the rest of the engine
   * lands on: the distiller resolves the body through it per window, and the chat context-assembly path
   * (P1) reads it to gather the `active-preset` source — a degradable seam (unset ⇒ the source is simply
   * omitted). A missing meta row (workspace never created) reads `undefined`, never throws. Does NOT
   * validate that the id still resolves to a live preset document — that is the resolver's job
   * (PresetDocuments.resolveActive), so a deleted preset degrades to no-injection rather than an error.
   */
  getActivePreset(workspaceId: string): string | undefined {
    const row = this.metaDb
      .prepare('select active_preset from workspaces where id = ?')
      .get(workspaceId) as { active_preset: string | null } | undefined
    return row?.active_preset ?? undefined
  }

  /**
   * Set (or clear) a workspace's active context-preset selection (pill P2) — the write half the PUT
   * /active-preset route binds to. `undefined` clears the selection (the workspace defers to no preset,
   * byte-identical to today). Existence/validity of the preset id is checked at the ROUTE (a nonexistent
   * preset ⇒ 400) — the store just persists the selection, mirroring how setEgressPolicy persists without
   * re-deriving policy. The workspace is created on demand (mirrors the other writers). No UI yet — the
   * pill's preset picker is a later client slice; selection is API-level this slice.
   */
  setActivePreset(workspaceId: string, presetId: string | undefined): void {
    this.ensureWorkspace({ id: workspaceId, name: workspaceId })
    this.metaDb
      .prepare('update workspaces set active_preset = ? where id = ?')
      .run(presetId ?? null, workspaceId)
  }

  /**
   * Persist a distillate to its workspace's OWN sqlite file. The workspace is created on demand
   * (a distill pass may reference a workspace no one has registered yet). This is the only path
   * that writes distillates — the distiller asks store to write, per the DB-handle hard rule.
   */
  saveDistillate(distillate: Distillate): Distillate {
    this.ensureWorkspace({ id: distillate.workspaceId, name: distillate.workspaceId })
    const db = this.openWorkspace(distillate.workspaceId)
    db.prepare('insert or replace into distillates (id, session_id, created_at, body) values (?, ?, ?, ?)').run(
      distillate.id,
      distillate.sessionId,
      distillate.createdAt,
      JSON.stringify(distillate),
    )
    return distillate
  }

  listDistillates(workspaceId: string, sessionId?: string): Distillate[] {
    const db = this.openWorkspace(workspaceId)
    const rows = sessionId
      ? (db.prepare('select body from distillates where session_id = ? order by created_at').all(sessionId) as { body: string }[])
      : (db.prepare('select body from distillates order by created_at').all() as { body: string }[])
    return rows.map((row) => JSON.parse(row.body) as Distillate)
  }

  /**
   * Persist an OCR/VLM screen-understanding result to its workspace's OWN sqlite file (P4B). Mirrors
   * saveDistillate exactly — session-scoped, workspace created on demand, idempotent per id — because an
   * OcrResult is the screen-understanding analogue of a distillate (raw frames expire once understood,
   * just as raw transcript chunks expire once distilled). Only this path writes OcrResults (DB-handle rule).
   */
  saveOcrResult(result: OcrResult): OcrResult {
    this.ensureWorkspace({ id: result.workspaceId, name: result.workspaceId })
    const db = this.openWorkspace(result.workspaceId)
    db.prepare('insert or replace into ocr_results (id, session_id, created_at, body) values (?, ?, ?, ?)').run(
      result.id,
      result.sessionId,
      result.createdAt,
      JSON.stringify(result),
    )
    return result
  }

  /**
   * Persist one transcribed segment's STT provenance (#116) to its workspace's OWN sqlite file. Mirrors
   * saveDistillate exactly — session-scoped, workspace created on demand, idempotent per id. The record
   * carries chunk id / endpoint / timing, never the transcript text (raw transcript stays ephemeral; the
   * durable text stream is the Distillate). Only this path writes SttSegments (DB-handle hard rule).
   */
  saveSttSegment(segment: SttSegment): SttSegment {
    this.ensureWorkspace({ id: segment.workspaceId, name: segment.workspaceId })
    const db = this.openWorkspace(segment.workspaceId)
    db.prepare('insert or replace into stt_segments (id, session_id, created_at, body) values (?, ?, ?, ?)').run(
      segment.id,
      segment.sessionId,
      segment.createdAt,
      JSON.stringify(segment),
    )
    return segment
  }

  /** List a workspace's STT segments (default all), oldest first; `sessionId` narrows to one session. */
  listSttSegments(workspaceId: string, sessionId?: string): SttSegment[] {
    const db = this.openWorkspace(workspaceId)
    const rows = sessionId
      ? (db.prepare('select body from stt_segments where session_id = ? order by created_at').all(sessionId) as { body: string }[])
      : (db.prepare('select body from stt_segments order by created_at').all() as { body: string }[])
    return rows.map((row) => JSON.parse(row.body) as SttSegment)
  }

  /**
   * Append one ContextPacket (#176) to its workspace's OWN sqlite file. Packets are APPEND-ONLY derived
   * records: a revision never mutates or deletes its predecessor — it is a new row whose `supersedes`
   * links the chain. `insert or replace` keyed on the content-derived id makes a replayed build byte-stable
   * (same content ⇒ same id ⇒ replace-in-place), mirroring saveDistillate's idempotence. Contract-validated
   * before write (the savePin last-line-of-defense idiom). Only this path writes context packets.
   */
  saveContextPacket(packet: ContextPacket): ContextPacket {
    this.ensureWorkspace({ id: packet.workspaceId, name: packet.workspaceId })
    const db = this.openWorkspace(packet.workspaceId)
    const { sessionId, windowStart } = packet
    if (!Value.Check(ContextPacketSchema, packet)) {
      throw new Error(`context packet failed contract validation: ${sessionId} ${windowStart}`)
    }
    db.prepare(
      'insert or replace into context_packets (id, session_id, window_start, window_end, created_at, body) values (?, ?, ?, ?, ?, ?)',
    ).run(packet.id, packet.sessionId, packet.windowStart, packet.windowEnd, packet.createdAt, JSON.stringify(packet))
    return packet
  }

  /**
   * Query a workspace's ContextPackets (#176) — the four query axes the issue names: workspace (the DB),
   * session, time window (`from`/`to` keep packets whose window INTERSECTS the range), and related entity
   * (a candidate names it). Default reads return only each window's LIVE chain head — superseded revisions
   * stay retrievable with `includeSuperseded` (append-only means history is data, not noise). Supersession
   * is resolved over the WHOLE workspace/session scope BEFORE the time/entity filters, so a filtered read
   * can never present a superseded packet as live merely because its successor fell outside the filter.
   * Unknown workspace reads as [] (mirrors listPins) — asking is never an error.
   */
  listContextPackets(
    workspaceId: string,
    opts: { sessionId?: string; from?: string; to?: string; entityId?: string; includeSuperseded?: boolean } = {},
  ): ContextPacket[] {
    if (!this.all().some((ws) => ws.id === workspaceId)) return []
    const db = this.openWorkspace(workspaceId)
    const rows = opts.sessionId
      ? (db
          .prepare('select body from context_packets where session_id = ? order by window_start, created_at, id')
          .all(opts.sessionId) as { body: string }[])
      : (db.prepare('select body from context_packets order by window_start, created_at, id').all() as { body: string }[])
    let packets = rows.map((row) => JSON.parse(row.body) as ContextPacket)
    if (!opts.includeSuperseded) {
      const superseded = new Set(packets.map((p) => p.supersedes).filter((id): id is string => id !== undefined))
      packets = packets.filter((p) => !superseded.has(p.id))
    }
    if (opts.from !== undefined) packets = packets.filter((p) => p.windowEnd > opts.from!)
    if (opts.to !== undefined) packets = packets.filter((p) => p.windowStart < opts.to!)
    if (opts.entityId !== undefined) packets = packets.filter((p) => p.candidates.some((c) => c.entityId === opts.entityId))
    return packets
  }

  /**
   * Append one hierarchical Summary (#177) to its workspace's OWN sqlite file. Summaries are APPEND-ONLY
   * derived records: a revision never mutates its predecessor — it is a new row whose `supersedes` links the
   * chain. `insert or replace` keyed on the (prose-excluding) content-derived id makes a degraded→prose
   * upgrade over the SAME children replace in place, and a changed child set append a new revision. Contract-
   * validated before write (the saveContextPacket idiom). Only this path writes summaries.
   */
  saveSummary(summary: Summary): Summary {
    this.ensureWorkspace({ id: summary.workspaceId, name: summary.workspaceId })
    const db = this.openWorkspace(summary.workspaceId)
    const { level, windowStart } = summary
    if (!Value.Check(SummarySchema, summary)) {
      throw new Error(`summary failed contract validation: ${level} ${windowStart}`)
    }
    db.prepare(
      'insert or replace into summaries (id, session_id, level, window_start, window_end, created_at, body) values (?, ?, ?, ?, ?, ?, ?)',
    ).run(summary.id, summary.sessionId ?? null, summary.level, summary.windowStart, summary.windowEnd, summary.createdAt, JSON.stringify(summary))
    return summary
  }

  /**
   * Query a workspace's Summaries (#177) — the axes the issue names: workspace (the DB), session, level, and
   * time window (`from`/`to` keep summaries whose window INTERSECTS the range). Default reads return each
   * interval's LIVE chain head only; superseded revisions stay retrievable with `includeSuperseded`.
   * Supersession is resolved over the whole workspace/level scope BEFORE the time filter, so a filtered read
   * can never present a superseded summary as live. Unknown workspace reads as [] (mirrors listContextPackets).
   */
  listSummaries(
    workspaceId: string,
    opts: { sessionId?: string; level?: SummaryLevel; from?: string; to?: string; includeSuperseded?: boolean } = {},
  ): Summary[] {
    if (!this.all().some((ws) => ws.id === workspaceId)) return []
    const db = this.openWorkspace(workspaceId)
    const rows = opts.sessionId
      ? (db.prepare('select body from summaries where session_id = ? order by window_start, created_at, id').all(opts.sessionId) as { body: string }[])
      : (db.prepare('select body from summaries order by window_start, created_at, id').all() as { body: string }[])
    let summaries = rows.map((row) => JSON.parse(row.body) as Summary)
    if (opts.level !== undefined) summaries = summaries.filter((s) => s.level === opts.level)
    if (!opts.includeSuperseded) {
      const superseded = new Set(summaries.map((s) => s.supersedes).filter((id): id is string => id !== undefined))
      summaries = summaries.filter((s) => !superseded.has(s.id))
    }
    if (opts.from !== undefined) summaries = summaries.filter((s) => s.windowEnd > opts.from!)
    if (opts.to !== undefined) summaries = summaries.filter((s) => s.windowStart < opts.to!)
    return summaries
  }

  /** List a workspace's OcrResults (default all), oldest first; `sessionId` narrows to one session. */
  listOcrResults(workspaceId: string, sessionId?: string): OcrResult[] {
    const db = this.openWorkspace(workspaceId)
    const rows = sessionId
      ? (db.prepare('select body from ocr_results where session_id = ? order by created_at').all(sessionId) as { body: string }[])
      : (db.prepare('select body from ocr_results order by created_at').all() as { body: string }[])
    return rows.map((row) => JSON.parse(row.body) as OcrResult)
  }

  /**
   * Persist a prepared draft (the Act pass output) to its workspace's OWN sqlite file. Workspace
   * created on demand, mirroring saveDistillate/saveMoment; idempotent per draft id. Only this path
   * writes drafts (DB-handle hard rule: the Actor asks store to write).
   */
  saveDraft(draft: Draft): Draft {
    this.ensureWorkspace({ id: draft.workspaceId, name: draft.workspaceId })
    const db = this.openWorkspace(draft.workspaceId)
    db.prepare('insert or replace into drafts (id, session_id, created_at, body) values (?, ?, ?, ?)').run(
      draft.id,
      draft.sessionId,
      draft.createdAt,
      JSON.stringify(draft),
    )
    return draft
  }

  /** List a workspace's prepared drafts (default all), oldest first; `sessionId` narrows to one session. */
  listDrafts(workspaceId: string, sessionId?: string): Draft[] {
    const db = this.openWorkspace(workspaceId)
    const rows = sessionId
      ? (db.prepare('select body from drafts where session_id = ? order by created_at').all(sessionId) as { body: string }[])
      : (db.prepare('select body from drafts order by created_at').all() as { body: string }[])
    return rows.map((row) => JSON.parse(row.body) as Draft)
  }

  /**
   * List a workspace's to-do LISTS (latest version of each session's document), narrowed to a session
   * when `sessionId` is given. Unlike drafts/moments, to-do lists are DOCUMENTS: they live in the
   * global _meta.db keyed by session id (workspace on the body — the store `TodoDocuments` writes,
   * `act/todo.ts`), NOT in the per-workspace record DBs. So the read walks `layouts` and filters by the
   * body's `workspaceId`/`sessionId`. Unknown workspace reads as [] (mirrors listPins) — never an error.
   * The `'todo-list'` kind mirrors `TodoDocuments`' private constant; kept in sync by the contract shape.
   */
  listTodos(workspaceId: string, sessionId?: string): TodoList[] {
    return this.layouts
      .latestOfKind<TodoList>('todo-list')
      .map((doc) => doc.body)
      .filter((list) => list.workspaceId === workspaceId && (sessionId === undefined || list.sessionId === sessionId))
  }

  /**
   * Persist a session record to its workspace's OWN sqlite file (a session lives in its workspace's
   * DB; DB-handle hard rule: only store/ writes). Workspace is created on demand, mirroring
   * saveDistillate. Idempotent per session id (insert or replace) — start writes it, end re-writes
   * it with endedAt stamped. started_at/ended_at are lifted into columns for ordering + the live
   * filter; ended_at null ⇔ the session is still live.
   */
  saveSession(session: Session): Session {
    this.ensureWorkspace({ id: session.workspaceId, name: session.workspaceId })
    const db = this.openWorkspace(session.workspaceId)
    db.prepare('insert or replace into sessions (id, started_at, ended_at, body) values (?, ?, ?, ?)').run(
      session.id,
      session.startedAt,
      session.endedAt ?? null,
      JSON.stringify(session),
    )
    return session
  }

  getSession(workspaceId: string, id: string): Session | undefined {
    if (!this.all().some((ws) => ws.id === workspaceId)) return undefined
    const db = this.openWorkspace(workspaceId)
    const row = db.prepare('select body from sessions where id = ?').get(id) as { body: string } | undefined
    return row ? (JSON.parse(row.body) as Session) : undefined
  }

  /** List a workspace's sessions, most recently started first; `live` narrows to unended sessions. */
  listSessions(workspaceId: string, opts: { live?: boolean } = {}): Session[] {
    if (!this.all().some((ws) => ws.id === workspaceId)) return []
    const db = this.openWorkspace(workspaceId)
    const sql = opts.live
      ? 'select body from sessions where ended_at is null order by started_at desc'
      : 'select body from sessions order by started_at desc'
    return (db.prepare(sql).all() as { body: string }[]).map((row) => JSON.parse(row.body) as Session)
  }

  /** The single live session for a workspace (the HUD's Now line keys off it), or undefined. */
  liveSession(workspaceId: string): Session | undefined {
    return this.listSessions(workspaceId, { live: true })[0]
  }

  /**
   * Find a session by id across all workspaces — session ids are globally unique (uuid), and the
   * end route addresses a session without its workspace. Returns the record (which carries its own
   * workspaceId), so callers can then saveSession it back to the right DB.
   */
  findSession(id: string): Session | undefined {
    for (const workspace of this.all()) {
      const session = this.getSession(workspace.id, id)
      if (session) return session
    }
    return undefined
  }

  /**
   * List a session's APPEND-ONLY episode titlings (#211), oldest first — the naming history behind its
   * resolved title. Ordered by `seq` (append order), not `created_at`: same-millisecond titlings would
   * otherwise be unorderable. Unknown workspace reads as [] (mirrors listSessions) — never an error.
   */
  listSessionTitlings(workspaceId: string, sessionId: string): SessionTitling[] {
    if (!this.all().some((ws) => ws.id === workspaceId)) return []
    const db = this.openWorkspace(workspaceId)
    const rows = db.prepare('select body from session_titlings where session_id = ? order by seq').all(sessionId) as { body: string }[]
    return rows.map((row) => JSON.parse(row.body) as SessionTitling)
  }

  /**
   * The effective title of a session (#211) — resolved across its append-only titlings by the sovereignty
   * rule: the latest USER titling wins (a human's name is never clobbered by a later derivation), else the
   * latest DERIVED titling, else `undefined` (no titling yet — the caller supplies an honest fallback, never
   * a raw id). Pure over the titling list; the source of truth is the append-only table, not Session.title.
   */
  static resolveTitle(titlings: readonly SessionTitling[]): string | undefined {
    let latestUser: SessionTitling | undefined
    let latestDerived: SessionTitling | undefined
    // titlings arrive oldest-first (seq order), so a later match overwrites — the last one wins per source.
    for (const t of titlings) {
      if (t.source === 'user') latestUser = t
      else if (t.source === 'derived') latestDerived = t
    }
    return (latestUser ?? latestDerived)?.title
  }

  /**
   * The latest DERIVED title for a session, if any (#211) — the judge reads it to avoid appending a
   * duplicate titling every pass: a re-derivation only appends when the derived name actually CHANGES.
   */
  latestDerivedTitle(workspaceId: string, sessionId: string): string | undefined {
    let latest: string | undefined
    for (const t of this.listSessionTitlings(workspaceId, sessionId)) if (t.source === 'derived') latest = t.title
    return latest
  }

  /**
   * Append a titling and MATERIALISE the session's resolved title (#211). The titling row is the durable
   * append-only truth; Session.title is a cache of the resolution so every existing surface that reads
   * `session.title` shows the name with no per-read resolution. Returns the updated Session (for the
   * `session.titled` broadcast), or undefined when no session record exists yet (the titling is still
   * persisted — a session created later will resolve it). Idempotent on the materialised value: if the
   * resolution is unchanged, the session is returned without a rewrite.
   */
  recordSessionTitling(titling: SessionTitling): Session | undefined {
    this.ensureWorkspace({ id: titling.workspaceId, name: titling.workspaceId })
    const db = this.openWorkspace(titling.workspaceId)
    db.prepare('insert or replace into session_titlings (id, session_id, created_at, source, body) values (?, ?, ?, ?, ?)').run(
      titling.id,
      titling.sessionId,
      titling.createdAt,
      titling.source,
      JSON.stringify(titling),
    )
    const session = this.getSession(titling.workspaceId, titling.sessionId)
    if (!session) return undefined
    const resolved = WorkspaceRegistry.resolveTitle(this.listSessionTitlings(titling.workspaceId, titling.sessionId))
    if (resolved === undefined || resolved === session.title) return session
    return this.saveSession({ ...session, title: resolved })
  }

  /**
   * Persist an extracted moment to its workspace's OWN sqlite file (DB-handle hard rule: only
   * store/ writes; the distiller asks store to write). Workspace is created on demand, mirroring
   * saveDistillate. Idempotent per moment id (insert or replace).
   */
  saveMoment(moment: Moment): Moment {
    this.ensureWorkspace({ id: moment.workspaceId, name: moment.workspaceId })
    const db = this.openWorkspace(moment.workspaceId)
    db.prepare('insert or replace into moments (id, session_id, at, kind, body) values (?, ?, ?, ?, ?)').run(
      moment.id,
      moment.sessionId,
      moment.at,
      moment.kind,
      JSON.stringify(moment),
    )
    return moment
  }

  listMoments(workspaceId: string, sessionId?: string): Moment[] {
    const db = this.openWorkspace(workspaceId)
    const rows = sessionId
      ? (db.prepare('select body from moments where session_id = ? order by at').all(sessionId) as { body: string }[])
      : (db.prepare('select body from moments order by at').all() as { body: string }[])
    return rows.map((row) => JSON.parse(row.body) as Moment)
  }

  /**
   * Resolve-and-merge an entity mention into ONE canonical record per entity — upsert, not append. The
   * MATCH STEP is the scored resolver (#72, `index/resolve.ts`): exact normalized equality is no longer
   * required — an ASR-mangled mention ("pie dev" for `pi.dev`) can find its record by phonetic/fuzzy score
   * over the record's name, aliases, AND stored heardAs variants. Resolution order:
   *
   *   1. SOVEREIGN OVERRIDE SHORT-CIRCUIT (preserved from #73, tested): if a record's `overrides[]` PINS a
   *      surface form the mention carries, that record wins DETERMINISTICALLY, before any scoring — an
   *      overridden mapping is never re-asked or re-scored against the rejected rival. Overrides outrank
   *      scores, period.
   *   2. Otherwise the resolver scores same-kind candidates. `auto`/`provisional` band ⇒ LINK to the
   *      winner; `new` band ⇒ CREATE a fresh record for the mention.
   *
   * On a LINK: bump `mentions`, advance `lastSeen`, union model-declared aliases, append provenance/moment
   * refs, grow the sighting + heardAs trails. On CREATE: store-stamp id + firstSeen. EVERY resolution (link
   * or create) appends an `EntityResolution` (score + band + components + rival, if any) to the record —
   * the inspectable "why did this land here" trail. A provisional/ambiguous resolution stamps `state:
   * 'provisional'` + `confidence` + `ambiguity` (the #66 micro-state); a NEW create is stamped provisional
   * only when its best same-kind rival landed near the provisional band (#94 create-marking rule); a clean
   * auto-link, a first-of-its-kind create, and an unrelated create with no near rival stay SILENT (state
   * absent). A user-confirmed record is never downgraded. The merged record is contract-validated before
   * write. Only this path writes entities.
   */
  upsertEntity(input: EntityUpsert): Entity {
    this.ensureWorkspace({ id: input.workspaceId, name: input.workspaceId })
    const db = this.openWorkspace(input.workspaceId)
    const nameKey = normalizeEntityName(input.name)
    const aliases = (input.aliases ?? []).map((alias) => alias.trim()).filter((alias) => alias.length > 0)

    const { existing, resolution, hadCandidates, overridePinned } = this.resolveMention(db, input, nameKey, aliases)
    // Exact when the mention's normalized name is already a known key of the matched record — governs
    // whether the heard name becomes an alias (below). A FUZZY link keeps the corrupted heard form out of
    // aliases (it lands in heardAs instead, via the caller's input.heardAs — the write-back on a match).
    const matchedExactly =
      existing !== undefined &&
      new Set([normalizeEntityName(existing.name), ...existing.aliases.map(normalizeEntityName)]).has(nameKey)

    const base: Entity = existing
      ? this.mergeEntity(existing, input, aliases, matchedExactly)
      : {
          id: randomUUID(),
          workspaceId: input.workspaceId,
          kind: input.kind,
          name: input.name.trim(),
          aliases,
          momentRefs: [...new Set(input.momentRefs ?? [])],
          outboundCount: 0,
          mentions: 1,
          ...(input.provenance !== undefined ? { provenance: [input.provenance] } : {}),
          ...(this.newSightings(input).length > 0 ? { sightings: this.newSightings(input) } : {}),
          ...(input.heardAs !== undefined ? { heardAs: [input.heardAs] } : {}),
          firstSeen: input.seenAt,
          lastSeen: input.seenAt,
        }

    // #74: a cross-source corroborating sighting (an independent sense named the same concept in-window) is
    // the one signal strong enough to CONFIRM a link with no user ask. Its multiplier already lifted the
    // score through the resolver's band decision (never a forked promotion path); its presence here stamps
    // the confirmed micro-state.
    const corroborated = input.crossSighting !== undefined
    const entity = this.stampResolution(base, resolution, input, existing !== undefined, hadCandidates, overridePinned, corroborated)

    if (!Value.Check(EntitySchema, entity)) {
      throw new Error(`entity failed contract validation: ${input.kind} "${input.name}"`)
    }
    db.prepare('insert or replace into entities (id, kind, name_key, last_seen, body) values (?, ?, ?, ?, ?)').run(
      entity.id,
      entity.kind,
      normalizeEntityName(entity.name),
      entity.lastSeen,
      JSON.stringify(entity),
    )
    return entity
  }

  /** Append moment ids to an entity's momentRefs (refs linking writes back both directions). */
  addEntityMomentRefs(workspaceId: string, entityId: string, momentIds: readonly string[]): Entity | undefined {
    const db = this.openWorkspace(workspaceId)
    const row = db.prepare('select body from entities where id = ?').get(entityId) as { body: string } | undefined
    if (!row) return undefined
    const entity = JSON.parse(row.body) as Entity
    entity.momentRefs = [...new Set([...entity.momentRefs, ...momentIds])]
    db.prepare('update entities set body = ? where id = ?').run(JSON.stringify(entity), entityId)
    return entity
  }

  listEntities(workspaceId: string): Entity[] {
    const db = this.openWorkspace(workspaceId)
    const rows = db.prepare('select body from entities order by last_seen desc, name_key').all() as { body: string }[]
    return rows.map((row) => JSON.parse(row.body) as Entity)
  }

  /**
   * Record a SOVEREIGN user correction on an entity (#73) — the durable, append-only override the
   * resolver (#72) must never re-ask about or re-score away. It appends the `EntityOverride`, and
   * because a user override outranks any machine score it stamps the record `state: 'confirmed'` and
   * `confidence: 1`. When the override pins a surface form (`pinnedName`), that form is unioned into the
   * entity's aliases so future mentions of it resolve HERE — and `findEntity` prefers this pinned
   * mapping over any rival, making the mapping durable across subsequent upserts (reads honor it). The
   * merged record is contract-validated before write (last line of defense, mirroring upsertEntity).
   * Only this path writes overrides. Returns the updated entity, or undefined for an unknown id.
   *
   * The override SETTLES the question: the record's `ambiguity` (the plausible-rival marker the #75 clarify
   * affordance keys off) is CLEARED, per the EntityAmbiguity contract ("cleared once a user override settles
   * the question") — so the ≟ ask does not re-appear on a subsequent load once the user answered.
   */
  overrideEntity(workspaceId: string, entityId: string, override: EntityOverride): Entity | undefined {
    const db = this.openWorkspace(workspaceId)
    const row = db.prepare('select body from entities where id = ?').get(entityId) as { body: string } | undefined
    if (!row) return undefined
    const current = JSON.parse(row.body) as Entity
    const aliases = [...current.aliases]
    if (override.pinnedName !== undefined) {
      const pin = override.pinnedName.trim()
      const known = new Set([normalizeEntityName(current.name), ...aliases.map(normalizeEntityName)])
      if (pin.length > 0 && !known.has(normalizeEntityName(pin))) aliases.push(pin)
    }
    const { ambiguity: _settled, ...rest } = current
    const entity: Entity = {
      ...rest,
      aliases,
      overrides: [...(current.overrides ?? []), override],
      state: 'confirmed',
      confidence: 1,
    }
    if (!Value.Check(EntitySchema, entity)) throw new Error(`overridden entity failed contract validation: ${entityId}`)
    db.prepare('insert or replace into entities (id, kind, name_key, last_seen, body) values (?, ?, ?, ?, ?)').run(
      entity.id,
      entity.kind,
      normalizeEntityName(entity.name),
      entity.lastSeen,
      JSON.stringify(entity),
    )
    return entity
  }

  /**
   * SETTLE an entity's ambiguity WITHOUT confirming it — the #75 companion to `overrideEntity` for the
   * losing side of a `disambiguate` verdict. When the user says the ambiguous mention actually meant the
   * RIVAL, the override is written on the rival (the truth), and THIS clears the once-linked entity's
   * `ambiguity` marker so its ≟ ask does not re-appear either. It leaves `state`/`confidence` untouched
   * (the record is not confirmed — the mention simply was not it), only dropping the reviewable marker.
   * Returns the updated entity, or undefined for an unknown id (mirrors overrideEntity).
   */
  clearEntityAmbiguity(workspaceId: string, entityId: string): Entity | undefined {
    const db = this.openWorkspace(workspaceId)
    const row = db.prepare('select body from entities where id = ?').get(entityId) as { body: string } | undefined
    if (!row) return undefined
    const current = JSON.parse(row.body) as Entity
    if (current.ambiguity === undefined) return current // already settled — idempotent no-op
    const { ambiguity: _cleared, ...rest } = current
    const entity = rest as Entity
    if (!Value.Check(EntitySchema, entity)) throw new Error(`entity failed contract validation clearing ambiguity: ${entityId}`)
    db.prepare('insert or replace into entities (id, kind, name_key, last_seen, body) values (?, ?, ?, ?, ?)').run(
      entity.id,
      entity.kind,
      normalizeEntityName(entity.name),
      entity.lastSeen,
      JSON.stringify(entity),
    )
    return entity
  }

  /**
   * Persist a pin record to its workspace's OWN sqlite file (P4D pinned canon; DB-handle hard rule: only
   * store/ writes). A pin is a WORKSPACE-LEVEL record like an entity (NOT session-keyed) — it is pinned
   * canon for the whole workspace, so it is not part of a session move (moveSession untouched). Workspace
   * created on demand, idempotent per id, contract-validated before write (mirrors upsertEntity's last line
   * of defense). The ingest lifecycle (index/ingest) asks store to write; store owns the id it was handed.
   */
  savePin(pin: Pin): Pin {
    this.ensureWorkspace({ id: pin.workspaceId, name: pin.workspaceId })
    const db = this.openWorkspace(pin.workspaceId)
    const { kind, title } = pin
    if (!Value.Check(PinSchema, pin)) throw new Error(`pin failed contract validation: ${kind} "${title}"`)
    db.prepare('insert or replace into pins (id, kind, created_at, body) values (?, ?, ?, ?)').run(
      pin.id,
      pin.kind,
      pin.createdAt,
      JSON.stringify(pin),
    )
    return pin
  }

  getPin(workspaceId: string, id: string): Pin | undefined {
    if (!this.all().some((ws) => ws.id === workspaceId)) return undefined
    const db = this.openWorkspace(workspaceId)
    const row = db.prepare('select body from pins where id = ?').get(id) as { body: string } | undefined
    return row ? (JSON.parse(row.body) as Pin) : undefined
  }

  /** List a workspace's pins, most recently created first; unknown workspace reads as [] (mirrors listEntities). */
  listPins(workspaceId: string): Pin[] {
    if (!this.all().some((ws) => ws.id === workspaceId)) return []
    const db = this.openWorkspace(workspaceId)
    const rows = db.prepare('select body from pins order by created_at desc').all() as { body: string }[]
    return rows.map((row) => JSON.parse(row.body) as Pin)
  }

  /**
   * Persist page-anchored pin chunks to their workspace's OWN sqlite file, in ONE atomic transaction
   * (idempotent per chunk id — a re-ingest with the same deterministic ids replaces in place). Each chunk
   * is contract-validated before write. Only this path writes pin chunks (DB-handle hard rule).
   */
  savePinChunks(chunks: readonly PinChunk[]): PinChunk[] {
    if (chunks.length === 0) return []
    const workspaceId = chunks[0]!.workspaceId
    this.ensureWorkspace({ id: workspaceId, name: workspaceId })
    const db = this.openWorkspace(workspaceId)
    const insert = db.prepare('insert or replace into pin_chunks (id, pin_id, ordinal, page, body) values (?, ?, ?, ?, ?)')
    db.transaction(() => {
      for (const chunk of chunks) {
        const { id, pinId, ordinal, page } = chunk
        if (!Value.Check(PinChunkSchema, chunk)) throw new Error(`pin chunk failed contract validation: ${pinId} #${ordinal}`)
        insert.run(id, pinId, ordinal, page ?? null, JSON.stringify(chunk))
      }
    })()
    return [...chunks]
  }

  /** A pin's chunks in stable ordinal order (the citation order); `pinId` omitted lists the workspace's all. */
  listPinChunks(workspaceId: string, pinId?: string): PinChunk[] {
    if (!this.all().some((ws) => ws.id === workspaceId)) return []
    const db = this.openWorkspace(workspaceId)
    const rows = pinId
      ? (db.prepare('select body from pin_chunks where pin_id = ? order by ordinal').all(pinId) as { body: string }[])
      : (db.prepare('select body from pin_chunks order by pin_id, ordinal').all() as { body: string }[])
    return rows.map((row) => JSON.parse(row.body) as PinChunk)
  }

  /** Drop a pin's chunks (a re-ingest clears the old page anchors before writing fresh ones). Returns the count removed. */
  deletePinChunks(workspaceId: string, pinId: string): number {
    if (!this.all().some((ws) => ws.id === workspaceId)) return 0
    const db = this.openWorkspace(workspaceId)
    return db.prepare('delete from pin_chunks where pin_id = ?').run(pinId).changes
  }

  /**
   * Append one turn to the workspace's PERSISTENT app-scoped chat thread (the Ask face's ask-history —
   * owner canon 2026-07-11: chat is one persistent thread per workspace; upstream glass left this
   * vestigial). Workspace-level like a pin (NOT session-keyed — the thread outlives sessions, so it is
   * no part of a session move), workspace created on demand, contract-validated before write (the
   * savePin last-line-of-defense idiom). Order is the store-stamped autoincrement `seq`, not the
   * timestamp — a user+assistant pair lands in the same millisecond.
   */
  appendChatTurn(workspaceId: string, turn: ChatTurn, at: string = new Date().toISOString()): ChatTurn {
    this.ensureWorkspace({ id: workspaceId, name: workspaceId })
    const db = this.openWorkspace(workspaceId)
    const { role } = turn
    if (!Value.Check(ChatTurnSchema, turn)) throw new Error(`chat turn failed contract validation: ${role}`)
    db.prepare('insert into chat_turns (created_at, body) values (?, ?)').run(at, JSON.stringify(turn))
    return turn
  }

  /**
   * The workspace's persisted chat thread, OLDEST turn first (the order a thread renders). `limit` keeps
   * the most recent tail (the honest cap the /chat/history route discloses via `truncated`); absent ⇒ the
   * whole thread. Unknown workspace reads as [] (mirrors listPins) — asking is never an error.
   */
  listChatTurns(workspaceId: string, limit?: number): ChatTurn[] {
    if (!this.all().some((ws) => ws.id === workspaceId)) return []
    const db = this.openWorkspace(workspaceId)
    const rows =
      limit !== undefined
        ? (db.prepare('select body from chat_turns order by seq desc limit ?').all(limit) as { body: string }[]).reverse()
        : (db.prepare('select body from chat_turns order by seq').all() as { body: string }[])
    return rows.map((row) => JSON.parse(row.body) as ChatTurn)
  }

  /** The full persisted turn count for a workspace (the `total` the honest history cap is disclosed against). */
  countChatTurns(workspaceId: string): number {
    if (!this.all().some((ws) => ws.id === workspaceId)) return 0
    const db = this.openWorkspace(workspaceId)
    return (db.prepare('select count(*) as n from chat_turns').get() as { n: number }).n
  }

  /**
   * Retroactively move a session — and EVERYTHING keyed to it — from one workspace DB to another
   * (Phase 3, the correction loop the router's mistakes require; IMPLEMENTATION §3 risk register).
   * This is the ONLY module that opens DB handles, so route/ asks store to move a session (dep rule 2).
   *
   * WHAT MOVES: the session record (with the authoritative manual correction appended atomically), its
   * distillates, moments, drafts, OcrResults, SttSegments, and ContextPackets (the whole append-only
   * chain, superseded revisions included), plus
   * the session-scoped document state in _meta.db: complete FieldValue and SessionAnnotation histories,
   * GuardHolds, and the current TodoList. ENTITIES are workspace-level aggregates, not session-keyed,
   * so they are re-aggregated (see below), never blindly copied.
   *
   * CRASH-SAFETY (v0, honest): sqlite transactions are per-file, so a move across three files cannot be
   * one ACID transaction. The guarantee instead: (1) each per-file mutation is atomic (better-sqlite3
   * `.transaction`); (2) order is destination-writes FIRST, then source-deletes; (3) every step is
   * IDEMPOTENT — entity contributions union/subtract by distillate id (a set), record copies are
   * insert-or-replace by id. A crash between the two phases leaves the session in BOTH workspaces — a
   * duplicate DETECTABLE via `sessionWorkspaces(id).length > 1` — and RESOLVED by re-running the same
   * move: the destination re-write is a no-op and the source-delete completes, converging to one copy.
   * A completed move re-run is also a no-op (source empty ⇒ returns the destination session).
   * `stopAfterCopy` is a test-only seam that stages exactly that mid-move crash.
   *
   * ENTITY SEMANTICS (v0 — deterministic, no llm, cannot corrupt the destination or lie in the source):
   * - Moved moments keep their text; their `refs` are REMAPPED to the destination entity of the same
   *   (kind, normalized-name), else DROPPED — a ref to an entity that STAYS in the source has no honest
   *   destination target and we never fabricate one.
   * - The moved session's entity CONTRIBUTIONS are the source entities carrying provenance whose
   *   distillateId belongs to a moved distillate. They are UPSERTED into the destination by (kind,
   *   normalized-name), unioning provenance by distillateId (so mentions never double-count on a re-run)
   *   and unioning the surviving moment refs.
   * - In the SOURCE each such entity's moved-distillate provenance is SUBTRACTED (mentions decremented,
   *   moved moment refs removed); an entity that reaches ZERO mentions is DELETED — a zero-mention ghost
   *   would silently lie about evidence the source no longer holds.
   */
  moveSession(sessionId: string, fromWorkspaceId: string, toWorkspaceId: string, opts: { stopAfterCopy?: boolean } = {}): Session {
    if (fromWorkspaceId === toWorkspaceId) throw new Error('moveSession: source and destination are the same workspace')
    const session = this.getSession(fromWorkspaceId, sessionId)
    if (!session) {
      const dest = this.getSession(toWorkspaceId, sessionId)
      if (dest && dest.reroutedFrom === fromWorkspaceId) {
        // A crash can land after the source workspace DB was deleted but before the global document
        // cleanup committed. Re-running the move must therefore converge that final _meta.db phase too.
        this.copySessionLayoutState(sessionId, fromWorkspaceId, toWorkspaceId)
        this.removeSessionLayoutSourceState(sessionId, fromWorkspaceId)
        return dest
      }
      throw new Error(`moveSession: no session ${sessionId} in workspace ${fromWorkspaceId}`)
    }
    this.ensureWorkspace({ id: toWorkspaceId, name: toWorkspaceId })

    const distillates = this.listDistillates(fromWorkspaceId, sessionId)
    const moments = this.listMoments(fromWorkspaceId, sessionId)
    const drafts = this.listDrafts(fromWorkspaceId, sessionId)
    const ocrResults = this.listOcrResults(fromWorkspaceId, sessionId)
    const sttSegments = this.listSttSegments(fromWorkspaceId, sessionId)
    // #176: the WHOLE append-only packet chain moves (includeSuperseded) — dropping superseded revisions
    // would silently rewrite history the chain promises to keep.
    const contextPackets = this.listContextPackets(fromWorkspaceId, { sessionId, includeSuperseded: true })
    // #177: the WHOLE append-only summary chain moves too (includeSuperseded), for the same reason as packets.
    const summaries = this.listSummaries(fromWorkspaceId, { sessionId, includeSuperseded: true })
    const movedDistillateIds = new Set(distillates.map((d) => d.id))
    const movedMomentIds = new Set(moments.map((m) => m.id))

    // The moved session's entity contributions in the source: entities whose provenance names a moved distillate.
    const sourceEntities = this.listEntities(fromWorkspaceId)
    const contributions: Contribution[] = []
    for (const entity of sourceEntities) {
      if (!entity.provenance) continue
      const provenance = entity.provenance.filter((p) => p.distillateId !== undefined && movedDistillateIds.has(p.distillateId))
      if (provenance.length === 0) continue
      contributions.push({
        sourceId: entity.id,
        kind: entity.kind,
        name: entity.name,
        aliases: entity.aliases,
        provenance,
        momentRefs: entity.momentRefs.filter((ref) => movedMomentIds.has(ref)),
        firstSeen: entity.firstSeen,
        lastSeen: entity.lastSeen,
      })
    }

    // Attribution is part of the destination record written in phase 1, not a route-layer follow-up.
    // Therefore a crash after this move returns cannot leave a rerouted session without the user's
    // authoritative correction. A retry while the source copy still exists derives the same destination
    // body from the unchanged source, so it replaces rather than duplicates this evidence entry.
    const movedSession: Session = {
      ...session,
      workspaceId: toWorkspaceId,
      reroutedFrom: fromWorkspaceId,
      attribution: {
        evidence: [
          ...session.attribution.evidence,
          { kind: 'manual', detail: `rerouted from workspace ${fromWorkspaceId} by user`, weight: 1 },
        ],
        confidence: 1,
      },
    }

    // PHASE 1 — destination writes, idempotent, one atomic per-file transaction.
    const toDb = this.openWorkspace(toWorkspaceId)
    const sourceToDestEntity = new Map<string, string>()
    toDb.transaction(() => {
      for (const c of contributions) sourceToDestEntity.set(c.sourceId, this.mergeMovedEntity(toDb, toWorkspaceId, c))
      for (const moment of moments) {
        const refs = [...new Set(moment.refs.map((r) => sourceToDestEntity.get(r)).filter((id): id is string => id !== undefined))]
        const moved: Moment = { ...moment, workspaceId: toWorkspaceId, refs }
        toDb.prepare('insert or replace into moments (id, session_id, at, kind, body) values (?, ?, ?, ?, ?)').run(moved.id, moved.sessionId, moved.at, moved.kind, JSON.stringify(moved))
      }
      for (const distillate of distillates) {
        const moved: Distillate = { ...distillate, workspaceId: toWorkspaceId }
        toDb.prepare('insert or replace into distillates (id, session_id, created_at, body) values (?, ?, ?, ?)').run(moved.id, moved.sessionId, moved.createdAt, JSON.stringify(moved))
      }
      for (const draft of drafts) {
        const moved: Draft = { ...draft, workspaceId: toWorkspaceId }
        toDb.prepare('insert or replace into drafts (id, session_id, created_at, body) values (?, ?, ?, ?)').run(moved.id, moved.sessionId, moved.createdAt, JSON.stringify(moved))
      }
      for (const result of ocrResults) {
        const moved: OcrResult = { ...result, workspaceId: toWorkspaceId }
        toDb.prepare('insert or replace into ocr_results (id, session_id, created_at, body) values (?, ?, ?, ?)').run(moved.id, moved.sessionId, moved.createdAt, JSON.stringify(moved))
      }
      for (const segment of sttSegments) {
        const moved: SttSegment = { ...segment, workspaceId: toWorkspaceId }
        toDb.prepare('insert or replace into stt_segments (id, session_id, created_at, body) values (?, ?, ?, ?)').run(moved.id, moved.sessionId, moved.createdAt, JSON.stringify(moved))
      }
      for (const packet of contextPackets) {
        // The id stays stable across the move (an id is opaque once minted); only the workspace scope is
        // rewritten, so a destination rebuild converges on the moved chain instead of forking a new one.
        const moved: ContextPacket = { ...packet, workspaceId: toWorkspaceId }
        toDb.prepare('insert or replace into context_packets (id, session_id, window_start, window_end, created_at, body) values (?, ?, ?, ?, ?, ?)').run(moved.id, moved.sessionId, moved.windowStart, moved.windowEnd, moved.createdAt, JSON.stringify(moved))
      }
      // #211: the append-only episode titlings move with the session (its naming history), workspace scope
      // rewritten; ids stay stable (opaque once minted), so a retry converges instead of duplicating.
      for (const titling of this.listSessionTitlings(fromWorkspaceId, sessionId)) {
        const moved: SessionTitling = { ...titling, workspaceId: toWorkspaceId }
        toDb.prepare('insert or replace into session_titlings (id, session_id, created_at, source, body) values (?, ?, ?, ?, ?)').run(moved.id, moved.sessionId, moved.createdAt, moved.source, JSON.stringify(moved))
      }
      for (const summary of summaries) {
        // The id stays stable across the move (opaque once minted); only the workspace scope is rewritten, so
        // a destination rebuild converges on the moved chain instead of forking a new one (as packets do).
        const moved: Summary = { ...summary, workspaceId: toWorkspaceId }
        toDb.prepare('insert or replace into summaries (id, session_id, level, window_start, window_end, created_at, body) values (?, ?, ?, ?, ?, ?, ?)').run(moved.id, moved.sessionId ?? null, moved.level, moved.windowStart, moved.windowEnd, moved.createdAt, JSON.stringify(moved))
      }
      toDb.prepare('insert or replace into sessions (id, started_at, ended_at, body) values (?, ?, ?, ?)').run(movedSession.id, movedSession.startedAt, movedSession.endedAt ?? null, JSON.stringify(movedSession))
    })()

    // _meta.db is a third sqlite file in the move. Copy destination layout state before touching the
    // source, in one transaction, and preserve the exact audit versions/timestamps of record histories.
    this.copySessionLayoutState(sessionId, fromWorkspaceId, toWorkspaceId)

    // Test seam: the source workspace DB and source-keyed histories stay intact. The globally keyed todo
    // has only one current owner, so its copy revision already points at the destination.
    if (opts.stopAfterCopy) return movedSession

    // PHASE 2 — source subtraction + deletes, idempotent, one atomic per-file transaction.
    const fromDb = this.openWorkspace(fromWorkspaceId)
    fromDb.transaction(() => {
      for (const entity of sourceEntities) this.subtractMovedFromEntity(fromDb, entity, movedDistillateIds, movedMomentIds)
      fromDb.prepare('delete from moments where session_id = ?').run(sessionId)
      fromDb.prepare('delete from distillates where session_id = ?').run(sessionId)
      fromDb.prepare('delete from drafts where session_id = ?').run(sessionId)
      fromDb.prepare('delete from ocr_results where session_id = ?').run(sessionId)
      fromDb.prepare('delete from stt_segments where session_id = ?').run(sessionId)
      fromDb.prepare('delete from context_packets where session_id = ?').run(sessionId)
      fromDb.prepare('delete from session_titlings where session_id = ?').run(sessionId)
      fromDb.prepare('delete from summaries where session_id = ?').run(sessionId)
      fromDb.prepare('delete from sessions where id = ?').run(sessionId)
    })()

    // Delete only source-owned session state. The TodoList is one globally-keyed document, so its latest
    // version already names the destination; its earlier source versions remain as editable history.
    this.removeSessionLayoutSourceState(sessionId, fromWorkspaceId)

    return movedSession
  }

  /**
   * Copy the session-scoped records that live in the global documents store. Field/annotation rows are
   * audit histories, so they retain their source version numbers and created_at values under remapped
   * deterministic keys. Holds and todos are current-state documents and append only when state changes.
   */
  private copySessionLayoutState(sessionId: string, fromWorkspaceId: string, toWorkspaceId: string): void {
    this.metaDb.transaction(() => {
      const fieldVersions = this.documentHistory<FieldValue>(
        FIELD_VALUE_KIND,
        `fv:${fromWorkspaceId}:${sessionId}:`,
        true,
      ).filter((doc) => doc.body.workspaceId === fromWorkspaceId && doc.body.sessionId === sessionId)
      for (const doc of fieldVersions) {
        const key = `fv:${toWorkspaceId}:${sessionId}:${doc.body.fieldId}`
        const moved: FieldValue = { ...doc.body, id: key, workspaceId: toWorkspaceId }
        this.insertHistoricalDocument(FIELD_VALUE_KIND, key, doc.version, moved, doc.createdAt)
      }

      const annotationVersions = this.documentHistory<SessionAnnotation>(
        SESSION_ANNOTATION_KIND,
        `oa:${fromWorkspaceId}:${sessionId}`,
      ).filter((doc) => doc.body.workspaceId === fromWorkspaceId && doc.body.sessionId === sessionId)
      for (const doc of annotationVersions) {
        const key = `oa:${toWorkspaceId}:${sessionId}`
        const moved: SessionAnnotation = { ...doc.body, id: key, workspaceId: toWorkspaceId }
        this.insertHistoricalDocument(SESSION_ANNOTATION_KIND, key, doc.version, moved, doc.createdAt)
      }

      const sourceHolds = this.layouts.getLatest<GuardHoldsDocument>(GUARD_HOLDS_KIND, fromWorkspaceId)?.body.holds ?? []
      const movedHolds = sourceHolds
        .filter((hold) => hold.sessionId === sessionId)
        .map((hold): GuardHold => ({ ...hold, workspaceId: toWorkspaceId }))
      if (movedHolds.length > 0) {
        const current = this.layouts.getLatest<GuardHoldsDocument>(GUARD_HOLDS_KIND, toWorkspaceId)?.body.holds ?? []
        const movedById = new Map(movedHolds.map((hold) => [hold.id, hold]))
        const currentIds = new Set(current.map((hold) => hold.id))
        // A user can resolve either visible copy between an interrupted phase 1 and recovery. Reconcile
        // rather than keeping the destination wholesale: resolved beats held, and a contradictory pair
        // resolves fail-closed to denied (see reconcileMovedGuardHold).
        const holds = [
          ...current.map((hold) => {
            const source = movedById.get(hold.id)
            return source === undefined ? hold : reconcileMovedGuardHold(hold, source)
          }),
          ...movedHolds.filter((hold) => !currentIds.has(hold.id)),
        ]
        const next: GuardHoldsDocument = { workspaceId: toWorkspaceId, holds }
        const currentDoc = this.layouts.getLatest<GuardHoldsDocument>(GUARD_HOLDS_KIND, toWorkspaceId)?.body
        if (JSON.stringify(currentDoc) !== JSON.stringify(next)) this.layouts.put(GUARD_HOLDS_KIND, toWorkspaceId, next)
      }

      const todo = this.layouts.getLatest<TodoList>(TODO_LIST_KIND, sessionId)?.body
      if (todo !== undefined && todo.sessionId === sessionId) {
        if (todo.workspaceId === fromWorkspaceId) {
          const moved: TodoList = { ...todo, workspaceId: toWorkspaceId, version: todo.version + 1 }
          this.layouts.put(TODO_LIST_KIND, sessionId, moved)
        } else if (todo.workspaceId !== toWorkspaceId) {
          throw new Error(
            `moveSession: to-do ${sessionId} belongs to workspace ${todo.workspaceId}, not ${fromWorkspaceId} or ${toWorkspaceId}`,
          )
        }
      }
    })()
  }

  /** Remove source-visible layout state only after both destination copies have committed. */
  private removeSessionLayoutSourceState(sessionId: string, fromWorkspaceId: string): void {
    this.metaDb.transaction(() => {
      const fieldKeys = new Set(
        this.documentHistory<FieldValue>(FIELD_VALUE_KIND, `fv:${fromWorkspaceId}:${sessionId}:`, true)
          .filter((doc) => doc.body.workspaceId === fromWorkspaceId && doc.body.sessionId === sessionId)
          .map((doc) => doc.key),
      )
      for (const key of fieldKeys) this.layouts.delete(FIELD_VALUE_KIND, key)

      const annotationKeys = new Set(
        this.documentHistory<SessionAnnotation>(SESSION_ANNOTATION_KIND, `oa:${fromWorkspaceId}:${sessionId}`)
          .filter((doc) => doc.body.workspaceId === fromWorkspaceId && doc.body.sessionId === sessionId)
          .map((doc) => doc.key),
      )
      for (const key of annotationKeys) this.layouts.delete(SESSION_ANNOTATION_KIND, key)

      const sourceDoc = this.layouts.getLatest<GuardHoldsDocument>(GUARD_HOLDS_KIND, fromWorkspaceId)?.body
      if (sourceDoc !== undefined) {
        const holds = sourceDoc.holds.filter((hold) => hold.sessionId !== sessionId)
        if (holds.length !== sourceDoc.holds.length) {
          this.layouts.put(GUARD_HOLDS_KIND, fromWorkspaceId, { workspaceId: fromWorkspaceId, holds })
        }
      }
    })()
  }

  /**
   * Read one exact document history (or one deterministic key prefix) without parsing every document of
   * that kind. A malformed unrelated field/annotation document must not make a healthy session immovable.
   */
  private documentHistory<T>(kind: string, key: string, prefix = false): HistoricalDocument<T>[] {
    const rows = prefix
      ? (this.metaDb
          .prepare(
            `select key, version, body, created_at from documents
             where kind = ? and substr(key, 1, ?) = ?
             order by key, version`,
          )
          .all(kind, key.length, key) as HistoricalDocumentRow[])
      : (this.metaDb
          .prepare(
            `select key, version, body, created_at from documents
             where kind = ? and key = ?
             order by version`,
          )
          .all(kind, key) as HistoricalDocumentRow[])
    return rows.map((row) => ({
      key: row.key,
      version: row.version,
      body: JSON.parse(row.body) as T,
      createdAt: row.created_at,
    }))
  }

  /** Insert one immutable history row exactly once; a same-version mismatch is an integrity failure. */
  private insertHistoricalDocument<T>(kind: string, key: string, version: number, body: T, createdAt: string): void {
    const encoded = JSON.stringify(body)
    const existing = this.metaDb
      .prepare('select body, created_at from documents where kind = ? and key = ? and version = ?')
      .get(kind, key, version) as { body: string; created_at: string } | undefined
    if (existing !== undefined) {
      if (existing.body !== encoded || existing.created_at !== createdAt) {
        throw new Error(`moveSession: conflicting ${kind} history at ${key} version ${version}`)
      }
      return
    }
    this.metaDb
      .prepare('insert into documents (kind, key, version, body, created_at) values (?, ?, ?, ?, ?)')
      .run(kind, key, version, encoded, createdAt)
  }

  /**
   * Every workspace whose DB currently holds a session with this id. Normally 0 or 1; length > 1 is the
   * DETECTABLE duplicate a crash mid-`moveSession` (between destination copy and source delete) leaves —
   * resolved by re-running the move. The detection primitive behind the reroute crash story.
   */
  sessionWorkspaces(id: string): string[] {
    return this.all().filter((ws) => this.getSession(ws.id, id) !== undefined).map((ws) => ws.id)
  }

  /**
   * Upsert ONE moved-session entity contribution into a destination workspace by (kind, normalized
   * name), unioning provenance by distillateId (idempotent — a re-run adds nothing already present) and
   * unioning moment refs. Returns the destination entity id (for the moment-ref remap). Uses the passed
   * db handle so it composes inside moveSession's destination transaction; it never opens its own.
   */
  private mergeMovedEntity(db: Database.Database, workspaceId: string, c: Contribution): string {
    const existing = this.findEntity(db, c.kind, [normalizeEntityName(c.name), ...c.aliases.map(normalizeEntityName)])
    const base: Entity = existing ?? {
      id: randomUUID(),
      workspaceId,
      kind: c.kind,
      name: c.name.trim(),
      aliases: [],
      momentRefs: [],
      outboundCount: 0,
      mentions: 0,
      provenance: [],
      firstSeen: c.firstSeen,
      lastSeen: c.lastSeen,
    }
    const seenDistillates = new Set((base.provenance ?? []).map((p) => p.distillateId).filter((id): id is string => id !== undefined))
    const addedProvenance = c.provenance.filter((p) => p.distillateId === undefined || !seenDistillates.has(p.distillateId))
    const knownKeys = new Set([normalizeEntityName(base.name), ...base.aliases.map(normalizeEntityName)])
    const aliases = [...base.aliases]
    for (const candidate of [c.name.trim(), ...c.aliases]) {
      const key = normalizeEntityName(candidate)
      if (!knownKeys.has(key)) { aliases.push(candidate); knownKeys.add(key) }
    }
    const entity: Entity = {
      ...base,
      aliases,
      momentRefs: [...new Set([...base.momentRefs, ...c.momentRefs])],
      mentions: (base.mentions ?? 0) + addedProvenance.length,
      provenance: [...(base.provenance ?? []), ...addedProvenance],
      firstSeen: c.firstSeen < base.firstSeen ? c.firstSeen : base.firstSeen,
      lastSeen: c.lastSeen > base.lastSeen ? c.lastSeen : base.lastSeen,
    }
    if (!Value.Check(EntitySchema, entity)) throw new Error(`moved entity failed contract validation: ${c.kind} "${c.name}"`)
    db.prepare('insert or replace into entities (id, kind, name_key, last_seen, body) values (?, ?, ?, ?, ?)').run(
      entity.id, entity.kind, normalizeEntityName(entity.name), entity.lastSeen, JSON.stringify(entity),
    )
    return entity.id
  }

  /**
   * Remove one moved session's contribution from a SOURCE entity (in the passed db handle, inside
   * moveSession's source transaction). Provenance entries from the moved distillates are dropped,
   * `mentions` decremented by that count, moved moment refs removed. An entity left with ZERO mentions
   * is DELETED (no zero-mention ghost). Idempotent: an entity with nothing to remove is left untouched.
   */
  private subtractMovedFromEntity(db: Database.Database, entity: Entity, movedDistillateIds: Set<string>, movedMomentIds: Set<string>): void {
    if (!entity.provenance) return
    const kept = entity.provenance.filter((p) => p.distillateId === undefined || !movedDistillateIds.has(p.distillateId))
    const removed = entity.provenance.length - kept.length
    if (removed === 0) return
    const mentions = Math.max(0, (entity.mentions ?? removed) - removed)
    if (mentions === 0) {
      db.prepare('delete from entities where id = ?').run(entity.id)
      return
    }
    const updated: Entity = {
      ...entity,
      mentions,
      provenance: kept,
      momentRefs: entity.momentRefs.filter((ref) => !movedMomentIds.has(ref)),
    }
    db.prepare('insert or replace into entities (id, kind, name_key, last_seen, body) values (?, ?, ?, ?, ?)').run(
      updated.id, updated.kind, normalizeEntityName(updated.name), updated.lastSeen, JSON.stringify(updated),
    )
  }

  /**
   * The #72 match step: decide where a mention lands. Loads the same-kind records once, applies the
   * sovereign override short-circuit (a pinned surface form outranks any score — #73, tested), else runs
   * the scored resolver. Returns the record to LINK to (undefined ⇒ create), the resolution decision to
   * stamp, and whether any same-kind candidates existed (governs whether a `new` create is provisional).
   */
  private resolveMention(
    db: Database.Database,
    input: EntityUpsert,
    nameKey: string,
    aliases: readonly string[],
  ): { existing: Entity | undefined; resolution: Resolution; hadCandidates: boolean; overridePinned: boolean } {
    const rows = (db.prepare('select body from entities where kind = ?').all(input.kind) as { body: string }[]).map(
      (row) => JSON.parse(row.body) as Entity,
    )
    const wanted = new Set([nameKey, ...aliases.map(normalizeEntityName)])

    // 1) Sovereign override short-circuit — a pinned surface form wins deterministically, before scoring.
    const pinned = rows.find((entity) =>
      (entity.overrides ?? []).some((o) => o.pinnedName !== undefined && wanted.has(normalizeEntityName(o.pinnedName))),
    )
    if (pinned) {
      const resolution: Resolution = {
        match: pinned,
        score: 1,
        band: 'auto',
        ambiguous: false,
        components: { phoneticFuzzy: 1, corpusPrior: 1, crossSourceCorroboration: 1, personAffinity: 1 },
      }
      return { existing: pinned, resolution, hadCandidates: rows.length > 0, overridePinned: true }
    }

    // 2) Scored resolver over same-kind candidates, plus the public-name gazetteer's rival candidates
    // (#143). The gazetteer supplies OUTSIDE rivals (well-known OSS/product names) so a heard form that
    // links to a corpus entity AND sounds like a famous public name is flagged AMBIGUOUS with that public
    // name as the rival — the resolver's own band/margin logic decides. Rival-only: the resolver never
    // links to or creates a gazetteer entry, and ignores them when the band is `new` (gazetteer-only ⇒
    // silent). Cheap and additive: no gazetteer hit ⇒ empty rivals ⇒ behavior identical to pre-#143.
    const provisionalBand = (input.resolverConfig ?? DEFAULT_RESOLVER_CONFIG).provisionalBand
    const rivals = gazetteerRivals([input.name, ...aliases], this.gazetteer(), {
      kind: input.kind,
      at: input.seenAt,
      workspaceId: input.workspaceId,
      floor: provisionalBand,
    })
    const resolution = resolveEntity({
      heard: { name: input.name, aliases },
      candidates: rows,
      now: new Date(input.seenAt),
      rivals,
      ...(input.signals !== undefined ? { signals: input.signals } : {}),
      ...(input.resolverConfig !== undefined ? { config: input.resolverConfig } : {}),
    })
    return { existing: resolution.band === 'new' ? undefined : resolution.match, resolution, hadCandidates: rows.length > 0, overridePinned: false }
  }

  /**
   * The public-name gazetteer document (#143), seed-if-absent. Read on the entity-resolution path to
   * supply outside rival candidates to the clarify gate. Seeded into `_meta.db` (LayoutStore) on first
   * read exactly like every other config doc, and NEVER clobbered thereafter — a `put` runs ONLY when the
   * document is absent, so a user's edits to the gazetteer survive every resolution and every restart. The
   * document is workspace-agnostic (install-wide public names), so it lives in the shared meta store.
   */
  gazetteer(): GazetteerDocument {
    const existing = this.layouts.getLatest<GazetteerDocument>(GAZETTEER_KIND, GAZETTEER_KEY)
    if (existing) return existing.body
    this.layouts.put(GAZETTEER_KIND, GAZETTEER_KEY, DEFAULT_GAZETTEER)
    return DEFAULT_GAZETTEER
  }

  /**
   * Append the resolution provenance and stamp the resolution micro-state. EVERY resolution records
   * score + band + components (+ rival, if any) — the DoD's inspectable trail. State stamping:
   *  - a clean AUTO link → SILENT (no state/confidence — pre-resolver behavior, keeps exact matches identical);
   *  - a PROVISIONAL link, or an AUTO link a rival made AMBIGUOUS → `state:'provisional'` + `confidence` +
   *    `ambiguity` (the reviewable #66 micro-state the clarify affordance #75 keys off);
   *  - a NEW entity whose best same-kind rival landed NEAR the provisional band (#94 create-marking rule,
   *    `CREATE_PROVISIONAL_MARGIN`) → `state:'provisional'` (a genuine near-namesake was present); a
   *    first-of-its-kind create, or one whose only rivals scored far below the band, stays silent.
   * A record already `confirmed` (a sovereign user override) is NEVER downgraded, and an override-pinned
   * resolution never re-stamps state (the override already settled it).
   *
   * CROSS-SOURCE CORROBORATION (#74): when `corroborated` (an independent sense named the same concept
   * in-window) AND the mention LINKED to an existing record, the resolution is PROMOTED straight to
   * `confirmed` — the design rule that two independent senses agreeing is near-proof and needs no ask. This
   * OUTRANKS the provisional stamping below (a corroborated provisional-band link becomes confirmed, not
   * reviewable) and clears any prior provisional state. It fires only on a LINK: a fresh `new` create is not
   * confirmed by corroboration alone.
   */
  private stampResolution(entity: Entity, resolution: Resolution, input: EntityUpsert, linked: boolean, hadCandidates: boolean, overridePinned: boolean, corroborated: boolean): Entity {
    const record: EntityResolution = {
      at: input.seenAt,
      heard: input.name.trim(),
      score: resolution.score,
      band: resolution.band,
      phoneticFuzzy: resolution.components.phoneticFuzzy,
      corpusPrior: resolution.components.corpusPrior,
      crossSourceCorroboration: resolution.components.crossSourceCorroboration,
      personAffinity: resolution.components.personAffinity,
      ...(resolution.rival !== undefined
        ? { rivalId: resolution.rival.entity.id, rivalName: resolution.rival.entity.name, rivalScore: resolution.rival.score }
        : {}),
      ...(resolution.margin !== undefined ? { margin: resolution.margin } : {}),
      ...(resolution.ambiguous ? { ambiguous: true } : {}),
      ...(overridePinned ? { override: true } : {}),
    }
    const resolutions = [...(entity.resolutions ?? []), record]
    const next: Entity = { ...entity, resolutions }

    // Never touch state on an override-pinned resolution (the override owns it), and never downgrade a
    // confirmed record.
    if (overridePinned || next.state === 'confirmed') return next

    // #74: cross-source corroboration promotes a LINK straight to confirmed (near-proof, no ask). Precedes
    // the provisional stamping so a corroborated provisional-band link is confirmed, not left reviewable.
    if (linked && corroborated) {
      next.state = 'confirmed'
      next.confidence = resolution.score
      return next
    }

    const reviewable = resolution.band === 'provisional' || (resolution.band === 'auto' && resolution.ambiguous)
    if (linked && reviewable) {
      next.state = 'provisional'
      next.confidence = resolution.score
      if (resolution.rival !== undefined) {
        next.ambiguity = {
          ...(resolution.rival.entity.id !== undefined ? { rivalId: resolution.rival.entity.id } : {}),
          rivalName: resolution.rival.entity.name,
          ...(resolution.margin !== undefined ? { margin: resolution.margin } : {}),
        }
      }
    } else if (!linked && hadCandidates) {
      // #94 create-marking rule: a fresh entity is provisional ONLY when the best same-kind rival landed
      // NEAR the provisional band (score ≥ provisionalBand − CREATE_PROVISIONAL_MARGIN). For a `new`-band
      // resolution, `resolution.score` IS the best near-miss score. An unrelated create (rival ≈0, e.g. a
      // CJK name against an existing Latin corpus) stays silent instead of being marked provisional merely
      // because some same-kind record happened to exist.
      const config = input.resolverConfig ?? DEFAULT_RESOLVER_CONFIG
      const bestRivalScore = resolution.rival?.score ?? resolution.score
      if (bestRivalScore >= config.provisionalBand - CREATE_PROVISIONAL_MARGIN) {
        next.state = 'provisional'
      }
    }
    return next
  }

  /** Match by kind + any normalized key against a stored record's normalized name OR aliases. */
  private findEntity(db: Database.Database, kind: Entity['kind'], keys: readonly string[]): Entity | undefined {
    const rows = (db.prepare('select body from entities where kind = ?').all(kind) as { body: string }[]).map(
      (row) => JSON.parse(row.body) as Entity,
    )
    const wanted = new Set(keys)
    // Override short-circuit (#73): a user override that PINS one of the wanted surface forms outranks any
    // score-based match — resolution is sovereign and deterministic, never re-decided against a rival the
    // user already settled. So an entity whose `overrides[].pinnedName` normalizes into `wanted` wins first,
    // before the ordinary name/alias scan (whose row order is otherwise arbitrary). This is the store-level
    // half of the resolver short-circuit #72 will build on (it will additionally honor rejectedRivalId).
    const pinned = rows.find((entity) =>
      (entity.overrides ?? []).some((o) => o.pinnedName !== undefined && wanted.has(normalizeEntityName(o.pinnedName))),
    )
    if (pinned) return pinned
    for (const entity of rows) {
      const known = [normalizeEntityName(entity.name), ...entity.aliases.map(normalizeEntityName)]
      if (known.some((key) => wanted.has(key))) return entity
    }
    return undefined
  }

  private mergeEntity(existing: Entity, input: EntityUpsert, aliases: readonly string[], matchedExactly: boolean): Entity {
    const knownKeys = new Set([normalizeEntityName(existing.name), ...existing.aliases.map(normalizeEntityName)])
    const mergedAliases = [...existing.aliases]
    // A mention under a different EXACT surface name becomes an alias of the canonical record (unchanged
    // #73 behavior). But on a FUZZY resolver link the heard name is (by definition) not a known key — it is
    // an ASR corruption, so it must NOT be promoted to a first-class alias (that would make the corruption
    // an exact-match key and pollute canon). It lands in the heardAs trail instead (input.heardAs, the
    // resolver's write-back). Model-declared aliases are always unioned regardless.
    const candidateNames = matchedExactly ? [input.name.trim(), ...aliases] : [...aliases]
    for (const candidate of candidateNames) {
      const key = normalizeEntityName(candidate)
      if (!knownKeys.has(key)) {
        mergedAliases.push(candidate)
        knownKeys.add(key)
      }
    }
    const provenance = [...(existing.provenance ?? []), ...(input.provenance !== undefined ? [input.provenance] : [])]
    // Contract v2 (#73): append this mention's evidence to the append-only trails. Sightings dedup by
    // (via, at, distillateId) so a re-run adds nothing already recorded; heardAs dedups by (normalized
    // text, source) so the same surface form heard again is not re-listed. `...existing` carries every
    // v2 field forward untouched — crucially state/confidence/overrides/external/ambiguity, so a
    // user-confirmed record STAYS confirmed through subsequent mentions (reads honor the override).
    const sightings = this.mergeSightings(existing.sightings, this.newSightings(input))
    const heardAs = this.mergeHeardAs(existing.heardAs, input.heardAs)
    return {
      ...existing,
      aliases: mergedAliases,
      momentRefs: [...new Set([...existing.momentRefs, ...(input.momentRefs ?? [])])],
      mentions: (existing.mentions ?? 0) + 1,
      ...(provenance.length > 0 ? { provenance } : {}),
      ...(sightings.length > 0 ? { sightings } : {}),
      ...(heardAs.length > 0 ? { heardAs } : {}),
      lastSeen: input.seenAt > existing.lastSeen ? input.seenAt : existing.lastSeen,
      firstSeen: input.seenAt < existing.firstSeen ? input.seenAt : existing.firstSeen,
    }
  }

  /**
   * This mention's typed evidence, in trail order: the `heard` sighting first, then the cross-source
   * corroborating `seen`/`calendar` sighting (#74) when the correlator supplied one. Both optional.
   */
  private newSightings(input: EntityUpsert): Sighting[] {
    const out: Sighting[] = []
    if (input.sighting !== undefined) out.push(input.sighting)
    if (input.crossSighting !== undefined) out.push(input.crossSighting)
    return out
  }

  /** Append sightings to the trail, deduped by (via, at, distillateId) so re-runs add nothing already there. */
  private mergeSightings(existing: readonly Sighting[] | undefined, added: readonly Sighting[]): Sighting[] {
    const trail = [...(existing ?? [])]
    const key = (s: Sighting): string => `${s.via}|${s.at}|${s.distillateId ?? ''}`
    const seen = new Set(trail.map(key))
    for (const s of added) {
      if (seen.has(key(s))) continue
      seen.add(key(s))
      trail.push(s)
    }
    return trail
  }

  /** Union a heard-as variant, deduped by (normalized text, source); keeps the freshest `at`/confidence. */
  private mergeHeardAs(existing: readonly HeardAs[] | undefined, added: HeardAs | undefined): HeardAs[] {
    const trail = [...(existing ?? [])]
    if (added === undefined) return trail
    const key = (h: HeardAs): string => `${normalizeEntityName(h.text)}|${h.source ?? ''}`
    const idx = trail.findIndex((h) => key(h) === key(added))
    if (idx === -1) trail.push(added)
    else trail[idx] = { ...trail[idx], ...added } // refresh at/confidence if the new mention carries them
    return trail
  }

  close(): void {
    for (const db of this.workspaceHandles.values()) db.close()
    this.workspaceHandles.clear()
    this.metaDb.close()
  }

  private openWorkspace(id: string): Database.Database {
    const existing = this.workspaceHandles.get(id)
    if (existing) return existing
    const workspace = this.all().find((entry) => entry.id === id)
    if (!workspace) throw new Error(`unknown workspace: ${id}`)
    const db = new Database(join(this.dataDir, workspace.dbFile))
    db.pragma('journal_mode = WAL')
    db.prepare(
      'create table if not exists sessions (id text primary key, started_at text not null, ended_at text, body text not null)',
    ).run()
    // #211: APPEND-ONLY episode titlings — one row per naming (a derived title from an orientation pass, or
    // a user rename). `seq` (autoincrement) is the stable append order: several titlings can share a
    // created_at millisecond, so time alone cannot order them (the chat_turns idiom). Never mutated; the
    // effective title is RESOLVED across the rows (latest user > latest derived). Additive
    // `create table if not exists` in the per-workspace open path ⇒ existing DBs gain it on next open.
    db.prepare(
      'create table if not exists session_titlings (seq integer primary key autoincrement, id text not null unique, session_id text not null, created_at text not null, source text not null, body text not null)',
    ).run()
    db.prepare(
      'create table if not exists distillates (id text primary key, session_id text not null, created_at text not null, body text not null)',
    ).run()
    db.prepare(
      'create table if not exists moments (id text primary key, session_id text not null, at text not null, kind text not null, body text not null)',
    ).run()
    db.prepare(
      'create table if not exists entities (id text primary key, kind text not null, name_key text not null, last_seen text not null, body text not null)',
    ).run()
    db.prepare(
      'create table if not exists drafts (id text primary key, session_id text not null, created_at text not null, body text not null)',
    ).run()
    db.prepare(
      'create table if not exists ocr_results (id text primary key, session_id text not null, created_at text not null, body text not null)',
    ).run()
    db.prepare(
      'create table if not exists pins (id text primary key, kind text not null, created_at text not null, body text not null)',
    ).run()
    // #116: per-transcribed-segment STT provenance — the root a pipeline trace walks from (closes the
    // disclosed #65 gap: STT invokes persisted no provenance row). Additive `create table if not exists`
    // in the per-workspace open path ⇒ existing DBs gain it on next open (no migration step).
    db.prepare(
      'create table if not exists stt_segments (id text primary key, session_id text not null, created_at text not null, body text not null)',
    ).run()
    db.prepare(
      'create table if not exists pin_chunks (id text primary key, pin_id text not null, ordinal integer not null, page integer, body text not null)',
    ).run()
    // #176: converged ContextPackets — session-keyed, append-only derived records over the observation
    // tables above (refs only, no copied content). Additive `create table if not exists` in the
    // per-workspace open path ⇒ existing DBs gain it on next open (no migration step).
    db.prepare(
      'create table if not exists context_packets (id text primary key, session_id text not null, window_start text not null, window_end text not null, created_at text not null, body text not null)',
    ).run()
    // #177: the multi-timescale summary hierarchy — level+window-keyed, append-only derived records over the
    // distillates/packets/lower summaries (refs only, no copied content). `session_id` is nullable so a
    // cross-session project summary (slice-2 production) can be stored without one. Additive `create table if
    // not exists` in the per-workspace open path ⇒ existing DBs gain it on next open (no migration step).
    db.prepare(
      'create table if not exists summaries (id text primary key, session_id text, level text not null, window_start text not null, window_end text not null, created_at text not null, body text not null)',
    ).run()
    // The Ask face's persistent app-scoped chat thread — one thread per workspace (owner canon 2026-07-11;
    // upstream glass left ask-history vestigial). `seq` (autoincrement) is the stable turn order: turns in
    // one exchange share a created_at millisecond, so time alone cannot order them. Additive `create table
    // if not exists` in the per-workspace open path ⇒ existing DBs gain it on next open (no migration step).
    db.prepare(
      'create table if not exists chat_turns (seq integer primary key autoincrement, created_at text not null, body text not null)',
    ).run()
    this.workspaceHandles.set(id, db)
    return db
  }

  private createMetaTables(): void {
    this.metaDb
      .prepare(
        'create table if not exists workspaces (id text primary key, name text not null, db_file text not null unique, color text, retention_days integer, egress text, active_preset text, created_at text not null)',
      )
      .run()
    // Additive migration (#128): DBs created before the workspace egress-deny layer predate the `egress`
    // column. Add it in place so an existing meta.db rehydrates the layer-3 policy instead of dropping it.
    const workspaceColumns = this.metaDb.prepare('pragma table_info(workspaces)').all() as { name: string }[]
    if (!workspaceColumns.some((column) => column.name === 'egress')) {
      this.metaDb.prepare('alter table workspaces add column egress text').run()
    }
    // Additive migration (pill P2): the workspace's ACTIVE context-preset selection — the id of the
    // `preset`-kind prompt-template document prepended to its distill pass, or NULL when unset. Stored as
    // its OWN column (the egress idiom), read/written by getActivePreset/setActivePreset, NOT rehydrated
    // onto the Workspace object (so the Workspace contract stays unchanged: it is workspace state, not a
    // workspace field). An existing meta.db gains the column in place instead of dropping the selection.
    if (!workspaceColumns.some((column) => column.name === 'active_preset')) {
      this.metaDb.prepare('alter table workspaces add column active_preset text').run()
    }
    this.metaDb
      .prepare(
        'create table if not exists documents (kind text not null, key text not null, version integer not null, body text not null, created_at text not null, primary key (kind, key, version))',
      )
      .run()
  }

  private fromRow(row: WorkspaceRow): Workspace {
    const workspace: Workspace = {
      id: row.id,
      name: row.name,
      dbFile: row.db_file,
      createdAt: row.created_at,
    }
    if (row.color !== null) workspace.color = row.color
    if (row.retention_days !== null) workspace.retentionDays = row.retention_days
    // #128: rehydrate the layer-3 egress-deny policy that fromRow used to drop, so the distiller's consent
    // resolver actually sees a workspace's wholesale egress denial (`workspace.egress?.deny`).
    if (row.egress !== null) workspace.egress = JSON.parse(row.egress) as EgressPolicy
    return workspace
  }
}
