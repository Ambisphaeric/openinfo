// Emits shared/contracts/schemas/<Name>.json from AllSchemas — the language-neutral artifact.
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const contractsDir = join(here, '..', '..', 'shared', 'contracts')
const { AllSchemas } = await import(join(contractsDir, 'dist', 'index.js'))
// Output dir defaults to the committed schemas/ (the language-neutral artifact
// checked into the repo). The local drift guard (shared/contracts, #87)
// overrides SCHEMA_OUT_DIR to a temp dir so it can regenerate and diff without
// ever mutating the committed tree; leave it unset for the real regeneration.
const out = process.env.SCHEMA_OUT_DIR
  ? resolve(process.env.SCHEMA_OUT_DIR)
  : join(contractsDir, 'schemas')
mkdirSync(out, { recursive: true })
let n = 0
for (const [name, schema] of Object.entries(AllSchemas)) {
  writeFileSync(join(out, `${name}.json`), JSON.stringify(schema, null, 2) + '\n')
  n++
}
console.log(`schema-gen: wrote ${n} schemas to ${out}`)
