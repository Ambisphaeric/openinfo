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
