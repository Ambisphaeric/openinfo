import { Type, type Static } from '@sinclair/typebox'
import { Fabric } from './fabric.js'

/**
 * Onboarding discovery contracts (ARCHITECTURE §8 — "Onboarding from first principles"). Discovery
 * turns the first setup screen from a form into a RESULT: it probes well-known local model servers,
 * enumerates what is actually loaded via `GET /v1/models`, and classifies each model into capability
 * slots by NAME. Two seeded, versioned DOCUMENTS carry the conventions (everything user-configurable is
 * a document): a probe list and a capability map. `GET /fabric/discover` returns a DiscoverResult — what
 * was found plus a synthesized one-endpoint-per-slot config-1 suggestion. No secrets involved (localhost).
 */

/** The six capability slots — the keys of Fabric.slots, named so classification/suggestion type-check. */
export const CapabilitySlot = Type.Union(
  ['stt', 'tts', 'llm', 'vlm', 'ocr', 'embed'].map((s) => Type.Literal(s)),
  { $id: 'CapabilitySlot' },
)
export type CapabilitySlot = Static<typeof CapabilitySlot>

/** One well-known local server to probe: a friendly name and its base URL (GET {url}/v1/models). */
const DiscoveryProbe = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    url: Type.String({ pattern: '^https?://' }),
  },
  { additionalProperties: false },
)

/**
 * The probe-list DOCUMENT: the well-known local servers discovery checks (LM Studio, Ollama, kokoro,
 * whisper servers — conventions, not truth). Seeded like the distill templates; versioned in _meta.db.
 * Editable as a document (a user on a nonstandard port edits the list); discovery reads whatever is stored.
 */
export const ProbeList = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    version: Type.Integer({ minimum: 1, description: 'store-stamped, monotonic; every prior version is kept' }),
    probes: Type.Array(DiscoveryProbe, { description: 'checked in parallel; order is the suggestion tie-break' }),
    description: Type.Optional(Type.String()),
  },
  { $id: 'ProbeList', additionalProperties: false },
)
export type ProbeList = Static<typeof ProbeList>

/**
 * One classification rule: if a model id contains ANY of `any` (case-insensitive substring), it is
 * classified into every slot in `slots`. A model may match several rules — its slots are the UNION
 * (a vision-language model maps to both vlm and llm). Rules are applied in order; `default` (llm) only
 * applies when NO rule matched — so non-llm slot membership is always explicit (the suggestion heuristic
 * relies on this).
 */
const CapabilityRule = Type.Object(
  {
    any: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: 'lowercased substrings; match = contains any' }),
    slots: Type.Array(CapabilitySlot, { minItems: 1 }),
  },
  { additionalProperties: false },
)

/**
 * The capability-map DOCUMENT: ordered name-pattern → slot rules, plus the default slots for a model
 * that matches nothing (llm). Versioned in _meta.db, seeded when absent, editable as a document.
 */
export const CapabilityMap = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    version: Type.Integer({ minimum: 1, description: 'store-stamped, monotonic; every prior version is kept' }),
    rules: Type.Array(CapabilityRule),
    default: Type.Array(CapabilitySlot, { minItems: 1, description: 'slots for a model that matched no rule (usually [llm])' }),
    description: Type.Optional(Type.String()),
  },
  { $id: 'CapabilityMap', additionalProperties: false },
)
export type CapabilityMap = Static<typeof CapabilityMap>

/** One model a server reported, with the slots its NAME classified it into (union of matched rules). */
const DiscoveredModel = Type.Object(
  {
    id: Type.String(),
    slots: Type.Array(CapabilitySlot),
  },
  { additionalProperties: false },
)

/**
 * One probed server: whether it returned a usable `/v1/models` list (`reachable`), the classified
 * models it reported, and — when not reachable — a short honest `error` (connection refused, timeout,
 * or an unexpected response shape). `reachable:false` means "not a usable model server right now", not
 * merely "TCP closed" (a port that answers but is not OpenAI-shaped is not usable for onboarding).
 */
const DiscoverServer = Type.Object(
  {
    name: Type.String(),
    url: Type.String(),
    reachable: Type.Boolean(),
    models: Type.Array(DiscoveredModel),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
)

/**
 * The result of `GET /fabric/discover`: every probed server (found or not) and a synthesized
 * `suggestion` — a config-1 Fabric with one best-available endpoint per slot (see ARCHITECTURE §8 for
 * the picking heuristic). The Get-Started lens renders the capability checklist from `servers` and, on
 * "Use this setup", writes `suggestion` as the config-1 profile via the existing profile routes.
 */
export const DiscoverResult = Type.Object(
  {
    servers: Type.Array(DiscoverServer),
    suggestion: Fabric,
    probedAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'DiscoverResult', additionalProperties: false },
)
export type DiscoverResult = Static<typeof DiscoverResult>

/**
 * The body of `POST /fabric/scan` — the founder's host-scan ("pick host, scan common ports, see if
 * missing api key, see if model list returns, list models on the call"). EXACTLY ONE of `url`/`host`:
 * an exact `url` probes that base URL; a bare `host` tries the probe-list DOCUMENT's ports against it
 * (the "common ports" are the same conventions discovery already carries — never a hardcoded list).
 * `keyRef` names a stored secret to send as a bearer — the REFERENCE, never a value (a 401 on the
 * first scan → the user wires a key, rescans, and the models appear). No caching: every call probes
 * fresh (this is hit infrequently, on user action).
 */
export const ScanRequest = Type.Object(
  {
    url: Type.Optional(Type.String({ pattern: '^https?://', description: 'probe exactly this base URL (GET {url}/v1/models)' })),
    host: Type.Optional(Type.String({ minLength: 1, description: "a bare hostname/IP — try the probe-list document's ports against it" })),
    keyRef: Type.Optional(Type.String({ minLength: 1, description: 'a secret REFERENCE to send as a bearer — never a value' })),
  },
  { $id: 'ScanRequest', additionalProperties: false, description: 'exactly one of url | host' },
)
export type ScanRequest = Static<typeof ScanRequest>

/**
 * A scan failure, classified with the SAME taxonomy the invoke/drain path uses (QueueFailure /
 * GenerateProbe classes) — an unreachable port, a timeout, a rejected key, an un-OpenAI-shaped reply —
 * plus the server's own message (or OS code) and the one-line troubleshoot hint. Value-free: an auth
 * failure's hint names a keyRef, never key material.
 */
const ScanError = Type.Object(
  {
    class: Type.Union(
      ['unreachable', 'timeout', 'auth', 'model-load', 'bad-response', 'reasoning-exhausted'].map((c) => Type.Literal(c)),
      { description: 'the classified failure — the same classes the drain and generate probe report' },
    ),
    message: Type.Optional(Type.String({ description: "the server's own error text or the OS code (ECONNREFUSED), captured verbatim" })),
    hint: Type.String({ description: 'the one-line "what to do about it" step' }),
  },
  { additionalProperties: false },
)

/**
 * ONE base URL the scan probed: whether it returned a usable `/v1/models` list (`reachable`), whether
 * it demanded a key (`authRequired` — a 401/403 answer IS a responding server, so reachable stays
 * true), the classified models it reported (the capability map, same as discovery), and the classified
 * `error` when it did not answer usably. `models[].slots` is what makes the editor's dropdown a
 * CAPABILITIES list, not just names.
 */
const ScannedHost = Type.Object(
  {
    url: Type.String({ description: 'the base URL probed' }),
    reachable: Type.Boolean({ description: 'the server answered /v1/models (even if it demanded a key)' }),
    authRequired: Type.Boolean({ description: 'the server answered 401/403 — it wants a key (wire a keyRef and rescan)' }),
    models: Type.Array(DiscoveredModel),
    error: Type.Optional(ScanError),
  },
  { additionalProperties: false },
)

/**
 * The result of `POST /fabric/scan`: one entry per base URL probed — a single entry for an exact-url
 * scan, one per probe-list port for a bare-host scan. Never cached; `scannedAt` stamps the call.
 */
export const ScanResult = Type.Object(
  {
    hosts: Type.Array(ScannedHost),
    scannedAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'ScanResult', additionalProperties: false },
)
export type ScanResult = Static<typeof ScanResult>
