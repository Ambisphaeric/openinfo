import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const defaultDataDir = (): string => join(homedir(), '.openinfo', 'data')

export const resolveDataDir = (override?: string): string =>
  resolve(override ?? process.env['OPENINFO_DATA'] ?? defaultDataDir())

/**
 * Where the engine-side secret store keeps its v0 chmod-600 file. It lives in its OWN `secrets/`
 * directory under the data root — not among the workspace `.db` files and not inside any database,
 * so it is never part of a one-file workspace export and never serialised into a document. Kept
 * inside the data root (rather than a parent dir) so it is isolated per engine instance and cleaned
 * up with the data dir; `OPENINFO_SECRETS` overrides the full path for a fully external location.
 */
export const resolveSecretsPath = (dataDir: string): string =>
  resolve(process.env['OPENINFO_SECRETS'] ?? join(dataDir, 'secrets', 'secrets.json'))
