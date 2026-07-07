import './formats.js'
export * from './common.js'
export * from './records/moment.js'
export * from './records/entity.js'
export * from './records/distillate.js'
export * from './records/draft.js'
export * from './records/session.js'
export * from './records/workspace.js'
export * from './records/pin.js'
export * from './records/commitment.js'
export * from './config/voice.js'
export * from './config/surface.js'
export * from './config/mode.js'
export * from './config/promptTemplate.js'
export * from './config/fabric.js'
export * from './config/flag.js'
export * from './api/routes.js'
export * from './api/events.js'
export * from './api/payloads.js'

import { Moment, MomentKind } from './records/moment.js'
import { Entity } from './records/entity.js'
import { Distillate } from './records/distillate.js'
import { Draft } from './records/draft.js'
import { Session } from './records/session.js'
import { Workspace } from './records/workspace.js'
import { Pin } from './records/pin.js'
import { Commitment, Watcher } from './records/commitment.js'
import { Dials, Register, VoiceBinding, DriftChainStep, DriftConfig } from './config/voice.js'
import { Surface, Block, BlockQuery, Action, BlockTypeName } from './config/surface.js'
import { Mode } from './config/mode.js'
import { PromptTemplate } from './config/promptTemplate.js'
import { Fabric, Endpoint, LocalRuntime } from './config/fabric.js'
import { Flag } from './config/flag.js'
import { Health, JsonSchema, CaptureSource, CaptureChunk, Ack, QueueStatus, RelevantEntity, QueryResult, StartSessionRequest } from './api/payloads.js'

/** Every schema, by $id — the registry schema-gen, tests, and the engine's /contracts route walk. */
export const AllSchemas = {
  Moment, MomentKind, Entity, Distillate, Draft, Session, Workspace, Pin, Commitment, Watcher,
  Dials, Register, VoiceBinding, DriftChainStep, DriftConfig,
  Surface, Block, BlockQuery, Action, BlockTypeName,
  Mode, PromptTemplate, Fabric, Endpoint, LocalRuntime, Flag,
  Health, JsonSchema, CaptureSource, CaptureChunk, Ack, QueueStatus, RelevantEntity, QueryResult, StartSessionRequest,
} as const
