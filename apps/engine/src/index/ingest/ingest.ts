import type { Pin } from '@openinfo/contracts'
import type { WorkspaceRegistry } from '../../store/index.js'
import { chunkPages } from './chunk.js'
import type { FetcherRegistry } from './fetcher.js'

/**
 * The pin-ingestion lifecycle (Index P3, index/README: "pin fetchers, chunk with page anchors"). Given a
 * Pin, it dispatches to the fetcher for that pin's kind, chunks the fetched document with page anchors, and
 * persists the chunks + the pin with a terminal `ingest.status`. Everything IO is store/fetcher deps, so
 * the orchestration is testable with fakes; store owns the DB (dep rule 2 — ingest ASKS the store).
 *
 * Status transitions (v0 synchronous ingest): a pin is created `pending`; ingestPin resolves it to
 * `ingested` (pages + chunk count stamped) or `failed` (the fetcher's error message stamped, no chunks
 * written). It NEVER leaves a half-state and NEVER fabricates pages/chunks on failure. Re-ingest is
 * idempotent: existing chunks are cleared first and the deterministic chunk ids replace in place.
 */
export interface IngestDeps {
  store: WorkspaceRegistry
  fetchers: FetcherRegistry
  /** target max characters per chunk (soft) — passed through to chunkPages */
  maxChars?: number
  /** injected for determinism/tests; defaults to Date.now ISO */
  now?: () => string
  log?: (message: string) => void
}

export const ingestPin = async (pin: Pin, deps: IngestDeps): Promise<Pin> => {
  const log = deps.log ?? (() => undefined)
  const now = deps.now ?? (() => new Date().toISOString())
  const fetcher = deps.fetchers[pin.kind]

  if (!fetcher) {
    log(`ingest: no fetcher for pin kind "${pin.kind}" (${pin.id})`)
    return deps.store.savePin({ ...pin, ingest: { status: 'failed', error: `no fetcher for pin kind "${pin.kind}"`, lastFetchedAt: now() } })
  }

  try {
    const doc = await fetcher.fetch(pin)
    const chunks = chunkPages(doc, {
      workspaceId: pin.workspaceId,
      pinId: pin.id,
      ...(deps.maxChars !== undefined ? { maxChars: deps.maxChars } : {}),
      createdAt: now(),
    })
    deps.store.deletePinChunks(pin.workspaceId, pin.id) // idempotent re-ingest: clear the old page anchors
    deps.store.savePinChunks(chunks)
    const pageCount = doc.pageCount ?? distinctPages(chunks)
    const ingested: Pin = {
      ...pin,
      ingest: {
        status: 'ingested',
        ...(pageCount !== undefined ? { pages: pageCount } : {}),
        chunks: chunks.length,
        lastFetchedAt: now(),
      },
    }
    log(`ingest: pin ${pin.id} → ${chunks.length} chunks${pageCount !== undefined ? ` across ${pageCount} pages` : ''}`)
    return deps.store.savePin(ingested)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`ingest: pin ${pin.id} FAILED — ${message}`)
    return deps.store.savePin({ ...pin, ingest: { status: 'failed', error: message, lastFetchedAt: now() } })
  }
}

/** Distinct 1-based page anchors present across chunks, or undefined when none carry a page (pageless source). */
const distinctPages = (chunks: readonly { page?: number }[]): number | undefined => {
  const pages = new Set<number>()
  for (const chunk of chunks) if (chunk.page !== undefined) pages.add(chunk.page)
  return pages.size > 0 ? pages.size : undefined
}
