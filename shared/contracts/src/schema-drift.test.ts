import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// #87 local drift guard: the committed shared/contracts/schemas/*.json are
// generated artifacts (schema-gen reads the compiled TypeBox dist). CI runs the
// gen + `git diff --exit-code` guard, but a contract change with a skipped
// regeneration otherwise stays invisible locally — the example tests validate
// against the source, never the committed JSON. This test brings the same guard
// into `pnpm -r test`: it regenerates into a throwaway temp dir (NEVER touching
// the committed tree) and diffs against schemas/, so drift fails the local suite
// too, with a clear "run pnpm gen" instruction.
const here = dirname(fileURLToPath(import.meta.url))
const committedDir = join(here, '..', 'schemas')
const genScript = join(here, '..', '..', '..', 'tools', 'schema-gen', 'gen.mjs')
const GEN_CMD = 'pnpm --filter @openinfo/contracts gen'

test('committed schemas match a fresh regeneration (no drift)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'openinfo-schema-drift-'))
  try {
    const res = spawnSync(process.execPath, [genScript], {
      env: { ...process.env, SCHEMA_OUT_DIR: tmp },
      encoding: 'utf8',
    })
    assert.equal(res.status, 0, `schema-gen failed to run:\n${res.stderr ?? ''}`)

    const committed = new Set(readdirSync(committedDir).filter((f) => f.endsWith('.json')))
    const fresh = new Set(readdirSync(tmp).filter((f) => f.endsWith('.json')))

    const missing = [...fresh].filter((f) => !committed.has(f)) // regenerated but not committed
    const stale = [...committed].filter((f) => !fresh.has(f)) // committed but no longer generated
    const changed = [...fresh]
      .filter((f) => committed.has(f))
      .filter((f) => readFileSync(join(tmp, f), 'utf8') !== readFileSync(join(committedDir, f), 'utf8'))

    const offenders = [
      ...missing.map((f) => `${f} (missing from schemas/)`),
      ...stale.map((f) => `${f} (stale in schemas/ — no longer generated)`),
      ...changed.map((f) => `${f} (out of date)`),
    ]
    assert.deepEqual(
      offenders,
      [],
      `shared/contracts/schemas/ is out of sync with the contract source.\n` +
        `Run \`${GEN_CMD}\` and commit the result. Offending files:\n  ${offenders.join('\n  ')}`,
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
