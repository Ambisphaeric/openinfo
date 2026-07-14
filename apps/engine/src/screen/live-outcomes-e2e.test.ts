import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CaptureChunk, Flag, SenseLaneSnapshot, Session } from '@openinfo/contracts'
import { createSecureTestEngineApp } from '../api/test-control-plane.js'
import { AggregateInvokeError, FabricDocuments, type ClassifiedFailure, type ScreenTextResult } from '../fabric/index.js'
import { wireScreenOcr } from './index.js'

const image = (id: string, sequence: number, capturedAt: string): CaptureChunk => ({
  id, sequence, capturedAt,
  sessionId: 'screen-outcomes-session', workspaceId: 'default', source: 'screen',
  contentType: 'image/jpeg', encoding: 'base64', data: Buffer.from(`PRIVATE-${id}`).toString('base64'),
})

test('wired processor projects blank/failed and ocr.completed success cannot regress after a later failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-live-screen-outcomes-'))
  const app = createSecureTestEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const laneEvents: SenseLaneSnapshot[] = []
  app.bus.subscribe('sense.lane.updated', (snapshot) => void laneEvents.push(snapshot))

  const flag: Flag = { key: 'screen.ocr', default: true, scope: 'engine', description: 'test screen outcomes' }
  app.store.layouts.put('flag', flag.key, flag)
  // #192: lane health now reflects the REAL screen gate chain. This fixture simulates a working OCR path
  // (an injected invoke), so its configuration must honestly match: screen.ocr on AND an occupied ocr
  // slot, refreshed through the same flag.changed seam a Settings edit publishes.
  new FabricDocuments(app.store).save({
    slots: {
      stt: [], tts: [], llm: [], vlm: [], embed: [],
      ocr: [{ kind: 'http', name: 'local-ocr', url: 'http://127.0.0.1:1', api: 'paddle-serving' }],
    },
  })
  await app.bus.publish('flag.changed', flag)
  const session: Session = {
    id: 'screen-outcomes-session', workspaceId: 'default', modeId: 'mode-meeting',
    startedAt: '2026-07-13T12:00:00.000Z', attribution: { evidence: [], confidence: 1 },
  }
  await app.bus.publish('session.started', session)

  const blank = image('screen-blank', 1, '2026-07-13T12:00:01.000Z')
  const failed = image('screen-failed', 2, '2026-07-13T12:00:02.000Z')
  const successful = image('screen-success', 3, '2026-07-13T12:00:03.000Z')
  const classified: ClassifiedFailure = {
    class: 'unreachable', endpoint: 'local-ocr', url: 'http://127.0.0.1:1', hint: 'start the local endpoint',
  }
  let invocation = 0
  const processor = wireScreenOcr(app, {
    invoke: async (): Promise<ScreenTextResult> => {
      invocation++
      if (invocation === 1) return { text: ' ', endpoint: 'local-ocr', slot: 'ocr' }
      if (invocation === 2) throw new AggregateInvokeError('ocr', 'private invoke failure', [classified])
      return { text: 'recognized private text', endpoint: 'local-ocr', slot: 'ocr' }
    },
  })

  // Force a failure strictly after saveOcrResult + ocr.completed. The live lane must retain the earlier
  // successful OCR evidence when legacy process() subsequently reports this mirror-publication failure.
  app.bus.subscribe('distillate.updated', () => {
    throw new Error('private downstream publication failure')
  })

  try {
    app.senseLanes.recordCapture(blank)
    await processor.process(blank)
    let screen = app.senseLanes.snapshotSet('default', session.id).lanes[2]
    assert.deepEqual([screen.disposition, screen.health, screen.reason], ['blank', 'healthy', 'blank'])
    assert.equal(screen.latestProcessing?.captureId, blank.id)
    assert.equal(screen.latestProcessing?.outcome, 'blank')

    app.senseLanes.recordCapture(failed)
    await processor.process(failed) // legacy ingest failure is classified, reported, and swallowed
    screen = app.senseLanes.snapshotSet('default', session.id).lanes[2]
    assert.deepEqual([screen.disposition, screen.health, screen.reason], ['failed', 'failed', 'processing-failed'])
    assert.equal(screen.latestProcessing?.captureId, failed.id)
    assert.equal(screen.latestProcessing?.outcome, 'failed')

    app.senseLanes.recordCapture(successful)
    await processor.process(successful) // resolves even though the later distillate publication throws
    screen = app.senseLanes.snapshotSet('default', session.id).lanes[2]
    assert.deepEqual([screen.disposition, screen.health, screen.reason], ['processed', 'healthy', 'processed'])
    assert.equal(screen.latestProcessing?.captureId, successful.id)
    assert.equal(screen.latestProcessing?.capturedAt, successful.capturedAt)
    assert.equal(screen.latestProcessing?.outcome, 'processed')
    assert.equal(app.store.listOcrResults('default').at(-1)?.sourceChunks[0], successful.id)

    const serialized = JSON.stringify(laneEvents)
    for (const forbidden of [blank.data, failed.data, successful.data, 'recognized private text', 'private invoke failure', 'private downstream publication failure']) {
      assert.equal(serialized.includes(forbidden), false)
    }
    for (const snapshot of laneEvents) {
      for (const key of ['data', 'text', 'preview', 'hash', 'error', 'blocks', 'endpoint']) {
        assert.equal(key in snapshot, false)
      }
    }
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})
