import { constants, type Stats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const TOKEN = /^[A-Za-z0-9_-]+$/
const INSTANCE_ID = /^[A-Za-z0-9._:-]{1,128}$/
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]{1,512}$/
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const MAX_RECORD_BYTES = 16 * 1024
const validToken = (value: string): boolean => Buffer.byteLength(value, 'utf8') >= 32 && value.length <= 4_096 && TOKEN.test(value)

export interface EngineAuthRecord {
  version: 1
  instanceId: string
  pid: number
  mode: 'local' | 'tunnel'
  bindHost: string
  port: number
  baseUrl: string
  publicOrigin?: string
  token: string
  createdAt: string
}

export interface EngineCredential {
  token: string
  instanceId?: string
}

export interface EngineCredentialLoadOptions {
  /** Re-read the source instead of returning a cached credential (401/reconnect rotation path). */
  refresh?: boolean
}

/** A keychain, tunnel provisioner, or the local discovery file can all implement this narrow seam. */
export interface EngineCredentialSource {
  credentialFor(baseUrl: string, options?: EngineCredentialLoadOptions): Promise<EngineCredential | undefined>
}

export interface EngineAuthDiscoveryOptions {
  runDir?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  uid?: number
}

/** Generic on purpose: credential values and discovery JSON never appear in error messages. */
export class EngineAuthError extends Error {
  constructor(readonly code: 'bad-url' | 'insecure-origin' | 'insecure-record' | 'invalid-record' | 'missing-credential') {
    super(`engine authentication unavailable (${code})`)
    this.name = 'EngineAuthError'
  }
}

const defaultPort = (protocol: string): string | undefined =>
  protocol === 'http:' ? '80' : protocol === 'https:' ? '443' : undefined

const parsedOrigin = (value: string): URL => {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new EngineAuthError('bad-url')
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new EngineAuthError('bad-url')
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) throw new EngineAuthError('bad-url')
  return parsed
}

const portOf = (url: URL): number => {
  const raw = url.port || defaultPort(url.protocol)
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new EngineAuthError('bad-url')
  return port
}

/** Loopback is the only origin where a bearer may travel over plaintext HTTP. */
export const isLoopbackHost = (host: string): boolean => {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '::1') return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized)
  if (!match) return false
  const octets = match.slice(1).map(Number)
  return octets.every((octet) => octet >= 0 && octet <= 255) && octets[0] === 127
}

export const maySendEngineCredential = (baseUrl: string): boolean => {
  const parsed = parsedOrigin(baseUrl)
  return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))
}

export const engineDiscoveryPath = (baseUrl: string, options: EngineAuthDiscoveryOptions = {}): string => {
  const parsed = parsedOrigin(baseUrl)
  const runDir = options.runDir ?? options.env?.['OPENINFO_CONTROL_RUN_DIR'] ?? process.env['OPENINFO_CONTROL_RUN_DIR'] ?? path.join(os.homedir(), '.openinfo', 'run')
  return path.join(runDir, `engine-${portOf(parsed)}.json`)
}

const assertOwnedPrivate = (stat: Stats, kind: 'dir' | 'file', options: EngineAuthDiscoveryOptions): void => {
  if (kind === 'dir' ? !stat.isDirectory() : !stat.isFile()) throw new EngineAuthError('insecure-record')
  if (stat.isSymbolicLink()) throw new EngineAuthError('insecure-record')
  const platform = options.platform ?? process.platform
  if (platform === 'win32') return
  if ((stat.mode & 0o077) !== 0) throw new EngineAuthError('insecure-record')
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined)
  if (uid !== undefined && stat.uid !== uid) throw new EngineAuthError('insecure-record')
}

const safeOrigin = (value: unknown): URL => {
  if (typeof value !== 'string') throw new EngineAuthError('invalid-record')
  try {
    return parsedOrigin(value)
  } catch {
    throw new EngineAuthError('invalid-record')
  }
}

const asRecord = (value: unknown, target: URL): EngineAuthRecord => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EngineAuthError('invalid-record')
  const row = value as Record<string, unknown>
  if (row['version'] !== 1) throw new EngineAuthError('invalid-record')
  if (typeof row['instanceId'] !== 'string' || !INSTANCE_ID.test(row['instanceId'])) throw new EngineAuthError('invalid-record')
  if (!Number.isSafeInteger(row['pid']) || (row['pid'] as number) < 1) throw new EngineAuthError('invalid-record')
  if (row['mode'] !== 'local' && row['mode'] !== 'tunnel') throw new EngineAuthError('invalid-record')
  if (typeof row['bindHost'] !== 'string' || !SAFE_TEXT.test(row['bindHost'])) throw new EngineAuthError('invalid-record')
  if (!Number.isInteger(row['port']) || (row['port'] as number) < 1 || (row['port'] as number) > 65_535) {
    throw new EngineAuthError('invalid-record')
  }
  if (typeof row['token'] !== 'string' || !validToken(row['token'])) throw new EngineAuthError('invalid-record')
  if (typeof row['createdAt'] !== 'string' || !ISO_INSTANT.test(row['createdAt']) || !Number.isFinite(Date.parse(row['createdAt']))) {
    throw new EngineAuthError('invalid-record')
  }

  const base = safeOrigin(row['baseUrl'])
  if (!isLoopbackHost(base.hostname) || portOf(base) !== row['port']) throw new EngineAuthError('invalid-record')
  const targetPort = portOf(target)
  const publicOrigin = row['publicOrigin'] === undefined ? undefined : safeOrigin(row['publicOrigin'])

  if (row['mode'] === 'local') {
    if (publicOrigin || !isLoopbackHost(target.hostname) || targetPort !== row['port']) {
      throw new EngineAuthError('invalid-record')
    }
  } else {
    if (!publicOrigin || publicOrigin.protocol !== 'https:' || target.origin !== publicOrigin.origin) {
      throw new EngineAuthError('invalid-record')
    }
  }

  return {
    version: 1,
    instanceId: row['instanceId'],
    pid: row['pid'] as number,
    mode: row['mode'],
    bindHost: row['bindHost'],
    port: row['port'] as number,
    baseUrl: base.origin,
    ...(publicOrigin ? { publicOrigin: publicOrigin.origin } : {}),
    token: row['token'],
    createdAt: row['createdAt'],
  }
}

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'

/**
 * Reads the engine-owned per-port discovery record without ever copying the token into client config.
 * The cache is keyed by configured origin; a 401 or WS reconnect passes refresh=true to observe rotation.
 */
export class EngineAuthDiscovery implements EngineCredentialSource {
  private readonly options: EngineAuthDiscoveryOptions
  private readonly cache = new Map<string, EngineCredential | undefined>()

  constructor(options: EngineAuthDiscoveryOptions = {}) {
    this.options = options
  }

  async credentialFor(baseUrl: string, options: EngineCredentialLoadOptions = {}): Promise<EngineCredential | undefined> {
    const target = parsedOrigin(baseUrl)
    const key = target.origin
    if (!options.refresh && this.cache.has(key)) return this.cache.get(key)

    // Do not even read a credential for a plaintext non-loopback destination. The request may continue
    // unauthenticated for compatibility with old engines, but secret material can never cross that wire.
    if (!maySendEngineCredential(target.origin)) {
      this.cache.set(key, undefined)
      return undefined
    }

    const recordPath = engineDiscoveryPath(target.origin, this.options)
    const runDir = path.dirname(recordPath)
    try {
      const dirStat = await lstat(runDir)
      assertOwnedPrivate(dirStat, 'dir', this.options)
    } catch (error) {
      if (missing(error)) {
        this.cache.set(key, undefined)
        return undefined
      }
      if (error instanceof EngineAuthError) throw error
      throw new EngineAuthError('insecure-record')
    }

    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(recordPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const stat = await handle.stat()
      assertOwnedPrivate(stat, 'file', this.options)
      if (stat.size < 2 || stat.size > MAX_RECORD_BYTES) throw new EngineAuthError('invalid-record')
      const raw = await handle.readFile({ encoding: 'utf8' })
      let parsed: unknown
      try {
        parsed = JSON.parse(raw) as unknown
      } catch {
        throw new EngineAuthError('invalid-record')
      }
      const record = asRecord(parsed, target)
      const credential = { token: record.token, instanceId: record.instanceId }
      this.cache.set(key, credential)
      return credential
    } catch (error) {
      if (missing(error)) {
        this.cache.set(key, undefined)
        return undefined
      }
      if (error instanceof EngineAuthError) throw error
      throw new EngineAuthError('insecure-record')
    } finally {
      await handle?.close()
    }
  }
}

/** In-memory seam for a keychain/tunnel integration; it refuses plaintext non-loopback origins. */
export class ProvisionedEngineCredential implements EngineCredentialSource {
  private readonly origin: string

  constructor(baseUrl: string, private readonly token: string) {
    const parsed = parsedOrigin(baseUrl)
    if (!maySendEngineCredential(parsed.origin)) throw new EngineAuthError('insecure-origin')
    if (!validToken(token)) throw new EngineAuthError('invalid-record')
    this.origin = parsed.origin
  }

  async credentialFor(baseUrl: string): Promise<EngineCredential | undefined> {
    const target = parsedOrigin(baseUrl)
    if (target.origin !== this.origin) return undefined
    return { token: this.token }
  }
}

export interface ConfiguredEngineCredentialOptions extends EngineAuthDiscoveryOptions {
  env?: NodeJS.ProcessEnv
}

/**
 * Resolve the product credential source. Local engines use their private per-port discovery record;
 * tunnel clients use an explicitly provisioned token or permission-checked token file. The secret is
 * never copied into client.json, and a tunnel token is never guessed from the public HTTPS port.
 */
export const configuredEngineCredentialSource = (
  baseUrl: string,
  options: ConfiguredEngineCredentialOptions = {},
): EngineCredentialSource => {
  const env = options.env ?? process.env
  const inline = env['OPENINFO_CONTROL_TOKEN']
  const tokenFile = env['OPENINFO_CONTROL_TOKEN_FILE']
  if (inline && tokenFile) throw new EngineAuthError('invalid-record')
  if (inline) return new ProvisionedEngineCredential(baseUrl, inline)
  if (!tokenFile) return new EngineAuthDiscovery(options)

  const origin = parsedOrigin(baseUrl).origin
  if (!maySendEngineCredential(origin)) throw new EngineAuthError('insecure-origin')
  return {
    credentialFor: async (candidate) => {
      if (parsedOrigin(candidate).origin !== origin) return undefined
      let handle: Awaited<ReturnType<typeof open>> | undefined
      try {
        handle = await open(tokenFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        const stat = await handle.stat()
        assertOwnedPrivate(stat, 'file', options)
        if (stat.size < 32 || stat.size > 4_096) throw new EngineAuthError('invalid-record')
        const token = (await handle.readFile({ encoding: 'utf8' })).trim()
        if (!validToken(token)) throw new EngineAuthError('invalid-record')
        return { token }
      } catch (error) {
        if (error instanceof EngineAuthError) throw error
        throw new EngineAuthError('insecure-record')
      } finally {
        await handle?.close()
      }
    },
  }
}

export const engineWebSocketProtocols = (credential: EngineCredential): [string, string] => {
  if (!validToken(credential.token)) throw new EngineAuthError('invalid-record')
  return ['openinfo.v1', `openinfo.auth.${credential.token}`]
}

export interface EngineFetchResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export type EngineFetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<EngineFetchResponse>

export interface EngineFetchOptions {
  fetchImpl: EngineFetchLike
  credentials: EngineCredentialSource
  baseUrl: string
  path: string
  init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
}

const withCredential = (
  baseUrl: string,
  init: EngineFetchOptions['init'],
  credential: EngineCredential | undefined,
): EngineFetchOptions['init'] => {
  if (!credential) return { ...init, ...(init.headers ? { headers: { ...init.headers } } : {}) }
  if (!maySendEngineCredential(baseUrl)) throw new EngineAuthError('insecure-origin')
  return { ...init, headers: { ...init.headers, authorization: `Bearer ${credential.token}` } }
}

/** One initial request and at most one credential reload/retry on 401. */
export const fetchEngineControl = async (options: EngineFetchOptions): Promise<EngineFetchResponse> => {
  const baseUrl = parsedOrigin(options.baseUrl).origin
  const url = `${baseUrl}${options.path}`
  const firstCredential = await options.credentials.credentialFor(baseUrl)
  if (!firstCredential) throw new EngineAuthError('missing-credential')
  const first = await options.fetchImpl(url, withCredential(baseUrl, options.init, firstCredential))
  if (first.status !== 401) return first
  const refreshed = await options.credentials.credentialFor(baseUrl, { refresh: true })
  if (!refreshed) throw new EngineAuthError('missing-credential')
  return options.fetchImpl(url, withCredential(baseUrl, options.init, refreshed))
}
