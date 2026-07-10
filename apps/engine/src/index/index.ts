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
export { mergeCanon, type CanonGroup, type CanonResult } from './canon.js'
export { relevantNow, type RelevantNowOptions } from './relevant.js'
export * from './ingest/index.js'
