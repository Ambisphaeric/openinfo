import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk } from '@openinfo/contracts'
import { CaptureSimulator } from '../capture/sim.js'
import { EngineLink } from './client.js'

interface EngineProcess {
  child: ChildProcess
  url: string
}

test('seam streams, spools while engine is down, then flushes exactly once in order', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'openinfo-seam-engine-'))
  const spoolDir = await mkdtemp(join(tmpdir(), 'openinfo-seam-client-'))
  const port = await randomPort()
  const received: CaptureChunk[] = []
  let engine = await startEngine(port, dataDir)
  let stopEvents = await collectCaptureEvents(engine.url, received)
  const link = new EngineLink({ baseUrl: engine.url, spoolDir })
  const sim = new CaptureSimulator(link, { sessionId: 'session-seam', workspaceId: 'default', cadenceMs: 15 })

  try {
    sim.start()
    await sleep(100)
    stopEvents()
    await stopEngine(engine)
    await sleep(100)
    await sim.stop()

    engine = await startEngine(port, dataDir)
    stopEvents = await collectCaptureEvents(engine.url, received)
    await eventually(async () => {
      await link.flush()
      assert.equal(await link.spool.pendingCount(), 0)
      assert.equal(received.length, sim.emitted.length)
    })

    assert.deepEqual(received.map((chunk) => chunk.sequence), sim.emitted.map((chunk) => chunk.sequence))
    assert.equal(new Set(received.map((chunk) => chunk.id)).size, received.length)
  } finally {
    stopEvents()
    await stopEngine(engine)
    await rm(dataDir, { recursive: true, force: true })
    await rm(spoolDir, { recursive: true, force: true })
  }
})

const here = dirname(fileURLToPath(import.meta.url))
const engineMain = join(here, '..', '..', '..', 'engine', 'dist', 'main.js')

async function randomPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function startEngine(port: number, dataDir: string): Promise<EngineProcess> {
  const child = spawn(process.execPath, [engineMain], {
    env: { ...process.env, OPENINFO_PORT: String(port), OPENINFO_DATA: dataDir },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr?.on('data', (chunk) => process.stderr.write(chunk))
  const url = `http://127.0.0.1:${port}`
  await eventually(async () => {
    const response = await fetch(`${url}/health`)
    assert.equal(response.status, 200)
  })
  return { child, url }
}

async function stopEngine(engine: EngineProcess): Promise<void> {
  if (engine.child.exitCode !== null) return
  engine.child.kill('SIGTERM')
  await new Promise<void>((resolve) => engine.child.once('exit', () => resolve()))
}

async function collectCaptureEvents(url: string, received: CaptureChunk[]): Promise<() => void> {
  const socket = new WebSocket(url.replace(/^http/, 'ws') + '/events')
  socket.addEventListener('message', (event) => {
    const parsed = JSON.parse(String(event.data)) as { name?: string; payload?: CaptureChunk }
    if (parsed.name === 'capture.received' && parsed.payload) received.push(parsed.payload)
  })
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('websocket failed')), { once: true })
  })
  return () => socket.close()
}

async function eventually(assertion: () => Promise<void>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await sleep(25)
    }
  }
  if (lastError instanceof Error) throw lastError
  throw new Error('condition was not met')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
