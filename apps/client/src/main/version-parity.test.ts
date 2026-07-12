import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The release-protocol guard (S6): the runtime manifests — repo root, apps/client, apps/engine — must all
 * report the SAME version. This is the standing test that would have CAUGHT the shipped 0.0.6 app whose
 * bundled engine self-reported 0.0.5: cutting a release bumped root + client but forgot the engine, and the
 * client's own /health skew note compares app vs. engine version, so a drifted engine breaks the very signal
 * S6 makes load-bearing. `tools/bump-version.mjs` moves all three in lockstep; this fails the build if any drifts.
 */

/** Walk up from this compiled test to the repo root (the dir holding pnpm-workspace.yaml). */
const repoRoot = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('could not locate the repo root (pnpm-workspace.yaml) from the compiled test')
}

const versionOf = (root: string, rel: string): string =>
  (JSON.parse(readFileSync(join(root, rel), 'utf8')) as { version?: string }).version ?? '(none)'

test('release parity: root, client, and engine package.json report the SAME version', () => {
  const root = repoRoot()
  const rootV = versionOf(root, 'package.json')
  const clientV = versionOf(root, 'apps/client/package.json')
  const engineV = versionOf(root, 'apps/engine/package.json')
  assert.equal(clientV, rootV, `client ${clientV} ≠ root ${rootV} — bump in lockstep (tools/bump-version.mjs)`)
  assert.equal(engineV, rootV, `engine ${engineV} ≠ root ${rootV} — the exact drift S6 closes (tools/bump-version.mjs)`)
})
