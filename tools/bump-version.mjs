#!/usr/bin/env node
/**
 * Cut-a-release version bump (S6 release-protocol fix).
 *
 * THE DEFECT this closes: cutting a release used to bump the ROOT + CLIENT package.json by hand but LEAVE
 * THE ENGINE'S behind — so the 0.0.6 app shipped an engine that self-reported 0.0.5, and the client's own
 * skew note (which compares app vs. engine /health version) would have cried wolf on the shipped build.
 * The versions must move in LOCKSTEP. This script is the single command that does it, so the engine can
 * never again be forgotten, and `check-version-parity.mjs` (run in the same breath / in CI) proves it held.
 *
 * Usage:  node tools/bump-version.mjs 0.0.12
 *
 * Bumps the three package.json that ship a runtime version — root, apps/client, apps/engine — to the exact
 * version given. It does NOT tag, commit, or push (the wave does that): it only edits the files, then
 * verifies parity and prints what changed. shared/contracts + apps/workbench stay at 0.0.0 (scaffold/type
 * packages, deliberately not versioned with the app — see pnpm-workspace.yaml).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The package.json files that MUST carry the shipped app version, in lockstep. Relative to the repo root. */
export const VERSIONED_MANIFESTS = ['package.json', 'apps/client/package.json', 'apps/engine/package.json']

/** A dotted `major.minor.patch` (with an optional -prerelease/+build suffix) — reject anything else early. */
export const isValidVersion = (v) => typeof v === 'string' && /^\d+\.\d+\.\d+([-+].+)?$/.test(v.trim())

/** Rewrite one manifest's `version` field, preserving the rest of the JSON + a trailing newline. Returns the prior version. */
export const setManifestVersion = (absPath, version) => {
  const text = readFileSync(absPath, 'utf8')
  const pkg = JSON.parse(text)
  const prior = pkg.version
  pkg.version = version
  const trailingNewline = text.endsWith('\n') ? '\n' : ''
  writeFileSync(absPath, JSON.stringify(pkg, null, 2) + trailingNewline)
  return prior
}

/** Read the version of each versioned manifest → a { relPath: version } map. */
export const readVersions = (root = repoRoot, manifests = VERSIONED_MANIFESTS) =>
  Object.fromEntries(manifests.map((rel) => [rel, JSON.parse(readFileSync(path.join(root, rel), 'utf8')).version]))

const main = () => {
  const version = process.argv[2]?.trim()
  if (!isValidVersion(version)) {
    console.error(`usage: node tools/bump-version.mjs <version>   (e.g. 0.0.12)\n  got: ${version ?? '(nothing)'}`)
    process.exit(1)
  }
  for (const rel of VERSIONED_MANIFESTS) {
    const prior = setManifestVersion(path.join(repoRoot, rel), version)
    console.log(`  ${rel}: ${prior} → ${version}`)
  }
  // Verify parity right here — the engine drift bug means "bumped them all" must be PROVEN, not assumed.
  const versions = readVersions()
  const distinct = [...new Set(Object.values(versions))]
  if (distinct.length !== 1 || distinct[0] !== version) {
    console.error('version parity FAILED after bump:', versions)
    process.exit(1)
  }
  console.log(`\nAll runtime manifests at ${version}. (Not committed/tagged — the release cut does that.)`)
}

// Run only when invoked directly (a plain import for the parity test does not bump anything).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
