import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type {
  CaptureChunk,
  Fabric,
  Flag,
  ScreenStatus,
  SenseLaneSnapshotSet,
  Session,
} from '@openinfo/contracts'
import {
  createSecureTestEngineApp as createEngineApp,
  secureTestFetch as fetch,
} from '../api/test-control-plane.js'
import { FabricDocuments, invokeOcr } from '../fabric/index.js'
import { wireScreenOcr } from './index.js'

/**
 * #175's named-failure proof at the product boundaries it claims. Configuration failures are read from
 * the authenticated, server-rendered Settings → Status route. Per-frame outcomes enter through the real
 * capture route, then are read back through authenticated GET /screen/status and GET /senses/live. The
 * companion client acceptance renders those exact public row shapes through the shipped sense-lanes
 * block; this engine half deliberately makes no synthetic "boundary" summary string.
 */

const IMAGE_BASE64 = Buffer.from('synthetic-screen-frame').toString('base64')

const emptyFabric = (): Fabric => ({
  slots: { stt: [], tts: [], llm: [], vlm: [], ocr: [], embed: [] },
})

const flag = (key: string, enabled: boolean): Flag => ({
  key,
  default: enabled,
  scope: 'engine',
  description: `#175 observable boundary: ${key}`,
})

const imageChunk = (id: string, session: Session): CaptureChunk => ({
  id,
  sessionId: session.id,
  workspaceId: session.workspaceId,
  source: 'screen',
  sequence: 1,
  capturedAt: new Date().toISOString(),
  contentType: 'image/jpeg',
  encoding: 'base64',
  data: IMAGE_BASE64,
})

type GateBoundary = {
  name: 'missing flag' | 'missing endpoint'
  kind: 'gate'
  enabled: boolean
  fabric: Fabric
  expectedLabel: string
}

type ProcessorMode = 'untrusted-lan' | 'blank' | 'invalid-response' | 'timeout' | 'model-failure'

type ProcessingBoundary = {
  name: 'untrusted LAN' | 'blank frame' | 'invalid response' | 'timeout' | 'model failure'
  kind: 'processing'
  mode: ProcessorMode
  expectedCounter: 'blank' | 'failed'
  expectedClass?: 'egress-denied' | 'bad-response' | 'timeout' | 'model-load'
  expectedDisposition: 'blank' | 'failed'
  expectedHealth: 'healthy' | 'failed'
}

type Boundary = GateBoundary | ProcessingBoundary

const configuredOcrFabric = (): Fabric => {
  const fabric = emptyFabric()
  fabric.slots.ocr = [{
    kind: 'http',
    name: 'configured-loopback-ocr',
    url: 'http://127.0.0.1:9002',
    api: 'paddle-serving',
  }]
  return fabric
}

const boundaries: readonly Boundary[] = [
  {
    name: 'missing flag',
    kind: 'gate',
    enabled: false,
    fabric: configuredOcrFabric(),
    expectedLabel: 'Screen OCR enabled',
  },
  {
    name: 'missing endpoint',
    kind: 'gate',
    enabled: true,
    fabric: emptyFabric(),
    expectedLabel: 'Reading (ocr) endpoint',
  },
  {
    name: 'untrusted LAN',
    kind: 'processing',
    mode: 'untrusted-lan',
    expectedCounter: 'failed',
    expectedClass: 'egress-denied',
    expectedDisposition: 'failed',
    expectedHealth: 'failed',
  },
  {
    name: 'blank frame',
    kind: 'processing',
    mode: 'blank',
    expectedCounter: 'blank',
    expectedDisposition: 'blank',
    expectedHealth: 'healthy',
  },
  {
    name: 'invalid response',
    kind: 'processing',
    mode: 'invalid-response',
    expectedCounter: 'failed',
    expectedClass: 'bad-response',
    expectedDisposition: 'failed',
    expectedHealth: 'failed',
  },
  {
    name: 'timeout',
    kind: 'processing',
    mode: 'timeout',
    expectedCounter: 'failed',
    expectedClass: 'timeout',
    expectedDisposition: 'failed',
    expectedHealth: 'failed',
  },
  {
    name: 'model failure',
    kind: 'processing',
    mode: 'model-failure',
    expectedCounter: 'failed',
    expectedClass: 'model-load',
    expectedDisposition: 'failed',
    expectedHealth: 'failed',
  },
] as const

interface FakeEndpoint {
  server: Server
  url: string
}

const startEndpoint = async (mode: Exclude<ProcessorMode, 'untrusted-lan'>): Promise<FakeEndpoint> => {
  const server = createServer((req, res) => {
    req.resume()
    if (mode === 'timeout') return
    if (mode === 'model-failure') {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'synthetic model failed to load' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(mode === 'invalid-response' ? JSON.stringify({ status: '0' }) : JSON.stringify({ status: '0', results: [[]] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}` }
}

const stopEndpoint = async (server: Server): Promise<void> => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
}

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}

const put = async (base: string, path: string, body: unknown): Promise<void> => {
  const response = await fetch(`${base}${path}`, { method: 'PUT', body: JSON.stringify(body) })
  assert.equal(response.status, 200, path)
}

const poll = async <T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> => {
  const deadline = Date.now() + 2_000
  let value = await read()
  while (!ready(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    value = await read()
  }
  assert.equal(ready(value), true, 'timed out waiting for the public boundary to advance')
  return value
}

const runGateBoundary = async (row: GateBoundary): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), `openinfo-175-${row.name.replaceAll(' ', '-')}-`))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  const base = await listen(app.server)
  try {
    await put(base, '/fabric', row.fabric)
    await put(base, '/flags/screen.ocr', flag('screen.ocr', row.enabled))

    const response = await fetch(`${base}/settings/status`)
    assert.equal(response.status, 200, row.name)
    const html = await response.text()
    const escapedLabel = row.expectedLabel.replace(/[()]/g, '\\$&')
    assert.match(html, new RegExp(`blocked</span> at ${escapedLabel}`), row.name)
    assert.match(html, /what to do/, row.name)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
}

const runProcessingBoundary = async (row: ProcessingBoundary): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), `openinfo-175-${row.mode}-`))
  let endpoint: FakeEndpoint | undefined
  const fabric = emptyFabric()
  if (row.mode === 'untrusted-lan') {
    fabric.slots.ocr = [{
      kind: 'http',
      name: 'untrusted-lan-ocr',
      url: 'http://192.168.1.50:8000',
      api: 'paddle-serving',
    }]
  } else {
    endpoint = await startEndpoint(row.mode)
    fabric.slots.ocr = [{
      kind: 'http',
      name: `fake-${row.mode}-ocr`,
      url: endpoint.url,
      api: 'paddle-serving',
      model: 'synthetic-ocr-model',
    }]
  }

  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  const liveFabric = new FabricDocuments(app.store)
  wireScreenOcr(app, {
    // Keep the real invoke/gate/classification path while making the timeout row deterministic.
    invoke: (params, opts) => invokeOcr(liveFabric.load(), { ...params, timeoutMs: 40 }, opts),
  })
  const base = await listen(app.server)
  let fetchAttempts = 0
  const originalFetch = globalThis.fetch
  if (row.mode === 'untrusted-lan') {
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith('http://192.168.1.50:8000')) {
        fetchAttempts += 1
        throw new Error('raw untrusted LAN bytes must be refused before fetch')
      }
      return originalFetch(input, init)
    }
  }

  try {
    await put(base, '/fabric', fabric)
    await put(base, '/flags/screen.ocr', flag('screen.ocr', true))
    const sessionResponse = await fetch(`${base}/sessions`, {
      method: 'POST',
      body: JSON.stringify({ workspaceId: 'default', modeId: 'mode-meeting' }),
    })
    assert.equal(sessionResponse.status, 200)
    const session = (await sessionResponse.json()) as Session
    const chunk = imageChunk(`screen-${row.mode}`, session)

    const capture = await fetch(`${base}/capture/screen`, { method: 'POST', body: JSON.stringify(chunk) })
    assert.equal(capture.status, 200, row.name)

    const readScreenStatus = async (): Promise<ScreenStatus> => {
      const response = await fetch(`${base}/screen/status`)
      assert.equal(response.status, 200, `${row.name}: authenticated GET /screen/status`)
      return (await response.json()) as ScreenStatus
    }
    const status = await poll(readScreenStatus, (value) => value[row.expectedCounter] === 1)
    assert.equal(status.enabled, true, row.name)
    assert.equal(status.processed, 0, row.name)
    assert.equal(status[row.expectedCounter], 1, row.name)

    const readLiveSenses = async (): Promise<SenseLaneSnapshotSet> => {
      const response = await fetch(`${base}/senses/live?workspace=default&session=${encodeURIComponent(session.id)}`)
      assert.equal(response.status, 200, `${row.name}: authenticated GET /senses/live`)
      return (await response.json()) as SenseLaneSnapshotSet
    }
    const snapshots = await poll(readLiveSenses, (value) => value.lanes[2].disposition === row.expectedDisposition)
    const lane = snapshots.lanes[2]
    assert.equal(lane.source, 'screen', row.name)
    assert.equal(lane.disposition, row.expectedDisposition, row.name)
    assert.equal(lane.health, row.expectedHealth, row.name)
    assert.equal(lane.reason, row.expectedDisposition === 'blank' ? 'blank' : 'processing-failed', row.name)
    assert.equal(lane.latestProcessing?.outcome, row.expectedDisposition, row.name)

    const results = await (await fetch(`${base}/screen/results?session=${encodeURIComponent(session.id)}`)).json() as unknown[]
    assert.deepEqual(results, [], `${row.name}: no result was fabricated`)

    if (row.expectedClass === undefined) {
      assert.deepEqual(status.lastFailures, [], row.name)
    } else {
      assert.equal(status.lastFailures.length, 1, row.name)
      assert.equal(status.lastFailures[0]?.class, row.expectedClass, row.name)
    }
    if (row.mode === 'untrusted-lan') assert.equal(fetchAttempts, 0, 'untrusted LAN is refused before fetch')
  } finally {
    globalThis.fetch = originalFetch
    await app.close()
    if (endpoint !== undefined) await stopEndpoint(endpoint.server)
    await rm(dir, { recursive: true, force: true })
  }
}

test('#175 named failure states reach authenticated routes and the shipped Settings renderer', async () => {
  assert.deepEqual(boundaries.map((row) => row.name), [
    'missing flag',
    'missing endpoint',
    'untrusted LAN',
    'blank frame',
    'invalid response',
    'timeout',
    'model failure',
  ])

  for (const row of boundaries) {
    if (row.kind === 'gate') await runGateBoundary(row)
    else await runProcessingBoundary(row)
  }
})
