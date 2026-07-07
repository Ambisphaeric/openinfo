import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { Workspace } from '@openinfo/contracts'
import { LayoutStore } from './layouts.js'
import { resolveDataDir } from './paths.js'

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
