import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { CaptureChunk, Distillate, Fabric, Flag, Surface } from '@openinfo/contracts'
import { EngineAuthDiscovery } from '../main/engine-auth.js'
import { mountSurface, renderInto, type MountTarget } from '../surfaces/block-renderer/index.js'
import { Hud } from '../surfaces/hud/hud.js'
import { EngineLink } from './client.js'

/**
 * #175's HEADLESS client-integration coverage. This starts the built product engine and crosses real
 * EngineLink auth, the engine's actually seeded Surface document/query, the shipped block registry, Hud,
 * and HTML serialization through mountSurface. It deliberately does NOT construct a DOM or BrowserWindow,
 * so it makes no layout/paint/visibility claim; scripts/screen-surface-e2e.mjs owns that GUI-only proof.
 */

const JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMQD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABLAAEBAAAAAAAAAAAAAAAAAAAABwEBAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIAAgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AL+AD//Z'
const OCR_TEXT = 'OPENINFO 175 SURFACE MIRROR — persisted synthetic screen text'

const here = dirname(fileURLToPath(import.meta.url))
const engineMain = join(here, '..', '..', '..', 'engine', 'dist', 'main.js')

interface EngineProcess {
  child: ChildProcess
  baseUrl: string
  stderr: () => string
}

interface FakeOcr {
  server: Server
  url: string
  paths: string[]
  bodies: string[]
}

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}

const startFakeOcr = async (): Promise<FakeOcr> => {
  const paths: string[] = []
  const bodies: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      paths.push(req.url ?? '')
      bodies.push(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        status: '0',
        results: [[{
          text: OCR_TEXT,
          confidence: 0.99,
          text_region: [[0, 0], [2, 0], [2, 2], [0, 2]],
        }]],
      }))
    })
  })
  return { server, url: await listen(server), paths, bodies }
}

const randomPort = async (): Promise<number> => {
  const server = createServer()
  const url = await listen(server)
  await stopServer(server)
  return Number(new URL(url).port)
}

const startEngine = async (port: number, dataDir: string, runDir: string): Promise<EngineProcess> => {
  let stderr = ''
  const child = spawn(process.execPath, [engineMain], {
    env: {
      ...process.env,
      OPENINFO_PORT: String(port),
      OPENINFO_DATA: dataDir,
      OPENINFO_CONTROL_RUN_DIR: runDir,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
  const baseUrl = `http://127.0.0.1:${port}`
  try {
    await eventually(async () => {
      if (child.exitCode !== null) throw new Error(`engine exited ${child.exitCode}: ${stderr}`)
      assert.equal((await fetch(`${baseUrl}/health`)).status, 200)
    }, 'built engine health')
    return { child, baseUrl, stderr: () => stderr }
  } catch (error) {
    if (child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      child.kill('SIGKILL')
      await exited
    }
    throw error
  }
}

const stopEngine = async (engine: EngineProcess): Promise<void> => {
  if (engine.child.exitCode !== null) return
  const exited = new Promise<void>((resolve) => engine.child.once('exit', () => resolve()))
  engine.child.kill('SIGKILL')
  await exited
}

const stopServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))

const eventually = async (
  assertion: () => void | Promise<void>,
  description: string,
  timeoutMs = 4_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw new Error(`timed out waiting for ${description}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

const framePair = (sessionId: string): readonly [CaptureChunk, CaptureChunk] => {
  const capturedAt = '2026-07-14T12:00:00.000Z'
  return [
    {
      id: 'capture-175-client-surface-image',
      sessionId,
      workspaceId: 'default',
      source: 'screen',
      sequence: 1,
      capturedAt,
      contentType: 'image/jpeg',
      encoding: 'base64',
      data: JPEG_BASE64,
    },
    {
      id: 'capture-175-client-surface-meta',
      sessionId,
      workspaceId: 'default',
      source: 'screen',
      sequence: 2,
      capturedAt,
      contentType: 'application/json',
      encoding: 'utf8',
      data: JSON.stringify({ displayId: 'synthetic-2x2', width: 2, height: 2 }),
    },
  ]
}

test('#175 headless: a real screen mirror crosses EngineLink + seeded Surface + Hud serialization', async () => {
  const jpeg = Buffer.from(JPEG_BASE64, 'base64')
  assert.deepEqual([...jpeg.subarray(0, 2)], [0xff, 0xd8])
  assert.equal(jpeg.subarray(6, 10).toString('ascii'), 'JFIF')
  assert.deepEqual([...jpeg.subarray(-2)], [0xff, 0xd9])

  let dataDir: string | undefined
  let runDir: string | undefined
  let spoolDir: string | undefined
  let ocr: FakeOcr | undefined
  let engine: EngineProcess | undefined
  let hud: Hud | undefined

  try {
    dataDir = await mkdtemp(join(tmpdir(), 'openinfo-175-surface-engine-'))
    runDir = await mkdtemp(join(tmpdir(), 'openinfo-175-surface-run-'))
    spoolDir = await mkdtemp(join(tmpdir(), 'openinfo-175-surface-spool-'))
    const fakeOcr = await startFakeOcr()
    ocr = fakeOcr
    const runningEngine = await startEngine(await randomPort(), dataDir, runDir)
    engine = runningEngine
    const credentials = new EngineAuthDiscovery({ runDir })
    await eventually(async () => {
      assert.ok(await credentials.credentialFor(runningEngine.baseUrl, { refresh: true }))
    }, 'engine discovery credential')
    const link = new EngineLink({ baseUrl: runningEngine.baseUrl, spoolDir, credentials })

    const fabric: Fabric = {
      slots: {
        stt: [],
        tts: [],
        llm: [],
        vlm: [],
        ocr: [{ kind: 'http', name: 'fake-loopback-ocr-175-surface', url: fakeOcr.url, api: 'paddle-serving', model: 'pp-ocrv4' }],
        embed: [],
      },
    }
    await link.putFabric(fabric)
    const flag: Flag = { key: 'screen.ocr', default: true, scope: 'engine', description: '#175 headless Surface integration' }
    await link.putFlag(flag)
    const session = await link.startSession({ workspaceId: 'default', modeId: 'mode-meeting', title: '#175 Surface proof' })

    const [image, meta] = framePair(session.id)
    assert.equal((await link.capture(image))?.ok, true)
    assert.equal((await link.capture(meta))?.ok, true)
    assert.equal(await link.spool.pendingCount(), 0)

    await eventually(async () => {
      const result = await link.query({
        source: 'distillates',
        params: { workspace: 'default', session: session.id },
        top: 10,
      })
      const mirrors = result.items as Distillate[]
      assert.equal(mirrors.filter((row) => row.sourceChunks.includes(image.id)).length, 1)
      assert.equal(mirrors.find((row) => row.sourceChunks.includes(image.id))?.text, OCR_TEXT)
    }, 'persisted OCR mirror')

    const headlessTarget: MountTarget = {
      innerHTML: '',
      addEventListener: () => undefined,
    }
    let mounted = false
    let loadedSurface: Surface | undefined
    hud = new Hud({
      transport: link,
      surfaceId: 'surf-openinfo-fields',
      workspace: 'default',
      onSurfaceLoaded: (surface) => { loadedSurface = surface },
      onRender: (panel) => {
        if (mounted) renderInto(headlessTarget, panel)
        else {
          mountSurface(headlessTarget, panel, { copy: () => undefined })
          mounted = true
        }
      },
      now: () => new Date('2026-07-14T12:00:01.000Z'),
    })
    await hud.start()

    assert.equal(loadedSurface?.id, 'surf-openinfo-fields', 'the engine served the actual seeded Surface')
    assert.ok(loadedSurface?.stack.some((block) => block.block === 'distillates' && block.query?.source === 'distillates'))
    assert.equal(mounted, true)
    assert.match(headlessTarget.innerHTML, /class="glbl">Transcript</)
    assert.ok(headlessTarget.innerHTML.includes(OCR_TEXT), 'model-only text reached serialized block HTML through the persisted mirror')
    assert.equal(
      (headlessTarget.innerHTML.match(new RegExp(`<span class="ttl">${OCR_TEXT}</span>`, 'g')) ?? []).length,
      1,
      'the one persisted mirror serializes one stream row (the copy action may also carry it as data)',
    )

    assert.deepEqual(fakeOcr.paths, ['/predict/ocr_system'])
    assert.deepEqual((JSON.parse(fakeOcr.bodies[0]!) as { images: string[] }).images, [JPEG_BASE64])
  } finally {
    hud?.stop()
    await Promise.all([
      ...(engine !== undefined ? [stopEngine(engine)] : []),
      ...(ocr !== undefined ? [stopServer(ocr.server)] : []),
    ])
    await Promise.all(
      [dataDir, runDir, spoolDir]
        .filter((dir): dir is string => dir !== undefined)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    )
  }
})
