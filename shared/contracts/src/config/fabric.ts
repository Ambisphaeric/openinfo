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
      { kind: Type.Literal('local'), name: Type.String(), runtime: LocalRuntime, model: Type.String(), measured: Measured },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal('http'),
        name: Type.String(),
        url: Type.String({ pattern: '^https?://' }),
        api: Type.Union(['openai-compat', 'native'].map((a) => Type.Literal(a))),
        model: Type.Optional(Type.String()),
        auth: EndpointAuth,
        measured: Measured,
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
