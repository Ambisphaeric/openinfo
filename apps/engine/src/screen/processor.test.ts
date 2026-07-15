import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk, Distillate, OcrResult, ScreenProcessingOutcome, VlmInvokeParams, WorkflowStep } from '@openinfo/contracts'
import { createFixtureReplay, loadFixtureSync } from '../../../../tools/fixtures/model.mjs'
import { AggregateInvokeError, FabricDocuments, defaultFabric, toQueueFailure, type ClassifiedFailure, type ScreenTextResult } from '../fabric/index.js'
import { CaptureQueue } from '../queue/index.js'
import { WorkspaceRegistry } from '../store/index.js'
import { ScreenOcrProcessor, type ScreenOcrInvoke, type ScreenVlmInvoke } from './processor.js'

const withStore = async (fn: (store: WorkspaceRegistry) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-screen-'))
  const store = new WorkspaceRegistry(dir)
  try {
    await fn(store)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
}

const imageChunk = (over: Partial<CaptureChunk> = {}): CaptureChunk => ({
  id: 'scr-s1-000001',
  sessionId: 's1',
  workspaceId: 'default',
  source: 'screen',
  sequence: 1,
  capturedAt: '2026-07-08T10:00:00.000Z',
  contentType: 'image/jpeg',
  encoding: 'base64',
  data: Buffer.from('JPEGDATA').toString('base64'),
  ...over,
})

const metaChunk = (): CaptureChunk => ({
  id: 'scr-s1-000002',
  sessionId: 's1',
  workspaceId: 'default',
  source: 'screen',
  sequence: 2,
  capturedAt: '2026-07-08T10:00:00.000Z',
  contentType: 'application/json',
  encoding: 'utf8',
  data: JSON.stringify({ displayId: '1', width: 200, height: 100 }),
})

/** A newId that hands out stable, distinct ids so OcrResult and Distillate never collide in a test. */
const counterId = (): (() => string) => {
  let n = 0
  return () => `id-${++n}`
}

test('fixture replay: real screen processor persists byte-identical OCR/distillate records with no model or network call', async () => {
  await withStore(async (store) => {
    const fixture = loadFixtureSync(new URL('../../../../tools/fixtures/fixtures/synthetic-converged.v1.json', import.meta.url))
    const replay = createFixtureReplay(fixture)
    const frame = replay.captures('screen').find((chunk) => chunk.contentType === 'image/jpeg')
    assert.ok(frame, 'synthetic fixture has a screen image')
    const distillates: Distillate[] = []
    const ocrs: OcrResult[] = []
    const run = async (): Promise<void> => {
      const processor = new ScreenOcrProcessor({
        store,
        fabric: new FabricDocuments(store),
        isEnabled: () => true,
        // Capture-scoped lookup prevents identical bytes in another lane/frame from crossing provenance.
        invoke: (params) => replay.invokeOcrFor(frame.id, params),
        publishDistillate: (d) => {
          distillates.push(d)
        },
        publishOcr: (r) => {
          ocrs.push(r)
        },
        reportProcessingOutcome: () => assert.fail('successful OCR is reported only through ocr.completed'),
        now: replay.now,
        newId: replay.newId,
      })
      await processor.process(frame)
      const status = processor.status()
      assert.deepEqual([status.processed, status.blank, status.skipped, status.failed], [1, 0, 0, 0])
    }

    await run()

    const stored = store.listOcrResults('workspace-synthetic')
    assert.equal(stored.length, 1)
    assert.equal(stored[0]!.text, 'Pull request 150 — checks passing')
    assert.equal(stored[0]!.sourceChunks[0], 'cap-screen-image-0001')
    assert.equal(stored[0]!.provenance.slot, 'ocr')
    assert.equal(stored[0]!.provenance.endpoint, 'fixture-ocr')
    assert.equal(stored[0]!.provenance.model, 'synthetic-ocr')
    assert.equal(stored[0]!.provenance.usage?.durationMs, 180)
    assert.equal(stored[0]!.provenance.egress?.decidedBy, 'content-class')
    assert.equal(stored[0]!.blocks?.length, 2)
    assert.deepEqual(stored[0]!.blocks?.[0]?.region, { x: 24, y: 30, width: 210, height: 28 })
    assert.equal(stored[0]!.capturedAt, '2026-07-12T13:00:02.000Z', 'capturedAt = the frame capture instant')
    assert.equal(stored[0]!.createdAt, '2026-07-12T13:00:03.000Z', 'createdAt = the fixture replay clock')

    const distilled = store.listDistillates('workspace-synthetic')
    assert.equal(distilled.length, 1)
    assert.equal(distilled[0]!.text, 'Pull request 150 — checks passing')
    assert.equal(distilled[0]!.windowStart, '2026-07-12T13:00:02.000Z')
    assert.equal(distilled[0]!.windowEnd, '2026-07-12T13:00:02.000Z')
    assert.equal(distilled[0]!.voice.scope, 'global')
    assert.equal(distilled[0]!.provenance.slot, 'ocr')

    const firstRecords = { ocr: structuredClone(stored[0]), distillate: structuredClone(distilled[0]) }
    replay.reset()
    await run()
    assert.equal(store.listOcrResults('workspace-synthetic').length, 1, 'stable replay id replaces instead of duplicating')
    assert.equal(store.listDistillates('workspace-synthetic').length, 1, 'stable replay id replaces instead of duplicating')
    assert.deepEqual(store.listOcrResults('workspace-synthetic')[0], firstRecords.ocr)
    assert.deepEqual(store.listDistillates('workspace-synthetic')[0], firstRecords.distillate)
    assert.deepEqual([ocrs.length, distillates.length], [2, 2])
  })
})

test('trusted-LAN destination provenance is identical on OcrResult and mirror Distillate', async () => {
  await withStore(async (store) => {
    const egress = {
      reach: 'local' as const,
      allowed: false,
      decidedBy: 'content-class' as const,
      reason:
        'raw screen bytes crossed the device boundary to an explicitly trusted LAN destination; hosted/public egress remained denied',
      destination: 'lan-local' as const,
      rawFrameTrust: 'explicit' as const,
    }
    const invoke: ScreenOcrInvoke = async (): Promise<ScreenTextResult> => ({
      text: 'trusted LAN result',
      endpoint: 'trusted-vision-box',
      model: 'vision-local',
      slot: 'ocr',
      egress,
    })
    const processor = new ScreenOcrProcessor({
      store,
      fabric: new FabricDocuments(store),
      isEnabled: () => true,
      invoke,
      newId: counterId(),
    })

    await processor.process(imageChunk())

    const result = store.listOcrResults('default')[0]
    const mirror = store.listDistillates('default')[0]
    assert.ok(result)
    assert.ok(mirror)
    assert.deepEqual(result.provenance, mirror.provenance)
    assert.deepEqual(result.provenance.egress, egress)
    assert.equal(result.provenance.egress?.destination, 'lan-local')
    assert.equal(result.provenance.egress?.rawFrameTrust, 'explicit')
    const serialized = JSON.stringify({ result: result.provenance, mirror: mirror.provenance })
    assert.equal(serialized.includes('http://'), false)
    assert.equal(serialized.includes('secret'), false)
  })
})

test('flag off ⇒ the frame is left untouched — invoke never called, nothing persisted, uncounted', async () => {
  await withStore(async (store) => {
    let called = false
    const invoke: ScreenOcrInvoke = async () => {
      called = true
      throw new Error('should not be called')
    }
    const processor = new ScreenOcrProcessor({ store, fabric: new FabricDocuments(store), isEnabled: () => false, invoke })
    await processor.process(imageChunk())
    assert.equal(called, false)
    assert.equal(store.listOcrResults('default').length, 0)
    assert.equal(store.listDistillates('default').length, 0)
    const s = processor.status()
    assert.deepEqual([s.processed, s.blank, s.skipped, s.failed], [0, 0, 0, 0])
  })
})

test('the companion ScreenFrameMeta chunk is skipped and counted, never recognized', async () => {
  await withStore(async (store) => {
    let called = false
    const outcomes: ScreenProcessingOutcome[] = []
    const invoke: ScreenOcrInvoke = async () => {
      called = true
      throw new Error('should not be called')
    }
    const processor = new ScreenOcrProcessor({
      store, fabric: new FabricDocuments(store), isEnabled: () => true, invoke,
      reportProcessingOutcome: (outcome) => void outcomes.push(outcome),
    })
    await processor.process(metaChunk())
    assert.equal(called, false)
    assert.equal(store.listOcrResults('default').length, 0)
    assert.equal(processor.status().skipped, 1)
    assert.equal(processor.status().processed, 0)
    assert.deepEqual(outcomes, [], 'ScreenStatus.skipped remains local accounting for companion metadata only')
  })
})

test('empty recognized text persists only a blank completion checkpoint and is counted as blank', async () => {
  await withStore(async (store) => {
    const invoke: ScreenOcrInvoke = async (): Promise<ScreenTextResult> => ({ text: '   ', endpoint: 'vlm', slot: 'ocr' })
    const outcomes: ScreenProcessingOutcome[] = []
    const logs: string[] = []
    const processor = new ScreenOcrProcessor({
      store, fabric: new FabricDocuments(store), isEnabled: () => true, invoke,
      now: () => new Date('2026-07-08T10:00:02.000Z'),
      reportProcessingOutcome: async (outcome) => {
        outcomes.push(outcome)
        throw new Error('PRIVATE REPORTER FAILURE')
      },
      log: (line) => void logs.push(line),
    })
    await processor.process(imageChunk())
    const checkpoints = store.listOcrResults('default')
    assert.equal(checkpoints.length, 1)
    assert.equal(checkpoints[0]?.text, '')
    assert.equal(checkpoints[0]?.provenance.endpoint, 'vlm')
    assert.equal(store.listDistillates('default').length, 0)
    assert.deepEqual([processor.status().blank, processor.status().processed], [1, 0])
    assert.deepEqual(outcomes, [{
      workspaceId: 'default', sessionId: 's1', outcome: 'blank',
      capture: { id: 'scr-s1-000001', capturedAt: '2026-07-08T10:00:00.000Z' },
      completedAt: '2026-07-08T10:00:02.000Z',
    }])
    assert.equal(JSON.stringify(outcomes).includes('JPEGDATA'), false)
    assert.equal(logs.some((line) => line.includes('PRIVATE REPORTER FAILURE')), false, 'reporter errors are not copied into telemetry/logs')
  })
})

test('a non-screen chunk is ignored entirely (not ours, not counted)', async () => {
  await withStore(async (store) => {
    let called = false
    const invoke: ScreenOcrInvoke = async () => {
      called = true
      throw new Error('should not be called')
    }
    const processor = new ScreenOcrProcessor({ store, fabric: new FabricDocuments(store), isEnabled: () => true, invoke })
    await processor.process(imageChunk({ source: 'mic', contentType: 'audio/webm' }))
    assert.equal(called, false)
    const s = processor.status()
    assert.deepEqual([s.processed, s.blank, s.skipped, s.failed], [0, 0, 0, 0])
  })
})

test('an invoke failure is classified into the last-failures ring and never thrown', async () => {
  await withStore(async (store) => {
    const classified: ClassifiedFailure = { class: 'unreachable', endpoint: 'paddle-box', url: 'http://127.0.0.1:1', hint: 'is the server running?' }
    const invoke: ScreenOcrInvoke = async () => {
      throw new AggregateInvokeError('ocr', 'no ocr endpoint answered', [classified])
    }
    const outcomes: ScreenProcessingOutcome[] = []
    const processor = new ScreenOcrProcessor({
      store, fabric: new FabricDocuments(store), isEnabled: () => true, invoke,
      now: () => new Date('2026-07-08T10:00:01.000Z'),
      reportProcessingOutcome: (outcome) => void outcomes.push(outcome),
    })
    await processor.process(imageChunk()) // must resolve, not reject
    const status = processor.status()
    assert.equal(status.failed, 1)
    assert.equal(status.processed, 0)
    assert.equal(status.lastFailures.length, 1)
    assert.equal(status.lastFailures[0]!.class, 'unreachable')
    assert.equal(status.lastFailures[0]!.endpoint, 'paddle-box')
    assert.equal(status.lastFailures[0]!.at, '2026-07-08T10:00:01.000Z')
    assert.equal(store.listOcrResults('default').length, 0)
    assert.deepEqual(outcomes, [{
      workspaceId: 'default', sessionId: 's1', outcome: 'failed',
      capture: { id: 'scr-s1-000001', capturedAt: '2026-07-08T10:00:00.000Z' },
      completedAt: '2026-07-08T10:00:01.000Z',
    }])
  })
})

test('an OCR server echoing a raw frame cannot copy it into processor status or logs', async () => {
  const rawFrameSentinel = Buffer.from('RAW_FRAME_ECHO_SENTINEL_PROCESSOR_175').toString('base64')
  let receivedBody = ''
  const echo = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      receivedBody = Buffer.concat(chunks).toString('utf8')
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `server echoed request: ${receivedBody}` }))
    })
  })
  await new Promise<void>((resolve) => echo.listen(0, resolve))
  const address = echo.address()
  assert.ok(address && typeof address === 'object')
  const url = `http://127.0.0.1:${address.port}`
  try {
    await withStore(async (store) => {
      const fabric = new FabricDocuments(store)
      fabric.save({
        slots: {
          ...defaultFabric().slots,
          ocr: [{ kind: 'http', name: 'echoing-paddle', url, api: 'paddle-serving', model: 'pp-ocrv4' }],
        },
      })
      const logs: string[] = []
      const processor = new ScreenOcrProcessor({
        store,
        fabric,
        isEnabled: () => true,
        log: (line) => void logs.push(line),
      })

      await processor.process(imageChunk({ data: rawFrameSentinel }))

      const status = processor.status()
      assert.equal(status.failed, 1)
      assert.equal(status.lastFailures[0]?.class, 'model-load')
      assert.equal(status.lastFailures[0]?.endpoint, 'echoing-paddle')
      assert.equal(status.lastFailures[0]?.model, 'pp-ocrv4')
      assert.equal(status.lastFailures[0]?.serverMessage, 'HTTP 500')
      assert.match(status.lastFailures[0]?.hint ?? '', /model "pp-ocrv4" failed to load/)
      assert.equal(receivedBody.includes(rawFrameSentinel), true, 'fake endpoint really received and echoed the sentinel')
      assert.equal(JSON.stringify(status).includes(rawFrameSentinel), false, 'GET /screen/status source state must not retain frame bytes')
      assert.equal(logs.join('\n').includes(rawFrameSentinel), false, 'processor logs must not retain frame bytes')
    })
  } finally {
    await new Promise<void>((resolve) => echo.close(() => resolve()))
  }
})

test('legacy OCR surfaces a boundary delivery hold without exposing the trusted-LAN endpoint URL', async () => {
  const configuredUrl = 'http://ocr-url-sentinel.example.invalid.local:48151/private-screen-route'
  const attempted: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    attempted.push(url)
    // Deliberately omit an OS error code: this forces the actionable unreachable hint into the
    // aggregate error/log, which is where a configured URL used to escape.
    throw new Error('documentation-only transport failure')
  }
  try {
    await withStore(async (store) => {
      const fabric = new FabricDocuments(store)
      fabric.save({
        slots: {
          ...defaultFabric().slots,
          ocr: [{
            kind: 'http',
            name: 'trusted-lan-ocr',
            url: configuredUrl,
            api: 'paddle-serving',
            model: 'screen-ocr-test-model',
            trustRawFrames: true,
          }],
        },
      })
      const logs: string[] = []
      const processor = new ScreenOcrProcessor({
        store,
        fabric,
        isEnabled: () => true,
        log: (line) => void logs.push(line),
      })

      await processor.process(imageChunk())

      assert.deepEqual(attempted, [`${configuredUrl}/predict/ocr_system`], 'the configured endpoint was actually attempted')
      const status = processor.status()
      assert.equal(status.failed, 1)
      assert.equal(status.lastFailures[0]?.class, 'guard-held')
      assert.equal(status.lastFailures[0]?.endpoint, 'trusted-lan-ocr')
      const surfaced = JSON.stringify({ status, logs })
      assert.equal(surfaced.includes(configuredUrl), false)
      assert.equal(surfaced.includes('ocr-url-sentinel.example.invalid.local'), false)
      assert.equal(surfaced.includes('/private-screen-route'), false)
      assert.match(surfaced, /trusted-lan-ocr/, 'the safe endpoint label remains actionable')
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('the last-failures ring is bounded to failureRingSize, keeping the newest', async () => {
  await withStore(async (store) => {
    let i = 0
    const invoke: ScreenOcrInvoke = async () => {
      i++
      throw new AggregateInvokeError('ocr', 'boom', [{ class: 'timeout', endpoint: `ep-${i}`, url: 'u', hint: 'h' }])
    }
    const processor = new ScreenOcrProcessor({ store, fabric: new FabricDocuments(store), isEnabled: () => true, invoke, failureRingSize: 2 })
    await processor.process(imageChunk())
    await processor.process(imageChunk())
    await processor.process(imageChunk())
    const status = processor.status()
    assert.equal(status.failed, 3)
    assert.equal(status.lastFailures.length, 2)
    assert.deepEqual(status.lastFailures.map((f) => f.endpoint), ['ep-2', 'ep-3'])
  })
})

// --- runOnDrain: the workflow executor's ocr/vlm DRAIN stage (P4A×P4B joint slice) ------------------
const ocrStep = (over: Partial<WorkflowStep> = {}): WorkflowStep =>
  ({ id: 'screen-ocr', kind: 'ocr', slot: 'ocr', trigger: 'drain', when: { flag: 'screen.ocr' }, params: {}, ...over })

test('runOnDrain: an ocr step recognizes the batch screen frames via the ocr slot → OcrResult + distillate persisted', async () => {
  await withStore(async (store) => {
    const seen: string[] = []
    const invoke: ScreenOcrInvoke = async (params): Promise<ScreenTextResult> => {
      seen.push(params.image)
      return { text: 'PR #7 — wire ocr drain', blocks: [{ text: 'PR #7 — wire ocr drain' }], endpoint: 'paddle', model: 'pp-ocrv4', slot: 'ocr' }
    }
    const processor = new ScreenOcrProcessor({ store, fabric: new FabricDocuments(store), isEnabled: () => true, invoke, newId: counterId() })
    // The batch: one image, its companion meta chunk, and an audio chunk — only the image is recognized.
    await processor.runOnDrain([imageChunk(), metaChunk(), imageChunk({ id: 'x', source: 'mic', contentType: 'audio/webm' })], ocrStep())
    assert.equal(seen.length, 1) // only the image frame invoked
    const stored = store.listOcrResults('default')
    assert.equal(stored.length, 1)
    assert.equal(stored[0]!.text, 'PR #7 — wire ocr drain')
    assert.equal(stored[0]!.provenance.slot, 'ocr')
    assert.equal(store.listDistillates('default').length, 1)
    const s = processor.status()
    assert.deepEqual([s.processed, s.blank, s.skipped, s.failed], [1, 0, 1, 0]) // meta counted as skipped
  })
})

test('runOnDrain: a vlm step invokes the VLM slot with the step prompt (not the ocr slot)', async () => {
  await withStore(async (store) => {
    let ocrCalled = false
    const invoke: ScreenOcrInvoke = async () => {
      ocrCalled = true
      throw new Error('ocr slot must not be called for a vlm step')
    }
    const prompts: string[] = []
    const invokeVlm: ScreenVlmInvoke = async (params: VlmInvokeParams): Promise<ScreenTextResult> => {
      prompts.push(params.prompt)
      return { text: 'a code editor with a failing test', endpoint: 'qwen-vl', slot: 'vlm' }
    }
    const processor = new ScreenOcrProcessor({ store, fabric: new FabricDocuments(store), isEnabled: () => true, invoke, invokeVlm, newId: counterId() })
    await processor.runOnDrain([imageChunk()], ocrStep({ id: 'screen-vlm', kind: 'vlm', slot: 'vlm', params: { prompt: 'What is on screen?' } }))
    assert.equal(ocrCalled, false)
    assert.deepEqual(prompts, ['What is on screen?'])
    const stored = store.listOcrResults('default')
    assert.equal(stored.length, 1)
    assert.equal(stored[0]!.provenance.slot, 'vlm')
    assert.equal(stored[0]!.text, 'a code editor with a failing test')
  })
})

test('runOnDrain: an invoke throw PROPAGATES (real drain work → re-queue), NOT swallowed into the ring', async () => {
  await withStore(async (store) => {
    const original = new AggregateInvokeError('ocr', 'no ocr endpoint answered', [{ class: 'unreachable', endpoint: 'paddle', url: 'u', hint: 'h' }])
    const invoke: ScreenOcrInvoke = async () => {
      throw original
    }
    const outcomes: ScreenProcessingOutcome[] = []
    const processor = new ScreenOcrProcessor({
      store, fabric: new FabricDocuments(store), isEnabled: () => true, invoke,
      now: () => new Date('2026-07-08T10:00:04.000Z'),
      reportProcessingOutcome: async (outcome) => {
        outcomes.push(outcome)
        throw new Error('reporter must not replace workflow failure')
      },
    })
    await assert.rejects(
      () => processor.runOnDrain([imageChunk()], ocrStep()),
      (error: unknown) => error === original,
    )
    // Drain failures are the QUEUE's health, not the processor ring — so the ring stays empty here.
    assert.equal(processor.status().lastFailures.length, 0)
    assert.equal(processor.status().failed, 1)
    assert.equal(store.listOcrResults('default').length, 0)
    assert.deepEqual(outcomes, [{
      workspaceId: 'default', sessionId: 's1', outcome: 'failed',
      capture: { id: 'scr-s1-000001', capturedAt: '2026-07-08T10:00:00.000Z' },
      completedAt: '2026-07-08T10:00:04.000Z',
    }])
  })
})

test('workflow VLM surfaces a boundary delivery hold without exposing its trusted-LAN URL', async () => {
  const configuredUrl = 'http://vlm-url-sentinel.example.invalid.local:48152/private-workflow-route'
  const attempted: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    attempted.push(url)
    throw new Error('documentation-only transport failure')
  }
  try {
    await withStore(async (store) => {
      const fabric = new FabricDocuments(store)
      fabric.save({
        slots: {
          ...defaultFabric().slots,
          vlm: [{
            kind: 'http',
            name: 'trusted-lan-vlm',
            url: configuredUrl,
            api: 'openai-compat',
            model: 'screen-vlm-test-model',
            trustRawFrames: true,
          }],
        },
      })
      const processorLogs: string[] = []
      const processor = new ScreenOcrProcessor({
        store,
        fabric,
        isEnabled: () => true,
        log: (line) => void processorLogs.push(line),
      })
      const step = ocrStep({
        id: 'screen-vlm-private',
        kind: 'vlm',
        slot: 'vlm',
        params: { prompt: 'Describe this documentation-only test frame.' },
      })
      const queueLogs: string[] = []
      const queue = new CaptureQueue(
        join(store.dataDir, 'privacy-workflow-queue'),
        (chunks) => processor.runOnDrain(chunks, step),
        (error, at) => toQueueFailure(error, at, async (failure) => failure.hint),
      )
      await queue.append(imageChunk())

      await queue.drainNow((line) => void queueLogs.push(line))

      assert.deepEqual(attempted, [`${configuredUrl}/v1/chat/completions`], 'the configured endpoint was actually attempted')
      const status = await queue.status()
      assert.equal(status.pendingFiles, 1, 'the failed workflow frame remains queued for retry')
      assert.equal(status.lastFailure?.class, 'guard-held')
      assert.equal(status.lastFailure?.endpoint, 'trusted-lan-vlm')
      assert.equal(processor.status().lastFailures.length, 0, 'workflow failures remain queue-owned')
      const surfaced = JSON.stringify({ queueFailure: status.lastFailure, queueLogs, processorLogs })
      assert.equal(surfaced.includes(configuredUrl), false)
      assert.equal(surfaced.includes('vlm-url-sentinel.example.invalid.local'), false)
      assert.equal(surfaced.includes('/private-workflow-route'), false)
      assert.match(surfaced, /trusted-lan-vlm/, 'the safe endpoint label remains actionable')
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('runOnDrain: an empty recognition persists a blank checkpoint without a text mirror', async () => {
  await withStore(async (store) => {
    const invoke: ScreenOcrInvoke = async (): Promise<ScreenTextResult> => ({ text: '', endpoint: 'paddle', slot: 'ocr' })
    const outcomes: ScreenProcessingOutcome[] = []
    const processor = new ScreenOcrProcessor({
      store, fabric: new FabricDocuments(store), isEnabled: () => true, invoke,
      reportProcessingOutcome: (outcome) => void outcomes.push(outcome),
    })
    await processor.runOnDrain([imageChunk()], ocrStep())
    assert.equal(store.listOcrResults('default').length, 1)
    assert.equal(store.listOcrResults('default')[0]?.text, '')
    assert.equal(store.listDistillates('default').length, 0)
    assert.deepEqual([processor.status().blank, processor.status().processed], [1, 0])
    assert.equal(outcomes[0]?.outcome, 'blank')
  })
})
