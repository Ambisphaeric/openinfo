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
