import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Pin } from '@openinfo/contracts'
import type { FetchedDoc, SourcePage } from './chunk.js'

/**
 * A pin fetcher turns a Pin's `uri` into a FetchedDoc (pages + count) ready for page-anchored chunking.
 * One fetcher per Pin.kind. A fetcher THROWS on failure (unreachable, unreadable, unsupported) — the
 * ingest lifecycle catches the throw and records it as `ingest.status: 'failed'` with the message, so a
 * failure is HONEST (a clear error), never a fabricated empty document.
 *
 * Fetchers take their IO as injected deps (a `readFile`, a `fetch`) so the whole ingest lifecycle is
 * testable without touching the real filesystem or network — the pure-logic / imperative-shell split the
 * distiller and extractor already use.
 */
export interface PinFetcher {
  readonly kind: Pin['kind']
  fetch(pin: Pin): Promise<FetchedDoc>
}

/** A registry of fetchers by pin kind — the lifecycle looks a pin's kind up here. */
export type FetcherRegistry = Partial<Record<Pin['kind'], PinFetcher>>

/** Split a plaintext blob into pages on the ASCII form-feed (\f) — the classic plaintext page separator. */
const splitFormFeedPages = (text: string): SourcePage[] => {
  const parts = text.split('\f')
  if (parts.length <= 1) return [{ text }] // no form feeds → one pageless blob
  return parts.map((part, i) => ({ page: i + 1, text: part }))
}

/** Resolve a pin uri to a local path — accepts a `file://` URL or a bare filesystem path. */
const uriToPath = (uri: string): string => (uri.startsWith('file://') ? fileURLToPath(uri) : uri)

export interface FileFetcherDeps {
  /** injected for tests; defaults to node:fs/promises readFile (utf8) */
  readFile?: (path: string) => Promise<string>
}

/**
 * `file` — read a local text file (utf8). Pages come from form-feed (\f) separators when present (a real,
 * honest page anchor for plaintext), else the whole file is one pageless page. This is the v0 honest path:
 * plaintext/markdown/exported-text ingests fully with real page anchors; no binary parsing.
 */
export const createFileFetcher = (deps: FileFetcherDeps = {}): PinFetcher => {
  const read = deps.readFile ?? ((path: string) => readFile(path, 'utf8'))
  return {
    kind: 'file',
    async fetch(pin: Pin): Promise<FetchedDoc> {
      const text = await read(uriToPath(pin.uri))
      const pages = splitFormFeedPages(text)
      // a form-feed-paginated file reports its page count; a single pageless blob reports none
      return pages.some((p) => p.page !== undefined) ? { pages, pageCount: pages.length } : { pages }
    },
  }
}

export interface UrlFetcherDeps {
  /** injected for tests; defaults to the global fetch */
  fetch?: typeof fetch
}

/**
 * `url` — fetch an http(s) resource and take its body as one PAGELESS page (a web page has no page number
 * to cite; a fabricated one would lie). v0 takes the raw response text as-is — HTML-to-text extraction and
 * multi-"page" pagination are deferred refinements; the honest v0 is "the text at this url, uncited by page".
 * A non-OK response throws (→ ingest failed with the status).
 */
export const createUrlFetcher = (deps: UrlFetcherDeps = {}): PinFetcher => {
  const doFetch = deps.fetch ?? fetch
  return {
    kind: 'url',
    async fetch(pin: Pin): Promise<FetchedDoc> {
      const response = await doFetch(pin.uri)
      if (!response.ok) throw new Error(`url fetch failed: ${response.status} ${response.statusText} for ${pin.uri}`)
      const text = await response.text()
      return { pages: [{ text }] }
    },
  }
}

/**
 * `pdf` — HONEST STUB (P4D PDF decision, recorded in PHASE4-NOTES). The engine's dependency policy is
 * deliberately minimal (`better-sqlite3` + `typebox` only); adding a PDF text-extraction dependency
 * (pdf.js/pdf-parse pull a large transitive tree) is a real policy change that needs explicit founder
 * sign-off, and hand-rolling a binary PDF parser is out of the question. So the ingest SEAM + page-anchor
 * chunking are fully built and exercised by the file/url fetchers, and PDF is a NAMED failure: it throws a
 * clear, actionable error → the pin records `ingest.status: 'failed'`, NEVER fabricated pages. The moment a
 * vetted parser is approved, this is the ONE file that changes (return real `{ page, text }` pages).
 */
export const pdfFetcher: PinFetcher = {
  kind: 'pdf',
  fetch(pin: Pin): Promise<FetchedDoc> {
    return Promise.reject(
      new Error(
        `PDF text extraction is not wired in v0 (${pin.uri}). The engine keeps a minimal dependency policy; ` +
          'add a vetted PDF parser (see docs/PHASE4-NOTES.md) or convert the document to text and pin it as a file.',
      ),
    )
  },
}

/**
 * `gdoc` — SEAM ONLY, out of scope beyond this stub (behind the seeded `ingest.gdoc` flag). Google Docs
 * ingestion needs read-only OAuth the engine does not have in v0; this fetcher throws so the seam exists
 * (a registry can carry it when the flag is on) without pretending to fetch. The auth flow + the real
 * fetch land with the `ingest.gdoc` feature (CODE_MAP §3: `engine/index/ingest/gdoc.ts` + flag `ingest.gdoc`).
 */
export const gdocFetcher: PinFetcher = {
  kind: 'gdoc',
  fetch(pin: Pin): Promise<FetchedDoc> {
    return Promise.reject(new Error(`gdoc ingestion requires read-only Google auth (flag ingest.gdoc); not wired in v0 (${pin.uri})`))
  },
}

/**
 * The default v0 fetcher registry: file + url (the honest v0 targets) + the pdf honest-stub. gdoc is
 * added ONLY when `ingest.gdoc` is enabled (the caller passes `{ gdoc: true }`), keeping the disabled
 * default free of a fetcher that can only fail.
 */
export const defaultFetchers = (opts: { gdoc?: boolean; file?: FileFetcherDeps; url?: UrlFetcherDeps } = {}): FetcherRegistry => ({
  file: createFileFetcher(opts.file),
  url: createUrlFetcher(opts.url),
  pdf: pdfFetcher,
  ...(opts.gdoc ? { gdoc: gdocFetcher } : {}),
})
