import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { CaptureChunk, Flag } from '@openinfo/contracts'
import { createSecureTestEngineApp, secureTestFetch } from '../api/test-control-plane.js'
import type { ScreenTextResult } from '../fabric/index.js'
import { screenRecognitionOwner } from './ownership.js'
import { wireScreenOcr, type ScreenOcrInvoke } from './index.js'

const setFlag = (store: ReturnType<typeof createSecureTestEngineApp>['store'], key: string, on: boolean): void => {
  const flag: Flag = { key, default: on, scope: 'engine', description: `ownership latch test: ${key}` }
  store.layouts.put('flag', key, flag)
}

const eventually = async (assertion: () => void | Promise<void>, timeoutMs = 4_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  throw lastError instanceof Error ? lastError : new Error('ownership latch condition was not met')
}

const frame = (id: string): CaptureChunk => ({
  id,
  sessionId: `session-${id}`,
  workspaceId: 'default',
  source: 'screen',
  sequence: 1,
  capturedAt: '2026-07-14T16:00:00.000Z',
  contentType: 'image/jpeg',
  encoding: 'base64',
  data: Buffer.from(`pixels-${id}`).toString('base64'),
})

const runInFlightFlip = async (initialWorkflow: boolean): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), `openinfo-screen-owner-${initialWorkflow ? 'on' : 'off'}-`))
  const app = createSecureTestEngineApp({ dataRoot: dir, log: () => undefined })
  let releaseBus = (): void => undefined
  let releaseLegacyInvoke = (): void => undefined
  const busGate = new Promise<void>((resolve) => { releaseBus = resolve })
  const legacyInvokeGate = new Promise<void>((resolve) => { releaseLegacyInvoke = resolve })
  let invokeStartedResolve = (): void => undefined
  const invokeStarted = new Promise<void>((resolve) => { invokeStartedResolve = resolve })
  let invokeCalls = 0
  const invoke: ScreenOcrInvoke = async (): Promise<ScreenTextResult> => {
    invokeCalls++
    invokeStartedResolve()
    // Hold the legacy pass open while the master flag flips. A broken implementation then lets the drain
    // claim the same durable row concurrently; the latched implementation filters it before invoke.
    if (!initialWorkflow && invokeCalls === 1) await legacyInvokeGate
    return { text: 'latched screen owner', endpoint: 'fake-owner-ocr', model: 'fake-owner-model', slot: 'ocr' }
  }

  try {
    setFlag(app.store, 'screen.ocr', true)
    setFlag(app.store, 'workflow.enabled', initialWorkflow)
    wireScreenOcr(app, { invoke })

    const capture = frame(initialWorkflow ? 'workflow-to-legacy' : 'legacy-to-workflow')
    let observedResolve!: (chunk: CaptureChunk) => void
    const observed = new Promise<CaptureChunk>((resolve) => { observedResolve = resolve })
    app.bus.subscribe('capture.received', async (chunk) => {
      if (chunk.id !== capture.id) return
      observedResolve(chunk)
      // captureChunk cannot schedule the durable queue drain until the test flips the flag and releases us.
      await busGate
    })

    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    const posted = secureTestFetch(`${base}/capture/screen`, {
      method: 'POST',
      body: JSON.stringify(capture),
    })

    const queued = await observed
    assert.equal(
      screenRecognitionOwner(queued),
      initialWorkflow ? 'workflow-drain' : 'legacy-ingest',
      'the engine stamps the owner selected before durable queue append',
    )
    if (!initialWorkflow) await invokeStarted
    setFlag(app.store, 'workflow.enabled', !initialWorkflow)
    releaseBus()
    assert.equal((await posted).status, 200)

    // In the legacy→workflow case, prove the text queue drained the same row while the legacy invoke was
    // still pending; it must not start a second recognition. Then let the one legitimate owner finish.
    if (!initialWorkflow) {
      await eventually(async () => {
        assert.ok((await app.textQueue.status()).drainedFiles >= 1)
      })
      assert.equal(invokeCalls, 1)
      releaseLegacyInvoke()
    }

    await eventually(() => {
      assert.equal(invokeCalls, 1)
      assert.equal(app.store.listOcrResults('default', capture.sessionId).length, 1)
      assert.equal(app.store.listDistillates('default', capture.sessionId).length, 1)
    })
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(invokeCalls, 1, 'the later owner decision never reclaims the in-flight frame')
  } finally {
    releaseBus()
    releaseLegacyInvoke()
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
}

test('legacy-owned in-flight frame stays legacy-owned after workflow.enabled turns on', () =>
  runInFlightFlip(false))

test('workflow-owned queued frame still drains after workflow.enabled turns off', () =>
  runInFlightFlip(true))
