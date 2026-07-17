export {
  extractEntities,
  entityMentioned,
  normalizeName,
  type EntityCandidate,
  type ExtractEntitiesDeps,
  type ExtractEntitiesInput,
  type ExtractEntitiesResult,
} from './extract.js'
export { rankEntities, scoreEntity, DEFAULT_RANK_CONFIG, type RankConfig, type RankedEntity } from './rank.js'
export {
  levenshtein,
  editSimilarity,
  doubleMetaphone,
  phoneticEqual,
  nameSimilarity,
  normalizeForm,
} from './phonetic.js'
export {
  resolveEntity,
  scoreCandidate,
  phoneticFuzzy,
  corpusPrior,
  DEFAULT_RESOLVER_CONFIG,
  type Resolution,
  type ResolutionBand,
  type ResolutionComponents,
  type ResolutionSignals,
  type ResolverConfig,
  type HeardMention,
  type ScoredCandidate,
} from './resolve.js'
export {
  correlate,
  correlateWindow,
  overlapsWindow,
  ocrForms,
  ocrTextForms,
  DEFAULT_CORRELATION_CONFIG,
  type CorrelationConfig,
  type Correlatable,
  type CorrelationResult,
  type WindowCorrelation,
  type WindowCorrelationInput,
} from './correlate.js'
export {
  buildContextPackets,
  DEFAULT_PACKET_BUILDER_CONFIG,
  type PacketBuilderConfig,
  type PacketBuildInput,
  type PacketBuildResult,
} from './packets.js'
export {
  materializeContextPackets,
  PacketBuildLog,
  type PacketBuildAttempt,
  type PacketBuildTrigger,
  type MaterializeScope,
  type MaterializeDeps,
  type MaterializeOutcome,
} from './produce-packets.js'
export {
  assembleSummaries,
  buildSummary,
  type SummaryInput,
  type SummaryLevelConfig,
  type SummaryPlanItem,
  type UnchangedSummary,
  type AssembleSummariesInput,
  type AssembleSummariesResult,
  type SummaryProse,
} from './summaries.js'
export {
  materializeSummaries,
  createFabricSummarizer,
  SummaryBuildLog,
  SUMMARY_LEVEL_ORDER,
  LIVE_SUMMARY_LEVELS,
  type Summarizer,
  type SummarizeRequest,
  type SummaryBuildAttempt,
  type SummaryBuildTrigger,
  type MaterializeSummariesScope,
  type MaterializeSummariesDeps,
  type MaterializeSummariesOutcome,
  type FabricSummarizerDeps,
  CROSS_SESSION_SUMMARY_LEVELS,
} from './produce-summaries.js'
export {
  walkSummaryTrace,
  type SummaryTrace,
  type SummaryTraceNode,
  type TraceRef,
  type TraceSourceStatus,
} from './summaries-trace.js'
export { mergeCanon, type CanonGroup, type CanonResult } from './canon.js'
export { relevantNow, type RelevantNowOptions } from './relevant.js'
export * from './ingest/index.js'
