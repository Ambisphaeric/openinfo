import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Endpoint } from '@openinfo/contracts'
import { classifyDestination, classifyEndpoint, classifyHost, egressDecision, isLoopbackEndpoint, mayReceiveRawFrames, resolveEgress } from './egress.js'

/* ---------- Layer 1: endpoint reach classification (pure, URL-derived) ---------- */

test('classifyHost: loopback and 0.0.0.0 are local', () => {
  for (const url of ['http://localhost:8000', 'http://127.0.0.1:1234', 'http://127.5.5.5', 'http://0.0.0.0:11434', 'http://[::1]:8080']) {
    assert.equal(classifyHost(url), 'local', url)
  }
})

test('classifyHost: private + link-local IPv4 ranges are local (LAN)', () => {
  for (const url of ['http://10.1.2.3:8000', 'http://192.168.1.50:8000', 'http://172.16.0.9', 'http://172.31.255.1', 'http://169.254.1.1']) {
    assert.equal(classifyHost(url), 'local', url)
  }
})

test('classifyHost: mDNS .local and IPv6 ULA/link-local are local', () => {
  assert.equal(classifyHost('http://my-mac.local:8000'), 'local')
  assert.equal(classifyHost('http://[fd00::1]:8000'), 'local')
  assert.equal(classifyHost('http://[fe80::1]:8000'), 'local')
})

test('classifyHost: public hosts and routable IPs are egress', () => {
  for (const url of ['https://api.openai.com', 'http://8.8.8.8', 'https://example.com:443', 'http://172.32.0.1', 'http://11.0.0.1']) {
    assert.equal(classifyHost(url), 'egress', url)
  }
})

test('classifyHost: an unparseable url fails CLOSED (egress)', () => {
  assert.equal(classifyHost('not a url'), 'egress')
  assert.equal(classifyHost(''), 'egress')
})

test('classifyEndpoint: local kind is local, cloud kind is egress, http follows its host', () => {
  const local: Endpoint = { kind: 'local', name: 'l', runtime: 'mlx', model: 'm' }
  const cloud: Endpoint = { kind: 'cloud', name: 'c', provider: 'anthropic', auth: 'keychain' }
  const httpLocal: Endpoint = { kind: 'http', name: 'h', url: 'http://127.0.0.1:8000', api: 'openai-compat' }
  const httpEgress: Endpoint = { kind: 'http', name: 'h', url: 'https://api.example.com', api: 'openai-compat' }
  assert.equal(classifyEndpoint(local), 'local')
  assert.equal(classifyEndpoint(cloud), 'egress')
  assert.equal(classifyEndpoint(httpLocal), 'local')
  assert.equal(classifyEndpoint(httpEgress), 'egress')
})

test('isLoopbackEndpoint: distinguishes this machine from private-LAN endpoints', () => {
  const endpoint = (url: string): Endpoint => ({ kind: 'http', name: url, url, api: 'openai-compat' })
  for (const url of ['http://localhost:8000', 'http://worker.localhost:8000', 'http://127.5.5.5:8000', 'http://[::1]:8000']) {
    assert.equal(isLoopbackEndpoint(endpoint(url)), true, url)
  }
  for (const url of ['http://0.0.0.0:8000', 'http://[::]:8000', 'http://10.1.2.3:8000', 'http://192.168.1.50:8000', 'http://worker.local:8000', 'https://api.example.com']) {
    assert.equal(isLoopbackEndpoint(endpoint(url)), false, url)
  }
  assert.equal(isLoopbackEndpoint({ kind: 'local', name: 'managed', runtime: 'mlx', model: 'm' }), true)
  assert.equal(isLoopbackEndpoint({ kind: 'cloud', name: 'cloud', provider: 'anthropic', auth: 'keychain' }), false)
})

test('classifyDestination: distinguishes device-local, LAN-local, and hosted/public without retaining an address', () => {
  const endpoint = (url: string): Endpoint => ({ kind: 'http', name: 'safe-name', url, api: 'openai-compat' })
  assert.equal(classifyDestination({ kind: 'local', name: 'managed', runtime: 'mlx', model: 'm' }), 'device-local')
  assert.equal(classifyDestination(endpoint('http://127.0.0.1:8000')), 'device-local')
  assert.equal(classifyDestination(endpoint('http://192.168.1.50:8000')), 'lan-local')
  assert.equal(classifyDestination(endpoint('http://vision-box.local:8000')), 'lan-local')
  assert.equal(classifyDestination(endpoint('https://vision.example.com')), 'hosted-public')
  assert.equal(classifyDestination(endpoint('not a url')), 'hosted-public')
})

test('mayReceiveRawFrames: the full truth table — loopback default, explicit LAN trust, an absolute LAN cap', () => {
  const http = (url: string, trustRawFrames?: boolean): Endpoint => ({
    kind: 'http',
    name: url,
    url,
    api: 'openai-compat',
    ...(trustRawFrames !== undefined ? { trustRawFrames } : {}),
  })
  // loopback needs NO flag — the default posture is unchanged
  assert.equal(mayReceiveRawFrames(http('http://127.0.0.1:8000')), true)
  assert.equal(mayReceiveRawFrames(http('http://localhost:8000')), true)
  // a managed local runtime is engine-spawned on loopback — always allowed
  assert.equal(mayReceiveRawFrames({ kind: 'local', name: 'managed', runtime: 'mlx', model: 'm' }), true)
  // an explicitly trusted LAN host IS allowed — the user's opt-in, capped to the local network
  assert.equal(mayReceiveRawFrames(http('http://192.168.1.50:8000', true)), true)
  assert.equal(mayReceiveRawFrames(http('http://10.1.2.3:8000', true)), true)
  assert.equal(mayReceiveRawFrames(http('http://vision-box.local:8000', true)), true)
  // an UNtrusted LAN host stays denied — absent flag means loopback-only, exactly as before
  assert.equal(mayReceiveRawFrames(http('http://192.168.1.50:8000')), false)
  assert.equal(mayReceiveRawFrames(http('http://10.1.2.3:8000', false)), false)
  // the LAN cap is ABSOLUTE: a public host is denied even when flagged
  assert.equal(mayReceiveRawFrames(http('https://vision.example.com', true)), false)
  assert.equal(mayReceiveRawFrames(http('http://8.8.8.8:8000', true)), false)
  // a wildcard bind address is not a destination host — the flag never trusts it
  assert.equal(mayReceiveRawFrames(http('http://0.0.0.0:8000', true)), false)
  assert.equal(mayReceiveRawFrames(http('http://[::]:8000', true)), false)
  assert.equal(mayReceiveRawFrames(http('not a url', true)), false)
  // cloud endpoints never receive raw frames
  assert.equal(mayReceiveRawFrames({ kind: 'cloud', name: 'cloud', provider: 'anthropic', auth: 'keychain' }), false)
})

/* ---------- Layers 2-4: content-side consent, most-specific denial wins ---------- */

test('resolveEgress: no layer denies ⇒ allowed by default', () => {
  const c = resolveEgress({ contentClass: 'transcript' })
  assert.equal(c.allowed, true)
  assert.equal(c.decidedBy, 'default')
})

test('resolveEgress: content-class screen denies (layer 4)', () => {
  const c = resolveEgress({ contentClass: 'screen' })
  assert.equal(c.allowed, false)
  assert.equal(c.decidedBy, 'content-class')
})

test('resolveEgress: prompt never-egress denies (layer 2)', () => {
  const c = resolveEgress({ contentClass: 'transcript', promptNeverEgress: true })
  assert.equal(c.allowed, false)
  assert.equal(c.decidedBy, 'prompt')
})

test('resolveEgress: mode deny (layer 3) and workspace deny (layer 3)', () => {
  assert.equal(resolveEgress({ modeDenies: true }).decidedBy, 'mode')
  assert.equal(resolveEgress({ workspaceDenies: true }).decidedBy, 'workspace')
})

test('resolveEgress: MOST-SPECIFIC denial wins when several layers deny', () => {
  // content-class > prompt > mode > workspace — content-class wins over all others.
  const c = resolveEgress({ contentClass: 'screen', promptNeverEgress: true, modeDenies: true, workspaceDenies: true })
  assert.equal(c.decidedBy, 'content-class')
  // prompt wins over mode+workspace
  const p = resolveEgress({ contentClass: 'transcript', promptNeverEgress: true, modeDenies: true, workspaceDenies: true })
  assert.equal(p.decidedBy, 'prompt')
  // mode wins over workspace
  const m = resolveEgress({ modeDenies: true, workspaceDenies: true })
  assert.equal(m.decidedBy, 'mode')
})

test('resolveEgress: unknown content class is not a silent deny', () => {
  assert.equal(resolveEgress({ contentClass: 'unknown' }).allowed, true)
  assert.equal(resolveEgress({}).allowed, true)
})

/* ---------- egressDecision: fuse reach with consent for provenance ---------- */

test('egressDecision: coarse local reach never fabricates device-local destination scope', () => {
  const d = egressDecision('local', resolveEgress({ contentClass: 'screen' }))
  assert.equal(d.reach, 'local')
  assert.equal(d.allowed, false)
  assert.equal(d.decidedBy, 'content-class')
  assert.equal(d.destination, undefined)
  assert.match(d.reason, /destination scope was not recorded/)
  assert.doesNotMatch(d.reason, /this device|device-local/)
})

test('egressDecision: egress reach can only pair with allowed consent (honest invariant)', () => {
  const d = egressDecision('egress', resolveEgress({ contentClass: 'transcript' }))
  assert.equal(d.reach, 'egress')
  assert.equal(d.allowed, true)
  assert.equal(d.destination, 'hosted-public')
  assert.match(d.reason, /left the machine/)
})

test('egressDecision: trusted-LAN raw-frame detail records boundary crossing and explicit trust without an address', () => {
  const d = egressDecision('local', resolveEgress({ contentClass: 'screen' }), {
    destination: 'lan-local',
    rawFrameTrust: 'explicit',
  })
  assert.deepEqual(
    {
      reach: d.reach,
      destination: d.destination,
      rawFrameTrust: d.rawFrameTrust,
      allowed: d.allowed,
      decidedBy: d.decidedBy,
    },
    {
      reach: 'local',
      destination: 'lan-local',
      rawFrameTrust: 'explicit',
      allowed: false,
      decidedBy: 'content-class',
    },
  )
  assert.match(d.reason, /crossed the device boundary/)
  assert.match(d.reason, /explicitly trusted LAN destination/)
  assert.match(d.reason, /hosted\/public egress remained denied/)
  assert.equal(d.reason.includes('192.168.'), false)
})
