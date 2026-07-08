import { createServer, type Server } from 'node:http'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ProbeList } from '@openinfo/contracts'
import { hostTargets, scanHosts } from './scan.js'
import { seededCapabilityMap, seededProbeList } from './discovery-defaults.js'

const MAP = seededCapabilityMap

// --- hostTargets (pure): the probe-list document's ports, applied to a bare host ---

test('hostTargets applies the probe-list ports to a bare host, in document order', () => {
  const urls = hostTargets('192.168.1.40', seededProbeList)
  assert.deepEqual(urls, [
    'http://192.168.1.40:1234',
    'http://192.168.1.40:11434',
    'http://192.168.1.40:8880',
    'http://192.168.1.40:8080',
    'http://192.168.1.40:8000',
  ])
})

test('hostTargets dedupes ports and skips malformed probe URLs (the document is user-editable)', () => {
  const probes: ProbeList = {
    id: 'p',
    version: 1,
    probes: [
      { name: 'a', url: 'http://localhost:1234' },
      { name: 'b', url: 'http://otherhost:1234' }, // same port, different host → same target, deduped
      { name: 'bad', url: 'http://' }, // malformed → contributes nothing
      { name: 'c', url: 'http://localhost' }, // no port → default 80
    ],
  }
  assert.deepEqual(hostTargets('rig', probes), ['http://rig:1234', 'http://rig:80'])
})

// --- scanHosts against fake servers ---

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}

const modelServer = (ids: string[], opts: { requireKey?: string } = {}): Server =>
  createServer((req, res) => {
    if (opts.requireKey !== undefined && req.headers.authorization !== `Bearer ${opts.requireKey}`) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'missing bearer token' }))
      return
    }
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: ids.map((id) => ({ id })) }))
      return
    }
    res.writeHead(404)
    res.end()
  })

test('scan exact url: models come back classified through the capability map', async () => {
  const server = modelServer(['ornith-1.0-9b', 'glm-ocr@q8_0', 'qwen2.5-vl-7b', 'whisper-large-v3'])
  const url = await listen(server)
  try {
    const result = await scanHosts({ url }, seededProbeList, MAP)
    assert.equal(result.hosts.length, 1)
    const host = result.hosts[0]!
    assert.equal(host.url, url)
    assert.equal(host.reachable, true)
    assert.equal(host.authRequired, false)
    assert.deepEqual(host.models, [
      { id: 'ornith-1.0-9b', slots: ['llm'] },
      { id: 'glm-ocr@q8_0', slots: ['ocr'] },
      { id: 'qwen2.5-vl-7b', slots: ['llm', 'vlm'] },
      { id: 'whisper-large-v3', slots: ['stt'] },
    ])
    assert.equal(host.error, undefined)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('scan bare host: probes every probe-list port on that host, in parallel', async () => {
  // Two live servers; the probe list is rewritten to their real ports plus one dead port.
  const a = modelServer(['ornith-1.0-9b'])
  const b = modelServer(['whisper-large-v3'])
  const urlA = await listen(a)
  const urlB = await listen(b)
  const portA = new URL(urlA).port
  const portB = new URL(urlB).port
  const probes: ProbeList = {
    id: 'p',
    version: 1,
    probes: [
      { name: 'a', url: `http://localhost:${portA}` },
      { name: 'b', url: `http://localhost:${portB}` },
      { name: 'dead', url: 'http://localhost:1' }, // nothing listens on port 1
    ],
  }
  try {
    const result = await scanHosts({ host: '127.0.0.1' }, probes, MAP, { timeoutMs: 1_000 })
    assert.equal(result.hosts.length, 3)
    const [ha, hb, dead] = result.hosts
    assert.equal(ha!.reachable, true)
    assert.deepEqual(ha!.models.map((m) => m.id), ['ornith-1.0-9b'])
    assert.equal(hb!.reachable, true)
    assert.deepEqual(hb!.models.map((m) => m.id), ['whisper-large-v3'])
    assert.equal(dead!.reachable, false)
    assert.equal(dead!.error?.class, 'unreachable')
    assert.match(dead!.error?.hint ?? '', /is the server running/)
  } finally {
    await new Promise<void>((resolve) => a.close(() => resolve()))
    await new Promise<void>((resolve) => b.close(() => resolve()))
  }
})

test('a 401 server is reachable + authRequired with the classified auth hint; a resolved keyRef unlocks it', async () => {
  const server = modelServer(['ornith-1.0-9b'], { requireKey: 's3cret-value' })
  const url = await listen(server)
  try {
    // no key → the server answers 401: reachable, wants a key, hint says how to wire one
    const locked = await scanHosts({ url }, seededProbeList, MAP)
    const h1 = locked.hosts[0]!
    assert.equal(h1.reachable, true)
    assert.equal(h1.authRequired, true)
    assert.deepEqual(h1.models, [])
    assert.equal(h1.error?.class, 'auth')
    assert.match(h1.error?.hint ?? '', /Settings → Keys/)

    // keyRef provided and resolvable → the rescan lists models; the VALUE never appears in the result
    const unlocked = await scanHosts({ url, keyRef: 'rig-key' }, seededProbeList, MAP, {
      resolveKey: (ref) => (ref === 'rig-key' ? 's3cret-value' : undefined),
    })
    const h2 = unlocked.hosts[0]!
    assert.equal(h2.reachable, true)
    assert.equal(h2.authRequired, false)
    assert.deepEqual(h2.models.map((m) => m.id), ['ornith-1.0-9b'])
    assert.ok(!JSON.stringify(unlocked).includes('s3cret-value'), 'a ScanResult must never carry key material')
    assert.ok(JSON.stringify(locked).includes('s3cret-value') === false)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('a keyRef with NO stored value fails honestly before any fetch — names the ref, never a value', async () => {
  const result = await scanHosts({ url: 'http://127.0.0.1:1', keyRef: 'unset-ref' }, seededProbeList, MAP, {
    resolveKey: () => undefined,
  })
  const host = result.hosts[0]!
  assert.equal(host.reachable, false)
  assert.equal(host.authRequired, true)
  assert.equal(host.error?.class, 'auth')
  assert.match(host.error?.message ?? '', /unresolved secret keyRef "unset-ref"/)
  assert.match(host.error?.hint ?? '', /no value stored/)
})

test('a dead port is classified unreachable; a non-OpenAI server is classified bad-response', async () => {
  const dead = await scanHosts({ url: 'http://127.0.0.1:1' }, seededProbeList, MAP, { timeoutMs: 1_000 })
  assert.equal(dead.hosts[0]!.reachable, false)
  assert.equal(dead.hosts[0]!.error?.class, 'unreachable')

  // answers 200 but not the OpenAI shape → bad-response ("check the URL points at an OpenAI-compatible server")
  const weird = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html>hello</html>')
  })
  const url = await listen(weird)
  try {
    const result = await scanHosts({ url }, seededProbeList, MAP)
    assert.equal(result.hosts[0]!.reachable, false)
    assert.equal(result.hosts[0]!.error?.class, 'bad-response')
    assert.match(result.hosts[0]!.error?.hint ?? '', /OpenAI-compatible/)
  } finally {
    await new Promise<void>((resolve) => weird.close(() => resolve()))
  }
})

test('a hanging server times out and is classified timeout (short, parallel probes)', async () => {
  const slow = createServer(() => {
    /* never responds */
  })
  const url = await listen(slow)
  try {
    const started = Date.now()
    const result = await scanHosts({ url }, seededProbeList, MAP, { timeoutMs: 300 })
    assert.ok(Date.now() - started < 2_000, 'the scan must not hang')
    assert.equal(result.hosts[0]!.reachable, false)
    assert.equal(result.hosts[0]!.error?.class, 'timeout')
  } finally {
    await new Promise<void>((resolve) => slow.close(() => resolve()))
  }
})

test('a request with neither url nor host scans nothing (the route 400s before this)', async () => {
  const result = await scanHosts({}, seededProbeList, MAP)
  assert.deepEqual(result.hosts, [])
  assert.ok(result.scannedAt)
})
