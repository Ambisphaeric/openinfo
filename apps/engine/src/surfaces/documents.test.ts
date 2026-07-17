import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Surface } from '@openinfo/contracts'
import { WorkspaceRegistry } from '../store/index.js'
import { SurfaceDocuments } from './documents.js'
import { defaultHudSurface, defaultFieldsSurface } from './defaults.js'
import { defaultPillSurface, LEGACY_DEFAULT_PILL_SURFACE } from './pill.js'

test('SurfaceDocuments seeds the openinfo HUD and serves it by id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-surfdoc-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const docs = new SurfaceDocuments(store)
    docs.ensureDefaults()
    const hud = docs.get(defaultHudSurface.id)
    assert.ok(hud)
    assert.equal(hud.name, 'openinfo HUD')
    assert.deepEqual(hud.stack.map((b) => b.block), ['now', 'summaries', 'summaries', 'relevant-now', 'moments', 'fields'])
    assert.equal(hud.stack.find((b) => b.block === 'relevant-now')?.top, 4)
    // #177 slice 2: the memory headline leads — the concise five-minute VIEW then the durable session result.
    assert.deepEqual(hud.stack.filter((b) => b.block === 'summaries').map((b) => b.query?.params['level']), ['five-minute', 'session'])
    const pill = docs.get(defaultPillSurface.id)
    assert.ok(pill)
    assert.equal(pill.version, 2)
    assert.deepEqual(pill.stack.map((b) => b.block), ['now', 'sense-lanes', 'relevant-now', 'moments', 'fields'])
    assert.deepEqual(pill.stack[1]?.query, { source: 'live-senses', params: { session: 'current' }, top: 3 })
    // unknown id ⇒ undefined (the route turns this into a 404)
    assert.equal(docs.get('surf-nope'), undefined)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('SurfaceDocuments migrates only the exact untouched legacy pill seed, once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-surfdoc-pill-refresh-'))
  const store = new WorkspaceRegistry(dir)
  try {
    // Simulate an existing install whose sole pill record is the exact previously shipped body.
    store.layouts.put('surface', LEGACY_DEFAULT_PILL_SURFACE.id, LEGACY_DEFAULT_PILL_SURFACE)
    const docs = new SurfaceDocuments(store)
    docs.ensureDefaults()

    const latest = store.layouts.getLatest<Surface>('surface', defaultPillSurface.id)
    assert.ok(latest)
    assert.equal(latest.version, 2, 'the refresh is a versioned document write')
    assert.equal(latest.body.version, 2, 'the refreshed body carries the new shipped surface version')
    assert.deepEqual(latest.body.stack.map((block) => block.block), ['now', 'sense-lanes', 'relevant-now', 'moments', 'fields'])

    docs.ensureDefaults()
    assert.equal(store.layouts.getLatest<Surface>('surface', defaultPillSurface.id)?.version, 2, 'the migration is idempotent')
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('SurfaceDocuments never migrates a customized v1 or any user-version pill', async () => {
  const customDir = await mkdtemp(join(tmpdir(), 'openinfo-surfdoc-pill-custom-'))
  const customStore = new WorkspaceRegistry(customDir)
  try {
    const customized: Surface = { ...LEGACY_DEFAULT_PILL_SURFACE, name: 'My deliberately customized pill' }
    customStore.layouts.put('surface', customized.id, customized)
    new SurfaceDocuments(customStore).ensureDefaults()
    const kept = customStore.layouts.getLatest<Surface>('surface', customized.id)
    assert.equal(kept?.version, 1)
    assert.equal(kept?.body.name, customized.name)
    assert.deepEqual(kept?.body.stack.map((block) => block.block), ['now', 'relevant-now', 'moments', 'fields'])
  } finally {
    customStore.close()
    await rm(customDir, { recursive: true, force: true })
  }

  const userVersionDir = await mkdtemp(join(tmpdir(), 'openinfo-surfdoc-pill-user-version-'))
  const userVersionStore = new WorkspaceRegistry(userVersionDir)
  try {
    // Even a body that happens to be byte-identical is user-owned once it has document history.
    userVersionStore.layouts.put('surface', LEGACY_DEFAULT_PILL_SURFACE.id, LEGACY_DEFAULT_PILL_SURFACE)
    userVersionStore.layouts.put('surface', LEGACY_DEFAULT_PILL_SURFACE.id, LEGACY_DEFAULT_PILL_SURFACE)
    new SurfaceDocuments(userVersionStore).ensureDefaults()
    const kept = userVersionStore.layouts.getLatest<Surface>('surface', LEGACY_DEFAULT_PILL_SURFACE.id)
    assert.equal(kept?.version, 2)
    assert.equal(kept?.body.version, 1)
    assert.deepEqual(kept?.body.stack.map((block) => block.block), ['now', 'relevant-now', 'moments', 'fields'])
  } finally {
    userVersionStore.close()
    await rm(userVersionDir, { recursive: true, force: true })
  }
})

test('SurfaceDocuments.list enumerates the seeded HUD plus user surfaces', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-surfdoc-list-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const docs = new SurfaceDocuments(store)
    docs.ensureDefaults()
    assert.deepEqual(docs.list().map((s) => s.id).sort(), ['surf-openinfo-chat', 'surf-openinfo-diagnostics', 'surf-openinfo-fields', 'surf-openinfo-hud', 'surf-openinfo-notetaker', 'surf-openinfo-pill', 'surf-openinfo-sidebar'])

    docs.save({ ...defaultHudSurface, id: 'surf-mine', name: 'My HUD', version: 1 })
    assert.deepEqual(docs.list().map((s) => s.id).sort(), ['surf-mine', 'surf-openinfo-chat', 'surf-openinfo-diagnostics', 'surf-openinfo-fields', 'surf-openinfo-hud', 'surf-openinfo-notetaker', 'surf-openinfo-pill', 'surf-openinfo-sidebar'])
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('SurfaceDocuments seeds the #100 fields app once and never clobbers a user edit on re-seed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-surfdoc-fields-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const docs = new SurfaceDocuments(store)
    docs.ensureDefaults()

    // The shipped fields app is served by id, with its canon stack (now · fields · distillate stream).
    const fields = docs.get(defaultFieldsSurface.id)
    assert.ok(fields)
    assert.equal(fields.name, 'Fields')
    assert.deepEqual(fields.stack.map((b) => b.block), ['now', 'fields', 'distillates'])
    // the fields block is SHOWN ALWAYS (a fields app must not vanish when empty) with the glyph verb strip
    const fieldsBlock = fields.stack.find((b) => b.block === 'fields')
    assert.equal(fieldsBlock?.show, 'always')
    assert.deepEqual(fieldsBlock?.actions?.map((a) => a.verb), ['copy', 'dismiss', 'pin', 'mark-for-follow-up'])

    // A user edits the fields app (drops the distillate stream) and saves — version bumps to 2.
    const edited = { ...defaultFieldsSurface, stack: defaultFieldsSurface.stack.filter((b) => b.block !== 'distillates') }
    assert.equal(docs.save(edited).version, 2)

    // A fresh ensureDefaults must NOT clobber the edit — seeded once, then hands-off.
    new SurfaceDocuments(store).ensureDefaults()
    const reloaded = docs.get(defaultFieldsSurface.id)
    assert.deepEqual(reloaded?.stack.map((b) => b.block), ['now', 'fields'])
    assert.equal(reloaded?.version, 2)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('SurfaceDocuments.save bumps the version and never clobbers a user edit on re-seed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-surfdoc-save-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const docs = new SurfaceDocuments(store)
    docs.ensureDefaults()

    // user removes the moments block and saves — version increments to 2
    const edited = { ...defaultHudSurface, stack: defaultHudSurface.stack.filter((b) => b.block !== 'moments') }
    const saved = docs.save(edited)
    assert.equal(saved.version, 2)
    assert.deepEqual(saved.stack.map((b) => b.block), ['now', 'summaries', 'summaries', 'relevant-now', 'fields'])

    // a fresh ensureDefaults must NOT clobber the edit
    new SurfaceDocuments(store).ensureDefaults()
    const reloaded = docs.get(defaultHudSurface.id)
    assert.deepEqual(reloaded?.stack.map((b) => b.block), ['now', 'summaries', 'summaries', 'relevant-now', 'fields'])
    assert.equal(reloaded?.version, 2)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
