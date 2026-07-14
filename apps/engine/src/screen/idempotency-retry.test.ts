import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { CaptureChunk, Distillate, OcrResult, WorkflowStep } from '@openinfo/contracts'
import { FabricDocuments, type ScreenTextResult } from '../fabric/index.js'
import { WorkspaceRegistry } from '../store/index.js'
import { NEUTRAL_DIALS } from '../voice/index.js'
import { latchScreenRecognitionOwner } from './ownership.js'
import { ScreenOcrProcessor, type ScreenOcrInvoke } from './processor.js'

const frame = (id: string, sequence: number): CaptureChunk =>
  latchScreenRecognitionOwner({
    id,
    sessionId: 'session-retry',
    workspaceId: 'default',
    source: 'screen',
    sequence,
    capturedAt: `2026-07-14T15:00:0${sequence}.000Z`,
    contentType: 'image/jpeg',
    encoding: 'base64',
    data: Buffer.from(id).toString('base64'),
  }, true)

const step: WorkflowStep = {
  id: 'screen-ocr-retry',
  kind: 'ocr',
  slot: 'ocr',
  trigger: 'drain',
  params: {},
}

test('workflow retry skips an earlier successful frame and persists one pair per source chunk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-screen-idempotent-retry-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const first = frame('frame-first', 1)
    const second = frame('frame-second', 2)
    const calls = new Map<string, number>()
    let failSecond = true
    const invoke: ScreenOcrInvoke = async (params): Promise<ScreenTextResult> => {
      const sourceId = Buffer.from(params.image, 'base64').toString('utf8')
      calls.set(sourceId, (calls.get(sourceId) ?? 0) + 1)
      if (sourceId === second.id && failSecond) throw new Error('synthetic second-frame failure')
      return { text: `recognized ${sourceId}`, endpoint: 'fake-ocr', model: 'fake-model', slot: 'ocr' }
    }
    let id = 0
    const processor = new ScreenOcrProcessor({
      store,
      fabric: new FabricDocuments(store),
      isEnabled: () => true,
      invoke,
      newId: () => `retry-record-${++id}`,
    })

    await assert.rejects(processor.runOnDrain([first, second], step), /synthetic second-frame failure/)
    assert.deepEqual(store.listOcrResults('default', first.sessionId).map((row) => row.sourceChunks), [[first.id]])
    assert.deepEqual(store.listDistillates('default', first.sessionId).map((row) => row.sourceChunks), [[first.id]])

    failSecond = false
    await processor.runOnDrain([first, second], step)

    assert.deepEqual(Object.fromEntries(calls), { [first.id]: 1, [second.id]: 2 })
    const ocr = store.listOcrResults('default', first.sessionId)
    const mirrors = store.listDistillates('default', first.sessionId)
    assert.equal(ocr.length, 2)
    assert.equal(mirrors.length, 2)
    for (const sourceId of [first.id, second.id]) {
      assert.equal(ocr.filter((row) => row.sourceChunks.length === 1 && row.sourceChunks[0] === sourceId).length, 1)
      assert.equal(mirrors.filter((row) => row.sourceChunks.length === 1 && row.sourceChunks[0] === sourceId).length, 1)
    }
    const status = processor.status()
    assert.deepEqual(
      { processed: status.processed, failed: status.failed },
      { processed: 2, failed: 1 },
      'the retry counts unique completed frames while retaining the failed attempt',
    )
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('workflow retry republishes a committed pair after mirror publication fails without invoking again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-screen-publish-retry-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const chunk = frame('frame-publish-failure', 3)
    let invokes = 0
    let ocrPublications = 0
    let mirrorPublications = 0
    const processor = new ScreenOcrProcessor({
      store,
      fabric: new FabricDocuments(store),
      isEnabled: () => true,
      invoke: async (): Promise<ScreenTextResult> => {
        invokes++
        return { text: 'durable before observer failure', endpoint: 'fake-ocr', slot: 'ocr' }
      },
      publishOcr: () => {
        ocrPublications++
      },
      publishDistillate: () => {
        mirrorPublications++
        if (mirrorPublications === 1) throw new Error('synthetic mirror observer failure')
      },
      newId: (() => {
        let id = 0
        return () => `publish-retry-record-${++id}`
      })(),
    })

    await assert.rejects(processor.runOnDrain([chunk], step), /synthetic mirror observer failure/)
    assert.equal(store.listOcrResults('default', chunk.sessionId).length, 1)
    assert.equal(store.listDistillates('default', chunk.sessionId).length, 1)

    await processor.runOnDrain([chunk], step)

    assert.equal(invokes, 1, 'the committed recognition is never invoked again')
    assert.equal(ocrPublications, 2, 'the retry republishes the canonical OCR id')
    assert.equal(mirrorPublications, 2, 'the missed mirror publication is retried')
    assert.equal(store.listOcrResults('default', chunk.sessionId).length, 1)
    assert.equal(store.listDistillates('default', chunk.sessionId).length, 1)
    const status = processor.status()
    assert.deepEqual({ processed: status.processed, failed: status.failed }, { processed: 1, failed: 1 })
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('workflow retry repairs either incomplete record direction from the persisted half', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-screen-partial-pair-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const ocrOnly = frame('frame-ocr-only', 4)
    const mirrorOnly = frame('frame-mirror-only', 5)
    const persistedOcr: OcrResult = {
      id: 'persisted-ocr',
      sessionId: ocrOnly.sessionId,
      workspaceId: ocrOnly.workspaceId,
      sourceChunks: [ocrOnly.id],
      text: 'canonical OCR text',
      blocks: [{ text: 'canonical block', confidence: 0.98 }],
      provenance: { slot: 'ocr', endpoint: 'persisted-ocr-endpoint', model: 'persisted-ocr-model' },
      schemaVersion: 1,
      createdAt: '2026-07-14T15:01:04.000Z',
      capturedAt: ocrOnly.capturedAt,
    }
    const persistedMirror: Distillate = {
      id: 'persisted-mirror',
      sessionId: mirrorOnly.sessionId,
      workspaceId: mirrorOnly.workspaceId,
      windowStart: mirrorOnly.capturedAt,
      windowEnd: mirrorOnly.capturedAt,
      sourceChunks: [mirrorOnly.id],
      text: 'canonical mirror text',
      voice: { scope: 'global', dials: NEUTRAL_DIALS },
      provenance: { slot: 'vlm', endpoint: 'persisted-vlm-endpoint', model: 'persisted-vlm-model' },
      schemaVersion: 1,
      createdAt: '2026-07-14T15:01:05.000Z',
    }
    store.saveOcrResult(persistedOcr)
    store.saveDistillate(persistedMirror)

    let invokes = 0
    const processor = new ScreenOcrProcessor({
      store,
      fabric: new FabricDocuments(store),
      isEnabled: () => true,
      invoke: async (): Promise<ScreenTextResult> => {
        invokes++
        return {
          text: 'different retry result',
          blocks: [{ text: 'different retry block', confidence: 0.5 }],
          endpoint: 'retry-endpoint',
          model: 'retry-model',
          slot: 'ocr',
        }
      },
      newId: (() => {
        let id = 0
        return () => `partial-repair-record-${++id}`
      })(),
    })

    await processor.runOnDrain([ocrOnly, mirrorOnly], step)

    assert.equal(invokes, 2)
    const ocrRows = store.listOcrResults('default', ocrOnly.sessionId)
    const mirrorRows = store.listDistillates('default', ocrOnly.sessionId)
    assert.equal(ocrRows.filter((row) => row.sourceChunks[0] === ocrOnly.id).length, 1)
    assert.equal(mirrorRows.filter((row) => row.sourceChunks[0] === ocrOnly.id).length, 1)
    const repairedMirror = mirrorRows.find((row) => row.sourceChunks[0] === ocrOnly.id)
    assert.equal(repairedMirror?.text, persistedOcr.text)
    assert.deepEqual(repairedMirror?.provenance, persistedOcr.provenance)

    assert.equal(ocrRows.filter((row) => row.sourceChunks[0] === mirrorOnly.id).length, 1)
    assert.equal(mirrorRows.filter((row) => row.sourceChunks[0] === mirrorOnly.id).length, 1)
    const repairedOcr = ocrRows.find((row) => row.sourceChunks[0] === mirrorOnly.id)
    assert.equal(repairedOcr?.text, persistedMirror.text)
    assert.equal(repairedOcr?.capturedAt, persistedMirror.windowStart)
    assert.deepEqual(repairedOcr?.provenance, persistedMirror.provenance)
    assert.equal(repairedOcr?.blocks, undefined, 'retry geometry is not attached to canonical mirror text')
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('concurrent legacy replay commits one pair and counts the source frame once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-screen-concurrent-replay-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const chunk: CaptureChunk = {
      id: 'frame-concurrent-replay',
      sessionId: 'session-retry',
      workspaceId: 'default',
      source: 'screen',
      sequence: 6,
      capturedAt: '2026-07-14T15:00:06.000Z',
      contentType: 'image/jpeg',
      encoding: 'base64',
      data: Buffer.from('frame-concurrent-replay').toString('base64'),
    }
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let started = 0
    let bothStarted = (): void => undefined
    const startedTwice = new Promise<void>((resolve) => { bothStarted = resolve })
    const processor = new ScreenOcrProcessor({
      store,
      fabric: new FabricDocuments(store),
      isEnabled: () => true,
      invoke: async (): Promise<ScreenTextResult> => {
        started++
        if (started === 2) bothStarted()
        await gate
        return { text: 'one canonical replay result', endpoint: 'fake-ocr', slot: 'ocr' }
      },
      newId: (() => {
        let id = 0
        return () => `concurrent-replay-record-${++id}`
      })(),
    })

    const first = processor.process(chunk)
    const duplicate = processor.process(chunk)
    await startedTwice
    release()
    await Promise.all([first, duplicate])

    assert.equal(started, 2, 'the transport-level duplicate raced before recognition completed')
    assert.equal(store.listOcrResults('default', chunk.sessionId).length, 1)
    assert.equal(store.listDistillates('default', chunk.sessionId).length, 1)
    assert.deepEqual(
      { processed: processor.status().processed, failed: processor.status().failed },
      { processed: 1, failed: 0 },
    )
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
