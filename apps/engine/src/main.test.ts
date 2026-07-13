import { createServer } from 'node:http'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startEngine } from './main.js'

const randomPort = async (): Promise<number> => {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

test('product startup binds loopback, advertises only after listen, and removes its discovery record on close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openinfo-main-control-'))
  const port = await randomPort()
  const token = 't'.repeat(43)
  const running = await startEngine({
    env: {
      OPENINFO_PORT: String(port),
      OPENINFO_CONTROL_TOKEN: token,
      OPENINFO_CONTROL_RUN_DIR: join(root, 'run'),
    },
    dataRoot: join(root, 'data'),
    makeInstanceId: () => 'main-start-instance',
    now: () => new Date('2026-07-12T13:00:00.000Z'),
    log: () => undefined,
  })
  try {
    const address = running.app.server.address()
    assert.ok(address && typeof address === 'object')
    assert.equal(address.address, '127.0.0.1')
    assert.equal(address.port, port)
    const record = JSON.parse(await readFile(running.controlPlane.discoveryPath, 'utf8')) as {
      instanceId: string
      token: string
    }
    assert.deepEqual(record, { ...running.controlPlane.discoveryRecord(), instanceId: 'main-start-instance', token })
  } finally {
    await running.close()
    await assert.rejects(() => readFile(running.controlPlane.discoveryPath), /ENOENT/)
    await rm(root, { recursive: true, force: true })
  }
})

test('product startup refuses a non-loopback bind before constructing data or discovery state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openinfo-main-refuse-'))
  const dataRoot = join(root, 'data')
  const runDir = join(root, 'run')
  try {
    await assert.rejects(
      () => startEngine({
        env: {
          OPENINFO_PORT: '8787',
          OPENINFO_BIND_HOST: '0.0.0.0',
          OPENINFO_CONTROL_RUN_DIR: runDir,
        },
        dataRoot,
        log: () => undefined,
      }),
      /refusing non-loopback/,
    )
    await assert.rejects(() => readFile(join(runDir, 'engine-8787.json')), /ENOENT/)
    await assert.rejects(() => readFile(join(dataRoot, '_meta.db')), /ENOENT/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
