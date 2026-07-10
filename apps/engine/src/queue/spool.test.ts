import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
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

// --- #70 freshness-first drain + age-shed policy -----------------------------------------------
// A pending spool file for `sessionId` whose last-activity time is `ageMs` in the past. Writing the file
// then back-dating its mtime is the honest fixture: mtime is exactly the freshness signal the drain reads.
const seedFile = async (dir: string, sessionId: string, ageMs: number): Promise<void> => {
  const path = join(dir, `${sessionId}.jsonl`)
  await writeFile(path, `${JSON.stringify(mk({ id: sessionId, sessionId }))}\n`, 'utf8')
  const when = new Date(Date.now() - ageMs)
  await utimes(path, when, when)
}

test('drain orders newest-first while a session is LIVE, oldest-first at idle (#70)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-queue-'))
  try {
    // maxAgeMinutes 60 so these seconds-old fixtures never shed — this test is about ORDER alone.
    const seedThree = async () => {
      await seedFile(dir, 'sess-old', 30_000)
      await seedFile(dir, 'sess-mid', 20_000)
      await seedFile(dir, 'sess-new', 10_000)
    }

    await seedThree()
    const liveOrder: string[] = []
    const liveQueue = new CaptureQueue(
      dir, async (chunks) => { liveOrder.push(String(chunks[0]?.sessionId)) },
      undefined, undefined, undefined, () => true, 60,
    )
    await liveQueue.drainNow(() => undefined)
    assert.deepEqual(liveOrder, ['sess-new', 'sess-mid', 'sess-old'], 'live → newest first (render the present)')

    await seedThree()
    const idleOrder: string[] = []
    const idleQueue = new CaptureQueue(
      dir, async (chunks) => { idleOrder.push(String(chunks[0]?.sessionId)) },
      undefined, undefined, undefined, () => false, 60,
    )
    await idleQueue.drainNow(() => undefined)
    assert.deepEqual(idleOrder, ['sess-old', 'sess-mid', 'sess-new'], 'idle → oldest first (FIFO the backlog)')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('age-shed drops backlog beyond the horizon, keeps fresh files, and counts it (#70)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-queue-'))
  try {
    await seedFile(dir, 'stale', 5 * 60_000) // 5m old → beyond the 1m horizon → shed
    await seedFile(dir, 'fresh', 5_000) // 5s old → processed
    const processed: string[] = []
    const logs: string[] = []
    const queue = new CaptureQueue(
      dir, async (chunks) => { processed.push(String(chunks[0]?.sessionId)) },
      undefined, undefined, undefined, () => false, 1,
    )
    await queue.drainNow((line) => logs.push(line))
    assert.deepEqual(processed, ['fresh'], 'only the fresh file is processed; the stale one never reaches the processor')
    const status = await queue.status()
    assert.equal(status.shedFiles, 1, 'the stale file is counted as shed')
    assert.equal(status.drainedFiles, 1)
    assert.equal(status.pendingFiles, 0, 'the shed file is gone from the spool, not re-queued')
    assert.ok(
      logs.some((line) => /age-shed/.test(line) && /dropped 1 stale file\(s\)/.test(line) && /age /.test(line)),
      `an audit line names the count + age range — got: ${JSON.stringify(logs)}`,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('age-shed boundary: just-under the horizon is kept, well-over is shed (#70)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-queue-'))
  try {
    await seedFile(dir, 'under', 90_000) // 1.5m < 2m horizon → kept
    await seedFile(dir, 'over', 180_000) // 3m > 2m horizon → shed
    const processed: string[] = []
    const queue = new CaptureQueue(
      dir, async (chunks) => { processed.push(String(chunks[0]?.sessionId)) },
      undefined, undefined, undefined, () => false, 2,
    )
    await queue.drainNow(() => undefined)
    assert.deepEqual(processed, ['under'], 'the file just under the horizon is processed')
    assert.equal((await queue.status()).shedFiles, 1, 'the file over the horizon is shed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a shed file is NOT re-queued; a fresh file that FAILS still re-queues (#70)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-queue-'))
  const failure: QueueFailure = {
    class: 'model-load',
    endpoint: 'lm-studio',
    hint: 'model failed to load — pick a smaller/loaded model',
    at: '2026-07-09T14:05:00Z',
  }
  try {
    await seedFile(dir, 'stale', 5 * 60_000) // beyond 1m → shed (never re-queued)
    await seedFile(dir, 'fresh', 5_000) // fresh → processor throws → re-queued
    const queue = new CaptureQueue(
      dir,
      async () => { throw new Error('invoke blew up') },
      async (_error, at) => ({ ...failure, at }),
      undefined, undefined, () => false, 1,
    )
    await queue.drainNow(() => undefined)
    const status = await queue.status()
    assert.equal(status.shedFiles, 1, 'the stale file is shed, not re-queued')
    assert.equal(status.pendingFiles, 1, 'the fresh file failed and is safe — re-queued')
    assert.equal(status.drainedFiles, 0)
    assert.equal(status.lastFailure?.class, 'model-load', 'the fresh failure is still classified')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('shedFiles is absent until something is shed (additive) (#70)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-queue-'))
  try {
    const queue = new CaptureQueue(dir, async () => undefined)
    await queue.append(chunk) // freshly appended → well within the default horizon → never shed
    await queue.drainNow(() => undefined)
    assert.equal((await queue.status()).shedFiles, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// --- #102 keep-time: backlog LAG metric (now − oldest-pending capture time) -------------------

test('lag reports how far behind the present the oldest pending capture is (#102)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-queue-'))
  try {
    const queue = new CaptureQueue(dir)
    // Two pending work chunks with TRUE capture times ~90s and ~30s in the past. The lag is measured
    // against the OLDEST (90s) — that is how far behind the present the pipeline is.
    const ninetyAgo = new Date(Date.now() - 90_000).toISOString()
    const thirtyAgo = new Date(Date.now() - 30_000).toISOString()
    await queue.append(mk({ id: 'old', sessionId: 'sess-old', capturedAt: ninetyAgo }))
    await queue.append(mk({ id: 'new', sessionId: 'sess-new', capturedAt: thirtyAgo }))
    const status = await queue.status()
    assert.equal(status.lag?.basis, 'capture-time')
    assert.equal(status.lag?.oldestPendingCapturedAt, ninetyAgo, 'the oldest pending capture instant is reported')
    assert.ok((status.lag?.behindMs ?? 0) >= 85_000, `behindMs tracks the oldest capture (~90s) — got ${status.lag?.behindMs}`)
    assert.ok((status.lag?.behindMs ?? 0) < 120_000, 'behindMs is now − oldest, not fabricated')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('lag is ABSENT when the queue is caught up (#102)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-queue-'))
  try {
    const queue = new CaptureQueue(dir, async () => undefined)
    assert.equal((await queue.status()).lag, undefined, 'empty queue → no lag (absence = 0 behind)')
    await queue.append(mk({ id: 'c' }))
    await queue.drainNow(() => undefined)
    assert.equal((await queue.status()).lag, undefined, 'fully drained → caught up → lag absent')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('lag ignores focus chunks — it tracks WORK capture time, like byKind/ETA (#102)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-queue-'))
  try {
    const queue = new CaptureQueue(dir)
    // A focus chunk captured LONG ago (routing context) must not inflate the lag; the work chunk governs.
    const longAgo = new Date(Date.now() - 600_000).toISOString()
    const recent = new Date(Date.now() - 20_000).toISOString()
    await queue.append(mk({ id: 'f', sessionId: 'focus-sess', source: 'focus', contentType: 'application/json', capturedAt: longAgo }))
    await queue.append(mk({ id: 'w', sessionId: 'work-sess', capturedAt: recent }))
    const status = await queue.status()
    assert.equal(status.lag?.oldestPendingCapturedAt, recent, 'the focus chunk (10m old) is excluded — the work chunk governs the lag')
    assert.ok((status.lag?.behindMs ?? 0) < 120_000, 'lag reflects the work chunk, not the ancient focus chunk')
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
