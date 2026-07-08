import type { CapabilityMap, CapabilitySlot, DiscoverResult, Endpoint, Fabric, ProbeList } from '@openinfo/contracts'

type DiscoverServer = DiscoverResult['servers'][number]
type DiscoveredModel = DiscoverServer['models'][number]
type HttpEndpoint = Extract<Endpoint, { kind: 'http' }>

/** Canonical slot order — makes classification + suggestion output deterministic and readable. */
const SLOT_ORDER: readonly CapabilitySlot[] = ['stt', 'tts', 'llm', 'vlm', 'ocr', 'embed']

/**
 * Classify one model id into capability slots by NAME (ARCHITECTURE §8). A model matching several
 * rules gets the UNION of their slots (a vision-language model is both vlm and llm); the `default`
 * (llm) applies only when no rule matched — so non-llm slot membership is always explicit. Pure.
 */
export const classifyModel = (map: CapabilityMap, id: string): CapabilitySlot[] => {
  const lower = id.toLowerCase()
  const found = new Set<CapabilitySlot>()
  for (const rule of map.rules) {
    if (rule.any.some((needle) => lower.includes(needle.toLowerCase()))) {
      for (const slot of rule.slots) found.add(slot)
    }
  }
  if (found.size === 0) for (const slot of map.default) found.add(slot)
  return SLOT_ORDER.filter((slot) => found.has(slot))
}

interface Candidate {
  name: string
  url: string
  model: string
  slots: CapabilitySlot[]
}

/**
 * Synthesize the config-1 suggestion: one best-available endpoint per slot (ARCHITECTURE §8 heuristic).
 * Reachable servers only, in probe-list order then model order; for each slot pick the first model
 * classified into it. For the llm slot, prefer a PURE chat model (classified llm and nothing else) over
 * a multi-slot model, so a vision-language model does not become the default chat model when a plain one
 * exists. Non-llm slots take the first explicit match. Pure — no I/O. Returns a full valid Fabric.
 */
export const synthesizeSuggestion = (servers: DiscoverServer[]): Fabric => {
  const flat: Candidate[] = []
  for (const server of servers) {
    if (!server.reachable) continue
    for (const model of server.models) {
      if (model.slots.length > 0) flat.push({ name: server.name, url: server.url, model: model.id, slots: model.slots })
    }
  }
  const endpoint = (c: Candidate): HttpEndpoint => ({ kind: 'http', name: c.name, url: c.url, api: 'openai-compat', model: c.model })
  const pick = (slot: CapabilitySlot): HttpEndpoint[] => {
    if (slot === 'llm') {
      const pure = flat.find((c) => c.slots.length === 1 && c.slots[0] === 'llm')
      if (pure) return [endpoint(pure)]
    }
    const match = flat.find((c) => c.slots.includes(slot))
    return match ? [endpoint(match)] : []
  }
  return {
    slots: { stt: pick('stt'), tts: pick('tts'), llm: pick('llm'), vlm: pick('vlm'), ocr: pick('ocr'), embed: pick('embed') },
  }
}

interface ModelsResponse {
  data?: unknown
}

/** Probe ONE server: GET {url}/v1/models, classify every model. Never throws — failures become error. */
const probeServer = async (
  probe: ProbeList['probes'][number],
  map: CapabilityMap,
  timeoutMs: number,
): Promise<DiscoverServer> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${probe.url.replace(/\/$/, '')}/v1/models`, { method: 'GET', signal: controller.signal })
    if (!response.ok) return { name: probe.name, url: probe.url, reachable: false, models: [], error: `HTTP ${response.status}` }
    let json: ModelsResponse
    try {
      json = (await response.json()) as ModelsResponse
    } catch {
      return { name: probe.name, url: probe.url, reachable: false, models: [], error: 'invalid JSON from /v1/models' }
    }
    if (!Array.isArray(json.data)) {
      return { name: probe.name, url: probe.url, reachable: false, models: [], error: 'unexpected /v1/models shape (no data array)' }
    }
    const models: DiscoveredModel[] = []
    for (const entry of json.data) {
      const id = (entry as { id?: unknown })?.id
      if (typeof id === 'string' && id.length > 0) models.push({ id, slots: classifyModel(map, id) })
    }
    return { name: probe.name, url: probe.url, reachable: true, models }
  } catch (error) {
    const message = error instanceof Error ? (error.name === 'AbortError' ? 'timed out' : error.message) : 'probe failed'
    return { name: probe.name, url: probe.url, reachable: false, models: [], error: message }
  } finally {
    clearTimeout(timeout)
  }
}

export interface DiscoverOptions {
  /** per-probe timeout; probes run in parallel so total wall time is ~this, not the sum. */
  timeoutMs?: number
}

/**
 * Discover local model servers: probe the probe list in PARALLEL (short timeout each, never throws),
 * classify every reported model by name, and synthesize a config-1 suggestion. No secrets involved
 * (localhost). This is the one new read-only engine capability the onboarding lens needs (§8).
 */
export const discoverFabric = async (
  probeList: ProbeList,
  map: CapabilityMap,
  opts: DiscoverOptions = {},
): Promise<DiscoverResult> => {
  const timeoutMs = opts.timeoutMs ?? 1_000
  const servers = await Promise.all(probeList.probes.map((probe) => probeServer(probe, map, timeoutMs)))
  return { servers, suggestion: synthesizeSuggestion(servers), probedAt: new Date().toISOString() }
}
