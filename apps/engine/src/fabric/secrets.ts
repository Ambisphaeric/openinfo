import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Resolve a keyRef to its secret value at invoke time, or undefined if unknown. */
export type SecretResolver = (ref: string) => string | undefined

/**
 * The engine-side secret store. Endpoints reference keys by `keyRef` (never a value); the value
 * lives here, addressed by ref. The API is deliberately WRITE-ONLY from the outside: you `set` a
 * value, you `delete` it, and you may `listRefs` — but the values only ever leave through `resolve`,
 * which the fabric calls at invoke time to inject `Authorization: Bearer …`. No route, event, GET
 * response, document, or export ever returns key material.
 *
 * This is an INTERFACE so the v0 file backend swaps for a macOS Keychain backend at P7 (CODE_MAP §3)
 * with zero caller change — the fabric only ever sees `resolve`/`listRefs`/`set`/`delete`.
 */
export interface SecretStore {
  /** the refs that currently have a stored value — NEVER the values. */
  listRefs(): string[]
  /** whether a value is stored for this ref. */
  has(ref: string): boolean
  /** the secret value for a ref, or undefined if none is stored (⇒ the endpoint fails gracefully). */
  resolve(ref: string): string | undefined
  /** store (or overwrite) a value under a ref. */
  set(ref: string, value: string): void
  /** remove a stored secret; returns whether it existed. */
  delete(ref: string): boolean
}

/**
 * v0 SecretStore: a single JSON file, chmod 0600, in its own `secrets/` directory (see
 * resolveSecretsPath — outside the workspace DBs, never in an export). Loaded into memory on
 * construction (the engine is the only writer) and re-persisted on every mutation with a tight file
 * mode. The file is created lazily on the first `set`, so a fresh install writes nothing.
 */
export class FileSecretStore implements SecretStore {
  private readonly secrets: Map<string, string>

  constructor(private readonly file: string) {
    this.secrets = FileSecretStore.load(file)
  }

  private static load(file: string): Map<string, string> {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      const map = new Map<string, string>()
      for (const [ref, value] of Object.entries(parsed)) if (typeof value === 'string') map.set(ref, value)
      return map
    } catch {
      // no file yet (fresh install) or unreadable → start empty; a mutation will (re)create it 0600.
      return new Map()
    }
  }

  listRefs(): string[] {
    return [...this.secrets.keys()].sort()
  }

  has(ref: string): boolean {
    return this.secrets.has(ref)
  }

  resolve(ref: string): string | undefined {
    return this.secrets.get(ref)
  }

  set(ref: string, value: string): void {
    this.secrets.set(ref, value)
    this.persist()
  }

  delete(ref: string): boolean {
    const existed = this.secrets.delete(ref)
    if (existed) this.persist()
    return existed
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const body = JSON.stringify(Object.fromEntries(this.secrets), null, 2)
    writeFileSync(this.file, body, { mode: 0o600 })
    chmodSync(this.file, 0o600) // enforce 0600 even if the file pre-existed with looser bits
  }
}
