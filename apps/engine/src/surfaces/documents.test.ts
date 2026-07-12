import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WorkspaceRegistry } from '../store/index.js'
import { SurfaceDocuments } from './documents.js'
import { defaultHudSurface, defaultFieldsSurface } from './defaults.js'

test('SurfaceDocuments seeds the openinfo HUD and serves it by id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-surfdoc-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const docs = new SurfaceDocuments(store)
    docs.ensureDefaults()
    const hud = docs.get(defaultHudSurface.id)
    assert.ok(hud)
    assert.equal(hud.name, 'openinfo HUD')
    assert.deepEqual(hud.stack.map((b) => b.block), ['now', 'relevant-now', 'moments', 'fields'])
    assert.equal(hud.stack.find((b) => b.block === 'relevant-now')?.top, 4)
    // unknown id ⇒ undefined (the route turns this into a 404)
    assert.equal(docs.get('surf-nope'), undefined)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
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
    assert.deepEqual(saved.stack.map((b) => b.block), ['now', 'relevant-now', 'fields'])

    // a fresh ensureDefaults must NOT clobber the edit
    new SurfaceDocuments(store).ensureDefaults()
    const reloaded = docs.get(defaultHudSurface.id)
    assert.deepEqual(reloaded?.stack.map((b) => b.block), ['now', 'relevant-now', 'fields'])
    assert.equal(reloaded?.version, 2)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
