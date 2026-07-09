import type { Endpoint } from '@openinfo/contracts'
import type { SecretResolver } from './secrets.js'
import type { LocalRuntimeManager, SpawnState } from './endpoints/local.js'

export interface EndpointHealth {
  name: string
  ok: boolean
  latencyMs?: number
  checkedAt: string
  error?: string
}

/** Honest one-liner for each spawn state (health reports state; it never spawns from a health check). */
const localHealth = (name: string, state: SpawnState, checkedAt: string, installHint?: string): EndpointHealth => {
  if (state === 'ready') return { name, ok: true, checkedAt }
  const error =
    state === 'starting' ? 'runtime starting (model loading)'
      : state === 'binary-missing' ? `runtime binary not installed${installHint ? ` — ${installHint}` : ''}`
      : state === 'model-missing' ? 'model not downloaded yet'
      : state === 'crashed' ? 'runtime crashed repeatedly — restart the engine'
      : state === 'unsupported' ? 'local runtime not managed in v0'
      : 'not started (spawns on demand)'
  return { name, ok: false, checkedAt, error }
}

export const checkEndpoint = async (
  endpoint: Endpoint,
  timeoutMs = 1_000,
  resolveKey?: SecretResolver,
  runtimeManager?: LocalRuntimeManager,
): Promise<EndpointHealth> => {
  const checkedAt = new Date().toISOString()
  if (endpoint.kind === 'local') {
    if (!runtimeManager) return { name: endpoint.name, ok: false, checkedAt, error: 'local runtime not managed here' }
    const spec = runtimeManager.specFor(endpoint)
    // An adopt-only external runtime (omlx) is supervised outside the engine, so status() cannot know
    // its liveness synchronously — a LIVE probe of its fixed port is the honest signal, exactly as an
    // http endpoint is probed (with the same keyRef→bearer). Its port + health path are the endpoint;
    // the rest of this function then treats it like the http case below.
    if (spec?.adoptOnly && spec.defaultPort !== undefined) {
      const keyRef = endpoint.auth?.keyRef
      const headers: Record<string, string> = {}
      if (keyRef !== undefined) {
        const value = resolveKey?.(keyRef)
        if (value === undefined || value === '') return { name: endpoint.name, ok: false, checkedAt, error: `unresolved secret keyRef "${keyRef}"` }
        headers['authorization'] = `Bearer ${value}`
      }
      const started = performance.now()
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await fetch(`http://127.0.0.1:${spec.defaultPort}${spec.healthPath}`, { method: 'GET', headers, signal: controller.signal })
        const latencyMs = Math.round(performance.now() - started)
        if (res.ok) return { name: endpoint.name, ok: true, latencyMs, checkedAt }
        return { name: endpoint.name, ok: false, latencyMs, checkedAt, error: `HTTP ${res.status}` }
      } catch {
        return { name: endpoint.name, ok: false, checkedAt, error: `${spec.runtime} not running on :${spec.defaultPort} — ${spec.installHint}` }
      } finally {
        clearTimeout(timeout)
      }
    }
    return localHealth(endpoint.name, runtimeManager.status(endpoint), checkedAt, spec?.installHint)
  }
  if (endpoint.kind === 'cloud') return { name: endpoint.name, ok: false, checkedAt, error: 'cloud endpoints are out of Phase 1' }

  // An endpoint that declares auth but whose keyRef cannot be resolved is unhealthy — gracefully, so
  // fallback moves to the next endpoint. Report the REF, never the value.
  const keyRef = endpoint.auth?.keyRef
  const headers: Record<string, string> = {}
  if (keyRef !== undefined) {
    const value = resolveKey?.(keyRef)
    if (value === undefined || value === '') return { name: endpoint.name, ok: false, checkedAt, error: `unresolved secret keyRef "${keyRef}"` }
    headers['authorization'] = `Bearer ${value}`
  }

  const started = performance.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(endpoint.url, { method: 'GET', headers, signal: controller.signal })
    const latencyMs = Math.round(performance.now() - started)
    if (response.ok) return { name: endpoint.name, ok: true, latencyMs, checkedAt }
    // An OpenAI-compat server may 404 its bare root (omlx/FastAPI does) while serving /v1 fine —
    // fall back to the dialect's own listing route before calling the endpoint unhealthy. Root is
    // still tried first so servers that only answer root (and any non-/v1 dialect) keep working.
    if (endpoint.api === 'openai-compat') {
      const models = await fetch(`${endpoint.url.replace(/\/$/, '')}/v1/models`, { method: 'GET', headers, signal: controller.signal })
      const modelsLatencyMs = Math.round(performance.now() - started)
      if (models.ok) return { name: endpoint.name, ok: true, latencyMs: modelsLatencyMs, checkedAt }
    }
    return { name: endpoint.name, ok: false, latencyMs, checkedAt, error: `HTTP ${response.status}` }
  } catch (error) {
    return { name: endpoint.name, ok: false, checkedAt, error: error instanceof Error ? error.message : 'endpoint check failed' }
  } finally {
    clearTimeout(timeout)
  }
}
