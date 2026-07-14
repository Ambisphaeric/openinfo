import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type {
  Block,
  Fabric,
  Flag,
  QueryResult,
  ScreenStatus,
  SenseLaneSnapshotSet,
  Session,
} from '@openinfo/contracts'
import { renderToHtml } from '../block-renderer/vnode.js'
import { renderSenseLanes } from './sense-lanes.js'

/**
 * Client half of #175's observable-boundary table. Client tests already run after the built engine in
 * the repository's declared topological CI order (the EngineLink seam uses the same dependency). Keep
 * the import computed so the client build remains source-independent; at test time this starts the real
 * authenticated engine app, reads GET /screen/status + GET /senses/live, and paints the returned lane set
 * through the shipped sense-lanes block renderer.
 */

type FailureClass = 'egress-denied' | 'bad-response' | 'timeout' | 'model-load'

type RenderBoundary =
  | { name: 'blank frame'; disposition: 'blank'; health: 'healthy' }
  | {
      name: 'untrusted LAN' | 'invalid response' | 'timeout' | 'model failure'
      disposition: 'failed'
      health: 'failed'
      failureClass: FailureClass
    }

const boundaries: readonly RenderBoundary[] = [
  { name: 'untrusted LAN', disposition: 'failed', health: 'failed', failureClass: 'egress-denied' },
  { name: 'blank frame', disposition: 'blank', health: 'healthy' },
  { name: 'invalid response', disposition: 'failed', health: 'failed', failureClass: 'bad-response' },
  { name: 'timeout', disposition: 'failed', health: 'failed', failureClass: 'timeout' },
  { name: 'model failure', disposition: 'failed', health: 'failed', failureClass: 'model-load' },
] as const

interface EngineAppShape {
  server: Server
  close(): Promise<void>
}

interface EngineModules {
  createEngineApp(options: { dataRoot: string; log: (line: string) => void }): EngineAppShape
  fetch: typeof globalThis.fetch
  wireScreenOcr(
    app: EngineAppShape,
    options: { invoke: () => Promise<{ text: string; endpoint: string; slot: 'ocr' }> },
  ): unknown
  AggregateInvokeError: new (
    slot: 'ocr',
    message: string,
    failures: Array<{ class: FailureClass; endpoint: string; url: string; hint: string }>,
  ) => Error
}

const engineModules = async (): Promise<EngineModules> => {
  const apiPath = new URL('../../../../engine/dist/api/test-control-plane.js', import.meta.url).href
  const screenPath = new URL('../../../../engine/dist/screen/index.js', import.meta.url).href
  const fabricPath = new URL('../../../../engine/dist/fabric/index.js', import.meta.url).href
  const api = await import(apiPath) as Record<string, unknown>
  const screen = await import(screenPath) as Record<string, unknown>
  const fabric = await import(fabricPath) as Record<string, unknown>
  return {
    createEngineApp: api['createSecureTestEngineApp'] as EngineModules['createEngineApp'],
    fetch: api['secureTestFetch'] as EngineModules['fetch'],
    wireScreenOcr: screen['wireScreenOcr'] as EngineModules['wireScreenOcr'],
    AggregateInvokeError: fabric['AggregateInvokeError'] as EngineModules['AggregateInvokeError'],
  }
}

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}

const poll = async <T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> => {
  const deadline = Date.now() + 2_000
  let value = await read()
  while (!ready(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    value = await read()
  }
  assert.equal(ready(value), true, 'timed out waiting for the rendered public lane state')
  return value
}

const screenFabric = (row: RenderBoundary): Fabric => ({
  slots: {
    stt: [],
    tts: [],
    llm: [],
    vlm: [],
    embed: [],
    ocr: [{
      kind: 'http',
      name: `acceptance-${row.name.replaceAll(' ', '-')}`,
      url: row.name === 'untrusted LAN' ? 'http://192.168.1.50:8000' : 'http://127.0.0.1:9002',
      api: 'paddle-serving',
    }],
  },
})

const block: Block = {
  block: 'sense-lanes',
  show: 'always',
  query: { source: 'live-senses', params: { session: 'current' } },
}

test('#175 public screen outcomes render through the shipped live-senses Surface block', async () => {
  const engine = await engineModules()
  for (const row of boundaries) {
    const dir = await mkdtemp(join(tmpdir(), `openinfo-175-render-${row.name.replaceAll(' ', '-')}-`))
    const app = engine.createEngineApp({ dataRoot: dir, log: () => undefined })
    engine.wireScreenOcr(app, {
      invoke: async () => {
        if (row.disposition === 'blank') return { text: '', endpoint: 'acceptance-blank', slot: 'ocr' }
        throw new engine.AggregateInvokeError('ocr', `synthetic ${row.name}`, [{
          class: row.failureClass,
          endpoint: `acceptance-${row.name.replaceAll(' ', '-')}`,
          url: 'http://endpoint-url.example.invalid',
          hint: `synthetic ${row.name} remediation`,
        }])
      },
    })
    const base = await listen(app.server)
    try {
      const putFabric = await engine.fetch(`${base}/fabric`, {
        method: 'PUT',
        body: JSON.stringify(screenFabric(row)),
      })
      assert.equal(putFabric.status, 200, row.name)
      const screenFlag: Flag = {
        key: 'screen.ocr',
        default: true,
        scope: 'engine',
        description: '#175 rendered boundary',
      }
      const putFlag = await engine.fetch(`${base}/flags/screen.ocr`, {
        method: 'PUT',
        body: JSON.stringify(screenFlag),
      })
      assert.equal(putFlag.status, 200, row.name)
      const sessionResponse = await engine.fetch(`${base}/sessions`, {
        method: 'POST',
        body: JSON.stringify({ workspaceId: 'default', modeId: 'mode-meeting' }),
      })
      assert.equal(sessionResponse.status, 200, row.name)
      const session = (await sessionResponse.json()) as Session
      const capture = {
        id: `render-${row.name.replaceAll(' ', '-')}`,
        sessionId: session.id,
        workspaceId: session.workspaceId,
        source: 'screen',
        sequence: 1,
        capturedAt: new Date().toISOString(),
        contentType: 'image/jpeg',
        encoding: 'base64',
        data: Buffer.from('synthetic-render-frame').toString('base64'),
      }
      assert.equal((await engine.fetch(`${base}/capture/screen`, {
        method: 'POST',
        body: JSON.stringify(capture),
      })).status, 200, row.name)

      const readScreenStatus = async (): Promise<ScreenStatus> => {
        const response = await engine.fetch(`${base}/screen/status`)
        assert.equal(response.status, 200, `${row.name}: authenticated GET /screen/status`)
        return (await response.json()) as ScreenStatus
      }
      const status = await poll(readScreenStatus, (value) => value[row.disposition === 'blank' ? 'blank' : 'failed'] === 1)
      if (row.disposition === 'blank') assert.deepEqual(status.lastFailures, [], row.name)
      else assert.equal(status.lastFailures[0]?.class, row.failureClass, row.name)

      const readLiveSenses = async (): Promise<SenseLaneSnapshotSet> => {
        const response = await engine.fetch(`${base}/senses/live?workspace=default&session=${encodeURIComponent(session.id)}`)
        assert.equal(response.status, 200, `${row.name}: authenticated GET /senses/live`)
        return (await response.json()) as SenseLaneSnapshotSet
      }
      const snapshots = await poll(readLiveSenses, (value) => value.lanes[2].disposition === row.disposition)
      assert.equal(snapshots.lanes[2].health, row.health, row.name)
      const result: QueryResult = { source: 'live-senses', items: [...snapshots.lanes], truncated: false }
      const rendered = renderSenseLanes({ block, result, now: { live: true } })
      if (rendered === null || Array.isArray(rendered)) assert.fail('sense-lanes must render one root node')
      const html = renderToHtml(rendered)
      if (row.disposition === 'blank') {
        assert.match(html, /Screen · No content found · Healthy/, row.name)
        assert.match(html, /No content found in [^<]+/, row.name)
      } else {
        assert.match(html, /Screen · Failed · Needs attention/, row.name)
        assert.match(html, /Processing failed in [^<]+/, row.name)
      }
      assert.equal(html.includes('endpoint-url.example.invalid'), false, `${row.name}: endpoint URLs stay out of the block`)
    } finally {
      await app.close()
      await rm(dir, { recursive: true, force: true })
    }
  }
})
