import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FocusSignal, Session, WorkspaceHints } from '@openinfo/contracts'
import { WorkspaceRegistry } from '../store/index.js'
import { Attributor, type AttributionEvent } from './attribute.js'
import { HintsDocuments } from './hints.js'
import type { TimedFocusSignal } from './detector.js'

const at = (sec: number): string => new Date(Date.UTC(2026, 6, 7, 14, 0, 0) + sec * 1000).toISOString()
const sales: FocusSignal = { app: 'Chrome', windowTitle: 'Acme — Salesforce', repoPath: '/Users/dev/acme-crm' }
const idle: FocusSignal = { app: 'Finder', windowTitle: 'Downloads' }

const salesHints: WorkspaceHints = { workspaceId: 'sales', patterns: [{ field: 'repoPath', contains: 'acme-crm', weight: 0.7 }] }
const streamOf = (signal: FocusSignal, count: number, step = 10): TimedFocusSignal[] =>
  Array.from({ length: count }, (_, i) => ({ at: at(i * step), signal }))

interface Harness {
  store: WorkspaceRegistry
  attributor: Attributor
  events: { event: AttributionEvent; session: Session }[]
  cleanup: () => Promise<void>
}

const harness = async (): Promise<Harness> => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-attr-'))
  const store = new WorkspaceRegistry(dir)
  const hints = new HintsDocuments(store)
  hints.ensureDefaults()
  hints.put(salesHints)
  store.ensureWorkspace({ id: 'sales', name: 'Sales' })
  const events: { event: AttributionEvent; session: Session }[] = []
  let seq = 0
  const attributor = new Attributor({
    store,
    hints,
    publish: (event, session) => { events.push({ event, session }) },
    modeId: () => 'mode-meeting',
    now: () => new Date('2026-07-07T15:00:00Z'),
    newId: () => `auto-${(seq += 1)}`,
  })
  return { store, attributor, events, cleanup: async () => { store.close(); await rm(dir, { recursive: true, force: true }) } }
}

test('no live session + sustained match → AUTO-START in the matched workspace with evidence, confidence < 1', async () => {
  const h = await harness()
  try {
    const result = await h.attributor.observe(streamOf(sales, 11))
    assert.equal(result.decision, 'switch')
    const live = h.store.liveSession('sales')
    assert.ok(live)
    assert.equal(live.modeId, 'mode-meeting')
    assert.ok(live.attribution.evidence.length >= 1)
    assert.ok(live.attribution.confidence < 1)
    // an auto-start carries ONLY detector evidence — never a 'manual' entry
    assert.ok(!live.attribution.evidence.some((e) => e.kind === 'manual'))
    assert.deepEqual(h.events.map((e) => e.event), ['session.started'])
  } finally {
    await h.cleanup()
  }
})

test('live session in W1 + sustained match for W2 → auto-END W1, START W2, emit session.switched', async () => {
  const h = await harness()
  try {
    const w1: Session = {
      id: 'manual-1', workspaceId: 'default', modeId: 'mode-meeting', startedAt: '2026-07-07T14:59:00Z',
      attribution: { evidence: [{ kind: 'manual', detail: 'started manually', weight: 1 }], confidence: 1 },
    }
    h.store.saveSession(w1)

    await h.attributor.observe(streamOf(sales, 11))

    assert.ok(h.store.liveSession('default') === undefined, 'W1 session auto-ended')
    assert.equal(h.store.findSession('manual-1')?.endedAt, new Date('2026-07-07T15:00:00Z').toISOString())
    const w2Live = h.store.liveSession('sales')
    assert.ok(w2Live)
    assert.deepEqual(h.events.map((e) => e.event), ['session.ended', 'session.started', 'session.switched'])
    // session.switched carries the STARTED session (the router's action), not the ended one
    assert.equal(h.events[2]!.session.id, w2Live.id)
  } finally {
    await h.cleanup()
  }
})

test('ambiguous / sub-sustain signals produce no session and emit nothing (thrash + flag-independent no-op)', async () => {
  const h = await harness()
  try {
    const result = await h.attributor.observe(streamOf(idle, 11)) // matches no hints
    assert.equal(result.decision, 'stay')
    assert.equal(h.store.liveSession('sales'), undefined)
    assert.equal(h.store.liveSession('default'), undefined)
    assert.deepEqual(h.events, [])
  } finally {
    await h.cleanup()
  }
})
