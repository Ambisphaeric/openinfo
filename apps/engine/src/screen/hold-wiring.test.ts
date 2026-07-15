import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { CaptureChunk, Flag, WorkflowStep } from '@openinfo/contracts'
import { createSecureTestEngineApp } from '../api/test-control-plane.js'
import { GuardHeldError } from '../fabric/index.js'
import { CaptureQueue } from '../queue/index.js'
import { wireScreenOcr } from './index.js'

const frame = (id: string): CaptureChunk => ({
  id,
  sessionId: 'ses-screen-hold',
  workspaceId: 'default',
  source: 'screen',
  sequence: Number(id.match(/(\d+)$/)?.[1] ?? 1),
  capturedAt: '2026-07-14T16:30:00.000Z',
  contentType: 'image/jpeg',
  encoding: 'base64',
  data: Buffer.from(`PRIVATE_PIXELS_${id}`).toString('base64'),
})

const held = (): GuardHeldError => new GuardHeldError(
  {
    behavior: 'hold-and-surface',
    outcome: 'held',
    guarded: false,
    maskedSpanCount: 0,
    reason: 'trusted LAN screen target received the frame but failed',
  },
  {
    endpoint: 'trusted-lan-ocr',
    url: 'http://192.168.1.50:8000',
    destination: 'lan-local',
    delivery: 'confirmed',
    failureClass: 'model-load',
    consent: { allowed: false, decidedBy: 'content-class', reason: 'screen content permits only explicit trusted-LAN raw-frame processing' },
  },
)

test('wired screen processor durably records metadata-only holds on both legacy and workflow paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-screen-hold-wiring-'))
  const app = createSecureTestEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  const enabled: Flag = { key: 'screen.ocr', default: true, scope: 'engine', description: 'screen hold test' }
  app.store.layouts.put('flag', enabled.key, enabled)
  let invokes = 0
  const processor = wireScreenOcr(app, {
    invoke: async (params) => {
      invokes += 1
      if (Buffer.from(params.image, 'base64').toString('utf8').includes('screen-blank-2')) {
        return { text: '', endpoint: 'trusted-lan-ocr', slot: 'ocr' }
      }
      throw held()
    },
  })
  const legacy = frame('screen-hold-1')
  const workflowBlank = frame('screen-blank-2')
  const workflowHeld = frame('screen-hold-3')
  const step: WorkflowStep = { id: 'screen-ocr', kind: 'ocr', trigger: 'drain', slot: 'ocr', params: {} }
  const queue = new CaptureQueue(join(dir, 'held-screen-queue'), (chunks) => processor.runOnDrain(chunks, step))

  try {
    await processor.process(legacy)
    // One durable raw file contains a successful blank frame followed by a boundary hold.
    await queue.append(workflowBlank)
    await queue.append(workflowHeld)
    await queue.drainNow(() => undefined)
    assert.equal((await queue.status()).pendingFiles, 1, 'the first held attempt remains queued until its terminal retry')
    let holds = app.guardHolds.list('default')
    assert.equal(holds.length, 2)
    assert.deepEqual(holds.map((hold) => hold.sourceChunks?.[0]).sort(), [legacy.id, workflowHeld.id])
    for (const hold of holds) {
      assert.equal(hold.stage, 'screen')
      assert.deepEqual(hold.target, {
        endpoint: 'trusted-lan-ocr', destination: 'lan-local', delivery: 'confirmed', failureClass: 'model-load',
      })
      assert.ok(!JSON.stringify(hold).includes('PRIVATE_PIXELS'))
    }

    // A workflow queue retry consumes the terminally held raw frame without invoking or producing screen
    // text. Approval is audit-only in v0, so neither an active nor later-resolved hold may replay payload.
    await queue.drainNow(() => undefined)
    assert.equal((await queue.status()).pendingFiles, 0)
    assert.equal(invokes, 3, 'legacy held + blank success + workflow held; retry resent neither raw frame')
    holds = app.guardHolds.list('default')
    assert.equal(holds.length, 2)
    const blankCheckpoint = app.store.listOcrResults('default').find((row) => row.sourceChunks.includes(workflowBlank.id))
    assert.equal(blankCheckpoint?.text, '')
    assert.equal(app.store.listDistillates('default').some((row) => row.sourceChunks.includes(workflowBlank.id)), false)
    assert.equal(app.store.listOcrResults('default').some((row) => row.sourceChunks.includes(workflowHeld.id)), false)
    assert.equal(app.store.listDistillates('default').some((row) => row.sourceChunks.includes(workflowHeld.id)), false)
  } finally {
    await queue.stop()
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})
