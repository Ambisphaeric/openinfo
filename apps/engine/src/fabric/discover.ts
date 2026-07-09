import type { CapabilityMap, CapabilitySlot, DiscoverResult, Endpoint, Fabric, ProbeList } from '@openinfo/contracts'
import type { SecretResolver } from './secrets.js'

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
  order: number
}

/**
 * A rough parameter-size rank for a model id, in millions of params — the FIRST `NNb`/`NNm` token in the
 * name (`llama-3.2-3b` → 3000, `qwen2.5-1.5b` → 1500, `whisper-350m` → 350). A model with no size token
 * ranks last (Infinity) so a known-small model is always preferred over an unknown-size one. Lower =
 * preferred. This is the cold-35B fix (slice b recorded a cold 35B blowing the 30s first-run invoke
 * timeout): the first-run suggestion should favour a smaller, likely-warm model. Deterministic and
 * inspectable (product principle 1). GRADUATION PATH: a real rank (measured tok/s, quant, MoE active-
 * param awareness, an explicit `preferOrder`) belongs in a ranking DOCUMENT like the capability map —
 * this in-code heuristic is the honest v0, and the user always sees every model in Advanced.
 */
export const modelSizeRank = (id: string): number => {
  const match = /(\d+(?:\.\d+)?)\s*([bm])\b/i.exec(id.toLowerCase())
  if (!match) return Number.POSITIVE_INFINITY
  const n = Number(match[1])
  return match[2] === 'b' ? n * 1000 : n
}

/**
 * Synthesize the config-1 suggestion: one best-available endpoint per slot (ARCHITECTURE §8 heuristic).
 * Reachable servers only. For each slot, among the models classified into it, prefer the SMALLEST by
 * `modelSizeRank` (the cold-35B first-run fix), tie-broken by probe-list order then model order. For the
 * llm slot, a PURE chat model (classified llm and nothing else) is preferred over a multi-slot model, so
 * a vision-language model does not become the default chat model when a plain one exists — size ranking
 * then applies within the chosen pool. Pure — no I/O. Returns a full valid Fabric.
 */
export const synthesizeSuggestion = (servers: DiscoverServer[]): Fabric => {
  const flat: Candidate[] = []
  let order = 0
  for (const server of servers) {
    if (!server.reachable) continue
    for (const model of server.models) {
      if (model.slots.length > 0) flat.push({ name: server.name, url: server.url, model: model.id, slots: model.slots, order: order++ })
    }
  }
  const endpoint = (c: Candidate): HttpEndpoint => ({ kind: 'http', name: c.name, url: c.url, api: 'openai-compat', model: c.model })
  // smallest first; ties keep discovery order (stable) — deterministic first-match with a size bias.
  const smallestFirst = (pool: Candidate[]): Candidate[] =>
    [...pool].sort((a, b) => modelSizeRank(a.model) - modelSizeRank(b.model) || a.order - b.order)
  const pick = (slot: CapabilitySlot): HttpEndpoint[] => {
    const inSlot = flat.filter((c) => c.slots.includes(slot))
    let pool = inSlot
    if (slot === 'llm') {
      const pure = inSlot.filter((c) => c.slots.length === 1 && c.slots[0] === 'llm')
      if (pure.length) pool = pure
    }
    const best = smallestFirst(pool)[0]
    return best ? [endpoint(best)] : []
  }
  return {
    slots: { stt: pick('stt'), tts: pick('tts'), llm: pick('llm'), vlm: pick('vlm'), ocr: pick('ocr'), embed: pick('embed') },
  }
}

interface ModelsResponse {
  data?: unknown
}

/**
 * Read the model ids ONE server currently reports (`GET {url}/v1/models`) — the loaded-model knowledge
 * discovery already speaks, reused read-only for the "the model you asked for won't load, but the server
 * has these others" suggestion. Never throws (a probe): an unreachable/odd server yields []. No secrets
 * (this is for local model servers). Distinct from probeServer: it returns bare ids, not a classified
 * DiscoverServer, so a diagnostic path can suggest a switch without pulling in the capability map.
 */
export const listLoadedModels = async (url: string, timeoutMs = 1_500): Promise<string[]> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/v1/models`, { method: 'GET', signal: controller.signal })
    if (!response.ok) return []
    const json = (await response.json()) as ModelsResponse
    if (!Array.isArray(json.data)) return []
    const ids: string[] = []
    for (const entry of json.data) {
      const id = (entry as { id?: unknown })?.id
      if (typeof id === 'string' && id.length > 0) ids.push(id)
    }
    return ids
  } catch {
    return []
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * The loaded-model suggestion (user agency, NOT automation): given a model-load failure's server url and
 * the model that failed, if the server reports OTHER models, produce a one-line "switch to one of these"
 * hint suffix. Returns undefined when the server reports nothing else (no false hope). Never auto-switches
 * — a future `auto` endpoint option (deferred) could, but v0 only tells the user what is available.
 */
export const loadedModelSuggestion = async (
  url: string,
  failedModel: string | undefined,
  timeoutMs = 1_500,
): Promise<string | undefined> => {
  const ids = await listLoadedModels(url, timeoutMs)
  const others = ids.filter((id) => id !== failedModel)
  if (others.length === 0) return undefined
  const eg = others.slice(0, 2).join(', ')
  return `server reports ${others.length} other model${others.length === 1 ? '' : 's'} (e.g. ${eg}) — switch in Settings → Endpoints`
}

/** Turn a live /v1/models body into classified models, or an honest shape error. Pure — no I/O. */
const modelsFromBody = (
  probe: ProbeList['probes'][number],
  map: CapabilityMap,
  json: ModelsResponse,
): DiscoverServer => {
  if (!Array.isArray(json.data)) {
    return { name: probe.name, url: probe.url, reachable: false, models: [], error: 'unexpected /v1/models shape (no data array)' }
  }
  const models: DiscoveredModel[] = []
  for (const entry of json.data) {
    const id = (entry as { id?: unknown })?.id
    if (typeof id === 'string' && id.length > 0) models.push({ id, slots: classifyModel(map, id) })
  }
  return { name: probe.name, url: probe.url, reachable: true, models }
}

/** GET {url}/v1/models with an optional bearer; returns the parsed body or a classified failure. Never throws. */
const fetchModels = async (
  url: string,
  bearer: string | undefined,
  timeoutMs: number,
): Promise<{ ok: true; json: ModelsResponse } | { ok: false; status?: number; error: string }> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const headers: Record<string, string> = bearer !== undefined ? { authorization: `Bearer ${bearer}` } : {}
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/v1/models`, { method: 'GET', headers, signal: controller.signal })
    if (!response.ok) return { ok: false, status: response.status, error: `HTTP ${response.status}` }
    try {
      return { ok: true, json: (await response.json()) as ModelsResponse }
    } catch {
      return { ok: false, error: 'invalid JSON from /v1/models' }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? (error.name === 'AbortError' ? 'timed out' : error.message) : 'probe failed' }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Probe ONE server: GET {url}/v1/models, classify every model. Never throws — failures become `error`.
 * A 401/403 is NOT a miss: the server ANSWERED, it just wants a key (omlx does even on localhost). We
 * surface that as `reachable:true, authRequired:true` (the onboarding lens shows "present, needs a key"
 * and the user wires a keyRef). If the probe carries a `keyRef` AND that secret is stored, we RETRY with
 * the bearer and enumerate the models — so an authed server that the engine already holds a key for is
 * discovered fully, with no key material ever leaving this call (only the ref is named).
 */
const probeServer = async (
  probe: ProbeList['probes'][number],
  map: CapabilityMap,
  timeoutMs: number,
  resolveKey: SecretResolver | undefined,
): Promise<DiscoverServer> => {
  const first = await fetchModels(probe.url, undefined, timeoutMs)
  if (first.ok) return modelsFromBody(probe, map, first.json)

  const needsAuth = first.status === 401 || first.status === 403
  if (needsAuth) {
    const value = probe.keyRef !== undefined ? resolveKey?.(probe.keyRef) : undefined
    if (value !== undefined && value !== '') {
      const retry = await fetchModels(probe.url, value, timeoutMs)
      if (retry.ok) return { ...modelsFromBody(probe, map, retry.json), authRequired: true }
      // still refused with the stored key (wrong/expired) — present, but the key did not open it.
      return { name: probe.name, url: probe.url, reachable: true, authRequired: true, models: [], error: retry.error }
    }
    // present, wants a key, none stored to try — a discovery result, not a miss.
    return {
      name: probe.name,
      url: probe.url,
      reachable: true,
      authRequired: true,
      models: [],
      error: probe.keyRef !== undefined ? `needs a key (keyRef "${probe.keyRef}" not stored yet)` : 'needs a key (attach a keyRef and rescan)',
    }
  }
  return { name: probe.name, url: probe.url, reachable: false, models: [], error: first.error }
}

export interface DiscoverOptions {
  /** per-probe timeout; probes run in parallel so total wall time is ~this, not the sum. */
  timeoutMs?: number
  /**
   * Resolve a probe's `keyRef` to its bearer value at probe time — the value never leaves this call.
   * When absent, an authed server (401) is surfaced as authRequired rather than enumerated. Localhost
   * probes need no secret; a server that demands one (omlx) does.
   */
  resolveKey?: SecretResolver
}

/**
 * Discover local model servers: probe the probe list in PARALLEL (short timeout each, never throws),
 * classify every reported model by name, and synthesize a config-1 suggestion. A 401 server is surfaced
 * as present-but-needs-a-key (and retried with a stored secret when the probe names one). This is the
 * one read-only engine capability the onboarding lens needs (§8).
 */
export const discoverFabric = async (
  probeList: ProbeList,
  map: CapabilityMap,
  opts: DiscoverOptions = {},
): Promise<DiscoverResult> => {
  const timeoutMs = opts.timeoutMs ?? 1_000
  const servers = await Promise.all(probeList.probes.map((probe) => probeServer(probe, map, timeoutMs, opts.resolveKey)))
  return { servers, suggestion: synthesizeSuggestion(servers), probedAt: new Date().toISOString() }
}
