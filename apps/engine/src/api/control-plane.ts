import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

/**
 * The engine control plane is deliberately narrower than the model fabric. Model endpoints may live on
 * the LAN; the API that can read capture, change fabric, and release guard holds may not. v0 supports a
 * direct loopback listener and a trusted-tunnel mode whose public HTTPS edge terminates back to that same
 * loopback listener. A direct plaintext LAN bind is never a mode.
 */
export type ControlPlaneMode = 'local' | 'tunnel'

export type ControlTokenSource = 'generated' | 'environment' | 'file'

export interface ControlPlaneDiscoveryRecord {
  version: 1
  instanceId: string
  pid: number
  mode: ControlPlaneMode
  bindHost: string
  port: number
  /** The loopback origin the engine itself listens on. */
  baseUrl: string
  /** The authenticated HTTPS edge in tunnel mode. Omitted in local mode. */
  publicOrigin?: string
  /** Per-launch local credential, or the explicitly provisioned tunnel credential. Never log this. */
  token: string
  createdAt: string
}

/** Safe to add to public /health: no credential, digest, filesystem path, or origin is exposed. */
export interface PublicControlPlanePolicy {
  authRequired: true
  instanceId: string
  mode: ControlPlaneMode
  transport: 'loopback-http' | 'trusted-tunnel-https'
}

/** Structural match for api/ws.ts's EventSocketPolicy; control-plane does not import the WS module. */
export interface EventSocketPolicy {
  validateHost(host: string | undefined): boolean
  validateOrigin(origin: string | undefined): boolean
  authenticate(token: string): boolean
}

/** The narrow request-time boundary consumed by api/http.ts; implemented by the real policy and tests. */
export interface ControlPlaneAccess {
  readonly mode: ControlPlaneMode
  readonly publicOrigin: string | undefined
  authenticate(token: string | undefined): boolean
  validateHost(host: string | undefined): boolean
  validateOrigin(origin: string | undefined): boolean
  eventSocketPolicy(): EventSocketPolicy
  publicPolicy(): PublicControlPlanePolicy
}

export interface ResolveControlPlaneOptions {
  env?: Record<string, string | undefined>
  homeDir?: string
  now?: () => Date
  pid?: number
  makeInstanceId?: () => string
  makeToken?: () => string
}

interface ResolvedControlPlanePolicy {
  mode: ControlPlaneMode
  bindHost: string
  port: number
  baseUrl: string
  publicOrigin?: string
  allowedOrigins: readonly string[]
  token: string
  tokenSource: ControlTokenSource
  instanceId: string
  createdAt: string
  pid: number
  runDir: string
}

const TOKEN_BYTES = 32
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/
const LOOPBACK_V4 = /^127(?:\.(?:\d{1,3})){3}$/

/** Generate exactly 256 random bits, encoded without padding so it is safe in a WS subprotocol token. */
export const generateControlToken = (): string => randomBytes(TOKEN_BYTES).toString('base64url')

/** Hash first so timingSafeEqual always compares fixed-size buffers, even for a malformed candidate. */
export const controlTokenDigest = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest()

export const validateControlToken = (expectedDigest: Buffer, candidate: string | undefined): boolean => {
  const value = typeof candidate === 'string' ? candidate : ''
  return timingSafeEqual(expectedDigest, controlTokenDigest(value))
}

/** Exactly one public unauthenticated route exists. Query strings do not change that classification. */
export const isPublicHealthRequest = (method: string | undefined, requestUrl: string | undefined): boolean => {
  if (method !== 'GET') return false
  try {
    return new URL(requestUrl ?? '/', 'http://control.invalid').pathname === '/health'
  } catch {
    return false
  }
}

const parsePort = (raw: string | undefined): number => {
  const port = Number(raw ?? 8787)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`OPENINFO_PORT must be an integer from 1 to 65535 (received ${JSON.stringify(raw)})`)
  }
  return port
}

const bareHostname = (hostname: string): string => hostname.toLowerCase().replace(/^\[|\]$/g, '')

export const isLoopbackControlHost = (hostname: string): boolean => {
  const host = bareHostname(hostname)
  if (host === 'localhost' || host === '::1') return true
  if (!LOOPBACK_V4.test(host)) return false
  return host.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255)
}

const resolveBindHost = (raw: string | undefined): string => {
  const requested = bareHostname((raw ?? '127.0.0.1').trim())
  if (!isLoopbackControlHost(requested)) {
    throw new Error(
      `refusing non-loopback OPENINFO_BIND_HOST=${JSON.stringify(raw)}; use ` +
        'OPENINFO_CONTROL_MODE=tunnel with an authenticated TLS tunnel terminating on loopback',
    )
  }
  // `localhost` can resolve differently across machines; make the product default deterministic.
  return requested === 'localhost' ? '127.0.0.1' : requested
}

const originHost = (host: string): string => (host.includes(':') ? `[${host}]` : host)
const loopbackOrigin = (host: string, port: number): string => `http://${originHost(host)}:${port}`

const parseExactOrigin = (raw: string, label: string): string => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${label} must be an absolute http(s) origin`)
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') {
    throw new Error(`${label} must be an absolute http(s) origin without credentials`)
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(`${label} must contain only scheme, host, and optional port`)
  }
  return url.origin
}

const readProvisionedToken = (env: Record<string, string | undefined>): { token?: string; source?: ControlTokenSource } => {
  const direct = env['OPENINFO_CONTROL_TOKEN']
  const file = env['OPENINFO_CONTROL_TOKEN_FILE']
  if (direct !== undefined && file !== undefined) {
    throw new Error('set only one of OPENINFO_CONTROL_TOKEN or OPENINFO_CONTROL_TOKEN_FILE')
  }
  if (direct !== undefined) return { token: direct.trim(), source: 'environment' }
  if (file === undefined) return {}

  const tokenPath = resolve(file)
  let fd: number | undefined
  try {
    fd = openSync(tokenPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error(`OPENINFO_CONTROL_TOKEN_FILE is not a regular file: ${tokenPath}`)
    // Windows does not expose POSIX permission semantics. On POSIX, fail closed instead of accepting a
    // group/world-readable remote control credential.
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new Error('OPENINFO_CONTROL_TOKEN_FILE must not be readable or writable by group/other (chmod 600)')
    }
    return { token: readFileSync(fd, 'utf8').trim(), source: 'file' }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

const assertControlToken = (token: string): void => {
  if (Buffer.byteLength(token, 'utf8') < TOKEN_BYTES || !TOKEN_PATTERN.test(token)) {
    throw new Error(
      'control token must be at least 32 bytes and contain only URL-safe base64 characters (A-Z, a-z, 0-9, _, -)',
    )
  }
}

const parseAllowedOrigins = (raw: string | undefined): string[] => {
  if (raw === undefined || raw.trim() === '') return []
  const origins = raw.split(',').map((part) => parseExactOrigin(part.trim(), 'OPENINFO_ALLOWED_ORIGINS entry'))
  return [...new Set(origins)]
}

const hostHeaderMatches = (rawHost: string | undefined, policy: ResolvedControlPlanePolicy): boolean => {
  if (rawHost === undefined || rawHost.trim() === '' || /[\s/@]/.test(rawHost)) return false
  let parsed: URL
  try {
    parsed = new URL(`http://${rawHost}`)
  } catch {
    return false
  }
  const hostname = bareHostname(parsed.hostname)
  const port = parsed.port === '' ? 80 : Number(parsed.port)
  if (isLoopbackControlHost(hostname) && port === policy.port) return true
  if (policy.publicOrigin !== undefined) return parsed.host.toLowerCase() === new URL(policy.publicOrigin).host.toLowerCase()
  return false
}

const originMatches = (rawOrigin: string | undefined, policy: ResolvedControlPlanePolicy): boolean => {
  // Native Node/Electron-main requests do not send Origin; authentication is still mandatory downstream.
  if (rawOrigin === undefined) return true
  // Chromium file renderers serialize an opaque origin as `null`; the Electron shell injects the bearer
  // only for trusted built-in webContents. A hostile null-origin browser still lacks the token.
  if (policy.mode === 'local' && (rawOrigin === 'null' || rawOrigin === 'file://')) return true
  let origin: string
  try {
    origin = parseExactOrigin(rawOrigin, 'Origin')
  } catch {
    return false
  }
  if (policy.allowedOrigins.includes(origin)) return true
  if (policy.publicOrigin === origin) return true
  const url = new URL(origin)
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port)
  return url.protocol === 'http:' && isLoopbackControlHost(url.hostname) && port === policy.port
}

export class ControlPlane implements ControlPlaneAccess {
  readonly mode: ControlPlaneMode
  readonly bindHost: string
  readonly port: number
  readonly baseUrl: string
  readonly publicOrigin: string | undefined
  readonly tokenSource: ControlTokenSource
  readonly instanceId: string
  readonly discoveryPath: string

  private readonly resolved: ResolvedControlPlanePolicy
  private readonly expectedTokenDigest: Buffer

  private constructor(resolved: ResolvedControlPlanePolicy) {
    this.resolved = resolved
    this.mode = resolved.mode
    this.bindHost = resolved.bindHost
    this.port = resolved.port
    this.baseUrl = resolved.baseUrl
    this.publicOrigin = resolved.publicOrigin
    this.tokenSource = resolved.tokenSource
    this.instanceId = resolved.instanceId
    this.discoveryPath = join(resolved.runDir, `engine-${resolved.port}.json`)
    this.expectedTokenDigest = controlTokenDigest(resolved.token)
  }

  authenticate(token: string | undefined): boolean {
    return validateControlToken(this.expectedTokenDigest, token)
  }

  validateHost(host: string | undefined): boolean {
    return hostHeaderMatches(host, this.resolved)
  }

  validateOrigin(origin: string | undefined): boolean {
    return originMatches(origin, this.resolved)
  }

  eventSocketPolicy(): EventSocketPolicy {
    return {
      validateHost: (host) => this.validateHost(host),
      validateOrigin: (origin) => this.validateOrigin(origin),
      authenticate: (token) => this.authenticate(token),
    }
  }

  publicPolicy(): PublicControlPlanePolicy {
    return {
      authRequired: true,
      instanceId: this.instanceId,
      mode: this.mode,
      transport: this.mode === 'local' ? 'loopback-http' : 'trusted-tunnel-https',
    }
  }

  discoveryRecord(): ControlPlaneDiscoveryRecord {
    return {
      version: 1,
      instanceId: this.resolved.instanceId,
      pid: this.resolved.pid,
      mode: this.resolved.mode,
      bindHost: this.resolved.bindHost,
      port: this.resolved.port,
      baseUrl: this.resolved.baseUrl,
      ...(this.resolved.publicOrigin !== undefined ? { publicOrigin: this.resolved.publicOrigin } : {}),
      token: this.resolved.token,
      createdAt: this.resolved.createdAt,
    }
  }

  /** Publish only after listen succeeds, so a discovery record never advertises a dead startup. */
  async publishDiscovery(): Promise<ControlPlaneDiscoveryRecord> {
    await mkdir(this.resolved.runDir, { recursive: true, mode: 0o700 })
    // mkdir's mode is umask-sensitive and does not repair an existing permissive directory.
    await chmod(this.resolved.runDir, 0o700)
    const record = this.discoveryRecord()
    const target = this.discoveryPath
    const temp = join(this.resolved.runDir, `.${basename(target)}.${this.instanceId}.tmp`)
    try {
      await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await chmod(temp, 0o600)
      await rename(temp, target)
      return record
    } finally {
      await rm(temp, { force: true }).catch(() => undefined)
    }
  }

  /** Remove only this launch's record; a later engine that replaced the per-port record wins. */
  async cleanupDiscovery(): Promise<boolean> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.discoveryPath, 'utf8')) as unknown
    } catch {
      return false
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { instanceId?: unknown }).instanceId !== this.instanceId
    ) {
      return false
    }
    try {
      await unlink(this.discoveryPath)
      return true
    } catch {
      return false
    }
  }

  static fromEnvironment(options: ResolveControlPlaneOptions = {}): ControlPlane {
    return new ControlPlane(resolveControlPlanePolicy(options))
  }
}

const resolveControlPlanePolicy = (options: ResolveControlPlaneOptions): ResolvedControlPlanePolicy => {
  const env = options.env ?? process.env
  const rawMode = env['OPENINFO_CONTROL_MODE'] ?? 'local'
  if (rawMode !== 'local' && rawMode !== 'tunnel') {
    throw new Error(`OPENINFO_CONTROL_MODE must be "local" or "tunnel" (received ${JSON.stringify(rawMode)})`)
  }
  const mode: ControlPlaneMode = rawMode
  const port = parsePort(env['OPENINFO_PORT'])
  const bindHost = resolveBindHost(env['OPENINFO_BIND_HOST'])
  const baseUrl = loopbackOrigin(bindHost, port)
  const supplied = readProvisionedToken(env)
  const token = supplied.token ?? options.makeToken?.() ?? generateControlToken()
  const tokenSource = supplied.source ?? 'generated'
  assertControlToken(token)

  const rawPublicOrigin = env['OPENINFO_PUBLIC_ORIGIN']
  let publicOrigin: string | undefined
  if (mode === 'tunnel') {
    if (rawPublicOrigin === undefined) {
      throw new Error('OPENINFO_CONTROL_MODE=tunnel requires OPENINFO_PUBLIC_ORIGIN=https://...')
    }
    publicOrigin = parseExactOrigin(rawPublicOrigin, 'OPENINFO_PUBLIC_ORIGIN')
    if (!publicOrigin.startsWith('https://')) {
      throw new Error('OPENINFO_CONTROL_MODE=tunnel requires an https:// OPENINFO_PUBLIC_ORIGIN')
    }
    if (tokenSource === 'generated') {
      throw new Error('OPENINFO_CONTROL_MODE=tunnel requires OPENINFO_CONTROL_TOKEN or OPENINFO_CONTROL_TOKEN_FILE')
    }
  } else if (rawPublicOrigin !== undefined) {
    throw new Error('OPENINFO_PUBLIC_ORIGIN is valid only with OPENINFO_CONTROL_MODE=tunnel')
  }

  const resolved: ResolvedControlPlanePolicy = {
    mode,
    bindHost,
    port,
    baseUrl,
    ...(publicOrigin !== undefined ? { publicOrigin } : {}),
    allowedOrigins: parseAllowedOrigins(env['OPENINFO_ALLOWED_ORIGINS']),
    token,
    tokenSource,
    instanceId: options.makeInstanceId?.() ?? randomUUID(),
    createdAt: (options.now?.() ?? new Date()).toISOString(),
    pid: options.pid ?? process.pid,
    runDir: resolve(env['OPENINFO_CONTROL_RUN_DIR'] ?? join(options.homeDir ?? homedir(), '.openinfo', 'run')),
  }
  return resolved
}

/** The supported construction path: it always resolves a token and refuses unsafe listener config. */
export const resolveControlPlane = (options: ResolveControlPlaneOptions = {}): ControlPlane =>
  ControlPlane.fromEnvironment(options)
