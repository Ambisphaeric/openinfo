import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Pin, Surface } from '@openinfo/contracts'
import { renderSurface, renderToHtml, type NowContext } from '../block-renderer/index.js'
import { defaultBlockRegistry } from './index.js'

/**
 * copy-value-only regression (#118): the pinned-doc copy affordance puts EXACTLY the pasteable reference
 * (`pin.uri`) on the clipboard — matching the fallback row's bare `doc` reference. The title is display
 * context (already on the row's `.ttl`) and never rides into the payload; the ingest why-line stays on the
 * row. This pins the fix that removed the `title — uri` composite from the copy payload.
 */

const now: NowContext = { live: true }

const pin: Pin = {
  id: 'pin-1', workspaceId: 'ws', uri: 'https://example.com/msa.pdf', title: 'Signed MSA',
  kind: 'pdf', ingest: { status: 'ingested', pages: 12 }, createdAt: '2026-07-16T19:57:00Z',
}

const surface: Surface = {
  id: 'surf', name: 's', context: 'meeting', version: 1,
  stack: [
    {
      block: 'pinned-doc', show: 'always',
      query: { source: 'pins', params: { workspace: 'ws' } },
      actions: [{ id: 'a-copy', label: 'Copy', verb: 'copy', params: {} }],
    },
  ],
}

const render = (items: unknown[]): string =>
  renderToHtml(
    renderSurface({ surface, now, results: [{ source: 'pins', items, truncated: false }] }, defaultBlockRegistry),
  )

const copyPayload = (html: string): string | undefined => html.match(/data-copy="([^"]*)"/)?.[1]

test('pinned-doc copy payload is the pasteable reference ONLY — the title never rides in', () => {
  const html = render([pin])
  // The row still DISPLAYS the title and its ingest why…
  assert.match(html, /Signed MSA/)
  assert.match(html, /ingested/)
  // …but the clipboard payload is exactly the bare uri.
  const payload = copyPayload(html)
  assert.equal(payload, 'https://example.com/msa.pdf')
  // Hard guard: no "title — uri" composite, no title text in the payload.
  assert.doesNotMatch(payload ?? '', /—/)
  assert.doesNotMatch(payload ?? '', /Signed MSA/)
})
