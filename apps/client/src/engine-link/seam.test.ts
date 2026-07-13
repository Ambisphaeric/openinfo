import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureReceipt } from '@openinfo/contracts'
import { CaptureSimulator } from '../capture/sim.js'
import { EngineAuthDiscovery, engineWebSocketProtocols, type EngineCredentialSource } from '../main/engine-auth.js'
import { EngineLink } from './client.js'

interface EngineProcess {
  child: ChildProcess
  url: string
}

test('seam streams, spools while engine is down, then flushes exactly once in order', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'openinfo-seam-engine-'))
  const spoolDir = await mkdtemp(join(tmpdir(), 'openinfo-seam-client-'))
  const runDir = await mkdtemp(join(tmpdir(), 'openinfo-seam-run-'))
  const port = await randomPort()
  const received: CaptureReceipt[] = []
  const credentials = new EngineAuthDiscovery({ runDir })
  let engine = await startEngine(port, dataDir, runDir)
  let collector = await collectCaptureEvents(engine.url, received, credentials)
  let stopEvents = collector.stop
  let instanceId = collector.instanceId
  const link = new EngineLink({ baseUrl: engine.url, spoolDir, credentials })
  const sim = new CaptureSimulator(link, { sessionId: 'session-seam', workspaceId: 'default', cadenceMs: 15 })

  try {
    sim.start()
    await sleep(100)
    stopEvents()
    await stopEngine(engine)
    await sleep(100)
    await sim.stop()

    engine = await startEngine(port, dataDir, runDir)
    collector = await collectCaptureEvents(engine.url, received, credentials, instanceId)
    stopEvents = collector.stop
    instanceId = collector.instanceId
    await eventually(async () => {
      await link.flush()
      assert.equal(await link.spool.pendingCount(), 0)
      assert.equal(received.length, sim.emitted.length)
    })

    assert.deepEqual(received.map((chunk) => chunk.sequence), sim.emitted.map((chunk) => chunk.sequence))
    assert.equal(new Set(received.map((chunk) => chunk.id)).size, received.length)
    assert.ok(received.every((receipt) => receipt.payloadBytes > 0))
    assert.ok(received.every((receipt) => !('data' in receipt)), 'public receipts must never expose capture bytes')
  } finally {
    stopEvents()
    await stopEngine(engine)
    await rm(dataDir, { recursive: true, force: true })
    await rm(spoolDir, { recursive: true, force: true })
    await rm(runDir, { recursive: true, force: true })
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

async function startEngine(port: number, dataDir: string, runDir: string): Promise<EngineProcess> {
  const child = spawn(process.execPath, [engineMain], {
    env: { ...process.env, OPENINFO_PORT: String(port), OPENINFO_DATA: dataDir, OPENINFO_CONTROL_RUN_DIR: runDir },
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
  const exited = new Promise<void>((resolve) => engine.child.once('exit', () => resolve()))
  // This seam deliberately simulates an abrupt engine outage. A graceful shutdown can keep accepting
  // chunks while long-lived collectors drain, creating an unobservable middle interval after WS closes.
  engine.child.kill('SIGKILL')
  await exited
}

async function collectCaptureEvents(
  url: string,
  received: CaptureReceipt[],
  credentials: EngineCredentialSource,
  previousInstanceId?: string,
): Promise<{ stop: () => void; instanceId: string }> {
  let credential: Awaited<ReturnType<EngineCredentialSource['credentialFor']>>
  await eventually(async () => {
    credential = await credentials.credentialFor(url, { refresh: true })
    assert.ok(credential)
    assert.ok(credential.instanceId)
    assert.notEqual(credential.instanceId, previousInstanceId)
  })
  const socket = new WebSocket(url.replace(/^http/, 'ws') + '/events', engineWebSocketProtocols(credential!))
  socket.addEventListener('message', (event) => {
    const parsed = JSON.parse(String(event.data)) as { name?: string; payload?: CaptureReceipt }
    if (parsed.name === 'capture.received' && parsed.payload) received.push(parsed.payload)
  })
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('websocket failed')), { once: true })
  })
  return { stop: () => socket.close(), instanceId: credential!.instanceId! }
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
