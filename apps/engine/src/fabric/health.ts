import type { Endpoint } from '@openinfo/contracts'

export interface EndpointHealth {
  name: string
  ok: boolean
  latencyMs?: number
  checkedAt: string
  error?: string
}

export const checkEndpoint = async (endpoint: Endpoint, timeoutMs = 1_000): Promise<EndpointHealth> => {
  const checkedAt = new Date().toISOString()
  if (endpoint.kind === 'local') return { name: endpoint.name, ok: false, checkedAt, error: 'local runtime health is stubbed in Phase 1' }
  if (endpoint.kind === 'cloud') return { name: endpoint.name, ok: false, checkedAt, error: 'cloud endpoints are out of Phase 1' }

  const started = performance.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(endpoint.url, { method: 'GET', signal: controller.signal })
    const latencyMs = Math.round(performance.now() - started)
    if (response.ok) return { name: endpoint.name, ok: true, latencyMs, checkedAt }
    return { name: endpoint.name, ok: false, latencyMs, checkedAt, error: `HTTP ${response.status}` }
  } catch (error) {
    return { name: endpoint.name, ok: false, checkedAt, error: error instanceof Error ? error.message : 'endpoint check failed' }
  } finally {
    clearTimeout(timeout)
  }
}
