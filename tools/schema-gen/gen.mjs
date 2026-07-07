// Emits shared/contracts/schemas/<Name>.json from AllSchemas — the language-neutral artifact.
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const contractsDir = join(here, '..', '..', 'shared', 'contracts')
const { AllSchemas } = await import(join(contractsDir, 'dist', 'index.js'))
const out = join(contractsDir, 'schemas')
mkdirSync(out, { recursive: true })
let n = 0
for (const [name, schema] of Object.entries(AllSchemas)) {
  writeFileSync(join(out, `${name}.json`), JSON.stringify(schema, null, 2) + '\n')
  n++
}
console.log(`schema-gen: wrote ${n} schemas to shared/contracts/schemas/`)
