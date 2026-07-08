import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { WorkspaceHints } from '@openinfo/contracts'
import { WorkspaceRegistry } from '../store/index.js'
import { HintsDocuments } from './hints.js'

test('ensureDefaults seeds an EMPTY default-workspace hints doc, idempotently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-hints-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const hints = new HintsDocuments(store)
    hints.ensureDefaults()
    const seeded = store.layouts.getLatest<WorkspaceHints>('workspace-hints', 'default')
    assert.ok(seeded)
    assert.equal(seeded.version, 1)
    assert.deepEqual(seeded.body, { workspaceId: 'default', patterns: [] }) // no permissive catch-all

    hints.ensureDefaults() // second call must NOT bump the version or clobber
    assert.equal(store.layouts.getLatest<WorkspaceHints>('workspace-hints', 'default')?.version, 1)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('put versions a workspace hints doc; get/all read it back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-hints-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const hints = new HintsDocuments(store)
    hints.ensureDefaults()
    const sales: WorkspaceHints = { workspaceId: 'sales', patterns: [{ field: 'repoPath', contains: 'acme-crm', weight: 0.7 }] }
    hints.put(sales)
    hints.put({ ...sales, patterns: [...sales.patterns, { field: 'app', prefix: 'zoom', weight: 0.4 }] })

    assert.equal(store.layouts.getLatest<WorkspaceHints>('workspace-hints', 'sales')?.version, 2)
    assert.equal(hints.get('sales')?.patterns.length, 2)
    const all = hints.all().map((h) => h.workspaceId).sort()
    assert.deepEqual(all, ['default', 'sales'])
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
