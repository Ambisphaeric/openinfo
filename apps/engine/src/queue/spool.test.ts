import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk, QueueFailure } from '@openinfo/contracts'
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

test('an empty queue reports no failure and no success yet', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-queue-'))
  try {
    const status = await new CaptureQueue(dir).status()
    assert.equal(status.pendingFiles, 0)
    assert.equal(status.lastFailure, undefined)
    assert.equal(status.lastSuccessAt, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a successful drain records lastSuccessAt and no failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-queue-'))
  try {
    const queue = new CaptureQueue(dir, async () => undefined)
    await queue.append(chunk)
    await queue.drainNow(() => undefined) // awaitable — deterministic, no polling
    const status = await queue.status()
    assert.equal(status.drainedFiles, 1)
    assert.ok(status.lastSuccessAt !== undefined)
    assert.equal(status.lastFailure, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failed drain records the CLASSIFIED failure and re-queues the file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-queue-'))
  const failure: QueueFailure = {
    class: 'model-load',
    endpoint: 'lm-studio',
    model: 'qwen3.5-35b',
    hint: 'model "qwen3.5-35b" failed to load on http://x — pick a smaller/loaded model in Settings → Endpoints',
    at: '2026-07-07T14:05:00Z',
  }
  try {
    const queue = new CaptureQueue(
      dir,
      async () => {
        throw new Error('invoke blew up')
      },
      async (_error, at) => ({ ...failure, at }),
    )
    await queue.append(chunk)
    await queue.drainNow(() => undefined) // awaitable — the file is re-queued, the failure recorded
    const status = await queue.status()
    assert.equal(status.pendingFiles, 1, 'the file is safe — re-queued, not lost')
    assert.equal(status.drainedFiles, 0)
    assert.equal(status.lastFailure?.class, 'model-load')
    assert.equal(status.lastFailure?.endpoint, 'lm-studio')
    assert.ok((status.lastFailure?.at ?? '').length > 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

const mk = (over: Partial<CaptureChunk>): CaptureChunk => ({ ...chunk, ...over })

test('status reports per-kind depth, classifying by source/contentType and excluding focus', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-queue-'))
  try {
    const queue = new CaptureQueue(dir)
    await queue.append(mk({ id: 'a', source: 'mic' }))
    await queue.append(mk({ id: 'b', source: 'system-audio', contentType: 'audio/wav', encoding: 'base64' }))
    await queue.append(mk({ id: 'c', source: 'screen' }))
    await queue.append(mk({ id: 'd', source: 'calendar', contentType: 'application/json' }))
    await queue.append(mk({ id: 'e', source: 'focus', contentType: 'application/json' }))
    const status = await queue.status()
    assert.equal(status.byKind?.audio.pendingChunks, 2)
    assert.equal(status.byKind?.screen.pendingChunks, 1)
    assert.equal(status.byKind?.['llm-work'].pendingChunks, 1)
    // focus is excluded from the per-kind depth (it never appears as a work kind)
    const workChunks =
      (status.byKind?.audio.pendingChunks ?? 0) +
      (status.byKind?.screen.pendingChunks ?? 0) +
      (status.byKind?.['llm-work'].pendingChunks ?? 0)
    assert.equal(workChunks, 4)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('eta is basis none before any drain, and observed (with caughtUpBy) after drains with a backlog', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-queue-'))
  try {
    const queue = new CaptureQueue(dir, async () => undefined)
    // A pending backlog but no drain history yet → honest unknown.
    await queue.append(mk({ id: 'p1', sessionId: 'pending-1' }))
    assert.equal((await queue.status()).eta?.basis, 'none')
    // Drain a couple of files to build rate samples, leaving one pending.
    await queue.drainNow(() => undefined)
    await queue.append(mk({ id: 'p2', sessionId: 'still-pending' }))
    const status = await queue.status()
    assert.equal(status.eta?.basis, 'observed')
    assert.ok((status.eta?.etaMs ?? -1) >= 0)
    assert.ok((status.eta?.caughtUpBy ?? '').length > 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the overflow policy and measured tok/s seams are surfaced when injected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-queue-'))
  try {
    const queue = new CaptureQueue(
      dir,
      async () => undefined,
      undefined,
      () => 41,
      () => ({ policy: 'queue-for-idle', enforced: true }),
    )
    await queue.append(mk({ id: 'x' }))
    const status = await queue.status()
    assert.equal(status.overflow?.policy, 'queue-for-idle')
    assert.equal(status.overflow?.enforced, true)
    assert.equal(status.eta?.measuredTokPerSec, 41)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('no overflow provider → the field is absent (additive/optional)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-queue-'))
  try {
    const status = await new CaptureQueue(dir).status()
    assert.equal(status.overflow, undefined)
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
