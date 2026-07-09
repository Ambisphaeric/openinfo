export { benchFabric, benchHttpEndpoint } from './bench.js'
export { FabricDocuments, defaultFabric } from './document.js'
export { FabricProfiles } from './profiles.js'
export { seededProfiles } from './defaults.js'
export { FileSecretStore, type SecretStore, type SecretResolver } from './secrets.js'
export { checkEndpoint, type EndpointHealth } from './health.js'
export { DiscoveryDocuments } from './discovery-documents.js'
export { seededProbeList, seededCapabilityMap } from './discovery-defaults.js'
export { discoverFabric, classifyModel, synthesizeSuggestion, listLoadedModels, loadedModelSuggestion, type DiscoverOptions } from './discover.js'
export { scanHosts, hostTargets, type ScanOptions } from './scan.js'
export { invokeLlm, type LlmMessage, type LlmResult, type InvokeOptions } from './invoke.js'
export { invokeStt, type SttAudio, type SttResult, type SttOptions } from './invoke.js'
export {
  selectSttAdapter,
  STT_ADAPTERS,
  type SttAdapter,
  type SttFlavor,
  type TranscriptResult,
  type TranscriptSegment,
} from './stt-adapters.js'
export { invokeVlm, invokeOcr, type ScreenTextResult, type ScreenBlock, type ScreenInvokeOptions } from './invoke.js'
export {
  InvokeError,
  AggregateInvokeError,
  describeInvokeFailure,
  classifyFetchError,
  classifyHttpResponse,
  extractServerMessage,
  type InvokeErrorClass,
  type ClassifiedFailure,
  type InvokeCtx,
} from './invoke-error.js'
export { toQueueFailure, enrichFailureHint } from './diagnose.js'
export {
  LocalRuntimeManager,
  findRuntimeBinary,
  RUNTIME_SPECS,
  type LocalEndpoint,
  type RuntimeSpec,
  type LocalRuntimeSpecs,
  type SpawnState,
} from './endpoints/local.js'
export { LocalModelStore, downloadModel, type DownloadProgress } from './local-models.js'
export { StarterModelsDocuments } from './local-documents.js'
export { seededStarterModels } from './local-defaults.js'
