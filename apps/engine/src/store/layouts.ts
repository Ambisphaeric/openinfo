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
