import './formats.js'
export * from './common.js'
export * from './records/moment.js'
export * from './records/entity.js'
export * from './records/distillate.js'
export * from './records/screen.js'
export * from './records/ocr.js'
export * from './records/draft.js'
export * from './records/session.js'
export * from './records/workspace.js'
export * from './records/pin.js'
export * from './records/pinChunk.js'
export * from './records/teach.js'
export * from './records/commitment.js'
export * from './records/signal.js'
export * from './records/fieldValue.js'
export * from './config/voice.js'
export * from './config/surface.js'
export * from './config/mode.js'
export * from './config/promptTemplate.js'
export * from './config/fabric.js'
export * from './config/discovery.js'
export * from './config/local.js'
export * from './config/flag.js'
export * from './config/hints.js'
export * from './config/workflow.js'
export * from './config/invoke.js'
export * from './config/todo.js'
export * from './api/routes.js'
export * from './api/events.js'
export * from './api/payloads.js'

import { InvokeUsage } from './common.js'
import { Moment, MomentKind } from './records/moment.js'
import { Entity, Sighting, HeardAs, EntityOverride, EntityAmbiguity, EntityExternal } from './records/entity.js'
import { Distillate } from './records/distillate.js'
import { ScreenFrameMeta } from './records/screen.js'
import { OcrResult } from './records/ocr.js'
import { Draft } from './records/draft.js'
import { Session } from './records/session.js'
import { Workspace } from './records/workspace.js'
import { Pin } from './records/pin.js'
import { PinChunk } from './records/pinChunk.js'
import { TeachSignal, TeachSignalKind } from './records/teach.js'
import { Commitment, Watcher } from './records/commitment.js'
import { ItemSignal, ItemSignalKind } from './records/signal.js'
import { FieldValue, FieldValueProvenance, JudgeReview } from './records/fieldValue.js'
import { Dials, Register, VoiceBinding, DriftChainStep, DriftConfig } from './config/voice.js'
import { Surface, Block, BlockQuery, Action, BlockTypeName } from './config/surface.js'
import { Mode } from './config/mode.js'
import { PromptTemplate, FastFieldBinding } from './config/promptTemplate.js'
import { Fabric, Endpoint, LocalRuntime, FabricProfile } from './config/fabric.js'
import { CapabilitySlot, ProbeList, CapabilityMap, DiscoverResult, ScanRequest, ScanResult } from './config/discovery.js'
import { StarterModel, StarterModels } from './config/local.js'
import { Flag } from './config/flag.js'
import { AttributionPattern, WorkspaceHints } from './config/hints.js'
import { WorkflowSpec, WorkflowStep, WorkflowStepKind, StepGate } from './config/workflow.js'
import { OcrInvokeParams, VlmInvokeParams } from './config/invoke.js'
import { TodoList, TodoItem, TodoProvenance } from './config/todo.js'
import { Health, JsonSchema, CaptureSource, CaptureChunk, FocusSignal, CalendarSignal, Ack, TranscriptUpdate, QueueStatus, QueueFailure, QueueKind, QueueKindDepth, BacklogEta, OverflowState, ScreenStatus, RelevantEntity, HintCandidate, QueryResult, StartSessionRequest, RerouteRequest, CloneProfileRequest, SecretRef, SecretValue, EndpointProbe, GenerateProbe, LocalModelStatus, LocalDownloadRequest } from './api/payloads.js'

/** Every schema, by $id — the registry schema-gen, tests, and the engine's /contracts route walk. */
export const AllSchemas = {
  InvokeUsage,
  Moment, MomentKind, Entity, Sighting, HeardAs, EntityOverride, EntityAmbiguity, EntityExternal, Distillate, ScreenFrameMeta, OcrResult, Draft, Session, Workspace, Pin, PinChunk, TeachSignal, TeachSignalKind, Commitment, Watcher, ItemSignal, ItemSignalKind, FieldValue, FieldValueProvenance, JudgeReview,
  Dials, Register, VoiceBinding, DriftChainStep, DriftConfig,
  Surface, Block, BlockQuery, Action, BlockTypeName,
  Mode, PromptTemplate, FastFieldBinding, Fabric, Endpoint, LocalRuntime, FabricProfile,
  CapabilitySlot, ProbeList, CapabilityMap, DiscoverResult, ScanRequest, ScanResult, StarterModel, StarterModels, Flag, AttributionPattern, WorkspaceHints,
  WorkflowSpec, WorkflowStep, WorkflowStepKind, StepGate, OcrInvokeParams, VlmInvokeParams,
  TodoList, TodoItem, TodoProvenance,
  Health, JsonSchema, CaptureSource, CaptureChunk, FocusSignal, CalendarSignal, Ack, TranscriptUpdate, QueueStatus, QueueFailure, QueueKind, QueueKindDepth, BacklogEta, OverflowState, ScreenStatus, RelevantEntity, HintCandidate, QueryResult, StartSessionRequest, RerouteRequest,
  CloneProfileRequest, SecretRef, SecretValue, EndpointProbe, GenerateProbe, LocalModelStatus, LocalDownloadRequest,
} as const
