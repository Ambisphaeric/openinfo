import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Endpoint } from '@openinfo/contracts'
import { classifyEndpoint, classifyHost, egressDecision, resolveEgress } from './egress.js'

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

test('egressDecision: local reach + denied consent records stayed-local + the layer', () => {
  const d = egressDecision('local', resolveEgress({ contentClass: 'screen' }))
  assert.equal(d.reach, 'local')
  assert.equal(d.allowed, false)
  assert.equal(d.decidedBy, 'content-class')
  assert.match(d.reason, /stayed local/)
})

test('egressDecision: egress reach can only pair with allowed consent (honest invariant)', () => {
  const d = egressDecision('egress', resolveEgress({ contentClass: 'transcript' }))
  assert.equal(d.reach, 'egress')
  assert.equal(d.allowed, true)
  assert.match(d.reason, /left the machine/)
})
