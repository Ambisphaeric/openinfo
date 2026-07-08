import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk, Distillate, Fabric, OcrResult, VlmInvokeParams, WorkflowStep } from '@openinfo/contracts'
import { AggregateInvokeError, FabricDocuments, type ClassifiedFailure, type ScreenTextResult } from '../fabric/index.js'
import { WorkspaceRegistry } from '../store/index.js'
import { ScreenOcrProcessor, type ScreenOcrInvoke, type ScreenVlmInvoke } from './processor.js'

/** A PaddleHub ocr_system region — [box corners], text, confidence — as the real serving returns it. */
interface PaddleRegion {
  text: string
  confidence: number
  text_region: [number, number][]
}

const startFakePaddle = async (regions: PaddleRegion[]): Promise<{ server: Server; url: string }> => {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: '0', results: [regions] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}` }
}

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

test('recognizes a screen frame via the fabric ocr slot → OcrResult + distillate, both persisted + published', async () => {
  await withStore(async (store) => {
    const paddle = await startFakePaddle([
      { text: 'File  Edit  View', confidence: 0.98, text_region: [[12, 8], [180, 8], [180, 30], [12, 30]] },
      { text: 'error: build failed', confidence: 0.91, text_region: [[12, 44], [220, 44], [220, 66], [12, 66]] },
    ])
    // The live fabric (no active profile) reads the legacy config/fabric doc — put an ocr endpoint there.
    const fabric: Fabric = {
      slots: { stt: [], tts: [], llm: [], vlm: [], embed: [], ocr: [{ kind: 'http', name: 'paddle-box', url: paddle.url, api: 'paddle-serving', model: 'pp-ocrv4' }] },
    }
    store.layouts.put('config', 'fabric', fabric)
    const distillates: Distillate[] = []
    const ocrs: OcrResult[] = []
    try {
      const processor = new ScreenOcrProcessor({
        store,
        fabric: new FabricDocuments(store),
        isEnabled: () => true,
        publishDistillate: (d) => {
          distillates.push(d)
        },
        publishOcr: (r) => {
          ocrs.push(r)
        },
        now: () => new Date('2026-07-08T10:00:01.000Z'),
        newId: counterId(),
      })
      await processor.process(imageChunk())

      const stored = store.listOcrResults('default')
      assert.equal(stored.length, 1)
      assert.equal(stored[0]!.text, 'File  Edit  View\nerror: build failed')
      assert.equal(stored[0]!.sourceChunks[0], 'scr-s1-000001')
      assert.equal(stored[0]!.provenance.slot, 'ocr')
      assert.equal(stored[0]!.provenance.endpoint, 'paddle-box')
      assert.equal(stored[0]!.provenance.model, 'pp-ocrv4')
      assert.equal(stored[0]!.blocks?.length, 2)
      assert.deepEqual(stored[0]!.blocks?.[0]?.region, { x: 12, y: 8, width: 168, height: 22 })

      const distilled = store.listDistillates('default')
      assert.equal(distilled.length, 1)
      assert.equal(distilled[0]!.text, 'File  Edit  View\nerror: build failed')
      assert.equal(distilled[0]!.windowStart, '2026-07-08T10:00:00.000Z')
      assert.equal(distilled[0]!.windowEnd, '2026-07-08T10:00:00.000Z')
      assert.equal(distilled[0]!.voice.scope, 'global')
      assert.equal(distilled[0]!.provenance.slot, 'ocr')

      assert.deepEqual([ocrs.length, distillates.length], [1, 1])
      const status = processor.status()
      assert.deepEqual([status.processed, status.blank, status.skipped, status.failed], [1, 0, 0, 0])
    } finally {
      await new Promise<void>((resolve) => paddle.server.close(() => resolve()))
    }
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
    const invoke: ScreenOcrInvoke = async () => {
      called = true
      throw new Error('should not be called')
    }
    const processor = new ScreenOcrProcessor({ store, fabric: new FabricDocuments(store), isEnabled: () => true, invoke })
    await processor.process(metaChunk())
    assert.equal(called, false)
    assert.equal(store.listOcrResults('default').length, 0)
    assert.equal(processor.status().skipped, 1)
    assert.equal(processor.status().processed, 0)
  })
})

test('empty recognized text is a blank frame — neither record persisted, counted as blank', async () => {
  await withStore(async (store) => {
    const invoke: ScreenOcrInvoke = async (): Promise<ScreenTextResult> => ({ text: '   ', endpoint: 'vlm', slot: 'ocr' })
    const processor = new ScreenOcrProcessor({ store, fabric: new FabricDocuments(store), isEnabled: () => true, invoke })
    await processor.process(imageChunk())
    assert.equal(store.listOcrResults('default').length, 0)
    assert.equal(store.listDistillates('default').length, 0)
    assert.deepEqual([processor.status().blank, processor.status().processed], [1, 0])
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
    const processor = new ScreenOcrProcessor({ store, fabric: new FabricDocuments(store), isEnabled: () => true, invoke, now: () => new Date('2026-07-08T10:00:01.000Z') })
    await processor.process(imageChunk()) // must resolve, not reject
    const status = processor.status()
    assert.equal(status.failed, 1)
    assert.equal(status.processed, 0)
    assert.equal(status.lastFailures.length, 1)
    assert.equal(status.lastFailures[0]!.class, 'unreachable')
    assert.equal(status.lastFailures[0]!.endpoint, 'paddle-box')
    assert.equal(status.lastFailures[0]!.at, '2026-07-08T10:00:01.000Z')
    assert.equal(store.listOcrResults('default').length, 0)
  })
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
    const invoke: ScreenOcrInvoke = async () => {
      throw new AggregateInvokeError('ocr', 'no ocr endpoint answered', [{ class: 'unreachable', endpoint: 'paddle', url: 'u', hint: 'h' }])
    }
    const processor = new ScreenOcrProcessor({ store, fabric: new FabricDocuments(store), isEnabled: () => true, invoke })
    await assert.rejects(() => processor.runOnDrain([imageChunk()], ocrStep()), /no ocr endpoint answered/)
    // Drain failures are the QUEUE's health, not the processor ring — so the ring stays empty here.
    assert.equal(processor.status().lastFailures.length, 0)
    assert.equal(store.listOcrResults('default').length, 0)
  })
})

test('runOnDrain: an empty recognition is a blank frame — neither record persisted, counted as blank', async () => {
  await withStore(async (store) => {
    const invoke: ScreenOcrInvoke = async (): Promise<ScreenTextResult> => ({ text: '', endpoint: 'paddle', slot: 'ocr' })
    const processor = new ScreenOcrProcessor({ store, fabric: new FabricDocuments(store), isEnabled: () => true, invoke })
    await processor.runOnDrain([imageChunk()], ocrStep())
    assert.equal(store.listOcrResults('default').length, 0)
    assert.deepEqual([processor.status().blank, processor.status().processed], [1, 0])
  })
})
