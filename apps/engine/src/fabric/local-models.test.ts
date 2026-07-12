import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { StarterModel } from '@openinfo/contracts'
import { downloadModel, LocalModelStore, type DownloadProgress } from './local-models.js'

// A deterministic ~250KB blob (above the 100KB truncation floor) served with Range support.
const blob = Buffer.alloc(250_000)
for (let i = 0; i < blob.length; i++) blob[i] = i % 251
const blobSha = createHash('sha256').update(blob).digest('hex')

const startServer = (opts: { rangeSupport?: boolean; body?: Buffer } = {}): Promise<{ url: string; close: () => void }> =>
  new Promise((resolve) => {
    const body = opts.body ?? blob
    const server: Server = createServer((req, res) => {
      const range = req.headers.range
      if (range && opts.rangeSupport !== false) {
        const start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? '0')
        const slice = body.subarray(start)
        res.writeHead(206, {
          'content-length': String(slice.length),
          'content-range': `bytes ${start}-${body.length - 1}/${body.length}`,
          'accept-ranges': 'bytes',
        })
        res.end(slice)
      } else {
        res.writeHead(200, { 'content-length': String(body.length) })
        res.end(body)
      }
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({ url: `http://127.0.0.1:${port}/model.bin`, close: () => server.close() })
    })
  })

const tmp = () => mkdtempSync(join(tmpdir(), 'oi-dl-'))

test('downloadModel: full download → promoted file, correct bytes, progress observed', async () => {
  const srv = await startServer()
  const dest = join(tmp(), 'model.bin')
  const seen: DownloadProgress[] = []
  const result = await downloadModel(srv.url, dest, { onProgress: (p) => seen.push(p) })
  srv.close()
  assert.equal(result.bytes, blob.length)
  assert.equal(result.totalBytes, blob.length)
  assert.ok(existsSync(dest) && !existsSync(`${dest}.part`), 'promoted, no leftover .part')
  assert.equal(statSync(dest).size, blob.length)
  assert.ok(seen.length > 0 && seen[seen.length - 1]!.downloadedBytes === blob.length)
  assert.equal(seen[seen.length - 1]!.totalBytes, blob.length)
})

test('downloadModel: resumes from an existing .part via Range', async () => {
  const srv = await startServer({ rangeSupport: true })
  const dest = join(tmp(), 'model.bin')
  writeFileSync(`${dest}.part`, blob.subarray(0, 100_000)) // pretend 100KB already fetched
  const result = await downloadModel(srv.url, dest, {})
  srv.close()
  assert.equal(result.bytes, blob.length)
  assert.deepEqual(readFileSync(dest), blob, 'resumed content matches the whole blob exactly')
})

test('downloadModel: a server that ignores Range restarts cleanly from zero', async () => {
  const srv = await startServer({ rangeSupport: false })
  const dest = join(tmp(), 'model.bin')
  writeFileSync(`${dest}.part`, blob.subarray(0, 100_000))
  const result = await downloadModel(srv.url, dest, {})
  srv.close()
  assert.equal(result.bytes, blob.length)
  assert.deepEqual(readFileSync(dest), blob)
})

test('downloadModel: truncated/error-page body is discarded (below the floor)', async () => {
  const srv = await startServer({ body: Buffer.from('<html>404 not found</html>') })
  const dest = join(tmp(), 'model.bin')
  await assert.rejects(downloadModel(srv.url, dest, {}), /implausibly small/)
  srv.close()
  assert.ok(!existsSync(dest) && !existsSync(`${dest}.part`), 'bogus file discarded')
})

test('downloadModel: sha256 mismatch is discarded', async () => {
  const srv = await startServer()
  const dest = join(tmp(), 'model.bin')
  await assert.rejects(downloadModel(srv.url, dest, { expectedSha256: 'deadbeef' }), /sha256 mismatch/)
  srv.close()
  assert.ok(!existsSync(dest))
})

test('downloadModel: a correct sha256 passes', async () => {
  const srv = await startServer()
  const dest = join(tmp(), 'model.bin')
  const r = await downloadModel(srv.url, dest, { expectedSha256: blobSha })
  srv.close()
  assert.equal(r.bytes, blob.length)
})

test('LocalModelStore: absent → download → ready, statuses reflect it; resolvePath finds the file', async () => {
  const srv = await startServer()
  const dir = tmp()
  const model: StarterModel = {
    id: 'test-model', slot: 'llm', runtime: 'llama.cpp', name: 'Test',
    filename: 'model.bin', url: srv.url, sizeBytes: blob.length,
  }
  const store = new LocalModelStore(dir, () => [model])
  const before = store.statuses()
  assert.equal(before[0]!.state, 'absent')
  assert.equal(typeof before[0]!.runtimeAvailable, 'boolean')

  const started = store.download('test-model')
  assert.equal(started?.state, 'downloading')
  await store.settle('test-model')
  srv.close()

  const after = store.statuses()
  assert.equal(after[0]!.state, 'ready')
  assert.equal(store.resolvePath({ kind: 'local', name: 'x', runtime: 'llama.cpp', model: 'test-model' }), join(dir, 'model.bin'))
  assert.equal(store.resolvePath({ kind: 'local', name: 'x', runtime: 'llama.cpp', model: 'model.bin' }), join(dir, 'model.bin'))
  assert.equal(store.resolvePath({ kind: 'local', name: 'x', runtime: 'llama.cpp', model: 'missing' }), undefined)
})

test('LocalModelStore: download failure surfaces as an error state (not a throw)', async () => {
  const srv = await startServer({ body: Buffer.from('nope') })
  const dir = tmp()
  const model: StarterModel = {
    id: 'bad', slot: 'llm', runtime: 'llama.cpp', name: 'Bad',
    filename: 'model.bin', url: srv.url, sizeBytes: 999,
  }
  const store = new LocalModelStore(dir, () => [model])
  store.download('bad')
  await store.settle('bad')
  srv.close()
  const status = store.statuses()[0]!
  assert.equal(status.state, 'error')
  assert.match(status.error ?? '', /implausibly small/)
})

test('LocalModelStore: unknown model id ⇒ undefined (route 404s)', () => {
  const store = new LocalModelStore(tmp(), () => [])
  assert.equal(store.download('ghost'), undefined)
})

const llmModel: StarterModel = {
  id: 'test-model', slot: 'llm', runtime: 'llama.cpp', name: 'Test',
  filename: 'model.bin', url: 'http://127.0.0.1/model.bin', sizeBytes: blob.length,
}

test('LocalModelStore: an injected runtime resolver GOVERNS availability — available when it says so (no real PATH lookup)', () => {
  // The resolver ignores its spec and always answers "here" — proving availability follows the injection,
  // never a real llama-server on PATH (which the bare CI runner does not have; that is the whole point).
  const store = new LocalModelStore(tmp(), () => [llmModel], { findBinary: () => '/injected/fake-runtime' })
  const status = store.statuses()[0]!
  assert.equal(status.runtimeAvailable, true)
  assert.equal(status.installHint, undefined, 'available ⇒ no install hint')
})

test('LocalModelStore: an injected runtime resolver GOVERNS availability — unavailable when it says not (install hint shown)', () => {
  // Resolver reports absent regardless of PATH ⇒ the lens must render the honest install hint, even if a
  // real llama-server happens to be installed on the dev machine running this test.
  const store = new LocalModelStore(tmp(), () => [llmModel], { findBinary: () => undefined })
  const status = store.statuses()[0]!
  assert.equal(status.runtimeAvailable, false)
  assert.equal(status.installHint, 'brew install llama.cpp')
})

test('LocalModelStore: injected specs govern availability too — a runtime absent from the spec table is unavailable', () => {
  // With an empty spec table there is no spec for llama.cpp, so availability is false regardless of what
  // the (never-consulted) binary resolver would say — spec lookup and discovery both ride the injection.
  const store = new LocalModelStore(tmp(), () => [llmModel], { specs: {}, findBinary: () => '/injected/fake-runtime' })
  assert.equal(store.statuses()[0]!.runtimeAvailable, false)
})
