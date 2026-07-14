import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Pin } from '@openinfo/contracts'
import { WorkspaceRegistry } from '../../store/index.js'
import { ingestPin } from './ingest.js'
import { createFileFetcher, createUrlFetcher, defaultFetchers, pdfFetcher } from './fetcher.js'

// A host-valid file:// URL (drive-lettered on Windows) — a bare POSIX 'file:///doc.txt' has no drive
// letter and fileURLToPath rejects it off POSIX. The referenced file need not exist: readFile is mocked.
const fileUri = (name: string): string => pathToFileURL(join(tmpdir(), name)).href

const pin = (over: Partial<Pin> & { id: string; kind: Pin['kind']; uri: string }): Pin => ({
  workspaceId: 'ws-canon',
  title: 'doc',
  ingest: { status: 'pending' },
  createdAt: '2026-07-07T14:59:00Z',
  ...over,
})

const withStore = async (fn: (store: WorkspaceRegistry) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-ingest-'))
  const store = new WorkspaceRegistry(dir)
  try {
    await fn(store)
  } finally {
    store.close()
    // Windows holds the sqlite files until the handle is released; retries absorb the release lag.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

const now = (): string => '2026-07-07T15:00:00Z'

test('file ingest: form-feed pages become page-anchored chunks; pin marked ingested', async () => {
  await withStore(async (store) => {
    const fetchers = { file: createFileFetcher({ readFile: async () => 'page one text\fpage two text' }) }
    const result = await ingestPin(pin({ id: 'pin-file', kind: 'file', uri: fileUri('doc.txt') }), { store, fetchers, now })
    assert.equal(result.ingest.status, 'ingested')
    assert.equal(result.ingest.pages, 2)
    assert.equal(result.ingest.chunks, 2)
    assert.equal(result.ingest.lastFetchedAt, '2026-07-07T15:00:00Z')

    const chunks = store.listPinChunks('ws-canon', 'pin-file')
    assert.deepEqual(chunks.map((c) => c.page), [1, 2])
    assert.deepEqual(chunks.map((c) => c.text), ['page one text', 'page two text'])
    // the pin itself is persisted and retrievable
    assert.equal(store.getPin('ws-canon', 'pin-file')!.ingest.status, 'ingested')
  })
})

test('url ingest: pageless body → one chunk with no page anchor', async () => {
  await withStore(async (store) => {
    const fetchers = {
      url: createUrlFetcher({ fetch: (async () => new Response('hello from the web', { status: 200 })) as typeof fetch }),
    }
    const result = await ingestPin(pin({ id: 'pin-url', kind: 'url', uri: 'https://example.com' }), { store, fetchers, now })
    assert.equal(result.ingest.status, 'ingested')
    assert.equal(result.ingest.pages, undefined) // pageless — no fabricated page count
    assert.equal(result.ingest.chunks, 1)
    assert.equal(store.listPinChunks('ws-canon', 'pin-url')[0]!.page, undefined)
  })
})

test('url ingest: a non-OK response fails honestly (status recorded, no chunks)', async () => {
  await withStore(async (store) => {
    const fetchers = {
      url: createUrlFetcher({ fetch: (async () => new Response('nope', { status: 404, statusText: 'Not Found' })) as typeof fetch }),
    }
    const result = await ingestPin(pin({ id: 'pin-404', kind: 'url', uri: 'https://example.com/x' }), { store, fetchers, now })
    assert.equal(result.ingest.status, 'failed')
    assert.match(result.ingest.error!, /404/)
    assert.equal(store.listPinChunks('ws-canon', 'pin-404').length, 0)
  })
})

test('pdf ingest is an HONEST stub: failed with a clear error, never fabricated pages', async () => {
  await withStore(async (store) => {
    const result = await ingestPin(pin({ id: 'pin-pdf', kind: 'pdf', uri: 'file:///doc.pdf' }), { store, fetchers: { pdf: pdfFetcher }, now })
    assert.equal(result.ingest.status, 'failed')
    assert.match(result.ingest.error!, /not wired in v0/)
    assert.equal(result.ingest.pages, undefined)
    assert.equal(store.listPinChunks('ws-canon', 'pin-pdf').length, 0)
  })
})

test('missing fetcher for a kind → failed, not a crash', async () => {
  await withStore(async (store) => {
    const result = await ingestPin(pin({ id: 'pin-x', kind: 'gdoc', uri: 'https://docs.google.com/x' }), { store, fetchers: defaultFetchers(), now })
    assert.equal(result.ingest.status, 'failed') // gdoc absent from the default registry (flag off)
    assert.match(result.ingest.error!, /no fetcher/)
  })
})

test('re-ingest is idempotent: chunks are replaced, not duplicated', async () => {
  await withStore(async (store) => {
    let body = 'v1 page a\fv1 page b\fv1 page c'
    const fetchers = { file: createFileFetcher({ readFile: async () => body }) }
    const p = pin({ id: 'pin-re', kind: 'file', uri: fileUri('doc.txt') })
    const first = await ingestPin(p, { store, fetchers, now })
    assert.equal(first.ingest.chunks, 3)

    body = 'v2 only one page now' // the document shrank
    const second = await ingestPin(p, { store, fetchers, now })
    assert.equal(second.ingest.chunks, 1)
    assert.equal(store.listPinChunks('ws-canon', 'pin-re').length, 1) // old 3 replaced, not accumulated
    assert.match(store.listPinChunks('ws-canon', 'pin-re')[0]!.text, /v2 only one page/)
  })
})
