import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk } from '@openinfo/contracts'
import { CaptureQueue } from './spool.js'

const chunk: CaptureChunk = {
  id: 'chunk-1',
  sessionId: 'session-1',
  workspaceId: 'default',
  source: 'mic',
  sequence: 1,
  capturedAt: '2026-07-07T14:00:00Z',
  contentType: 'text/plain',
  encoding: 'utf8',
  data: 'hello',
}

test('capture queue appends and drains raw files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-queue-'))
  try {
    const queue = new CaptureQueue(dir)
    await queue.append(chunk)
    assert.equal((await queue.status()).pendingFiles, 1)
    queue.scheduleDrain(() => undefined)
    await waitForDrain(queue)
    const status = await queue.status()
    assert.equal(status.pendingFiles, 0)
    assert.equal(status.drainedFiles, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

async function waitForDrain(queue: CaptureQueue): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await queue.status()).pendingFiles === 0) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
