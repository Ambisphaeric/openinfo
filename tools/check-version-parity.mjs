#!/usr/bin/env node
/**
 * Guard: the runtime manifests (root, apps/client, apps/engine) must all report the SAME version (S6).
 * This is the standing check that would have CAUGHT the 0.0.6-app-with-a-0.0.5-engine drift — run it in CI
 * or before a release cut. Exits non-zero (and prints the offenders) on any mismatch. See bump-version.mjs.
 *
 * Usage:  node tools/check-version-parity.mjs
 */
import { readVersions, VERSIONED_MANIFESTS } from './bump-version.mjs'

const versions = readVersions()
const distinct = [...new Set(Object.values(versions))]
if (distinct.length === 1) {
  console.log(`version parity OK — all runtime manifests at ${distinct[0]}`)
  process.exit(0)
}
console.error('version parity FAILED — runtime manifests disagree:')
for (const rel of VERSIONED_MANIFESTS) console.error(`  ${rel}: ${versions[rel]}`)
console.error('\nFix with:  node tools/bump-version.mjs <version>')
process.exit(1)
