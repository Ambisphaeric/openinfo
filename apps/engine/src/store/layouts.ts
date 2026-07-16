import type Database from 'better-sqlite3'

export interface VersionedDocument<T> {
  kind: string
  key: string
  version: number
  body: T
  createdAt: string
}

interface DocumentRow {
  kind: string
  key: string
  version: number
  body: string
  created_at: string
}

export class LayoutStore {
  constructor(private readonly db: Database.Database) {}

  getLatest<T>(kind: string, key: string): VersionedDocument<T> | undefined {
    const row = this.db
      .prepare('select kind, key, version, body, created_at from documents where kind = ? and key = ? order by version desc limit 1')
      .get(kind, key) as DocumentRow | undefined
    if (!row) return undefined
    return {
      kind: row.kind,
      key: row.key,
      version: row.version,
      body: JSON.parse(row.body) as T,
      createdAt: row.created_at,
    }
  }

  /**
   * The latest version of every key under a kind (one row per key). Lets a documents module list
   * its records — e.g. fabric profiles — without a store-schema change and without an index doc.
   */
  latestOfKind<T>(kind: string): VersionedDocument<T>[] {
    const rows = this.db
      .prepare(
        `select kind, key, version, body, created_at from documents d
         where kind = ? and version = (select max(version) from documents where kind = d.kind and key = d.key)
         order by key`,
      )
      .all(kind) as DocumentRow[]
    return rows.map((row) => ({
      kind: row.kind,
      key: row.key,
      version: row.version,
      body: JSON.parse(row.body) as T,
      createdAt: row.created_at,
    }))
  }

  /**
   * Every persisted version under a kind, oldest to newest within each document key. Unlike
   * `latestOfKind`, this is an audit/history read: callers can reconstruct an earlier causal pass even
   * after the same document key has been updated by a later pass. The version metadata stays attached so
   * a caller that needs to collapse revisions from one pass can do so without guessing from timestamps.
   */
  versionsOfKind<T>(kind: string): VersionedDocument<T>[] {
    const rows = this.db
      .prepare(
        `select kind, key, version, body, created_at from documents
         where kind = ?
         order by key, version`,
      )
      .all(kind) as DocumentRow[]
    return rows.map((row) => ({
      kind: row.kind,
      key: row.key,
      version: row.version,
      body: JSON.parse(row.body) as T,
      createdAt: row.created_at,
    }))
  }

  /**
   * The most recently APPENDED versions under a kind for one exact JSON workspace/session scope, returned
   * in global append order for causal reconstruction. The guarded JSON predicates and hard limit
   * happen in SQL before parsing, so an opaque id containing `:` cannot alias another workspace and a
   * corrupt body outside the selected scope cannot break its Settings read. A session query also includes
   * workspace-scoped documents whose `sessionId` is absent.
   */
  recentVersionsOfKindByScope<T>(kind: string, workspaceId: string, sessionId: string | undefined, limit: number): VersionedDocument<T>[] {
    if (!Number.isInteger(limit) || limit < 1) return []
    const rows = this.db
      .prepare(
        `select kind, key, version, body, created_at from (
           select rowid as append_order, kind, key, version, body, created_at from documents
           where kind = ?
             and case when json_valid(body) then json_extract(body, '$.workspaceId') = ? else 0 end
             and (
               ? is null
               or case when json_valid(body)
                 then json_type(body, '$.sessionId') is null or json_extract(body, '$.sessionId') = ?
                 else 0
               end
             )
           order by rowid desc
           limit ?
         )
         order by append_order`,
      )
      .all(kind, workspaceId, sessionId ?? null, sessionId ?? null, limit) as DocumentRow[]
    return rows.map((row) => ({
      kind: row.kind,
      key: row.key,
      version: row.version,
      body: JSON.parse(row.body) as T,
      createdAt: row.created_at,
    }))
  }

  /**
   * Hard-delete every version of a (kind, key) — the one place the append-only version history is
   * discarded, used when a user removes a config document they own (e.g. a fabric profile). Returns
   * whether any row existed. Not used for records; documents only.
   */
  delete(kind: string, key: string): boolean {
    const info = this.db.prepare('delete from documents where kind = ? and key = ?').run(kind, key)
    return info.changes > 0
  }

  put<T>(kind: string, key: string, body: T): VersionedDocument<T> {
    const current = this.getLatest<unknown>(kind, key)
    const version = (current?.version ?? 0) + 1
    const createdAt = new Date().toISOString()
    this.db
      .prepare('insert into documents (kind, key, version, body, created_at) values (?, ?, ?, ?, ?)')
      .run(kind, key, version, JSON.stringify(body), createdAt)
    return { kind, key, version, body, createdAt }
  }
}
