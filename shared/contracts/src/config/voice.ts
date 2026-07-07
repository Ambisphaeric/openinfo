import { Type, type Static } from '@sinclair/typebox'
import { Id } from '../common.js'

const Dial = Type.Integer({ minimum: 0, maximum: 10 })

export const Dials = Type.Object(
  {
    tone: Dial,        // 0 stern … 10 soft
    warmth: Dial,      // distinct from tone: soft-but-cool exists
    wit: Dial,
    charm: Dial,       // "low but not NO charm" = 2, not 0
    specificity: Dial, // 10 = cite-the-page
    brevity: Dial,
  },
  { $id: 'Dials', additionalProperties: false },
)
export type Dials = Static<typeof Dials>

export const Register = Type.Object(
  {
    id: Id,
    name: Type.String({ minLength: 1 }),
    dials: Dials,
    description: Type.Optional(Type.String()),
    builtin: Type.Optional(Type.Boolean()),
  },
  { $id: 'Register', additionalProperties: false },
)
export type Register = Static<typeof Register>

export const VoiceBinding = Type.Object(
  {
    scope: Type.Union(['global', 'mode', 'workspace', 'session'].map((s) => Type.Literal(s))),
    targetId: Type.Optional(Type.String({ minLength: 1, description: 'the mode/workspace/session; absent for global' })),
    registerId: Id,
    dialOverrides: Type.Optional(Type.Partial(Dials)),
  },
  { $id: 'VoiceBinding', additionalProperties: false, description: 'resolution: session > workspace > mode > global' },
)
export type VoiceBinding = Static<typeof VoiceBinding>

export const DriftChainStep = Type.Union(
  [
    Type.Object({ step: Type.Literal('glyph') }, { additionalProperties: false }),
    Type.Object(
      { step: Type.Literal('card'), offer: Type.Array(Id, { minItems: 2, maxItems: 2, description: 'ALWAYS two ways back' }) },
      { additionalProperties: false },
    ),
    Type.Object(
      { step: Type.Literal('tts'), if: Type.Optional(Type.Literal('audio_private')) },
      { additionalProperties: false },
    ),
  ],
  { $id: 'DriftChainStep' },
)
export type DriftChainStep = Static<typeof DriftChainStep>

export const DriftConfig = Type.Object(
  {
    threshold: Type.Integer({ minimum: 1, maximum: 10, description: 'dial-distance that counts as drift' }),
    sustainSec: Type.Integer({ minimum: 10 }),
    chain: Type.Array(DriftChainStep, { minItems: 1 }),
  },
  { $id: 'DriftConfig', additionalProperties: false },
)
export type DriftConfig = Static<typeof DriftConfig>
