import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Value } from '@sinclair/typebox/value'
import { BlockTypeName, Surface } from '@openinfo/contracts'
import { SEEDED_SURFACES } from './defaults.js'

// #234 seed-validation guard. Two guardrails were disabled at once: BlockTypeName's static type had widened
// to `string` (so `block: 'sessions'` type-checked despite not being in the union), AND nothing ever ran a
// runtime Value.Check over the shipped surface documents (they are seeded as TS objects / cloned from JSON
// and served as-is). Net: the seeded note-taker's `sessions` block was silently out of sync with the
// contract union, caught by neither compiler nor runtime. This test closes the runtime gap: it Value.Checks
// every SEEDED surface (in-process) AND every cloneable template surface.json against the Surface contract,
// so an unregistered block type fails LOUDLY here rather than rendering by client-registry luck.
//
// Red-then-green by construction: the seeded note-taker (`defaultNotetakerSurface`) carries
// `block: 'sessions'`; before 'sessions' was added to the BlockTypeName union, Value.Errors(Surface, …) over
// that doc was NON-EMPTY (the enum rejected it) and this suite would have failed. The `contains a 'sessions'
// block` assertion below proves the fixed path is actually exercised, not vacuously green.
const here = dirname(fileURLToPath(import.meta.url))
const templatesDir = join(here, '..', '..', '..', '..', 'templates')

const surfaceErrors = (doc: unknown): string[] => [...Value.Errors(Surface, doc)].map((e) => `${e.path}: ${e.message}`)

for (const surface of SEEDED_SURFACES) {
  test(`seeded surface ${surface.id} validates against the Surface contract (#234)`, () => {
    assert.deepEqual(surfaceErrors(surface), [], `${surface.id} failed Surface validation`)
  })
}

const templateFiles = readdirSync(templatesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => join(templatesDir, d.name, 'surface.json'))
  .filter((p) => existsSync(p))

for (const file of templateFiles) {
  test(`template ${file.slice(templatesDir.length + 1)} validates against the Surface contract (#234)`, () => {
    const doc: unknown = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(surfaceErrors(doc), [], `${file} failed Surface validation`)
  })
}

test('the guard is not vacuous: a seeded surface actually exercises the fixed `sessions` block type (#234)', () => {
  const usesSessions = SEEDED_SURFACES.some((s) => s.stack.some((b) => b.block === 'sessions'))
  assert.ok(usesSessions, 'expected at least one seeded surface to carry a `sessions` block (the note-taker left rail)')
  assert.ok(Value.Check(BlockTypeName, 'sessions'), "'sessions' must be a registered block type")
})

test('the guard BITES: a shipped surface carrying an unregistered block type fails validation (#234)', () => {
  // Drive the negative probe off a REAL seeded surface so the only difference is the bogus block type — proving
  // the guard rejects an out-of-union block rather than passing everything.
  const good = SEEDED_SURFACES[0]!
  assert.deepEqual(surfaceErrors(good), [], 'baseline seeded surface is valid')
  const bogus = { ...good, stack: [{ block: 'totally-not-a-real-block' }, ...good.stack] }
  assert.ok(surfaceErrors(bogus).length > 0, 'a surface with an unregistered block type must fail the Surface contract')
})
