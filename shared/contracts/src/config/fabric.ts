import { Type, type Static } from '@sinclair/typebox'

export const LocalRuntime = Type.Union(
  ['mlx', 'ollama', 'llama.cpp', 'whisper.cpp', 'paddle', 'coreml'].map((r) => Type.Literal(r)),
  { $id: 'LocalRuntime' },
)
export type LocalRuntime = Static<typeof LocalRuntime>

const Measured = Type.Optional(
  Type.Object(
    {
      tokPerSec: Type.Optional(Type.Number({ minimum: 0 })),
      latencyMs: Type.Optional(Type.Number({ minimum: 0 })),
      measuredAt: Type.Optional(Type.String({ format: 'date-time' })),
    },
    { additionalProperties: false, description: 'MEASURED by tools/bench — never vendor claims' },
  ),
)

/**
 * An http endpoint's OPTIONAL credential reference. It names a key by `keyRef` — never the value.
 * The value lives in the engine-side secret store (chmod-600 v0, Keychain P7) and is injected only
 * at invoke time as `Authorization: Bearer <resolved>`. This shape never carries key material, so it
 * is safe in documents, GET /fabric responses, exports, and the fabric.changed event.
 */
const EndpointAuth = Type.Optional(
  Type.Object(
    { keyRef: Type.String({ minLength: 1, description: 'name of a secret in the engine secret store — never the value' }) },
    { additionalProperties: false },
  ),
)

export const Endpoint = Type.Union(
  [
    Type.Object(
      {
        kind: Type.Literal('local'),
        name: Type.String(),
        runtime: LocalRuntime,
        model: Type.String(),
        // A managed-local runtime may require a bearer even on localhost (omlx does), so the local
        // variant carries the SAME keyRef-by-reference auth the http variant does — resolved to a
        // bearer only at invoke/health time, never key material in the document. Optional: llama.cpp /
        // whisper.cpp the engine spawns need none.
        auth: EndpointAuth,
        measured: Measured,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal('http'),
        name: Type.String(),
        url: Type.String({ pattern: '^https?://' }),
        api: Type.Union(['openai-compat', 'native', 'paddle-serving'].map((a) => Type.Literal(a)), {
          description:
            "the endpoint's wire dialect. openai-compat: /v1/chat|audio (llm/stt/vlm). paddle-serving: a PaddleOCR-class HTTP runtime (POST /predict/ocr_system, {images:[base64]}) — the ocr slot's non-openai dialect, additive alongside whisper.cpp's non-/v1 precedent. native: reserved.",
        }),
        model: Type.Optional(Type.String()),
        auth: EndpointAuth,
        measured: Measured,
        // Per-endpoint request EXTRAS threaded verbatim into the openai-compat completions body when set,
        // omitted entirely when unset (zero behavior change for existing endpoints). NEVER auto-derived —
        // this is user config: some templates expose no thinking toggle (LFM2.5), others burn the token
        // budget reasoning unless told not to (qwen3.5-9b distill: chatTemplateKwargs {enable_thinking:false}).
        chatTemplateKwargs: Type.Optional(
          Type.Record(Type.String(), Type.Unknown(), {
            description: "passed as chat_template_kwargs on the completions request, e.g. {enable_thinking:false} to stop a reasoning model burning the token budget. Per-endpoint user config, never auto-set.",
          }),
        ),
        responseFormat: Type.Optional(
          Type.Unknown({ description: "passed as response_format on the completions request, e.g. {type:'json_object'} — verbatim, per-endpoint." }),
        ),
        // The user's EXPLICIT declaration that this endpoint's host is trusted to receive raw screen
        // frames (OCR/VLM image bytes). Default (absent/false): raw frames stay loopback-only — the
        // posture is unchanged. The flag is only honored for LAN-local hosts (private/link-local/mDNS);
        // a public host is denied regardless — trust widens loopback to the user's own network, never
        // to the internet. Per-endpoint user config, never auto-set.
        trustRawFrames: Type.Optional(
          Type.Boolean({
            description:
              'explicit user trust: this host may receive raw screen frames. Absent ⇒ raw frames stay loopback-only (the default). Honored only for LAN-local hosts — a public host is denied even when set.',
          }),
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal('cloud'),
        name: Type.String(),
        provider: Type.String(),
        auth: Type.Literal('keychain'),
        model: Type.Optional(Type.String()),
        measured: Measured,
      },
      { additionalProperties: false, description: 'enhancement, never dependency — offline is a guarantee' },
    ),
  ],
  { $id: 'Endpoint' },
)
export type Endpoint = Static<typeof Endpoint>

export const Fabric = Type.Object(
  {
    slots: Type.Object(
      {
        stt: Type.Array(Endpoint, { description: 'order is fallback; first healthy wins' }),
        tts: Type.Array(Endpoint),
        llm: Type.Array(Endpoint),
        vlm: Type.Array(Endpoint),
        ocr: Type.Array(Endpoint),
        embed: Type.Array(Endpoint),
        // The GUARD slot (#63) — the content/PII classifier invoked on every EGRESS-marked hop (a
        // llama-guard / gpt-oss-guard class model, or any OpenAI-compat classifier endpoint). A FIRST-CLASS
        // slot KIND, not an `llm.judge`-style naming convention (#88). OPTIONAL and append-only: a fabric
        // document predating #63 (and one that never egresses) validates without it. An empty/absent guard
        // slot on an egress hop is the fail-closed edge the GuardPolicy governs (strict ⇒ hold; default ⇒
        // acknowledge-or-hold). Not part of onboarding discovery classification in v0 — configured manually.
        guard: Type.Optional(Type.Array(Endpoint, { description: 'egress content/PII classifier (#63); order is fallback, first that answers wins' })),
      },
      { additionalProperties: false },
    ),
    memoryBudgetMb: Type.Optional(
      Type.Integer({ minimum: 512, description: 'concurrent slot residency (paddle + stt + tts + llm together) fits under this' }),
    ),
  },
  { $id: 'Fabric', additionalProperties: false },
)
export type Fabric = Static<typeof Fabric>

/**
 * A named, versioned, cloneable fabric configuration — a full slot→endpoints map the user can save,
 * clone, and switch between (LM Studio 8B today; a 27B on another host + a 4B OCR box + parakeet STT
 * tomorrow — any composition across hosts). `fabric` reuses the §8 Fabric shape verbatim (additive
 * reuse, not a fork). One profile is "active" at a time; ACTIVATING it makes its `fabric` the live
 * fabric that health/bench/invoke run against — so `GET`/`PUT /fabric` are simply the active-profile
 * view. Stored like every other config document (versioned in _meta.db; cloning is copying a doc).
 */
export const FabricProfile = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    version: Type.Integer({ minimum: 1, description: 'store-stamped, monotonic; every prior version is kept' }),
    fabric: Fabric,
    description: Type.Optional(Type.String()),
    createdAt: Type.Optional(Type.String({ format: 'date-time' })),
  },
  { $id: 'FabricProfile', additionalProperties: false },
)
export type FabricProfile = Static<typeof FabricProfile>
