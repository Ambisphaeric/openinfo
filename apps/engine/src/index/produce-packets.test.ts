import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Session, SttSegment } from '@openinfo/contracts'
import { WorkspaceRegistry } from '../store/index.js'
import { materializeContextPackets, PacketBuildLog } from './produce-packets.js'

/**
 * The LIVE producer seam (#176 slice 2). Drives the REAL store: it materializes packets from stored
 * observations WITHOUT the on-demand route, is idempotent on a converged rebuild, isolates workspaces, and
 * — the non-negotiable — CONTAINS a failure (never throws, records the reason on the log) so a build error
 * is visible in diagnostics and never sinks the capture path that produced the observations.
 */

const startSession = (store: WorkspaceRegistry, workspaceId: string, id: string): Session => {
  const session: Session = {
    id,
    workspaceId,
    modeId: 'mode-meeting',
    startedAt: '2026-07-14T09:00:00.000Z',
    attribution: { confidence: 1, evidence: [] },
  }
  store.saveSession(session)
  return session
}

const micSegment = (workspaceId: string, sessionId: string, id: string, at: string): SttSegment => ({
  id,
  workspaceId,
  sessionId,
  chunkId: `${id}-chunk`,
  source: 'mic',
  capturedAt: at,
  processedAt: at,
  textChars: 42,
  provenance: { slot: 'stt', endpoint: 'fixture-parakeet' },
  schemaVersion: 1,
  createdAt: at,
})

test('#176 live producer: materializes packets from stored observations without the on-demand route', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-produce-'))
  const store = new WorkspaceRegistry(dir)
  const log = new PacketBuildLog()
  try {
    const session = startSession(store, 'default', 'ses-live')
    store.saveSttSegment(micSegment('default', session.id, 'stt-1', '2026-07-14T09:00:05.000Z'))
    store.saveSttSegment(micSegment('default', session.id, 'stt-2', '2026-07-14T09:00:10.000Z'))

    const first = materializeContextPackets({ store, log }, { workspaceId: 'default', sessionId: session.id, trigger: 'session-end' })
    assert.equal(first.error, undefined, 'a clean build has no error')
    assert.equal(first.created.length, 1, 'one window materialized from the two in-window mic segments')
    assert.equal(first.created[0]!.microphone.length, 2)
    assert.deepEqual(first.created[0]!.gaps.map((g) => g.lane).sort(), ['screen', 'system-audio'], 'the two silent lanes degrade honestly')

    // The packet is now durably queryable — with NO POST /context/packets/build ever called.
    const stored = store.listContextPackets('default', { sessionId: session.id })
    assert.deepEqual(stored.map((p) => p.id), first.created.map((p) => p.id))

    // The build log carries the honest success outcome for the diagnostics "last update" line.
    const attempt = log.latestFor('default', session.id)
    assert.ok(attempt && attempt.error === undefined && attempt.created === 1 && attempt.trigger === 'session-end')

    // Idempotent: a converged rebuild appends nothing (the honest no-op) and records unchanged=1.
    const again = materializeContextPackets({ store, log }, { workspaceId: 'default', sessionId: session.id, trigger: 'session-end' })
    assert.equal(again.created.length, 0, 'nothing changed ⇒ nothing appended')
    assert.equal(again.unchanged.length, 1)
    assert.equal(log.latestFor('default', session.id)!.created, 0)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('#176 live producer: workspace isolation — a build reads and writes only its own workspace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-produce-iso-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const a = startSession(store, 'ws-a', 'ses-a')
    const b = startSession(store, 'ws-b', 'ses-b')
    store.saveSttSegment(micSegment('ws-a', a.id, 'stt-a', '2026-07-14T09:00:05.000Z'))
    store.saveSttSegment(micSegment('ws-b', b.id, 'stt-b', '2026-07-14T09:00:05.000Z'))

    materializeContextPackets({ store }, { workspaceId: 'ws-a', sessionId: a.id, trigger: 'session-end' })
    assert.equal(store.listContextPackets('ws-a').length, 1, 'ws-a has its packet')
    assert.equal(store.listContextPackets('ws-b').length, 0, 'ws-b is untouched by the ws-a build')
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('#176 live producer: a build failure is CONTAINED — never thrown, recorded on the log with its reason', async () => {
  const log = new PacketBuildLog()
  // A store stub whose first read throws — the failure the capture path must survive. materialize must
  // catch it, record it, and return an error outcome rather than propagating.
  const boom = 'disk read failed mid-build'
  const brokenStore = {
    getSession: () => undefined,
    listSttSegments: () => {
      throw new Error(boom)
    },
  } as unknown as WorkspaceRegistry

  let threw = false
  let outcome
  try {
    outcome = materializeContextPackets({ store: brokenStore, log }, { workspaceId: 'default', sessionId: 'ses-x', trigger: 'session-end' })
  } catch {
    threw = true
  }
  assert.equal(threw, false, 'materialize never throws — the capture path is never sunk by a packet build')
  assert.ok(outcome && outcome.error === boom, 'the true reason is returned in the outcome')
  assert.deepEqual(outcome!.created, [], 'nothing is claimed built on failure')
  const attempt = log.latestFor('default', 'ses-x')
  assert.ok(attempt && attempt.error === boom, 'the failure is recorded for the diagnostics “last update didn’t finish” line')
})
