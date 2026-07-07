import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { Distillate, Entity, EntityProvenance, Moment, Workspace } from '@openinfo/contracts'
import { Entity as EntitySchema } from '@openinfo/contracts'
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

  /** Match by kind + any normalized key against a stored record's normalized name OR aliases. */
  private findEntity(db: Database.Database, kind: Entity['kind'], keys: readonly string[]): Entity | undefined {
    const rows = db.prepare('select body from entities where kind = ?').all(kind) as { body: string }[]
    const wanted = new Set(keys)
    for (const row of rows) {
      const entity = JSON.parse(row.body) as Entity
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
    return {
      ...existing,
      aliases: mergedAliases,
      momentRefs: [...new Set([...existing.momentRefs, ...(input.momentRefs ?? [])])],
      mentions: (existing.mentions ?? 0) + 1,
      ...(provenance.length > 0 ? { provenance } : {}),
      lastSeen: input.seenAt > existing.lastSeen ? input.seenAt : existing.lastSeen,
      firstSeen: input.seenAt < existing.firstSeen ? input.seenAt : existing.firstSeen,
    }
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
    db.prepare('create table if not exists sessions (id text primary key, body text not null)').run()
    db.prepare(
      'create table if not exists distillates (id text primary key, session_id text not null, created_at text not null, body text not null)',
    ).run()
    db.prepare(
      'create table if not exists moments (id text primary key, session_id text not null, at text not null, kind text not null, body text not null)',
    ).run()
    db.prepare(
      'create table if not exists entities (id text primary key, kind text not null, name_key text not null, last_seen text not null, body text not null)',
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
