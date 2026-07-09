import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunkPages, type FetchedDoc } from './chunk.js'

const opts = { workspaceId: 'ws-canon', pinId: 'pin-1', createdAt: '2026-07-07T15:00:00Z' }

test('page anchors survive chunking: each chunk cites the page it came from', () => {
  const doc: FetchedDoc = {
    pages: [
      { page: 1, text: 'Intro paragraph.' },
      { page: 42, text: 'Section 4.2 data retention.\n\nPurged within 30 days.' },
    ],
    pageCount: 2,
  }
  const chunks = chunkPages(doc, opts)
  assert.deepEqual(chunks.map((c) => c.page), [1, 42]) // second page's two paragraphs pack into one chunk
  assert.deepEqual(chunks.map((c) => c.ordinal), [0, 1]) // global sequence
  assert.deepEqual(chunks.map((c) => c.id), ['pin-1-0', 'pin-1-1']) // deterministic ids
  assert.ok(chunks[1]!.text.includes('30 days'))
})

test('pageless source (no page numbers) → chunks carry no page anchor, never a fabricated one', () => {
  const doc: FetchedDoc = { pages: [{ text: 'a web page body with no page numbers' }] }
  const chunks = chunkPages(doc, opts)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0]!.page, undefined)
})

test('oversized paragraph is hard-split at the char limit, both pieces keep the page anchor', () => {
  const long = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ') // ~ > 50 chars
  const chunks = chunkPages({ pages: [{ page: 7, text: long }] }, { ...opts, maxChars: 40 })
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) {
    assert.equal(chunk.page, 7)
    assert.ok(chunk.text.length <= 40)
  }
  // ordinals are a contiguous global sequence
  assert.deepEqual(chunks.map((c) => c.ordinal), chunks.map((_, i) => i))
})

test('paragraphs pack greedily up to maxChars without crossing a page boundary', () => {
  const doc: FetchedDoc = {
    pages: [
      { page: 1, text: 'aaa\n\nbbb\n\nccc' }, // three short paragraphs on page 1
      { page: 2, text: 'ddd' },
    ],
  }
  const chunks = chunkPages(doc, { ...opts, maxChars: 20 })
  // page 1's paragraphs pack together (aaa\n\nbbb\n\nccc = 13 chars ≤ 20) into one chunk; page 2 is its own
  assert.deepEqual(chunks.map((c) => c.page), [1, 2])
  assert.ok(chunks[0]!.text.startsWith('aaa') && chunks[0]!.text.includes('ccc'))
})

test('whitespace-only pages contribute no chunks (PinChunk.text is min-length 1)', () => {
  const chunks = chunkPages({ pages: [{ page: 1, text: '   \n\n  ' }, { page: 2, text: 'real' }] }, opts)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0]!.page, 2)
  assert.equal(chunks[0]!.ordinal, 0) // ordinal counts EMITTED chunks, not source pages
})

test('re-chunking the same document is deterministic (same ids → store replaces in place)', () => {
  const doc: FetchedDoc = { pages: [{ page: 1, text: 'one' }, { page: 2, text: 'two' }] }
  assert.deepEqual(chunkPages(doc, opts).map((c) => c.id), chunkPages(doc, opts).map((c) => c.id))
})
