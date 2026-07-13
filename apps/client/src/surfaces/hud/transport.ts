import type { BlockQuery, QueryResult, Session, Surface } from '@openinfo/contracts'

/**
 * The narrow API surface the HUD needs — the read side of the engine seam plus a live event feed. A
 * standalone interface (not a hard dependency on EngineLink) for two reasons: (1) EngineLink pulls in
 * node:fs via its offline capture spool, so it can't load in a plain browser; the browser dev entry
 * provides a fetch-based implementation instead. (2) It keeps the HUD trivially testable with a fake.
 * EngineLink (Electron) satisfies this interface structurally. The client NEVER opens a DB — API only.
 */
export interface HudTransport {
  surface(id: string): Promise<Surface>
  /** Surface id carries the app-instance workspace binding into POST /query?surface=<id>. */
  query(query: BlockQuery, surfaceId?: string): Promise<QueryResult>
  sessions(opts: { workspace?: string; live?: boolean }): Promise<Session[]>
  /** Subscribe to the engine WS event feed; returns an unsubscribe. */
  subscribe(handler: (event: { name: string; payload: unknown }) => void): () => void
}
