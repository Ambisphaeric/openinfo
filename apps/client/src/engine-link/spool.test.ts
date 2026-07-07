import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk } from '@openinfo/contracts'
import { OfflineSpool } from './spool.js'

const chunk = (sequence: number): CaptureChunk => ({
  id: `chunk-${sequence}`,
  sessionId: 'session-1',
  workspaceId: 'default',
  source: 'mic',
  sequence,
  capturedAt: '2026-07-07T14:00:00Z',
  contentType: 'text/plain',
  encoding: 'utf8',
  data: `chunk ${sequence}`,
})

test('offline spool flushes chunks in enqueue order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-client-spool-'))
  try {
    const spool = new OfflineSpool(dir)
    await spool.enqueue(chunk(1))
    await spool.enqueue(chunk(2))
    const seen: number[] = []
    await spool.flush(async (entry) => {
      seen.push(entry.sequence)
    })
    assert.deepEqual(seen, [1, 2])
    assert.equal(await spool.pendingCount(), 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
