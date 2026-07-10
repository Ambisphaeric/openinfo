import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { Distillate, Draft, Entity, EntityProvenance, EntityOverride, HeardAs, Moment, OcrResult, Pin, PinChunk, Session, Sighting, TodoList, Workspace } from '@openinfo/contracts'
import { Entity as EntitySchema, Pin as PinSchema, PinChunk as PinChunkSchema } from '@openinfo/contracts'
import { Value } from '@sinclair/typebox/value'
import { LayoutStore } from './layouts.js'
import { resolveDataDir } from './paths.js'

/**
 * Normalize an entity name for the v0 resolution match key: trim, lowercase, collapse internal
 * whitespace. Deliberately simple — case/whitespace-insensitive only, no fuzzy or coreference
 * matching (documented weakness in PHASE2-NOTES). Kept identical to distill/entities.ts's alias
 * normalization; store owns the match key so it stays decoupled from the (DB-free) extractor.
 */
const normalizeEntityName = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, ' ')

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
      .prepare('select id, name, db_file, color, retention_days, created_at from workspaces order by created_at')
      .all() as WorkspaceRow[]
    return rows.map((row) => this.fromRow(row))
  }

  ensureWorkspace(input: { id: string; name: string; color?: string; retentionDays?: number }): Workspace {
    const dbFile = `${input.id}.db`
    const existing = this.metaDb
      .prepare('select id, name, db_file, color, retention_days, created_at from workspaces where id = ?')
      .get(input.id) as WorkspaceRow | undefined
    if (existing) return this.fromRow(existing)

    const createdAt = new Date().toISOString()
    this.metaDb
      .prepare('insert into workspaces (id, name, db_file, color, retention_days, created_at) values (?, ?, ?, ?, ?, ?)')
      .run(input.id, input.name, dbFile, input.color ?? null, input.retentionDays ?? null, createdAt)
    this.openWorkspace(input.id)
    const workspace: Workspace = { id: input.id, name: input.name, dbFile, createdAt }
    if (input.color !== undefined) workspace.color = input.color
    if (input.retentionDays !== undefined) workspace.retentionDays = input.retentionDays
    return workspace
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
   * Resolve-and-merge an entity mention into ONE canonical record per (kind, normalized name) —
   * upsert, not append (Index v0). Match policy: same kind AND the normalized mention name equals
   * the record's normalized name or one of its normalized aliases. On match: bump `mentions`,
   * advance `lastSeen`, union new aliases, append the provenance entry and moment refs. On miss:
   * create the record (id + firstSeen are store-stamped). The full merged record is contract-
   * validated before it is written — the last line of defense, mirroring saveMoment's policy.
   * Only this path writes entities (DB-handle hard rule).
   */
  upsertEntity(input: EntityUpsert): Entity {
    this.ensureWorkspace({ id: input.workspaceId, name: input.workspaceId })
    const db = this.openWorkspace(input.workspaceId)
    const nameKey = normalizeEntityName(input.name)
    const aliases = (input.aliases ?? []).map((alias) => alias.trim()).filter((alias) => alias.length > 0)

    const existing = this.findEntity(db, input.kind, [nameKey, ...aliases.map(normalizeEntityName)])
    const entity: Entity = existing
      ? this.mergeEntity(existing, input, aliases)
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
          // Contract v2 (#73): seed the evidence trails from this mention. state/confidence are LEFT
          // ABSENT — no resolver scores them yet (#72); only a user override (overrideEntity) stamps them.
          ...(input.sighting !== undefined ? { sightings: [input.sighting] } : {}),
          ...(input.heardAs !== undefined ? { heardAs: [input.heardAs] } : {}),
          firstSeen: input.seenAt,
          lastSeen: input.seenAt,
        }

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
    const entity: Entity = {
      ...current,
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
   * Retroactively move a session — and EVERYTHING keyed to it — from one workspace DB to another
   * (Phase 3, the correction loop the router's mistakes require; IMPLEMENTATION §3 risk register).
   * This is the ONLY module that opens DB handles, so route/ asks store to move a session (dep rule 2).
   *
   * WHAT MOVES: the session record, its distillates, moments, drafts, and OcrResults (everything keyed
   * by sessionId). ENTITIES are workspace-level aggregates, not session-keyed, so they are re-aggregated
   * (see below), never blindly copied.
   *
   * CRASH-SAFETY (v0, honest): sqlite transactions are per-file, so a move across two files cannot be
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
      if (dest && dest.reroutedFrom === fromWorkspaceId) return dest // already moved — idempotent no-op
      throw new Error(`moveSession: no session ${sessionId} in workspace ${fromWorkspaceId}`)
    }
    this.ensureWorkspace({ id: toWorkspaceId, name: toWorkspaceId })

    const distillates = this.listDistillates(fromWorkspaceId, sessionId)
    const moments = this.listMoments(fromWorkspaceId, sessionId)
    const drafts = this.listDrafts(fromWorkspaceId, sessionId)
    const ocrResults = this.listOcrResults(fromWorkspaceId, sessionId)
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

    const movedSession: Session = { ...session, workspaceId: toWorkspaceId, reroutedFrom: fromWorkspaceId }

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
      toDb.prepare('insert or replace into sessions (id, started_at, ended_at, body) values (?, ?, ?, ?)').run(movedSession.id, movedSession.startedAt, movedSession.endedAt ?? null, JSON.stringify(movedSession))
    })()

    if (opts.stopAfterCopy) return movedSession // test seam: leave the source intact to stage a mid-move crash

    // PHASE 2 — source subtraction + deletes, idempotent, one atomic per-file transaction.
    const fromDb = this.openWorkspace(fromWorkspaceId)
    fromDb.transaction(() => {
      for (const entity of sourceEntities) this.subtractMovedFromEntity(fromDb, entity, movedDistillateIds, movedMomentIds)
      fromDb.prepare('delete from moments where session_id = ?').run(sessionId)
      fromDb.prepare('delete from distillates where session_id = ?').run(sessionId)
      fromDb.prepare('delete from drafts where session_id = ?').run(sessionId)
      fromDb.prepare('delete from ocr_results where session_id = ?').run(sessionId)
      fromDb.prepare('delete from sessions where id = ?').run(sessionId)
    })()

    return movedSession
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

  private mergeEntity(existing: Entity, input: EntityUpsert, aliases: readonly string[]): Entity {
    const knownKeys = new Set([normalizeEntityName(existing.name), ...existing.aliases.map(normalizeEntityName)])
    const mergedAliases = [...existing.aliases]
    // a mention under a different surface name becomes an alias of the canonical record
    for (const candidate of [input.name.trim(), ...aliases]) {
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
    const sightings = this.mergeSightings(existing.sightings, input.sighting)
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

  /** Append a sighting to the trail, deduped by (via, at, distillateId) so re-runs add nothing already there. */
  private mergeSightings(existing: readonly Sighting[] | undefined, added: Sighting | undefined): Sighting[] {
    const trail = [...(existing ?? [])]
    if (added === undefined) return trail
    const key = (s: Sighting): string => `${s.via}|${s.at}|${s.distillateId ?? ''}`
    const seen = new Set(trail.map(key))
    if (!seen.has(key(added))) trail.push(added)
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
    db.prepare(
      'create table if not exists pin_chunks (id text primary key, pin_id text not null, ordinal integer not null, page integer, body text not null)',
    ).run()
    this.workspaceHandles.set(id, db)
    return db
  }

  private createMetaTables(): void {
    this.metaDb
      .prepare(
        'create table if not exists workspaces (id text primary key, name text not null, db_file text not null unique, color text, retention_days integer, created_at text not null)',
      )
      .run()
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
    return workspace
  }
}
