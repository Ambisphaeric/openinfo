import type { PinChunk } from '@openinfo/contracts'

/**
 * Page-anchored pin chunking (Index P3, ARCHITECTURE §5: pins are ingested with page anchors — "how an
 * answer cites p. 42 with a copy-ready excerpt"). Pure and deterministic: a fetched document (its text
 * split into source PAGES) becomes an ordered list of PinChunks, each carrying the `page` it came from so
 * a retrieved excerpt can be cited back to its exact source location.
 *
 * Why pages in, chunks out: the FETCHER knows page boundaries (a PDF's pages, a plaintext file's form-feed
 * \f separators); the CHUNKER packs each page's prose into retrieval-sized units without crossing a page
 * boundary — so every chunk has exactly ONE honest page anchor. A pageless source (a web URL, one plaintext
 * blob) has `page: undefined` on its chunks — never a fabricated page number.
 */

/** One source page of a fetched document. `page` is the 1-based page number, or undefined for a pageless source. */
export interface SourcePage {
  page?: number
  text: string
}

/** A fetched document ready to chunk: its pages plus the total page count (undefined for pageless sources). */
export interface FetchedDoc {
  pages: SourcePage[]
  pageCount?: number
}

export interface ChunkOptions {
  workspaceId: string
  pinId: string
  /** target max characters per chunk (soft — a single oversized paragraph is hard-split at the limit) */
  maxChars?: number
  /** store-stamp equivalent, injected for determinism (defaults to now) */
  createdAt?: string
}

const DEFAULT_MAX_CHARS = 1_000

/**
 * Pack a page's text into <= maxChars pieces WITHOUT splitting mid-paragraph where it fits: paragraphs
 * (blank-line separated) are greedily accumulated up to maxChars; a single paragraph longer than maxChars
 * is hard-split on whitespace at the limit. Whitespace-only input yields no pieces. Pure.
 */
const packText = (text: string, maxChars: number): string[] => {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0)
  const pieces: string[] = []
  let current = ''
  const flush = (): void => {
    if (current.length > 0) pieces.push(current)
    current = ''
  }
  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      // hard-split an oversized paragraph on word boundaries at the limit
      flush()
      let rest = paragraph
      while (rest.length > maxChars) {
        let cut = rest.lastIndexOf(' ', maxChars)
        if (cut <= 0) cut = maxChars // no space to break on — hard cut
        pieces.push(rest.slice(0, cut).trim())
        rest = rest.slice(cut).trim()
      }
      if (rest.length > 0) current = rest
      continue
    }
    if (current.length === 0) current = paragraph
    else if (current.length + 2 + paragraph.length <= maxChars) current = `${current}\n\n${paragraph}`
    else {
      flush()
      current = paragraph
    }
  }
  flush()
  return pieces
}

/**
 * Chunk a fetched document into page-anchored PinChunks (pure, deterministic). `ordinal` is the chunk's
 * global 0-based sequence across the whole document (stable ordering for retrieval + re-assembly); `page`
 * is copied from the source page a chunk came from (omitted when the page is undefined). Chunk `id` is
 * DETERMINISTIC (`${pinId}-${ordinal}`) so a re-ingest of the same document produces the same ids and the
 * store replaces in place (idempotent). Empty/whitespace pages contribute nothing (PinChunk.text is min-1).
 */
export const chunkPages = (doc: FetchedDoc, opts: ChunkOptions): PinChunk[] => {
  const maxChars = Math.max(1, opts.maxChars ?? DEFAULT_MAX_CHARS)
  const createdAt = opts.createdAt ?? new Date().toISOString()
  const chunks: PinChunk[] = []
  let ordinal = 0
  for (const page of doc.pages) {
    for (const text of packText(page.text, maxChars)) {
      const chunk: PinChunk = {
        id: `${opts.pinId}-${ordinal}`,
        pinId: opts.pinId,
        workspaceId: opts.workspaceId,
        ordinal,
        ...(page.page !== undefined ? { page: page.page } : {}),
        text,
        createdAt,
      }
      chunks.push(chunk)
      ordinal += 1
    }
  }
  return chunks
}
