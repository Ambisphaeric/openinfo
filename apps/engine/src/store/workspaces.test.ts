import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WorkspaceRegistry } from './workspaces.js'

test('workspace registry creates one sqlite file per workspace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-store-'))
  try {
    const registry = new WorkspaceRegistry(dir)
    const workspace = registry.ensureWorkspace({ id: 'sales', name: 'Sales' })
    assert.equal(workspace.dbFile, 'sales.db')
    assert.ok(existsSync(join(dir, '_meta.db')))
    assert.ok(existsSync(join(dir, 'default.db')))
    assert.ok(existsSync(join(dir, 'sales.db')))
    assert.deepEqual(registry.all().map((entry) => entry.id), ['default', 'sales'])
    registry.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('pill P2: the active-preset selection round-trips, clears, and persists across reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-ws-preset-'))
  try {
    const registry = new WorkspaceRegistry(dir)
    // Unset by default — the byte-identical seam: no selection ⇒ no injection.
    assert.equal(registry.getActivePreset('default'), undefined, 'unset by default')
    // A workspace that was never created reads undefined rather than throwing (degradable seam).
    assert.equal(registry.getActivePreset('never-made'), undefined, 'unknown workspace reads undefined')
    // Set, then read back through the SAME narrow read the distiller and P1 land on.
    registry.setActivePreset('default', 'preset-sales')
    assert.equal(registry.getActivePreset('default'), 'preset-sales', 'selection reads back')
    // The store creates the workspace on demand (mirrors the other writers).
    registry.setActivePreset('sales-ws', 'preset-recruiting')
    assert.equal(registry.getActivePreset('sales-ws'), 'preset-recruiting', 'write creates the workspace')
    // Clearing round-trips as absent — back to no injection.
    registry.setActivePreset('default', undefined)
    assert.equal(registry.getActivePreset('default'), undefined, 'cleared selection reads undefined')
    registry.close()

    // Durable: a fresh registry over the same dir rehydrates the selection (persisted, not in-memory).
    const reopened = new WorkspaceRegistry(dir)
    assert.equal(reopened.getActivePreset('sales-ws'), 'preset-recruiting', 'selection persists across reopen')
    reopened.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('#128: a workspace-level egress deny survives the store row round-trip (fromRow used to drop it)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-ws-egress-'))
  try {
    const registry = new WorkspaceRegistry(dir)
    // Set the layer-3 egress-deny policy, then read it back through the SAME code path the distiller uses.
    const set = registry.setEgressPolicy('default', { deny: true })
    assert.equal(set.egress?.deny, true)
    assert.equal(registry.all().find((w) => w.id === 'default')?.egress?.deny, true, 'all() rehydrates egress')
    assert.equal(registry.ensureWorkspace({ id: 'default', name: 'Default' }).egress?.deny, true, 'ensureWorkspace too')
    registry.close()

    // The policy is durable: a fresh registry over the same dir rehydrates the deny (persisted, not in-memory).
    const reopened = new WorkspaceRegistry(dir)
    assert.equal(reopened.all().find((w) => w.id === 'default')?.egress?.deny, true, 'the deny persists across reopen')
    // Clearing the policy round-trips as absent — the workspace defers to the other layers again.
    reopened.setEgressPolicy('default', undefined)
    assert.equal(reopened.all().find((w) => w.id === 'default')?.egress, undefined, 'a cleared policy reads as absent')
    reopened.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('upsertEntity resolves the same entity across windows into ONE record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-entities-'))
  try {
    const registry = new WorkspaceRegistry(dir)

    // window 1: "Dana" — created, mentions 1
    const first = registry.upsertEntity({
      workspaceId: 'ws-ent', kind: 'person', name: 'Dana', seenAt: '2026-07-07T14:00:00Z',
      provenance: { distillateId: 'dst-1', slot: 'llm', endpoint: 'llm.fast' },
      momentRefs: ['mom-1'],
    })
    assert.equal(first.mentions, 1)
    assert.equal(first.firstSeen, '2026-07-07T14:00:00Z')

    // window 2: "dana" (case/whitespace-insensitive match) with a new alias — merged, mentions 2
    const second = registry.upsertEntity({
      workspaceId: 'ws-ent', kind: 'person', name: '  dana ', aliases: ['Dana Cruz'], seenAt: '2026-07-07T14:45:00Z',
      provenance: { distillateId: 'dst-2', slot: 'llm', endpoint: 'llm.fast' },
      momentRefs: ['mom-2', 'mom-1'],
    })
    assert.equal(second.id, first.id)
    assert.equal(second.mentions, 2)
    assert.equal(second.name, 'Dana') // canonical name stays; the variant is not duplicated
    assert.deepEqual(second.aliases, ['Dana Cruz'])
    assert.equal(second.firstSeen, '2026-07-07T14:00:00Z')
    assert.equal(second.lastSeen, '2026-07-07T14:45:00Z')
    assert.deepEqual(second.momentRefs, ['mom-1', 'mom-2']) // unioned, no dupes
    assert.deepEqual(second.provenance?.map((p) => p.distillateId), ['dst-1', 'dst-2']) // full trail

    // window 3: mention via the ALIAS resolves to the same record
    const third = registry.upsertEntity({
      workspaceId: 'ws-ent', kind: 'person', name: 'dana cruz', seenAt: '2026-07-07T15:00:00Z',
    })
    assert.equal(third.id, first.id)
    assert.equal(third.mentions, 3)

    // same name, DIFFERENT KIND is a different entity (a topic "dana" is a distinct record)
    const topic = registry.upsertEntity({
      workspaceId: 'ws-ent', kind: 'topic', name: 'Dana', seenAt: '2026-07-07T15:00:00Z',
    })
    assert.notEqual(topic.id, first.id)

    assert.equal(registry.listEntities('ws-ent').length, 2)
    registry.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('sessions persist in their own workspace DB; live filter + cross-workspace find', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-sessions-'))
  try {
    const registry = new WorkspaceRegistry(dir)
    const session: import('@openinfo/contracts').Session = {
      id: 'ses-a', workspaceId: 'ws-a', modeId: 'mode-meeting', startedAt: '2026-07-07T14:00:00Z',
      attribution: { evidence: [{ kind: 'manual', detail: 'started manually', weight: 1 }], confidence: 1 },
    }
    registry.saveSession(session)

    // isolation: the session lives in ws-a's DB, not ws-b's, not default's
    assert.equal(registry.getSession('ws-a', 'ses-a')?.id, 'ses-a')
    assert.equal(registry.getSession('default', 'ses-a'), undefined)
    assert.deepEqual(registry.listSessions('ws-b'), [])

    // live while unended; drops off the live list once ended
    assert.equal(registry.liveSession('ws-a')?.id, 'ses-a')
    registry.saveSession({ ...session, endedAt: '2026-07-07T15:00:00Z' })
    assert.equal(registry.liveSession('ws-a'), undefined)
    assert.equal(registry.listSessions('ws-a').length, 1) // still listed, just not live
    assert.equal(registry.listSessions('ws-a', { live: true }).length, 0)

    // findSession locates it across workspaces without knowing its workspace
    assert.equal(registry.findSession('ses-a')?.workspaceId, 'ws-a')
    assert.equal(registry.findSession('ses-nowhere'), undefined)
    registry.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('addEntityMomentRefs appends refs; unknown entity is undefined', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-entities-'))
  try {
    const registry = new WorkspaceRegistry(dir)
    const entity = registry.upsertEntity({
      workspaceId: 'ws-ent', kind: 'artifact', name: 'SOC 2 addendum', seenAt: '2026-07-07T14:00:00Z', momentRefs: ['mom-1'],
    })
    const updated = registry.addEntityMomentRefs('ws-ent', entity.id, ['mom-2', 'mom-1'])
    assert.deepEqual(updated?.momentRefs, ['mom-1', 'mom-2'])
    assert.equal(registry.addEntityMomentRefs('ws-ent', 'ent-nowhere', ['mom-9']), undefined)
    registry.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('upsertEntity populates v2 sightings + heardAs; both are append-only and idempotent on re-run (#73)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-entities-v2-'))
  try {
    const registry = new WorkspaceRegistry(dir)
    // window 1: creates the record (canonical "Sam Rivera", alias "Sam") with one sighting + one heard-as
    const first = registry.upsertEntity({
      workspaceId: 'ws-v2', kind: 'person', name: 'Sam Rivera', aliases: ['Sam'], seenAt: '2026-07-08T09:00:00Z',
      sighting: { via: 'heard', at: '2026-07-08T09:00:00Z', distillateId: 'dst-1' },
      heardAs: { text: 'Sam Rivera', source: 'stt', at: '2026-07-08T09:00:00Z' },
    })
    assert.deepEqual(first.sightings?.map((s) => s.distillateId), ['dst-1'])
    assert.deepEqual(first.heardAs?.map((h) => h.text), ['Sam Rivera'])
    // state/confidence are NOT stamped by plain extraction (no resolver scores them yet)
    assert.equal(first.state, undefined)
    assert.equal(first.confidence, undefined)

    // window 2: heard as the KNOWN alias "Sam" (resolves to the same record) in a new window ⇒ both trails grow
    const second = registry.upsertEntity({
      workspaceId: 'ws-v2', kind: 'person', name: 'Sam', seenAt: '2026-07-08T09:05:00Z',
      sighting: { via: 'heard', at: '2026-07-08T09:05:00Z', distillateId: 'dst-2' },
      heardAs: { text: 'Sam', source: 'stt', at: '2026-07-08T09:05:00Z' },
    })
    assert.equal(second.id, first.id)
    assert.deepEqual(second.sightings?.map((s) => s.distillateId), ['dst-1', 'dst-2'])
    assert.deepEqual(second.heardAs?.map((h) => h.text), ['Sam Rivera', 'Sam'])

    // re-run of window 2 (same sighting + same surface form) adds NOTHING — idempotent dedup
    const again = registry.upsertEntity({
      workspaceId: 'ws-v2', kind: 'person', name: 'Sam', seenAt: '2026-07-08T09:05:00Z',
      sighting: { via: 'heard', at: '2026-07-08T09:05:00Z', distillateId: 'dst-2' },
      heardAs: { text: 'Sam', source: 'stt', at: '2026-07-08T09:05:00Z' },
    })
    assert.equal(again.sightings?.length, 2)
    assert.equal(again.heardAs?.length, 2)
    registry.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('overrideEntity is sovereign: pins the mapping, stamps confirmed, and outranks a rival in findEntity (#73)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-entities-override-'))
  try {
    const registry = new WorkspaceRegistry(dir)
    // two rival people, BOTH plausibly "Sam"
    const rivera = registry.upsertEntity({ workspaceId: 'ws-ov', kind: 'person', name: 'Sam Rivera', seenAt: '2026-07-08T09:00:00Z' })
    const lee = registry.upsertEntity({ workspaceId: 'ws-ov', kind: 'person', name: 'Sam Lee', seenAt: '2026-07-08T09:01:00Z' })
    assert.notEqual(rivera.id, lee.id)

    // the user pins "Sam" → Sam Rivera, rejecting Sam Lee
    const confirmed = registry.overrideEntity('ws-ov', rivera.id, {
      at: '2026-07-08T10:00:00Z', by: 'the user', pinnedName: 'Sam', rejectedRivalId: lee.id, rejectedRivalName: 'Sam Lee',
      note: 'Sam here is Sam Rivera',
    })
    assert.equal(confirmed?.state, 'confirmed')
    assert.equal(confirmed?.confidence, 1)
    assert.equal(confirmed?.overrides?.length, 1)
    assert.ok(confirmed?.aliases.includes('Sam')) // pinned surface form is now an alias

    // a later mention of "Sam" resolves to the PINNED entity, never re-scored against the rejected rival
    const laterMention = registry.upsertEntity({ workspaceId: 'ws-ov', kind: 'person', name: 'Sam', seenAt: '2026-07-08T11:00:00Z' })
    assert.equal(laterMention.id, rivera.id)
    assert.equal(laterMention.state, 'confirmed') // the confirmed state survives subsequent mentions (reads honor it)
    assert.equal(laterMention.confidence, 1)

    assert.equal(registry.overrideEntity('ws-ov', 'ent-nowhere', { at: '2026-07-08T10:00:00Z' }), undefined)
    registry.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('migration-safe: a v1 entity row with no v2 fields loads, re-upserts, and can be overridden (#73)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-entities-migrate-'))
  try {
    const registry = new WorkspaceRegistry(dir)
    // a v1-shaped mention carries NO sighting/heardAs — the record has neither trail (no fabrication)
    const v1 = registry.upsertEntity({ workspaceId: 'ws-mig', kind: 'topic', name: 'renewal', seenAt: '2026-07-08T09:00:00Z' })
    assert.equal(v1.sightings, undefined)
    assert.equal(v1.heardAs, undefined)
    assert.equal(v1.state, undefined)
    // it still loads and merges on a later mention, and remains overridable
    const merged = registry.upsertEntity({ workspaceId: 'ws-mig', kind: 'topic', name: 'renewal', seenAt: '2026-07-08T09:05:00Z' })
    assert.equal(merged.mentions, 2)
    const ov = registry.overrideEntity('ws-mig', v1.id, { at: '2026-07-08T10:00:00Z', by: 'the user', note: 'a real topic' })
    assert.equal(ov?.state, 'confirmed')
    registry.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('resolver (#72): an ASR-mangled mention fuzzy-links to the record, writes the variant back to heardAs (not aliases), and records the resolution', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-resolve-'))
  try {
    const registry = new WorkspaceRegistry(dir)
    // an established repo record
    const repo = registry.upsertEntity({
      workspaceId: 'ws-r', kind: 'artifact', name: 'pi.dev', seenAt: '2026-07-08T09:00:00Z',
      heardAs: { text: 'pi.dev', source: 'stt', at: '2026-07-08T09:00:00Z' },
    })
    assert.equal(repo.state, undefined) // first-of-its-kind create is silent
    assert.equal(repo.resolutions?.at(-1)?.band, 'new')

    // heard through imperfect ASR as "pie dev" — must find the SAME record, not spawn a new one
    const heard = registry.upsertEntity({
      workspaceId: 'ws-r', kind: 'artifact', name: 'pie dev', seenAt: '2026-07-08T09:05:00Z',
      heardAs: { text: 'pie dev', source: 'stt', at: '2026-07-08T09:05:00Z' },
    })
    assert.equal(heard.id, repo.id, 'fuzzy-linked to pi.dev')
    // the corrupted heard form landed in heardAs (the write-back), NOT in aliases
    assert.ok(heard.heardAs?.some((h) => h.text === 'pie dev'), 'variant written back to heardAs')
    assert.ok(!heard.aliases.includes('pie dev'), 'ASR corruption is NOT promoted to an alias')
    // the resolution is recorded with score + band + components
    const res = heard.resolutions?.at(-1)
    assert.equal(res?.heard, 'pie dev')
    assert.ok(res && res.score > 0 && res.phoneticFuzzy > 0, 'score/components recorded')
    assert.ok(res && (res.band === 'auto' || res.band === 'provisional'), `linked band, got ${res?.band}`)
    registry.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('resolver (#72): a provisional-band link stamps the reviewable micro-state + confidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-resolve-prov-'))
  try {
    const registry = new WorkspaceRegistry(dir)
    const full = registry.upsertEntity({ workspaceId: 'ws-p', kind: 'person', name: 'Dana Cruz', seenAt: '2026-07-08T09:00:00Z' })
    // a bare first name is a plausible-but-uncertain link → provisional band
    const bare = registry.upsertEntity({
      workspaceId: 'ws-p', kind: 'person', name: 'Dana', seenAt: '2026-07-08T09:05:00Z',
      resolverConfig: { autoBand: 0.85, provisionalBand: 0.5, ambiguityMargin: 0.05, establishmentBoost: 0.1, establishmentSaturation: 32, halfLifeHours: 168 },
    })
    assert.equal(bare.id, full.id, 'linked to Dana Cruz')
    assert.equal(bare.state, 'provisional', 'reviewable micro-state stamped')
    assert.ok((bare.confidence ?? 0) >= 0.5 && (bare.confidence ?? 1) < 0.85, `provisional confidence ${bare.confidence}`)
    registry.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('resolver (#72): exact matches still resolve identically — score 1, band auto, no micro-state (regression)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-resolve-reg-'))
  try {
    const registry = new WorkspaceRegistry(dir)
    const first = registry.upsertEntity({ workspaceId: 'ws-x', kind: 'topic', name: 'renewal', seenAt: '2026-07-08T09:00:00Z' })
    const again = registry.upsertEntity({ workspaceId: 'ws-x', kind: 'topic', name: 'renewal', seenAt: '2026-07-08T09:05:00Z' })
    assert.equal(again.id, first.id)
    assert.equal(again.mentions, 2)
    assert.equal(again.state, undefined) // silent auto-link — no dot, identical to pre-resolver behavior
    assert.equal(again.confidence, undefined)
    const res = again.resolutions?.at(-1)
    assert.equal(res?.score, 1)
    assert.equal(res?.band, 'auto')
    registry.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('#94 create-marking: an unrelated create amid a same-kind corpus stays SILENT (no near rival)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-create-silent-'))
  try {
    const registry = new WorkspaceRegistry(dir)
    // A same-kind corpus already exists — under the OLD rule this alone stamped every new create provisional.
    const rivera = registry.upsertEntity({ workspaceId: 'ws-c', kind: 'person', name: 'Sam Rivera', seenAt: '2026-07-08T09:00:00Z' })
    assert.equal(rivera.state, undefined, 'first-of-its-kind create is silent')

    // A CJK name shares NO surface form with the Latin corpus → best rival scores ~0 → clean silent create.
    const tanaka = registry.upsertEntity({ workspaceId: 'ws-c', kind: 'person', name: '田中太郎', seenAt: '2026-07-08T09:05:00Z' })
    assert.notEqual(tanaka.id, rivera.id, 'a genuinely new record, not a merge')
    assert.equal(tanaka.state, undefined, 'unrelated create with no near rival stays silent (not provisional)')
    assert.equal(tanaka.resolutions?.at(-1)?.band, 'new')

    // Contrast: a distant near-miss (shares one token but scores below the near-band window) also stays silent.
    const cruz = registry.upsertEntity({ workspaceId: 'ws-c2', kind: 'person', name: 'Dana Cruz', seenAt: '2026-07-08T09:00:00Z' })
    const kim = registry.upsertEntity({ workspaceId: 'ws-c2', kind: 'person', name: 'Dana Kim', seenAt: '2026-07-08T09:05:00Z' })
    assert.notEqual(kim.id, cruz.id)
    assert.equal(kim.state, undefined, 'a far-below-band rival does not trigger the review dot')
    registry.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('#94 create-marking: a create with a NEAR-provisional-band rival is still stamped provisional', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-create-prov-'))
  try {
    const registry = new WorkspaceRegistry(dir)
    const rivera = registry.upsertEntity({ workspaceId: 'ws-n', kind: 'person', name: 'Sam Rivera', seenAt: '2026-07-08T09:00:00Z' })
    // "Sam Lee" shares the "Sam" token → scores in the near-band window (new band, but rival ≥ band − margin).
    const lee = registry.upsertEntity({ workspaceId: 'ws-n', kind: 'person', name: 'Sam Lee', seenAt: '2026-07-08T09:05:00Z' })
    assert.notEqual(lee.id, rivera.id, 'stays a distinct record (does not merge)')
    assert.equal(lee.resolutions?.at(-1)?.band, 'new', 'a create, not a link')
    assert.equal(lee.state, 'provisional', 'a genuine near-namesake collision still earns the review dot')
    registry.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('pins + page-anchored chunks persist per workspace; unknown workspace reads empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-pins-'))
  try {
    const registry = new WorkspaceRegistry(dir)
    registry.savePin({
      id: 'pin-1', workspaceId: 'ws-pins', uri: 'file:///doc.txt', title: 'Doc', kind: 'file',
      ingest: { status: 'ingested', pages: 2, chunks: 2, lastFetchedAt: '2026-07-07T15:00:00Z' }, createdAt: '2026-07-07T14:59:00Z',
    })
    registry.savePinChunks([
      { id: 'pin-1-0', pinId: 'pin-1', workspaceId: 'ws-pins', ordinal: 0, page: 1, text: 'page one', createdAt: '2026-07-07T15:00:00Z' },
      { id: 'pin-1-1', pinId: 'pin-1', workspaceId: 'ws-pins', ordinal: 1, page: 42, text: 'page forty-two', createdAt: '2026-07-07T15:00:00Z' },
    ])
    assert.equal(registry.getPin('ws-pins', 'pin-1')!.kind, 'file')
    assert.deepEqual(registry.listPins('ws-pins').map((p) => p.id), ['pin-1'])
    assert.deepEqual(registry.listPinChunks('ws-pins', 'pin-1').map((c) => c.page), [1, 42]) // ordinal order

    assert.equal(registry.deletePinChunks('ws-pins', 'pin-1'), 2)
    assert.deepEqual(registry.listPinChunks('ws-pins', 'pin-1'), [])
    // unknown workspace never throws — reads empty (mirrors listEntities)
    assert.deepEqual(registry.listPins('ws-nowhere'), [])
    assert.equal(registry.getPin('ws-nowhere', 'pin-1'), undefined)
    registry.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('upsertEntity: cross-source corroboration promotes a provisional link to confirmed + teaches the heard-as alias (#74)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-xsrc-'))
  try {
    const registry = new WorkspaceRegistry(dir)
    // Tighten the auto band so the ASR homophone "pie dev" (~0.92 fuzzy) lands PROVISIONAL on its own — the
    // cross-source multiplier is what must lift it into auto. (Same band config across the whole scenario.)
    const resolverConfig = { autoBand: 0.95, provisionalBand: 0.5, ambiguityMargin: 0.05, establishmentBoost: 0.1, establishmentSaturation: 32, halfLifeHours: 24 * 7 }

    // Corpus: an established `pi.dev` artifact (first-of-its-kind create → silent, no state).
    const created = registry.upsertEntity({ workspaceId: 'ws-x', kind: 'artifact', name: 'pi.dev', seenAt: '2026-07-07T13:00:00Z', resolverConfig })
    assert.equal(created.state, undefined)

    // A mangled mention with NO screen agreement → provisional link, alias NOT confirmed.
    const heardOnly = registry.upsertEntity({
      workspaceId: 'ws-x', kind: 'artifact', name: 'pie dev', seenAt: '2026-07-07T14:00:08Z', resolverConfig,
      heardAs: { text: 'pie dev', source: 'stt', at: '2026-07-07T14:00:08Z' },
      sighting: { via: 'heard', at: '2026-07-07T14:00:08Z', distillateId: 'dst-a' },
    })
    assert.equal(heardOnly.id, created.id) // linked to pi.dev
    assert.equal(heardOnly.state, 'provisional') // reviewable — not yet confirmed
    assert.ok((heardOnly.heardAs ?? []).some((h) => h.text === 'pie dev'))

    // SAME mangle, this time corroborated by an in-window `seen` sighting of "pi.dev" on screen.
    const corroborated = registry.upsertEntity({
      workspaceId: 'ws-x', kind: 'artifact', name: 'pie dev', seenAt: '2026-07-07T14:05:08Z', resolverConfig,
      heardAs: { text: 'pie dev', source: 'stt', at: '2026-07-07T14:05:08Z' },
      sighting: { via: 'heard', at: '2026-07-07T14:05:08Z', distillateId: 'dst-b' },
      crossSighting: { via: 'seen', at: '2026-07-07T14:05:04Z', detail: 'pi.dev' },
      signals: { crossSourceCorroboration: 1.5 },
    })
    assert.equal(corroborated.id, created.id)
    assert.equal(corroborated.state, 'confirmed') // promoted provisional → confirmed, no user ask
    assert.ok((corroborated.confidence ?? 0) >= 0.95)
    // the ASR-mangled variant is taught as a heard-as alias (deduped — one entry)
    assert.deepEqual((corroborated.heardAs ?? []).map((h) => h.text), ['pie dev'])
    // both senses are in the evidence trail
    assert.deepEqual((corroborated.sightings ?? []).map((s) => s.via).sort(), ['heard', 'heard', 'seen'])
    const seen = (corroborated.sightings ?? []).find((s) => s.via === 'seen')
    assert.equal(seen?.detail, 'pi.dev')

    registry.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('upsertEntity: repeat cross-source corroboration is idempotent — no duplicate heardAs or sightings (#74)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-xsrc-idem-'))
  try {
    const registry = new WorkspaceRegistry(dir)
    registry.upsertEntity({ workspaceId: 'ws-i', kind: 'artifact', name: 'pi.dev', seenAt: '2026-07-07T13:00:00Z' })
    const upsert = () =>
      registry.upsertEntity({
        workspaceId: 'ws-i', kind: 'artifact', name: 'pie dev', seenAt: '2026-07-07T14:05:08Z',
        heardAs: { text: 'pie dev', source: 'stt', at: '2026-07-07T14:05:08Z' },
        sighting: { via: 'heard', at: '2026-07-07T14:05:08Z', distillateId: 'dst-b' },
        crossSighting: { via: 'seen', at: '2026-07-07T14:05:04Z', detail: 'pi.dev' },
        signals: { crossSourceCorroboration: 1.5 },
      })
    upsert()
    const second = upsert() // identical window, replayed
    assert.equal(second.state, 'confirmed')
    assert.deepEqual((second.heardAs ?? []).map((h) => h.text), ['pie dev']) // no dup
    assert.deepEqual((second.sightings ?? []).map((s) => s.via).sort(), ['heard', 'seen']) // no dup
    registry.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// A wide ambiguityMargin + low provisionalBand forces a rival within Δ, so the linked record is stamped
// with an `ambiguity` marker deterministically — the #75 clarify affordance's precondition. Seeding the
// rival with a high provisionalBand keeps it a DISTINCT record (it does not link into the first).
const AMBIGUOUS = { autoBand: 0.85, provisionalBand: 0.3, ambiguityMargin: 0.6, establishmentBoost: 0.1, establishmentSaturation: 32, halfLifeHours: 168 }
const seedCollision = (registry: WorkspaceRegistry, ws: string) => {
  const primary = registry.upsertEntity({ workspaceId: ws, kind: 'artifact', name: 'Mercury', seenAt: '2026-07-08T09:00:00Z' })
  const rival = registry.upsertEntity({
    workspaceId: ws, kind: 'artifact', name: 'Mercury Bank', seenAt: '2026-07-08T09:01:00Z',
    resolverConfig: { ...AMBIGUOUS, provisionalBand: 0.95 }, // forces 'new' so the rival stays distinct
  })
  const linked = registry.upsertEntity({ workspaceId: ws, kind: 'artifact', name: 'Mercury', seenAt: '2026-07-08T09:02:00Z', resolverConfig: AMBIGUOUS })
  return { primaryId: primary.id, rivalId: rival.id, linked }
}

test('an ambiguous resolution stamps the reviewable ambiguity marker the #75 clarify affordance keys off', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-ambig-'))
  try {
    const registry = new WorkspaceRegistry(dir)
    const { primaryId, rivalId, linked } = seedCollision(registry, 'ws-am')
    assert.equal(linked.id, primaryId) // linked to the exact-name winner, not the rival
    assert.equal(linked.state, 'provisional') // a rival within Δ downgrades the auto-link to reviewable
    assert.equal(linked.ambiguity?.rivalId, rivalId)
    assert.equal(linked.ambiguity?.rivalName, 'Mercury Bank')
    registry.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('overrideEntity SETTLES the ambiguity — the marker is cleared so the #75 ask does not re-appear', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-ambig-ov-'))
  try {
    const registry = new WorkspaceRegistry(dir)
    const { primaryId, rivalId } = seedCollision(registry, 'ws-amo')
    const confirmed = registry.overrideEntity('ws-amo', primaryId, {
      at: '2026-07-08T10:00:00Z', by: 'the user', pinnedName: 'Mercury', rejectedRivalId: rivalId, rejectedRivalName: 'Mercury Bank',
    })
    assert.equal(confirmed?.state, 'confirmed')
    assert.equal(confirmed?.ambiguity, undefined) // the reviewable marker is gone once the user settled it
    // and a later mention of the settled form resolves to the confirmed entity, never re-scored (no ambiguity)
    const later = registry.upsertEntity({ workspaceId: 'ws-amo', kind: 'artifact', name: 'Mercury', seenAt: '2026-07-08T11:00:00Z' })
    assert.equal(later.id, primaryId)
    assert.equal(later.state, 'confirmed')
    assert.equal(later.ambiguity, undefined) // the same collision never asks again
    registry.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('clearEntityAmbiguity settles the LOSING side of a disambiguate without confirming it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-ambig-cl-'))
  try {
    const registry = new WorkspaceRegistry(dir)
    const { primaryId } = seedCollision(registry, 'ws-amc')
    const settled = registry.clearEntityAmbiguity('ws-amc', primaryId)
    assert.equal(settled?.ambiguity, undefined) // marker dropped
    assert.notEqual(settled?.state, 'confirmed') // NOT confirmed — the mention simply was not it
    assert.equal(registry.clearEntityAmbiguity('ws-amc', primaryId)?.ambiguity, undefined) // idempotent
    assert.equal(registry.clearEntityAmbiguity('ws-amc', 'ent-nowhere'), undefined) // unknown id
    registry.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── #143 public-name gazetteer: the OSS-collision rival source for the clarify gate ──────────────────
// The whole point: an internal repo that reused a famous OSS name ("Kubeflow") must trip the ≟ gate when
// a mention sounds like the public project, instead of silently linking to the corpus entity.

test('#143 e2e: "cube flow" against an internal Kubeflow repo + the gazetteer Kubeflow ⇒ ≟ offers both', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-gaz-e2e-'))
  try {
    const registry = new WorkspaceRegistry(dir)
    const ws = 'ws-gaz'
    // A corporate repo named the same as the famous OSS project — the collision.
    const repo = registry.upsertEntity({ workspaceId: ws, kind: 'artifact', name: 'Kubeflow', seenAt: '2026-07-08T09:00:00Z' })
    assert.equal(repo.ambiguity, undefined, 'the first, clean mention does not ask')

    // Heard "cube flow": links to the internal repo, but the public Kubeflow is a plausible rival ⇒ ambiguous.
    const heard = registry.upsertEntity({ workspaceId: ws, kind: 'artifact', name: 'cube flow', seenAt: '2026-07-08T09:05:00Z', heardAs: { text: 'cube flow' } })
    assert.equal(heard.id, repo.id, 'the winner is the CORPUS repo — never the gazetteer')
    assert.equal(heard.state, 'provisional', 'the silent auto-link is downgraded to reviewable')
    assert.equal(heard.ambiguity?.rivalName, 'Kubeflow', 'the public name is offered as the rival (≟ shows both)')
    assert.equal(heard.ambiguity?.rivalId, 'gaz:kubeflow', 'a stable synthetic id so rejectedRivalId is durable')
    const trail = heard.resolutions?.at(-1)
    assert.equal(trail?.ambiguous, true)
    assert.equal(trail?.rivalId, 'gaz:kubeflow')

    // The ≟ answer (confirm: it IS the internal repo) — exactly what POST /teach/entity writes on `confirm`:
    // pin the heard form to the linked entity and REJECT the gazetteer rival.
    const confirmed = registry.overrideEntity(ws, repo.id, {
      at: '2026-07-08T09:06:00Z', by: 'the user', pinnedName: 'cube flow', rejectedRivalId: 'gaz:kubeflow', rejectedRivalName: 'Kubeflow',
    })
    assert.equal(confirmed?.state, 'confirmed')
    assert.equal(confirmed?.ambiguity, undefined, 'the ≟ marker is cleared once the user answers')

    // A later "cube flow" resolves straight to the repo, no ≟ — the rejected public rival is never re-offered.
    const later = registry.upsertEntity({ workspaceId: ws, kind: 'artifact', name: 'cube flow', seenAt: '2026-07-08T10:00:00Z' })
    assert.equal(later.id, repo.id)
    assert.equal(later.state, 'confirmed')
    assert.equal(later.ambiguity, undefined, 'the settled collision never asks again')
    registry.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('#143 a mention that only SOUNDS like a public name (no corpus entity) stays SILENT — no create, no ask', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-gaz-silent-'))
  try {
    const registry = new WorkspaceRegistry(dir)
    const ws = 'ws-gaz-s'
    // No "Kubeflow" in the corpus. "cube flow" creates a fresh entity — and is NOT marked ambiguous by the
    // gazetteer (a gazetteer hit is never a corpus rival on a bare create).
    const created = registry.upsertEntity({ workspaceId: ws, kind: 'artifact', name: 'cube flow', seenAt: '2026-07-08T09:00:00Z' })
    assert.equal(created.name, 'cube flow', 'a NEW entity for the heard form — never the gazetteer Kubeflow')
    assert.notEqual(created.id, 'gaz:kubeflow', 'the gazetteer entry is never created as an entity')
    assert.equal(created.ambiguity, undefined, 'gazetteer-only ⇒ no ≟')
    // Only one entity exists, and it is the heard form (no Kubeflow record was conjured).
    const all = registry.listEntities(ws)
    assert.equal(all.length, 1)
    assert.equal(all[0]?.name, 'cube flow')
    registry.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('#143 the seeded gazetteer document is seed-if-absent and a user edit is NEVER clobbered', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-gaz-seed-'))
  try {
    const registry = new WorkspaceRegistry(dir)
    // First read seeds the shipped default.
    assert.ok(registry.gazetteer().entries.some((e) => e.name === 'Kubeflow'), 'default seed carries Kubeflow')

    // A user prunes it down to their own list.
    registry.layouts.put('gazetteer', 'gazetteer-default', { entries: [{ name: 'Widgetron' }] })
    assert.deepEqual(registry.gazetteer().entries, [{ name: 'Widgetron' }], 'the edit is what reads back')

    // A resolution (which reads the gazetteer) must not re-seed over the edit — the edit survives.
    registry.upsertEntity({ workspaceId: 'ws-seed', kind: 'artifact', name: 'anything', seenAt: '2026-07-08T09:00:00Z' })
    assert.deepEqual(registry.gazetteer().entries, [{ name: 'Widgetron' }], 'never clobbered by a later read')

    // And it is durable across a reopen (persisted in _meta.db, not defaulted back).
    registry.close()
    const reopened = new WorkspaceRegistry(dir)
    assert.deepEqual(reopened.gazetteer().entries, [{ name: 'Widgetron' }], 'the edit persists across restart')
    reopened.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
