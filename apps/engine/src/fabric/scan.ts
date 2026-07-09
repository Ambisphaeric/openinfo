import type { CapabilityMap, ProbeList, ScanRequest, ScanResult } from '@openinfo/contracts'
import { classifyModel } from './discover.js'
import { InvokeError, classifyFetchError, extractServerMessage, type InvokeCtx } from './invoke-error.js'
import type { SecretResolver } from './secrets.js'

/**
 * The host-scan (HOST-SCAN + MODEL-DROPDOWN slice) — the user's mandate made mechanism: "pick host,
 * scan common ports, see if missing api key, see if model list returns, list models on the call — then
 * you get a 'capabilities' list." An exact `url` probes that base URL; a bare `host` tries the
 * probe-list DOCUMENT's ports against it (the "common ports" are the conventions discovery already
 * carries — a user on a nonstandard port edits the document, and the scan follows). Every model is
 * classified through the capability-map document, so the result IS the capabilities list.
 *
 * Failures are classified with the SAME taxonomy invoke/drain use (invoke-error.ts): a dead port is
 * `unreachable`, a hang is `timeout`, a 401/403 is `auth` (authRequired — wire a keyRef and rescan),
 * an un-OpenAI-shaped reply is `bad-response` — each with the standard troubleshoot hint.
 *
 * POSTURE: the engine is localhost-only (auth is P7), and this is a USER-DIRECTED probe of a host the
 * user typed into their own settings — a handful of GETs to {url}/v1/models, not an unsolicited subnet
 * sweep (the consent-gated LAN sweep stays future, CODE_MAP §3). Timeouts are short and probes run in
 * PARALLEL, like discovery. No caching — every call probes fresh (the user's explicit call: "don't
 * even need to cache, it will be hit infrequently"). VALUE-FREE: a keyRef resolves server-side into a
 * bearer header; no key material ever appears in a ScanResult (hints name the ref only).
 */

type ScannedHost = ScanResult['hosts'][number]
type ScanError = NonNullable<ScannedHost['error']>

/** An InvokeError, reshaped for the wire (class + the server's message/OS code + the hint). */
const toScanError = (error: InvokeError): ScanError => ({
  class: error.class,
  ...(error.serverMessage !== undefined ? { message: error.serverMessage } : {}),
  hint: error.hint,
})

/**
 * The base URLs a bare host expands to: the probe-list document's PORTS applied to that host, in
 * document order, deduped. Ports are read from the stored document (not a hardcoded list) so a user
 * who added a nonstandard port to discovery gets it in the scan too. Pure.
 */
export const hostTargets = (host: string, probeList: ProbeList): string[] => {
  const urls: string[] = []
  const seen = new Set<string>()
  for (const probe of probeList.probes) {
    let port: string
    try {
      const parsed = new URL(probe.url)
      port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
    } catch {
      continue // a malformed probe URL contributes nothing (the document is user-editable)
    }
    const url = `http://${host}:${port}`
    if (!seen.has(url)) {
      seen.add(url)
      urls.push(url)
    }
  }
  return urls
}

export interface ScanOptions {
  /** per-URL timeout; URLs are probed in parallel so total wall time is ~this, not the sum. */
  timeoutMs?: number
  /** resolves a keyRef to its bearer value at scan time — the value never leaves this call. */
  resolveKey?: SecretResolver
}

interface ModelsResponse {
  data?: unknown
}

/** Probe ONE base URL: GET {url}/v1/models (bearer when a keyRef resolves), classify every model. Never throws. */
const scanOne = async (
  rawUrl: string,
  map: CapabilityMap,
  keyRef: string | undefined,
  opts: ScanOptions,
): Promise<ScannedHost> => {
  const url = rawUrl.replace(/\/$/, '')
  const ctx: InvokeCtx = { endpoint: url, url, ...(keyRef !== undefined ? { keyRef } : {}) }
  const dead = (error: InvokeError): ScannedHost => ({ url, reachable: false, authRequired: false, models: [], error: toScanError(error) })

  const headers: Record<string, string> = {}
  if (keyRef !== undefined) {
    const value = opts.resolveKey?.(keyRef)
    if (value === undefined || value === '') {
      // Honest before any fetch: the ref has no stored value. Value-free — the message names the REF.
      return {
        url,
        reachable: false,
        authRequired: true,
        models: [],
        error: {
          class: 'auth',
          message: `unresolved secret keyRef "${keyRef}"`,
          hint: 'no value stored for this keyRef yet — add it under Settings → Keys, then rescan',
        },
      }
    }
    headers['authorization'] = `Bearer ${value}`
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 1_500)
  try {
    const response = await fetch(`${url}/v1/models`, { method: 'GET', headers, signal: controller.signal })
    if (response.status === 401 || response.status === 403) {
      // The server ANSWERED — it just wants a key. reachable stays true; the editor wires a keyRef and rescans.
      const message = extractServerMessage(await response.text().catch(() => ''))
      const error = new InvokeError('auth', ctx, message !== undefined ? { serverMessage: message } : {})
      return { url, reachable: true, authRequired: true, models: [], error: toScanError(error) }
    }
    if (!response.ok) {
      const message = extractServerMessage(await response.text().catch(() => '')) ?? `HTTP ${response.status}`
      return dead(new InvokeError('bad-response', ctx, { serverMessage: message }))
    }
    let json: ModelsResponse
    try {
      json = (await response.json()) as ModelsResponse
    } catch {
      return dead(new InvokeError('bad-response', ctx, { serverMessage: 'invalid JSON from /v1/models' }))
    }
    // Ollama with ZERO models pulled answers {"object":"list","data":null} — a LIVE OpenAI-compatible
    // server with nothing loaded, not a bad response (found scanning the real thing). Honest empty list.
    const entries = Array.isArray(json.data) ? json.data : json.data === null && (json as { object?: unknown }).object === 'list' ? [] : undefined
    if (entries === undefined) {
      return dead(new InvokeError('bad-response', ctx, { serverMessage: 'unexpected /v1/models shape (no data array)' }))
    }
    const models: ScannedHost['models'] = []
    for (const entry of entries) {
      const id = (entry as { id?: unknown })?.id
      if (typeof id === 'string' && id.length > 0) models.push({ id, slots: classifyModel(map, id) })
    }
    return { url, reachable: true, authRequired: false, models }
  } catch (error) {
    return dead(classifyFetchError(error, ctx)) // timeout | unreachable, with the OS code when present
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Run the scan a ScanRequest describes: exact `url` → that one base URL; bare `host` → the probe-list
 * ports against it (hostTargets). Parallel, short-timeout, never throws, never cached. The CALLER
 * validates exactly-one-of url|host (the route 400s); given neither this returns an empty result.
 */
export const scanHosts = async (
  request: ScanRequest,
  probeList: ProbeList,
  map: CapabilityMap,
  opts: ScanOptions = {},
): Promise<ScanResult> => {
  const targets = request.url !== undefined ? [request.url] : request.host !== undefined ? hostTargets(request.host, probeList) : []
  const hosts = await Promise.all(targets.map((url) => scanOne(url, map, request.keyRef, opts)))
  return { hosts, scannedAt: new Date().toISOString() }
}
