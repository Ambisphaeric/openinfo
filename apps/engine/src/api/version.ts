import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Read the engine's OWN package version at startup, for the /health version handshake (the client
 * surfaces it + flags skew against its own app version). Resolved by walking up from this compiled
 * module until a package.json named `@openinfo/engine` is found — so it works UNCHANGED in both
 * layouts: dev (`apps/engine/dist/api/version.js` → `apps/engine/package.json`) and the packaged
 * `engine-bundle/apps/engine/{dist,package.json}` (package.mjs stages the package.json beside dist).
 * Best-effort: an unreadable/absent package.json degrades to `undefined` — the handshake is additive,
 * a missing version is a signal (an older engine that predates this field), never a crash.
 */
export const readEngineVersion = (): string | undefined => {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string }
      if (pkg.name === '@openinfo/engine' && typeof pkg.version === 'string') return pkg.version
    } catch {
      // not this level (or unreadable) — keep walking toward the filesystem root
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * An OPTIONAL build id, stamped into /health when the environment carries one (a CI/DMG build can set
 * OPENINFO_BUILD to a git short sha). Undefined in a plain dev run — additive, never fabricated.
 */
export const readEngineBuild = (): string | undefined => {
  const build = process.env['OPENINFO_BUILD']
  return build !== undefined && build.trim() !== '' ? build.trim() : undefined
}
