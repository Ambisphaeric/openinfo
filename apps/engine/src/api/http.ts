import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import { AllSchemas, Routes, STT_SEGMENT_SCHEMA_VERSION, type Ack, type BlockQuery, type Bundle, type CaptureChunk, type ChatHistory, type ChatRequest, type ChatScreenshot, type CloneProfileRequest, type Draft, type Endpoint, type EndpointProbe, type Entity, type Fabric, type GenerateProbe, type FabricProfile, type Flag, type GuardPolicy, type ItemSignal, type LocalDownloadRequest, type Mode, type Moment, type OverflowState, type Pin, type QueueFailure, type QueueStatus, type PinChunk, type PromptTemplate, type Register, type RelevantEntity, type RerouteRequest, type EntityCorrection, type EntityOverride, type ScanRequest, type ScreenCaptureObservation, type SecretValue, type SenseLaneSnapshot, type Session, type StartSessionRequest, type SttSlotEndpoint, type Surface, type TodoList, type WorkflowSpec, type WorkspaceHints } from '@openinfo/contracts'
import { Actor, ActDocuments, TodoDocuments, TaskExtractor } from '../act/index.js'
import { EventBus, type EngineEvents } from '../bus/index.js'
import { DistillDocuments, Distiller, DistillCadence, DEFAULT_DISTILL_CADENCE_MS, FieldValueStore, FastFieldScheduler, JudgeScheduler, transcribeChunks, buildTranscriptUpdates, TranscriptRing, EchoDedupe, echoDedupeEnabled, ECHO_DEDUPE_WINDOW_MS, type DistillOptions } from '../distill/index.js'
import { GuardDocuments, GuardHoldStore } from '../guard/index.js'
import { DiscoveryDocuments, FabricDocuments, FileSecretStore, LocalModelStore, LocalRuntimeManager, StarterModelsDocuments, checkEndpoint, discoverFabric, invokeLlm, invokeOcr, invokeStt, describeInvokeFailure, enrichFailureHint, resolveEgress, scanHosts, toQueueFailure, DEFAULT_NO_SPEECH_THRESHOLD, type SecretStore } from '../fabric/index.js'
import { relevantNow, ingestPin, defaultFetchers } from '../index/index.js'
import { TeachStore, deriveHintCandidates, captureEntityCorrection, type HintCandidate } from '../teach/index.js'
import { Attributor, HintsDocuments, extractFocusSignals, rerouteSession } from '../route/index.js'
import { isFlagEnabled } from '../flags/read.js'
import { CaptureQueue, DEFAULT_MAX_AGE_MINUTES } from '../queue/spool.js'
import { WorkspaceRegistry, resolveSecretsPath } from '../store/index.js'
import { WorkflowDocuments, WorkflowExecutor, type ScreenRunner } from '../workflow/index.js'
import { BundleDocuments, DEFAULT_BUNDLE_ID } from '../bundles/index.js'
import { PresetDocuments } from '../presets/index.js'
import { SurfaceDocuments, compileQuery, resolveQueryScope, ItemSignalStore, renderSettingsPage, sectionById, defaultSectionId, renderSurfaceEditorPage, defaultHudSurface, evaluateSenseGates, requiredScreenSenseSlots, buildLedger, buildTrace, buildTraceInputs, type TraceData, type SetupData, type QuerySources } from '../surfaces/index.js'
import type { EndpointHealth } from '../fabric/health.js'
import { handleScreen, getScreenProcessor, latchScreenRecognitionOwner, screenRecognitionOwner } from '../screen/index.js'
import { SenseLaneTracker, senseLaneGateState } from '../senses/index.js'
import { VoiceDocuments } from '../voice/index.js'
import { ensureDefaultFlags } from './defaults.js'
import { schemaByName, validationErrors } from './validation.js'
import { runChat, BUNDLE_PROMPT, type ChatDeps } from './chat.js'
import { DEFAULT_CONTEXT_SOURCES } from './context-assembly.js'
import { readEngineVersion, readEngineBuild } from './version.js'
import { EventSocketHub } from './ws.js'
import { isPublicHealthRequest, type ControlPlaneAccess } from './control-plane.js'
import { BrowserAuthSessions } from './browser-auth.js'

// Read ONCE at module load ("at startup") — the engine's own version + an optional build id, echoed on
// every /health so the client's version handshake needs no extra route. Static for the process lifetime.
const ENGINE_VERSION = readEngineVersion()
const ENGINE_BUILD = readEngineBuild()

export interface EngineApp {
  server: ReturnType<typeof createServer>
  bus: EventBus<EngineEvents>
  store: WorkspaceRegistry
  /** The egress guard held-hops store (#63) — exposed so a suspended hop can be seeded/inspected (tests,
   * and any embedder that wants the durable audit of blocks). */
  guardHolds: GuardHoldStore
  /** The context-switch router (route.detect). Exposed so the engine-side calendar collector, mounted
   * POST-createEngineApp by startCalendarCollector (P4C), feeds the SAME detector buffer the focus drain
   * feeds — mirroring how wireScreenOcr reaches the screen processor from main.ts. */
  attributor: Attributor
  /** The distill/LLM track's spool (#115). The STT track (the primary `queue`) transcribes and writes the
   * text stream here; this queue drains it on its OWN loop, so a parked LLM never blocks transcription.
   * Exposed so a test / embedder can inspect the LLM-track backlog independently of the audio backlog. */
  textQueue: CaptureQueue
  /** Process-local metadata-only read model for mic, system-audio, and screen. It deliberately does not
   * hydrate from persisted live sessions, so a fresh launch remains stopped until a lifecycle event. */
  senseLanes: SenseLaneTracker
  /** True once the first live transcript has been published this process (#115) — the cold-boot gate the
   * calendar collector reads so it holds its first Calendar.app sample until a transcript has landed. */
  firstTranscriptSeen: () => boolean
  close: () => Promise<void>
}

export interface EngineOptions {
  /** Required for every listening engine. There is no implicit unauthenticated product policy. */
  controlPlane: ControlPlaneAccess
  dataRoot?: string
  dataDir?: string
  onCapture?: (chunk: CaptureChunk) => void
  log?: (message: string) => void
  /**
   * Override the local-runtime manager wiring (tier zero) — a testability seam so an e2e can spawn a
   * FAKE runtime binary instead of a real llama.cpp/whisper.cpp. Production leaves this unset (real
   * binary discovery on PATH + Homebrew locations).
   */
  localRuntime?: {
    findBinary?: (spec: import('../fabric/index.js').RuntimeSpec) => string | undefined
    freePort?: () => Promise<number>
    specs?: import('../fabric/index.js').LocalRuntimeSpecs
    readyTimeoutMs?: number
  }
  /** Deterministic clock/token seam for browser-ticket HTTP tests. Production leaves this unset. */
  browserAuth?: BrowserAuthSessions
}

interface HandlerContext {
  bus: EventBus<EngineEvents>
  fabric: FabricDocuments
  discovery: DiscoveryDocuments
  secrets: SecretStore
  voice: VoiceDocuments
  surfaces: SurfaceDocuments
  distill: DistillDocuments
  guardDocs: GuardDocuments
  guardHolds: GuardHoldStore
  todos: TodoDocuments
  workflow: WorkflowDocuments
  bundles: BundleDocuments
  /** The five context presets + the active-preset resolver (pill P2). Presets live in the prompt-template
   * substrate (edited over /templates); this exposes the preset-shaped reads + the active-preset seam. */
  presets: PresetDocuments
  hints: HintsDocuments
  /** The STT track's spool — the capture backlog (#115). */
  queue: CaptureQueue
  /** The distill/LLM track's spool (#115) — folded into the surfaced status so a distill failure still shows. */
  textQueue: CaptureQueue
  senseLanes: SenseLaneTracker
  /** In-memory ring of recent ephemeral transcript updates (#101) — the diagnostics inspector's honest v0 source. */
  transcripts: TranscriptRing
  /** The durable per-field latest values (#61) — read by the Audit ledger + Trace sections (#116). */
  fieldValues: FieldValueStore
  store: WorkspaceRegistry
  runtime: LocalRuntimeManager
  models: LocalModelStore
  controlPlane: ControlPlaneAccess
  browserAuth: BrowserAuthSessions
  onCapture?: (chunk: CaptureChunk) => void
  log: (message: string) => void
}

/** Publish only tracker-owned metadata rows. Keeping this helper narrow prevents raw capture/transcript
 * payloads from ever being passed to the public sense event by an integration call site. */
const publishSenseLaneUpdates = async (
  bus: EventBus<EngineEvents>,
  updates: SenseLaneSnapshot | readonly SenseLaneSnapshot[] | undefined,
): Promise<void> => {
  if (updates === undefined) return
  const rows = Array.isArray(updates) ? updates : [updates]
  for (const row of rows) await bus.publish('sense.lane.updated', row)
}

export function createEngineApp(options: EngineOptions): EngineApp {
  const log = options.log ?? console.log
  const store = new WorkspaceRegistry(options.dataRoot ?? options.dataDir)
  const bus = new EventBus<EngineEvents>()
  // Runtime truth only: the tracker intentionally starts empty and never adopts store.liveSession(). A
  // persisted unended session from a prior process therefore cannot turn a fresh launch into "waiting" or
  // restart capture; only a lifecycle event observed during this process opens its three lanes.
  const senseLanes = new SenseLaneTracker()
  const browserAuth = options.browserAuth ?? new BrowserAuthSessions()
  const socketPolicy = options.controlPlane.eventSocketPolicy()
  const ws = new EventSocketHub({
    ...socketPolicy,
    authenticateBrowserSession: (cookie) => browserAuth.authenticateCookie(cookie),
  })
  const fabric = new FabricDocuments(store)
  // Engine-side secret store: v0 chmod-600 file in its own secrets/ dir (see resolveSecretsPath),
  // never in a DB or workspace export. Values are injected ONLY at invoke time; the API is write-only.
  const secrets: SecretStore = new FileSecretStore(resolveSecretsPath(store.dataDir))
  const resolveKey = (ref: string): string | undefined => secrets.resolve(ref)
  const voice = new VoiceDocuments(store)
  const distillDocs = new DistillDocuments(store)
  // Egress guard (#63): the verdict→behavior policy document + the held-hops audit store. The guard runs
  // on egress-marked hops during distill (gated by the guard.egress flag); a suspended hop lands in
  // guardHolds with its verdict (span descriptors, never the raw value) and surfaces in the audit ledger.
  const guardDocs = new GuardDocuments(store)
  const guardHolds = new GuardHoldStore(store)
  const actDocs = new ActDocuments(store)
  const todoDocs = new TodoDocuments(store)
  const hintsDocs = new HintsDocuments(store)
  const surfaces = new SurfaceDocuments(store)
  const discovery = new DiscoveryDocuments(store)
  const starterModels = new StarterModelsDocuments(store)
  const workflow = new WorkflowDocuments(store)
  // App bundles (bundle-as-runtime-object): the Standard App is a DOCUMENT bundling its faces (surface
  // refs) + workflow/template refs + flag overlay + chat context-assembly plan — served like /workflows.
  const bundles = new BundleDocuments(store)
  // Context presets (pill P2): the glass-parity five, seeded as preset-kind prompt-template documents.
  // Editable over the existing /templates routes; this resolver backs the /active-preset selection routes,
  // the distiller's injection, and the chat context-assembly path's (P1) active-preset read.
  const presets = new PresetDocuments(store)
  // Tier zero (ARCHITECTURE §8, slice c): the engine downloads + spawns managed local runtimes.
  // The model store maps a `local` endpoint's model ref to its on-disk path; the runtime manager
  // spawns llama.cpp/whisper.cpp on demand and is threaded into invoke/health so local endpoints
  // ride the SAME seams as http ones. Models live under the data root models/ dir.
  // The model store shares the runtime-discovery seam with the manager below: the SAME injected resolver
  // that decides what spawns also decides what the Get-Started lens reports as available, so an e2e's
  // injected fake governs availability with no real PATH lookup for llama-server leaking through.
  const models = new LocalModelStore(join(store.dataDir, 'models'), () => starterModels.models(), {
    ...(options.localRuntime?.findBinary ? { findBinary: options.localRuntime.findBinary } : {}),
    ...(options.localRuntime?.specs ? { specs: options.localRuntime.specs } : {}),
  })
  const runtime = new LocalRuntimeManager({
    modelPath: (endpoint) => models.resolvePath(endpoint),
    log,
    ...(options.localRuntime?.findBinary ? { findBinary: options.localRuntime.findBinary } : {}),
    ...(options.localRuntime?.freePort ? { freePort: options.localRuntime.freePort } : {}),
    ...(options.localRuntime?.specs ? { specs: options.localRuntime.specs } : {}),
    ...(options.localRuntime?.readyTimeoutMs !== undefined ? { readyTimeoutMs: options.localRuntime.readyTimeoutMs } : {}),
  })
  ensureDefaultFlags(store)
  fabric.ensureDefaults()
  guardDocs.ensureDefaults()
  voice.ensureDefaults()
  distillDocs.ensureDefaults()
  actDocs.ensureDefaults()
  hintsDocs.ensureDefaults()
  surfaces.ensureDefaults()
  discovery.ensureDefaults()
  starterModels.ensureDefaults()
  workflow.ensureDefaults()
  bundles.ensureDefaults()
  presets.ensureDefaults()

  const distiller = new Distiller({
    store,
    voice,
    fabric,
    docs: distillDocs,
    presets,
    resolveKey,
    runtimeManager: runtime,
    guardDocs,
    guardHolds,
    guardEnabled: () => isFlagEnabled(store, 'guard.egress'),
    publishHold: (hold) => bus.publish('guard.hold.updated', hold),
    publish: (distillate) => bus.publish('distillate.updated', distillate),
    publishMoment: (moment) => bus.publish('moment.created', moment),
    publishEntity: (entity) => bus.publish('entity.updated', entity),
    log,
  })
  // Fast-field fan-out (#61): the substrate that grows surface fields from prompt documents. It rides
  // the SAME accumulation seam the distiller does (the cadence-released batch, below), reading every
  // fast-field prompt document (distillDocs.fieldTemplates), running the triggered ones CONCURRENTLY
  // against the llm slot, then publishing field.updated + persisting each field's latest value. Gated by
  // distill.fields (default OFF) — a new engine-processing behavior gets its own flag (CONTRIBUTING rule
  // 3). It EXTENDS distill (does not replace it): the distiller still produces the monolithic distillate.
  const fieldValues = new FieldValueStore(store)
  const fieldScheduler = new FastFieldScheduler({
    store,
    voice,
    fabric,
    docs: distillDocs,
    values: fieldValues,
    resolveKey,
    runtimeManager: runtime,
    publish: (value) => bus.publish('field.updated', value),
    log,
  })
  // Judge stage (#62): the dual-input review that lifts fast fields off `provisional`. It reads the SAME
  // released batch the fast fan-out did (so it sees the SAME source), but at a LOWER cadence — its own
  // accumulation buffer (judgeCadence below) releases a wider window, decoupled from the fast tier's per-
  // batch fan-out. It reviews each judge prompt document's fast-result set against that source window and
  // confirms/corrects/flags in place, republishing field.updated with the overrule provenance. Gated by
  // distill.judge (default OFF) AND tier-gated on fabric contents — with no judge-capable endpoint the
  // pass is a logged no-op and fields stay provisional (honest degradation, never an error).
  const judgeScheduler = new JudgeScheduler({
    store,
    fabric,
    docs: distillDocs,
    values: fieldValues,
    resolveKey,
    runtimeManager: runtime,
    publish: (value) => bus.publish('field.updated', value),
    // Orientation pass (#131): a judge document producing a session-nature classification lands a
    // SessionAnnotation and emits orientation.updated — the trigger source a contextual sidebar (#134)
    // subscribes to. Disposition defaults to 'annotate' (the gate-ready seam; a future config flips to 'gate').
    publishAnnotation: (annotation) => bus.publish('orientation.updated', annotation),
    log,
  })
  // Seam (see PHASE2-NOTES): distill rides the queue drain, gated on distill.enabled (OFF by
  // default). Flag off → the drain stays the Phase 1 no-op GC; on → each drained file distills.
  // Moments extraction (distill.moments) and entity indexing (distill.index) are further opt-ins
  // and require distill.enabled — all three flags are read per-drain, so flipping any of them over
  // the API takes effect without a restart. Moment.refs linking needs BOTH extras on: with
  // distill.index alone entities still index, but there are no same-pass moments to link.
  // Context-switch detection (route.detect, OFF by default — a flagged engine-processing behavior,
  // CONTRIBUTING rule 3). The router holds a rolling buffer of focus signals and auto-starts/switches
  // sessions into the workspace whose hints sustain dominance (see route/attribute.ts). It runs
  // INDEPENDENTLY of distill.enabled: focus is context for routing, not content to distill.
  const attributor = new Attributor({
    store,
    hints: hintsDocs,
    modeId: () => distillDocs.mode().id,
    publish: (event, session) => bus.publish(event, session),
    log,
  })
  // The pre-distill transcription stage (distill.transcribe): rewrites base64 audio/* chunks while
  // preserving their physical mic/system-audio lane to utf8 text BEFORE the distiller's utf8 filter;
  // non-audio chunks pass through. A transcription transport failure propagates → the drain re-queues
  // the file (retry-at-idle), exactly like distill/moments. Shared verbatim by the legacy drain path
  // and the workflow executor's transcribe seam, so the two are byte-for-byte identical.
  // Transcript fast-path (#58): as each audio chunk transcribes we collect its id, sequence, session,
  // physical source, text, capture time, and real processing time, then publish EPHEMERAL
  // transcript.updated events — one per contiguous (session, source) run in the
  // drain — the instant transcription succeeds, BEFORE the throttled distill pass. This is the live
  // feed the HUD renders within one WS hop; it is never persisted (durable records still come only from
  // distill). Shared by both the legacy drain and the executor's transcribe seam, so both paths emit it.
  // Silence filter threshold (#69): near-silent windows hallucinate stock phrases; transcribeChunks drops
  // segments whose no_speech_prob is at/above this bar BEFORE they enter the distill accumulator. Default
  // is DEFAULT_NO_SPEECH_THRESHOLD (0.8); OPENINFO_NO_SPEECH_THRESHOLD overrides it (a finite 0..1 value),
  // so the filter is tunable without a rebuild. Resolved once at wiring time.
  const noSpeechThreshold = ((): number => {
    const raw = Number(process.env['OPENINFO_NO_SPEECH_THRESHOLD'])
    return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : DEFAULT_NO_SPEECH_THRESHOLD
  })()
  // Age-shed horizon (#70): the queue drops backlog older than this many minutes so a live session renders
  // the present. Default DEFAULT_MAX_AGE_MINUTES (10); OPENINFO_QUEUE_MAX_AGE_MINUTES overrides it with a
  // finite >= 0 value (0 disables shedding). Resolved once at wiring time — tunable without a rebuild.
  const queueMaxAgeMinutes = ((): number => {
    const raw = Number(process.env['OPENINFO_QUEUE_MAX_AGE_MINUTES'])
    return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MAX_AGE_MINUTES
  })()
  // Echo-dedupe (sys-audio arc, follow-up to #142): with the CoreAudio tap a speakers-on call yields the
  // SAME words on BOTH streams — the tap carries the clean far side while the physical mic picks up
  // speaker bleed, so the live transcript shows near-duplicate physical-lane lines (the mic copy often
  // garbled). Freshly-transcribed system-audio fragments feed a per-session rolling buffer; a mic
  // fragment that near-duplicates a buffered system fragment is dropped inside runTranscribe, BEFORE the
  // text queue persists it and before the transcript.updated fan-out. OPENINFO_ECHO_DEDUPE=0 disables
  // (default ON — a no-op with no system stream). Resolved once at wiring time like the knobs above.
  const echoDedupe = echoDedupeEnabled(process.env) ? new EchoDedupe() : undefined
  const runTranscribe = async (chunks: readonly CaptureChunk[]): Promise<CaptureChunk[]> => {
    const segments: {
      id: string
      sourceChunkId: string
      sessionId: string
      source: CaptureChunk['source']
      sequence: number
      text: string
      capturedAt: string
      processedAt: string
    }[] = []
    // Skipped-as-silence accounting (#69): count windows fully filtered to nothing and total segments
    // dropped across the drain, so filtered content is VISIBLE in a log line rather than silently vanished.
    let skippedWindows = 0
    let droppedSegments = 0
    // #116: one correlation id per transcribe pass — every segment this drain transcribes shares it.
    const transcribeSpanId = randomUUID()
    const ready = await transcribeChunks(chunks, {
      invoke: (audio, opts) => invokeStt(fabric.load(), audio, { ...opts, resolveKey, runtimeManager: runtime }),
      onTranscribed: (chunk, text, processedAt, stt) => {
        segments.push({
          id: chunk.id,
          sourceChunkId: chunk.id,
          sessionId: chunk.sessionId,
          source: chunk.source,
          sequence: chunk.sequence,
          text,
          capturedAt: chunk.capturedAt,
          processedAt,
        })
        // #116: persist per-segment STT provenance — the ROOT a pipeline trace walks from (closes the
        // disclosed #65 gap). Recorded for EVERY successful transcription invoke, including chunks the
        // echo-dedupe below later drops (the invoke happened; the audit never loses it). Carries the chunk
        // id / endpoint / measured timing — never the transcript text (raw transcript stays ephemeral).
        // Best-effort: a persistence failure must not sink the drain (chunks stay durable in the spool).
        try {
          store.saveSttSegment({
            id: randomUUID(),
            workspaceId: chunk.workspaceId,
            sessionId: chunk.sessionId,
            chunkId: chunk.id,
            spanId: transcribeSpanId,
            source: chunk.source,
            capturedAt: chunk.capturedAt,
            processedAt,
            textChars: text.length,
            provenance: {
              slot: 'stt',
              endpoint: stt.endpoint,
              durationMs: stt.durationMs,
              ...(stt.model !== undefined ? { model: stt.model } : {}),
              ...(stt.egress !== undefined ? { egress: stt.egress } : {}),
            },
            schemaVersion: STT_SEGMENT_SCHEMA_VERSION,
            createdAt: processedAt,
          })
        } catch (error) {
          log(`stt segment for chunk ${chunk.id} not recorded: ${error instanceof Error ? error.message : String(error)}`)
        }
      },
      onSilenceSkipped: (_chunk, info) => {
        droppedSegments += info.dropped
        if (info.windowSkipped) skippedWindows += 1
      },
      noSpeechThreshold,
      log,
    })
    if (droppedSegments > 0) log(`transcribe: silence filter dropped ${droppedSegments} no-speech segment(s); ${skippedWindows} window(s) skipped as silence this drain`)
    // ECHO-DEDUPE: two passes over THIS drain's freshly-transcribed fragments (only chunks onTranscribed
    // saw — utf8 passthroughs and the executor's re-pass over already-text chunks are untouched). Pass 1
    // feeds every system-audio fragment into the rolling buffer FIRST, so a mic twin matches regardless
    // of intra-drain order; pass 2 drops mic fragments the buffer marks as echoes — out of BOTH the
    // returned stream (text queue → distill) and the live transcript.updated fan-out. Cross-drain the
    // check stays forward-only (v1): a mic fragment drained BEFORE its system twin is never re-checked.
    const echoDropped = new Set<string>()
    if (echoDedupe !== undefined) {
      for (const segment of segments) if (segment.source === 'system-audio') echoDedupe.observeSystem(segment)
      for (const segment of segments) {
        if (segment.source !== 'mic' || !echoDedupe.isEcho(segment)) continue
        echoDropped.add(segment.id)
        log(`transcribe: echo-dedupe dropped mic chunk ${segment.id} — near-duplicates a system-audio fragment within ±${ECHO_DEDUPE_WINDOW_MS}ms (session ${segment.sessionId}: ${echoDedupe.suppressedCount(segment.sessionId)} suppressed)`)
      }
    }
    const live = echoDropped.size === 0 ? segments : segments.filter((segment) => !echoDropped.has(segment.id))
    for (const update of buildTranscriptUpdates(live)) await bus.publish('transcript.updated', update)
    return echoDropped.size === 0 ? ready : ready.filter((chunk) => !echoDropped.has(chunk.id))
  }

  // Distill cadence throttle (#58): transcription runs every drain (cheap now, and it feeds the live
  // fast-path above), but the LLM distill/moments/index pass must NOT fire per drain once segments
  // shrink. DistillCadence accumulates each drain's transcribed text per session and only releases it to
  // the distiller when the buffered span reaches the threshold (default 15s) — or on session end (flush
  // below). Carry-over is in-memory: a mid-crash loses only the undistilled tail (chunks stay durable).
  const cadence = new DistillCadence()
  const currentDistillOpts = (): DistillOptions => ({
    extractMoments: isFlagEnabled(store, 'distill.moments'),
    extractEntities: isFlagEnabled(store, 'distill.index'),
  })
  // When true, the distill seam BYPASSES the throttle and distills immediately — used only while flushing
  // the accumulated tail (below), so the released batch is not re-buffered.
  let flushing = false
  // Run the fast-field fan-out over the SAME released batch the distiller just saw (#61). Best-effort and
  // gated by distill.fields (read per-drain, hot-flippable): fields are a distinct pass, so a fan-out
  // error must not sink the drain — the scheduler already catches per-field invoke failures, and this
  // catch guards the whole pass. Nothing text-bearing in the batch ⇒ the scheduler returns [] (no-op).
  const runFastFields = async (batch: readonly CaptureChunk[]): Promise<void> => {
    if (batch.length === 0 || !isFlagEnabled(store, 'distill.fields')) return
    try {
      await fieldScheduler.runFields(batch)
    } catch (error) {
      log(`fast-field fan-out failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // Judge cadence (#62): decoupled from the fast fan-out. Fast fields run every released distill batch
  // (~15s); the judge accumulates those batches in its OWN buffer and only reviews once its span crosses
  // a WIDER threshold (default 4× the distill cadence, so the judge sees ~a minute of source at once —
  // a larger model at a lower cadence). OPENINFO_JUDGE_CADENCE_MS overrides it (finite >= 0). Resolved
  // once at wiring time. The judge rides the SAME batches the fast tier saw, so it judges the SAME source.
  const judgeCadenceMs = ((): number => {
    const raw = Number(process.env['OPENINFO_JUDGE_CADENCE_MS'])
    return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DISTILL_CADENCE_MS * 4
  })()
  const judgeCadence = new DistillCadence(judgeCadenceMs)
  // Best-effort like the fast fan-out: a judge is a distinct, later pass, so a review error must never
  // sink the drain (the scheduler already catches per-judge invoke failures; this guards the whole pass).
  // Gated by distill.judge (read per-drain, hot-flippable). On a flush the cadence is bypassed so the tail
  // gets judged; otherwise the batch is accumulated and released only when the judge's wider span is met.
  const runJudgePass = async (batch: readonly CaptureChunk[], flush = false): Promise<void> => {
    if (batch.length === 0 || !isFlagEnabled(store, 'distill.judge')) return
    const due = flush ? [...judgeCadence.flush(), ...batch] : judgeCadence.offer(batch)
    if (due.length === 0) return
    try {
      await judgeScheduler.runJudge(due)
    } catch (error) {
      log(`judge pass failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const distillThrottled = async (chunks: readonly CaptureChunk[], opts: DistillOptions): Promise<void> => {
    if (flushing) {
      if (chunks.length > 0) {
        await distiller.distillChunks(chunks, opts)
        await runFastFields(chunks)
        await runJudgePass(chunks, true)
      }
      return
    }
    const due = cadence.offer(chunks)
    if (due.length > 0) {
      await distiller.distillChunks(due, opts)
      await runFastFields(due)
      await runJudgePass(due)
    }
  }
  // Session-end flush: distill the accumulated sub-threshold tail so the record — and any follow-up draft —
  // reflects the whole session. Routed through the SAME drain pipeline the throttle wraps, so the drain
  // acts that ride the distill pass (task-extract, gated act.tasks) run once more over the flushed
  // material before the session-end act composes its draft — otherwise a short session's to-do would never
  // populate. workflow.enabled ON → the executor's runDrain (distill bypassed + moments/index + drain
  // acts); OFF → the legacy direct distill (the legacy path has no drain acts). Idempotent: an empty
  // buffer is a no-op, so calling it after a path that already flushed is safe.
  const flushDistill = async (): Promise<void> => {
    const remainder = cadence.flush()
    if (remainder.length === 0) return
    flushing = true
    try {
      if (isFlagEnabled(store, 'workflow.enabled')) {
        // Executor path: its `distill` seam IS distillThrottled, which already fans out fast fields on the
        // flushing bypass — so the tail's fields land here without a second call.
        await executor.runDrain(remainder)
      } else {
        // Legacy path distills the tail DIRECTLY (bypassing the throttle), so fan out fast fields over the
        // same flushed batch explicitly — otherwise a short (sub-cadence) session's fields would strand (#61).
        await distiller.distillChunks(remainder, currentDistillOpts())
        await runFastFields(remainder)
        await runJudgePass(remainder, true)
      }
    } finally {
      flushing = false
    }
  }

  // The executor runs the seeded workflow-default document behind workflow.enabled (default OFF). It is
  // assigned just below (after the queues exist, so its drainNow seam can close over them) and referenced
  // lazily by the text-queue drain — that callback only fires async, long after assignment. See PHASE4-NOTES.
  let executor: WorkflowExecutor
  // Typed-queue envelope seams (P4A slice 3 / #70), READ-ONLY, SHARED by both drain queues so each keeps
  // zero fabric/store imports (the describeFailure precedent). measuredTokPerSec: the primary (fabric-order
  // first) llm endpoint's benchmarked tok/s — the envelope's measured side, surfaced as ETA context (never
  // converted to an ETA in v0). overflowState: the active mode's declared overflow policy mapped to the
  // status tri-state (only queue-for-idle is enforced in v0). sessionLive: a live default-workspace session
  // flips the drain to newest-first (render the present); at idle it stays oldest-first FIFO.
  const measuredTokPerSec = (): number | undefined => fabric.load().slots.llm[0]?.measured?.tokPerSec
  const overflowState = (): OverflowState => {
    const raw = distillDocs.mode().overflow
    const policy = raw === 'degrade' ? 'degrade-cadence' : raw === 'drop' ? 'drop' : 'queue-for-idle'
    return { policy, enforced: policy === 'queue-for-idle' }
  }
  const sessionLive = (): boolean => store.liveSession('default') !== undefined

  // #115 — STT and distill run on INDEPENDENT drain queues that never share a lock. The TEXT queue is the
  // LLM track: it consumes the PERSISTED transcript stream the STT track writes (below), on its OWN single-
  // flight loop, and runs the distill / moments / fields / judge chain (cadence-gated). A parked LLM stalls
  // only THIS queue — parakeet keeps transcribing on the audio queue. The transcribed segments are ordinary
  // utf8 CaptureChunks (exactly what runTranscribe emits and the distiller already consumes), so the stream
  // needs NO new contract — a second spool of the SAME shape, reusing the spool machinery (single-flight,
  // freshness-first ordering, age-shed, overflow/ETA envelope). DistillCadence still governs the LLM cadence.
  const textQueue = new CaptureQueue(join(store.dataDir, 'queue-text'), async (chunks) => {
    // workflow.enabled ON → the executor runs the workflow document over the transcribed stream (its own
    // transcribe step is a passthrough no-op on already-text chunks, so no double live feed; its ocr/vlm
    // steps consume any screen frames the STT track forwarded). OFF → the legacy throttled distill. Both
    // read their flags per-drain so they stay hot-flippable. This queue is LLM-only: transcription already
    // ran on the STT track, so a due distill window can never block parakeet (the #115 root cause).
    if (isFlagEnabled(store, 'workflow.enabled')) return executor.runDrain(chunks)
    // A screen frame captured while workflow ownership was selected keeps that owner even if the master
    // flag flips before this durable row drains. Run only its screen stage; every other workflow stage
    // continues to obey the current (now-off) master switch.
    if (chunks.some((chunk) => screenRecognitionOwner(chunk) === 'workflow-drain')) {
      await executor.runScreen(chunks)
    }
    if (!isFlagEnabled(store, 'distill.enabled')) return
    // Throttled: accumulate across drains, distill only when the span crosses the cadence threshold (or on
    // session-end flush). A distill/moments/judge invoke throw PROPAGATES → this queue re-queues the text
    // file (retry-at-idle), the same resilience the single queue had — now isolated to the LLM track.
    await distillThrottled(chunks, currentDistillOpts())
  }, toQueueFailure, measuredTokPerSec, overflowState, sessionLive, queueMaxAgeMinutes)

  // The AUDIO queue is the STT track. Its drain does routing-context focus detection, then transcription
  // (the #58 live fast-path), then hands the transcribed TEXT stream to the text queue — it NEVER awaits an
  // LLM call. A transcribe transport failure still propagates so THIS queue re-queues the audio file
  // (retry-at-idle, unchanged); the age-shed horizon + freshness-first ordering still govern the STT track.
  const queue = new CaptureQueue(join(store.dataDir, 'queue'), async (chunks) => {
    // Focus chunks feed the detector, never the distiller (distill hygiene, PHASE3-NOTES) — routing
    // CONTEXT, on both paths, read per-drain so it is hot-flippable like the distill flags.
    if (isFlagEnabled(store, 'route.detect')) {
      const signals = extractFocusSignals(chunks, log)
      if (signals.length > 0) await attributor.observe(signals)
    }
    // Nothing downstream consumes the stream unless distill or the workflow executor is on — this matches
    // the legacy early return (distill off ⇒ the drain was a no-op GC), so an idle default engine is
    // unchanged. When neither is on the text queue is never fed and never drains.
    const distillOn = isFlagEnabled(store, 'distill.enabled')
    const workflowOn = isFlagEnabled(store, 'workflow.enabled')
    const hasLatchedWorkflowScreen = chunks.some((chunk) => screenRecognitionOwner(chunk) === 'workflow-drain')
    if (!distillOn && !workflowOn && !hasLatchedWorkflowScreen) return
    // Transcription (distill.transcribe) is the STT stage: audio → utf8 text, emitting the live
    // transcript.updated fast-path. Gated exactly as the legacy path was — INSIDE distill.enabled, because
    // there is no persistence for transcribed-but-undistilled text (PHASE2-NOTES). With it off, raw chunks
    // forward unchanged (the executor's ocr/vlm still need the screen frames; the distiller filters non-text).
    const ready = distillOn && isFlagEnabled(store, 'distill.transcribe') ? await runTranscribe(chunks) : chunks
    // Persist the transcript stream onto the LLM track and wake it — enqueue-then-schedule mirrors the
    // capture ingest path (captureChunk). The text queue drains on its OWN single-flight loop, so a distill
    // in flight there does not block this audio drain from returning and transcribing the next chunk.
    for (const segment of ready) await textQueue.append(segment)
    textQueue.scheduleDrain(log)
  }, toQueueFailure, measuredTokPerSec, overflowState, sessionLive, queueMaxAgeMinutes)

  // #115 session-end drain-first flush: run the STT track to empty FIRST (all pending audio → transcribed
  // text on the text queue), THEN the LLM track to empty (that text → the cadence buffer), so the following
  // flushDistill releases the whole session's tail. Draining only one queue would strand the hand-off.
  const drainBoth = async (): Promise<void> => {
    await queue.drainNow(log)
    await textQueue.drainNow(log)
  }

  // Act v0 (the first Act node): the follow-up draft. It rides session END, not the chunk drain —
  // see PHASE2-NOTES for the direct-trigger (vs DAG) and ≤60s decisions. On session.ended, when
  // act.enabled is on and the session's mode declares a follow-up-draft act, we first flush any
  // in-flight chunks (drainNow → their distillates land) so the draft reflects the whole meeting,
  // then compose one voice-interpolated draft from the session's stored distillates + moments.
  const actor = new Actor({
    store,
    voice,
    fabric,
    docs: actDocs,
    todos: todoDocs,
    resolveKey,
    runtimeManager: runtime,
    mode: (id) => distillDocs.mode(id),
    publish: (draft) => bus.publish('draft.created', draft),
    log,
  })
  // task-extract (P4A slice 4): the CONSTRAIN side of the dynamic-to-do loop. Rides the DRAIN pass so a
  // session's to-do accumulates mid-meeting; gated by act.tasks (default OFF), so the default pipeline is
  // unchanged. A sibling of the Actor over the same store/voice/fabric + the shared prompt-template store.
  const taskExtractor = new TaskExtractor({
    store,
    voice,
    fabric,
    templates: actDocs,
    todos: todoDocs,
    resolveKey,
    runtimeManager: runtime,
    mode: (id) => distillDocs.mode(id),
    log,
  })
  // The executor composes the SAME seams the legacy paths use (distill/transcribe/drainNow/acts), so
  // workflow.enabled ON with the seeded workflow-default is behavior-identical: same flags honored, same
  // retry-at-idle propagation (transcribe/distill throws bubble out so the drain re-queues), same
  // drain-first flush before the act. drainActs adds the task-extract drain act (best-effort, gated
  // act.tasks). See PHASE4-NOTES for the byte-for-byte proof + the drain-vs-session-end decision.
  // The screen-recognition drain seam (P4A×P4B joint slice): the executor's ocr/vlm steps delegate to the
  // screen processor's runOnDrain (invokeOcr/invokeVlm → OcrResult + distillate, persisted). The processor
  // is wired POST-createEngineApp by wireScreenOcr (P4B's charter keeps screen wiring out of this file), so
  // it is reached LAZILY at drain time through the same store-keyed registry bridge the /screen router uses
  // — not held as a reference here. Absent (a bare app with no wireScreenOcr) ⇒ the ocr/vlm steps
  // skip-with-log in the executor. Double-processing with the ingest path is avoided in screen/index.ts:
  // the ingest subscription defers while workflow.enabled is ON, so screen understanding has ONE owner.
  const recognizeScreen: ScreenRunner = (chunks, step) =>
    getScreenProcessor(store)?.runOnDrain(chunks, step) ?? Promise.resolve()
  executor = new WorkflowExecutor({
    store,
    docs: workflow,
    // Throttled distill (#58) — same cadence instance the legacy path uses, so both drain paths share
    // one carry-over buffer. The executor's own step flags already produced `opts`.
    distill: (chunks, opts) => distillThrottled(chunks, opts),
    transcribe: runTranscribe,
    recognizeScreen,
    // The executor calls drainNow ONLY at session-end (runSessionEnd, when an act is enabled), and it
    // runs BEFORE the acts — so flushing the cadence tail here means a follow-up draft sees the whole
    // session. drainBoth runs the STT track then the LLM track to empty (#115), then flushDistill releases
    // the accumulated cadence tail.
    drainNow: async () => {
      await drainBoth()
      await flushDistill()
    },
    acts: { 'follow-up-draft': async (session) => void (await actor.runFollowUpDraft(session)) },
    drainActs: { 'task-extract': (chunks, step) => taskExtractor.runOnDrain(chunks, step) },
    log,
  })

  bus.subscribe('session.ended', (session) => {
    void (async () => {
      // workflow.enabled ON → the executor's session-end seam (drain-first flush incl. the cadence tail
      // via the drainNow seam above, then the enabled session-end acts). OFF → the legacy act trigger:
      // act.enabled gate, drainNow, flush the distill tail so the draft reflects it, then runFollowUpDraft.
      // The flag is read per-event so it is hot-flippable like the drain path.
      if (isFlagEnabled(store, 'workflow.enabled')) {
        await executor.runSessionEnd(session)
      } else if (isFlagEnabled(store, 'act.enabled')) {
        await drainBoth()
        await flushDistill()
        await actor.runFollowUpDraft(session)
      }
      // The distill cadence throttle (#58) means a short session's transcribed material never crossed the
      // 15s threshold and is still buffered (or still spooled un-drained). Session end MUST distill that
      // tail so the whole meeting is recorded — otherwise the throttle would silently drop sub-threshold
      // sessions. Drain the STT track then the LLM track INTO the cadence (drainBoth, #115), then flush it.
      // Both steps are safe no-ops when an act path above already ran them (drainBoth with nothing pending;
      // flush with an empty buffer). Gated on distill.enabled — with distill off nothing ever accumulated.
      if (isFlagEnabled(store, 'distill.enabled')) {
        await drainBoth()
        await flushDistill()
      }
    })().catch((error: unknown) =>
      log(`follow-up draft failed for session ${session.id}: ${error instanceof Error ? error.message : String(error)}`),
    )
  })

  bus.subscribe('capture.received', (chunk) => ws.broadcast('capture.received', chunk))
  bus.subscribe('queue.updated', (status) => ws.broadcast('queue.updated', status))
  bus.subscribe('flag.changed', (flag) => ws.broadcast('flag.changed', flag))
  bus.subscribe('distillate.updated', (distillate) => ws.broadcast('distillate.updated', distillate))
  // Ephemeral transcript fast-path (#58): rebroadcast the live feed to WS clients. Never persisted.
  bus.subscribe('transcript.updated', (update) => ws.broadcast('transcript.updated', update))
  // Ephemeral streaming chat-answer fast-path (the Ask face): rebroadcast each model-emitted chunk the
  // instant postChat publishes it (the #58 idiom). Never persisted — the ChatReply is the authoritative
  // answer, and the persisted thread (chat_turns) the durable record.
  bus.subscribe('chat.delta', (delta) => ws.broadcast('chat.delta', delta))
  // Diagnostics inspector (#101): remember the last N ephemeral updates in an in-memory ring so the
  // diagnostics app's transcription inspector can render the recent feed on a surface (it was ssh-only).
  // Fed off the SAME bus event — no new persistence path; the ring is process-scoped and cleared on restart.
  const transcripts = new TranscriptRing()
  bus.subscribe('transcript.updated', (update) => transcripts.record(update))
  // Cold-boot gate (#115): latch the instant the first live transcript flies past. The calendar collector
  // reads firstTranscriptSeen() so it defers its first Calendar.app sample past the first transcript — one
  // less surprise window (a TCC automation prompt) during the messy first session.
  let firstTranscriptAt: string | undefined
  bus.subscribe('transcript.updated', () => { firstTranscriptAt ??= new Date().toISOString() })
  bus.subscribe('moment.created', (moment) => ws.broadcast('moment.created', moment))
  bus.subscribe('entity.updated', (entity) => ws.broadcast('entity.updated', entity))
  // Fast-field fan-out (#61): rebroadcast a field's latest value the instant it lands (mirrors the #58
  // transcript.updated pattern). Unlike that ephemeral feed, the value is ALSO persisted (FieldValue).
  bus.subscribe('field.updated', (value) => ws.broadcast('field.updated', value))
  // Orientation pass (#131): rebroadcast the session-nature classification the instant it lands — the
  // trigger a contextual surface (#134) subscribes to. Persisted as a SessionAnnotation (annotate-and-correct).
  bus.subscribe('orientation.updated', (annotation) => ws.broadcast('orientation.updated', annotation))
  bus.subscribe('session.started', (session) => ws.broadcast('session.started', session))
  bus.subscribe('session.ended', (session) => ws.broadcast('session.ended', session))
  bus.subscribe('session.switched', (session) => ws.broadcast('session.switched', session))
  bus.subscribe('session.rerouted', (session) => ws.broadcast('session.rerouted', session))
  bus.subscribe('draft.created', (draft) => ws.broadcast('draft.created', draft))
  bus.subscribe('fabric.changed', (fabricDoc) => ws.broadcast('fabric.changed', fabricDoc))
  bus.subscribe('workflow.updated', (workflowSpec) => ws.broadcast('workflow.updated', workflowSpec))
  bus.subscribe('surface.updated', (surface) => ws.broadcast('surface.updated', surface))
  // Egress guard (#63): rebroadcast a suspended/resolved hop so a subscribed surface refreshes its held
  // indicator + release/deny affordance. Payload carries span descriptors, never the raw value.
  bus.subscribe('guard.hold.updated', (hold) => ws.broadcast('guard.hold.updated', hold))
  // Truthful physical-lane projection (#174). Register these AFTER the existing lifecycle/transcript WS
  // broadcasters: clients see the underlying event first, then its metadata-only read-model transition.
  // session.switched repeats the just-published session.started payload; SenseLaneTracker dedupes it.
  bus.subscribe('session.started', (session) => publishSenseLaneUpdates(bus, senseLanes.startSession(session)))
  bus.subscribe('session.switched', (session) => publishSenseLaneUpdates(bus, senseLanes.startSession(session)))
  bus.subscribe('session.ended', (session) => publishSenseLaneUpdates(bus, senseLanes.endSession(session)))
  bus.subscribe('transcript.updated', (update) => publishSenseLaneUpdates(bus, senseLanes.recordTranscript(update)))
  // OcrResult stays engine-internal. Only the correlated metadata snapshot is allowed onto the public WS.
  bus.subscribe('ocr.completed', (result) => publishSenseLaneUpdates(bus, senseLanes.recordOcr(result)))
  bus.subscribe('sense.lane.updated', (snapshot) => {
    // The internal bus is extensible and TypeScript types disappear at runtime. Revalidate at the public
    // egress so an accidental/hostile publisher with extra text or bytes fails closed instead of relying
    // on tracker construction discipline as a security boundary. Log schema paths only, never payloads.
    const errors = validationErrors('SenseLaneSnapshot', snapshot)
    if (errors.length > 0) {
      log(`dropped invalid sense.lane.updated at public egress: ${errors.join('; ')}`)
      return
    }
    ws.broadcast('sense.lane.updated', snapshot)
  })
  // #192: REAL gate state drives lane health. The SAME per-sense gate chain the diagnostics already
  // evaluate (flags, live fabric slots, active-workflow screen ownership — deterministic configuration
  // only, no probe) becomes the tracker's closed per-source overlay, so an off lane reads blocked with its
  // true reason (disabled / configuration-blocked) instead of idle. Re-evaluated on every flag/fabric/
  // workflow edit — the exact hot-flip seams those documents already publish — so re-enabling restores
  // truthful state without restart; applyGates is idempotent and emits only genuinely changed lanes.
  const refreshSenseLaneGates = async (): Promise<void> => {
    const chains = evaluateSenseGates({ flags: readFlags(store), fabric: fabric.load(), activeWorkflow: workflow.active() })
    await publishSenseLaneUpdates(bus, senseLanes.applyGates(senseLaneGateState(chains)))
  }
  bus.subscribe('flag.changed', () => refreshSenseLaneGates())
  bus.subscribe('fabric.changed', () => refreshSenseLaneGates())
  bus.subscribe('workflow.updated', () => refreshSenseLaneGates())
  // Seed the overlay from the flags/fabric/workflow documents as they stand at boot: applyGates runs
  // synchronously inside this call, so the verdict is in place before any session can open a lane.
  void refreshSenseLaneGates()

  const server = createServer((req, res) => {
    const ctx: HandlerContext = { bus, fabric, discovery, secrets, voice, surfaces, distill: distillDocs, guardDocs, guardHolds, todos: todoDocs, workflow, bundles, presets, hints: hintsDocs, queue, textQueue, senseLanes, transcripts, fieldValues, store, runtime, models, controlPlane: options.controlPlane, browserAuth, log }
    if (options.onCapture !== undefined) ctx.onCapture = options.onCapture
    void handleControlRequest(req, res, ctx).catch((error: unknown) => {
      if (res.headersSent) return void res.destroy(error instanceof Error ? error : undefined)
      if (error instanceof MalformedJsonError) return send(res, 400, { error: error.message })
      send(res, 500, { error: error instanceof Error ? error.message : String(error) })
    })
  })
  server.on('upgrade', (req, socket) => {
    if (!ws.handleUpgrade(req, socket as Socket)) socket.destroy()
  })

  return {
    server,
    bus,
    store,
    guardHolds,
    attributor,
    textQueue,
    senseLanes,
    firstTranscriptSeen: () => firstTranscriptAt !== undefined,
    close: async () => {
      ws.close()
      runtime.shutdown() // kill any spawned local runtimes (tier zero)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
      // Stop BOTH drain tracks before the store closes: a drain scheduled via setImmediate could otherwise
      // fire against a closed DB handle (the teardown race). Pending spool files stay durable on disk.
      await queue.stop()
      await textQueue.stop()
      store.close()
    },
  }
}

/**
 * The queue status the API surfaces (#115). STT and distill now drain on two queues, so a distill/moments/
 * judge failure lands on the LLM track (`textQueue`) while the capture backlog (depth/eta/lag/overflow/shed)
 * lives on the STT track (`queue`). The surfaced snapshot is the STT track's numbers — the real capture
 * backlog the HUD renders — with the LLM track's failure ADOPTED when it is the more recent, and the later
 * lastSuccessAt across both. Otherwise GET /queue, Status, /senses, and the queue-status block would lose
 * the very failure the user needs to see (#7, the user's wall).
 */
async function surfacedQueueStatus(ctx: HandlerContext): Promise<QueueStatus> {
  const [audio, text] = await Promise.all([ctx.queue.status(), ctx.textQueue.status()])
  const lastFailure = [audio.lastFailure, text.lastFailure]
    .filter((f): f is QueueFailure => f !== undefined)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .at(-1)
  const lastSuccessAt = [audio.lastSuccessAt, text.lastSuccessAt]
    .filter((s): s is string => s !== undefined)
    .sort()
    .at(-1)
  return {
    ...audio,
    ...(lastFailure !== undefined ? { lastFailure } : {}),
    ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {}),
  }
}

class MalformedJsonError extends Error {}

const singleHeader = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined

const isSettingsPath = (pathname: string): boolean =>
  pathname === '/settings' || pathname.startsWith('/settings/') || pathname === '/setup' || pathname.startsWith('/setup/')

const lockedSettings = (res: ServerResponse): void => {
  res.statusCode = 401
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('www-authenticate', 'Bearer')
  res.end(
    '<!doctype html><html><head><meta charset="utf-8"><title>openinfo settings locked</title></head>' +
      '<body><main><h1>Settings are locked</h1><p>Open Settings from the openinfo app to start an authenticated browser session.</p></main></body></html>',
  )
}

const unauthorized = (res: ServerResponse): void => {
  res.setHeader('www-authenticate', 'Bearer')
  send(res, 401, { error: 'authentication required' })
}

const bearerToken = (authorization: string | undefined): string | undefined => {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization ?? '')
  return match?.[1]
}

const isJsonMutation = (req: IncomingMessage): boolean => {
  if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'DELETE') return true
  return singleHeader(req.headers['content-type'])?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
}

const applyCors = (res: ServerResponse, origin: string | undefined): void => {
  if (origin === undefined) return
  res.setHeader('access-control-allow-origin', origin)
  res.setHeader('access-control-allow-credentials', 'true')
  res.setHeader('vary', 'Origin')
}

const handlePreflight = (req: IncomingMessage, res: ServerResponse, origin: string | undefined): void => {
  if (origin === undefined) return send(res, 403, { error: 'CORS preflight requires an allowed Origin' })
  const requestedMethod = singleHeader(req.headers['access-control-request-method'])?.toUpperCase()
  if (!requestedMethod || !['GET', 'POST', 'PUT', 'DELETE'].includes(requestedMethod)) {
    return send(res, 403, { error: 'CORS method is not allowed' })
  }
  const requestedHeaders = (singleHeader(req.headers['access-control-request-headers']) ?? '')
    .split(',')
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean)
  if (requestedHeaders.some((header) => header !== 'authorization' && header !== 'content-type')) {
    return send(res, 403, { error: 'CORS header is not allowed' })
  }
  res.writeHead(204, {
    'access-control-allow-methods': 'GET, POST, PUT, DELETE',
    'access-control-allow-headers': 'Authorization, Content-Type',
    'access-control-max-age': '600',
  })
  res.end()
}

/**
 * Local-daemon boundary order is deliberate and test-pinned:
 * Host → request target → Origin → preflight → auth → Content-Type → resource router/body parse.
 * Authentication is evaluated before reading a request body, so a drive-by page cannot make the engine
 * allocate/parse an attacker-controlled capture or configuration payload.
 */
async function handleControlRequest(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext): Promise<void> {
  res.setHeader('cache-control', 'no-store')
  res.setHeader('referrer-policy', 'no-referrer')

  const host = singleHeader(req.headers.host)
  if (!ctx.controlPlane.validateHost(host)) return send(res, 421, { error: 'unrecognized control-plane Host' })
  if (req.url === undefined || !req.url.startsWith('/') || req.url.startsWith('//')) {
    return send(res, 400, { error: 'invalid request target' })
  }

  const origin = singleHeader(req.headers.origin)
  if (!ctx.controlPlane.validateOrigin(origin)) return send(res, 403, { error: 'Origin is not allowed' })
  applyCors(res, origin)
  if (req.method === 'OPTIONS') return handlePreflight(req, res, origin)

  const url = new URL(req.url, 'http://control.invalid')
  if (isPublicHealthRequest(req.method, req.url)) return handle(req, res, ctx)

  // A browser ticket is itself a short-lived one-use credential. Consume it before ordinary bearer/cookie
  // auth, mint an independent in-memory session, and redirect to a clean URL that contains no credential.
  if (req.method === 'GET' && url.pathname === '/auth/browser') {
    const consumed = ctx.browserAuth.consume(url.searchParams.get('ticket'), ctx.controlPlane.mode === 'tunnel')
    if (consumed === undefined) return lockedSettings(res)
    res.writeHead(302, { location: '/settings', 'set-cookie': consumed.cookie })
    res.end()
    return
  }

  const token = bearerToken(singleHeader(req.headers.authorization))
  const authenticated =
    ctx.controlPlane.authenticate(token) || ctx.browserAuth.authenticateCookie(singleHeader(req.headers.cookie))
  if (!authenticated) {
    if (isSettingsPath(url.pathname)) return lockedSettings(res)
    return unauthorized(res)
  }

  if (!isJsonMutation(req)) {
    return send(res, 415, { error: 'POST, PUT, and DELETE require Content-Type: application/json' })
  }

  if (req.method === 'POST' && url.pathname === '/auth/browser-ticket') {
    const browserOrigin = ctx.controlPlane.publicOrigin ?? `http://${host!}`
    const ticket = ctx.browserAuth.issue(browserOrigin)
    return send(res, 201, ticket)
  }

  return handle(req, res, ctx)
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, {
      ok: true,
      phase: 1,
      uptimeMs: process.uptime() * 1000,
      checkedAt: new Date().toISOString(),
      ...(ENGINE_VERSION !== undefined ? { version: ENGINE_VERSION } : {}),
      ...(ENGINE_BUILD !== undefined ? { build: ENGINE_BUILD } : {}),
    })
  }
  if (req.method === 'GET' && url.pathname === '/contracts') return send(res, 200, Object.keys(AllSchemas))
  if (req.method === 'GET' && url.pathname === '/routes') return send(res, 200, Routes)
  if (req.method === 'GET' && url.pathname === '/flags') return send(res, 200, readFlags(ctx.store))
  if (req.method === 'GET' && url.pathname === '/queue') return send(res, 200, await surfacedQueueStatus(ctx))
  if (req.method === 'GET' && url.pathname === '/senses/live') return getLiveSenses(res, ctx, url)
  if (req.method === 'GET' && url.pathname === '/senses') return getSenses(res, ctx)
  if (req.method === 'POST' && url.pathname === '/screen/observations') return postScreenCaptureObservation(req, res, ctx)
  if (url.pathname === '/screen' || url.pathname.startsWith('/screen/')) return handleScreen(req, res, ctx) // P4B: screen-OCR results + status (router owned by screen/)
  // /setup is the former name of the Settings surface — 301 to /settings, preserving any subpath +
  // query (?edit=, ?surface=, ?discover=). The old URL must keep working (README/skills/first-run).
  if (req.method === 'GET' && (url.pathname === '/setup' || url.pathname.startsWith('/setup/'))) {
    const location = '/settings' + url.pathname.slice('/setup'.length) + url.search
    res.writeHead(301, { location })
    res.end()
    return
  }
  if (req.method === 'GET' && (url.pathname === '/settings' || url.pathname.startsWith('/settings/'))) {
    return getSettings(res, ctx, url, req.headers.host)
  }
  if (req.method === 'GET' && url.pathname === '/fabric') return send(res, 200, ctx.fabric.load())
  if (req.method === 'PUT' && url.pathname === '/fabric') return saveFabric(req, res, ctx)
  if (req.method === 'GET' && url.pathname === '/fabric/discover') return discover(res, ctx)
  if (req.method === 'POST' && url.pathname === '/fabric/scan') return scanFabric(req, res, ctx)
  if (req.method === 'GET' && url.pathname === '/fabric/local/models') return send(res, 200, ctx.models.statuses())
  if (req.method === 'POST' && url.pathname === '/fabric/local/download') return downloadModel(req, res, ctx)
  if (req.method === 'POST' && url.pathname === '/fabric/test') return testEndpoint(req, res, ctx)
  if (req.method === 'GET' && url.pathname === '/fabric/profiles') return send(res, 200, ctx.fabric.profiles.list())
  const profileClone = url.pathname.match(/^\/fabric\/profiles\/([^/]+)\/clone$/)
  if (req.method === 'POST' && profileClone?.[1]) return cloneProfile(req, res, ctx, decodeURIComponent(profileClone[1]))
  const profileActivate = url.pathname.match(/^\/fabric\/profiles\/([^/]+)\/activate$/)
  if (req.method === 'POST' && profileActivate?.[1]) return activateProfile(res, ctx, decodeURIComponent(profileActivate[1]))
  const profile = url.pathname.match(/^\/fabric\/profiles\/([^/]+)$/)
  if (req.method === 'GET' && profile?.[1]) return getProfile(res, ctx, decodeURIComponent(profile[1]))
  if (req.method === 'PUT' && profile?.[1]) return putProfile(req, res, ctx, decodeURIComponent(profile[1]))
  if (req.method === 'DELETE' && profile?.[1]) return deleteProfile(res, ctx, decodeURIComponent(profile[1]))
  if (req.method === 'GET' && url.pathname === '/fabric/secrets') return send(res, 200, ctx.secrets.listRefs().map((ref) => ({ ref })))
  const secret = url.pathname.match(/^\/fabric\/secrets\/([^/]+)$/)
  if (req.method === 'PUT' && secret?.[1]) return putSecret(req, res, ctx, decodeURIComponent(secret[1]))
  if (req.method === 'DELETE' && secret?.[1]) return deleteSecret(res, ctx, decodeURIComponent(secret[1]))
  if (req.method === 'GET' && url.pathname === '/workspaces') return send(res, 200, ctx.store.all())
  if (req.method === 'GET' && url.pathname === '/registers') return send(res, 200, ctx.voice.registers())
  if (req.method === 'GET' && url.pathname === '/modes') return send(res, 200, ctx.distill.modes())
  // #23: the prompt layer becomes readable+writable over the API like /workflows (the prerequisite for the
  // fast-fields prompt-document layer). Templates gain a whole resource; registers/modes gain write + by-id
  // reads, fixing the read-only drift (the route table already declared PUT /modes/:id). All follow the
  // /workflows pattern exactly: create-on-unknown-id, contract-validated body → 400, read-fresh hot-edit.
  if (req.method === 'GET' && url.pathname === '/templates') return send(res, 200, ctx.distill.templates())
  const template = url.pathname.match(/^\/templates\/([^/]+)$/)
  if (req.method === 'GET' && template?.[1]) return getTemplate(res, ctx, decodeURIComponent(template[1]))
  if (req.method === 'PUT' && template?.[1]) return putTemplate(req, res, ctx, decodeURIComponent(template[1]))
  const register = url.pathname.match(/^\/registers\/([^/]+)$/)
  if (req.method === 'GET' && register?.[1]) return getRegister(res, ctx, decodeURIComponent(register[1]))
  if (req.method === 'PUT' && register?.[1]) return putRegister(req, res, ctx, decodeURIComponent(register[1]))
  const mode = url.pathname.match(/^\/modes\/([^/]+)$/)
  if (req.method === 'GET' && mode?.[1]) return getMode(res, ctx, decodeURIComponent(mode[1]))
  if (req.method === 'PUT' && mode?.[1]) return putMode(req, res, ctx, decodeURIComponent(mode[1]))
  // pill P2: the workspace's ACTIVE context-preset selection (the presets themselves are prompt-template
  // documents served/edited by /templates above; this is the per-workspace selection over them). GET reads
  // the selection (+ the five choices); PUT sets it with honest validation — selecting a nonexistent preset
  // is a 400, clearing it (presetId null) is allowed. `?workspace=<id>` scopes it (absent ⇒ 'default').
  if (req.method === 'GET' && url.pathname === '/active-preset') return getActivePreset(res, ctx, url)
  if (req.method === 'PUT' && url.pathname === '/active-preset') return putActivePreset(req, res, ctx, url)
  if (req.method === 'GET' && url.pathname === '/sessions') return send(res, 200, readSessions(ctx.store, url))
  if (req.method === 'POST' && url.pathname === '/sessions') return startSession(req, res, ctx)
  const sessionEnd = url.pathname.match(/^\/sessions\/([^/]+)\/end$/)
  if (req.method === 'POST' && sessionEnd?.[1]) return endSession(res, ctx, decodeURIComponent(sessionEnd[1]))
  const sessionReroute = url.pathname.match(/^\/sessions\/([^/]+)\/reroute$/)
  if (req.method === 'POST' && sessionReroute?.[1]) return reroute(req, res, ctx, decodeURIComponent(sessionReroute[1]))
  if (req.method === 'GET' && url.pathname === '/moments') return send(res, 200, readMoments(ctx.store, url))
  if (req.method === 'GET' && url.pathname === '/entities') return send(res, 200, readEntities(ctx.store, url))
  if (req.method === 'GET' && url.pathname === '/relevant') return send(res, 200, readRelevant(ctx.store, url))
  if (req.method === 'GET' && url.pathname === '/drafts') return send(res, 200, readDrafts(ctx.store, url))
  if (req.method === 'GET' && url.pathname === '/todos') return send(res, 200, ctx.todos.list())
  const todo = url.pathname.match(/^\/todos\/([^/]+)$/)
  if (req.method === 'GET' && todo?.[1]) return getTodo(res, ctx, decodeURIComponent(todo[1]))
  if (req.method === 'PUT' && todo?.[1]) return putTodo(req, res, ctx, decodeURIComponent(todo[1]))
  if (req.method === 'GET' && url.pathname === '/workflows') return send(res, 200, ctx.workflow.list())
  const workflow = url.pathname.match(/^\/workflows\/([^/]+)$/)
  if (req.method === 'GET' && workflow?.[1]) return getWorkflow(res, ctx, decodeURIComponent(workflow[1]))
  if (req.method === 'PUT' && workflow?.[1]) return putWorkflow(req, res, ctx, decodeURIComponent(workflow[1]))
  // App bundles (bundle-as-runtime-object) — served in the document-route idiom, exactly like /workflows:
  // enumerate, read by id (default resolves via seed + code fallback; unknown ⇒ 404), and a validated PUT
  // that create-on-unknown-id and version-stamps. The tray Apps catalog reads GET /bundles.
  if (req.method === 'GET' && url.pathname === '/bundles') return send(res, 200, ctx.bundles.list())
  const bundle = url.pathname.match(/^\/bundles\/([^/]+)$/)
  if (req.method === 'GET' && bundle?.[1]) return getBundle(res, ctx, decodeURIComponent(bundle[1]))
  if (req.method === 'PUT' && bundle?.[1]) return putBundle(req, res, ctx, decodeURIComponent(bundle[1]))
  // P4-T2: pins ingest/read + teach candidates — the P4D store/derivation seams over HTTP, no logic change.
  if (req.method === 'GET' && url.pathname === '/pins') return send(res, 200, readPins(ctx.store, url))
  if (req.method === 'POST' && url.pathname === '/pins') return createPin(req, res, ctx)
  const pinIngest = url.pathname.match(/^\/pins\/([^/]+)\/ingest$/)
  if (req.method === 'POST' && pinIngest?.[1]) return ingestPinRoute(res, ctx, decodeURIComponent(pinIngest[1]), url)
  const pinChunks = url.pathname.match(/^\/pins\/([^/]+)\/chunks$/)
  if (req.method === 'GET' && pinChunks?.[1]) return getPinChunks(res, ctx, decodeURIComponent(pinChunks[1]), url)
  if (req.method === 'GET' && url.pathname === '/teach/candidates') return send(res, 200, readTeachCandidates(ctx.store, url))
  // #75 clarify affordance answer: the user's verdict on an AMBIGUOUS resolution writes BOTH a labeled
  // entity-correction TeachSignal AND a sovereign EntityOverride (the durable resolver short-circuit).
  if (req.method === 'POST' && url.pathname === '/teach/entity') return postEntityCorrection(req, res, ctx)
  // P4-T3b: the APPLY-with-review half of the teach loop — GET/PUT the workspace's attribution-hints
  // document. /teach/candidates SUGGESTS a pattern; the user reviews it and PUTs an updated hints doc
  // here, and the detector then attributes on it. No auto-apply: "apply a candidate" is just this plain
  // document edit over the existing HintsDocuments store seam (no logic in route/ is touched).
  if (req.method === 'GET' && url.pathname === '/hints') return send(res, 200, ctx.hints.all())
  const hintsDoc = url.pathname.match(/^\/hints\/([^/]+)$/)
  if (req.method === 'GET' && hintsDoc?.[1]) return getHints(res, ctx, decodeURIComponent(hintsDoc[1]))
  if (req.method === 'PUT' && hintsDoc?.[1]) return putHints(req, res, ctx, decodeURIComponent(hintsDoc[1]))
  if (req.method === 'GET' && url.pathname === '/layouts/surfaces') return send(res, 200, ctx.surfaces.list())
  // #99: instantiate a new app instance from a template surface (server-side deep-clone + workspace bind).
  // Matched BEFORE the bare /:id route so the trailing segment is the verb, not a surface id.
  const instantiate = url.pathname.match(/^\/layouts\/surfaces\/([^/]+)\/instantiate$/)
  if (req.method === 'POST' && instantiate?.[1]) return instantiateSurface(req, res, ctx, decodeURIComponent(instantiate[1]))
  const surface = url.pathname.match(/^\/layouts\/surfaces\/([^/]+)$/)
  if (req.method === 'GET' && surface?.[1]) return getSurface(res, ctx, decodeURIComponent(surface[1]))
  if (req.method === 'PUT' && surface?.[1]) return putSurface(req, res, ctx, decodeURIComponent(surface[1]))
  // #99: `?surface=<id>` names the app instance a query runs under — its bound workspace becomes the query's
  // DEFAULT (an explicit params.workspace still wins). Absent ⇒ unchanged 'default' behavior.
  if (req.method === 'POST' && url.pathname === '/query') return runQuery(req, res, ctx, url.searchParams.get('surface'))
  if (req.method === 'POST' && url.pathname === '/chat') return postChat(req, res, ctx)
  // The Ask face's persisted thread read (ask-history): the chat window renders the recent conversation on
  // open. Honest cap — the tail plus total/truncated so a cut is disclosed, never silently absorbed.
  if (req.method === 'GET' && url.pathname === '/chat/history') return getChatHistory(res, ctx, url)
  // #66: dismiss / mark-for-follow-up write a per-item signal. Dismiss is the SUPPRESSION record that
  // runQuery above then honors (dismissed rows excluded). Self-contained: one POST over the store seam.
  if (req.method === 'POST' && url.pathname === '/item-signals') return postItemSignal(req, res, ctx)
  // #63 egress guard: the held-hops audit + the guard policy document.
  if (req.method === 'GET' && url.pathname === '/guard-holds') return send(res, 200, ctx.guardHolds.list(url.searchParams.get('workspace') ?? 'default'))
  if (req.method === 'POST' && url.pathname === '/guard-holds/resolve') return resolveGuardHold(req, res, ctx)
  if (req.method === 'GET' && url.pathname === '/guard/policy') return send(res, 200, ctx.guardDocs.policy())
  if (req.method === 'PUT' && url.pathname === '/guard/policy') return saveGuardPolicy(req, res, ctx)
  if (req.method === 'GET' && url.pathname.startsWith('/contracts/')) return sendContract(url, res)
  if (req.method === 'PUT' && url.pathname.startsWith('/flags/')) return saveFlag(req, res, ctx, decodeURIComponent(url.pathname.slice(7)))
  const capture = url.pathname.match(/^\/capture\/([^/]+)$/)
  if (req.method === 'POST' && capture?.[1]) return captureChunk(req, res, ctx, decodeURIComponent(capture[1]))
  return send(res, 404, { error: `no such route: ${req.method ?? 'GET'} ${url.pathname}` })
}

/**
 * Edit the LIVE fabric (the active-profile view — see ARCHITECTURE §8). With a profile active this
 * edits that profile in place (version-bumped); with none active it writes the legacy single doc.
 * Either way the live fabric changed, so fabric.changed fires. Never carries key material: an
 * endpoint's auth is a keyRef, not a value.
 */
async function saveFabric(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext): Promise<void> {
  const body = await readJson(req)
  const errors = validationErrors('Fabric', body)
  if (errors.length > 0) return send(res, 400, { error: 'invalid Fabric', details: errors })
  const saved = ctx.fabric.save(body as Fabric)
  await ctx.bus.publish('fabric.changed', ctx.fabric.load())
  send(res, 200, saved)
}

/**
 * Serve the Settings surface (ARCHITECTURE §8):
 * a persistent sidebar + content pane, server-rendered per request. Sections are pure view modules
 * registered in ONE table (surfaces/settings/registry.ts); this handler assembles the live data the
 * sections read, resolves the active section, and hands it to the shell. It composes only the existing
 * profile/secret/fabric/flags/surface routes — no new engine capability. localhost-only (no auth) is P7.
 *
 * Routing: GET /settings → the default section (Get started when the llm slot is empty, else Status);
 * GET /settings/<id> → that section. `?surface=<id>` opens the HUD-layout editor; `?edit=<id>` opens the
 * Endpoints editor on that profile; `?discover=1` forces a fresh detection on the Get-started section.
 * Discovery (network probes) runs ONLY when the Get-started section is active — every other section is
 * assembled from cheap in-process reads.
 */
async function getSettings(res: ServerResponse, ctx: HandlerContext, url: URL, host: string | undefined): Promise<void> {
  // ?surface=<id> opens the HUD-layout editor for that surface (mirrors ?edit=<id> for a fabric profile).
  const surfaceParam = url.searchParams.get('surface')
  if (surfaceParam !== null) return getSurfaceEditor(res, ctx, surfaceParam)
  const profiles = ctx.fabric.profiles.list()
  const activeId = ctx.fabric.profiles.activeId()
  const editParam = url.searchParams.get('edit')
  const wantDiscover = url.searchParams.get('discover') === '1'
  const editing = editParam
    ? profiles.find((p) => p.id === editParam)
    : (activeId ? profiles.find((p) => p.id === activeId) : profiles[0])
  const liveFabric = ctx.fabric.load()
  const liveSession = ctx.store.liveSession('default')

  const data: SetupData = {
    profiles,
    activeId,
    liveFabric,
    editing,
    secretRefs: ctx.secrets.listRefs(),
    surfaces: ctx.surfaces.list(),
    defaultSurfaceId: defaultHudSurface.id,
    flags: readFlags(ctx.store),
    activeWorkflow: ctx.workflow.active(),
    uptimeMs: process.uptime() * 1000,
    queue: await surfacedQueueStatus(ctx),
    localModels: ctx.models.statuses(),
    ...(host !== undefined ? { engineLabel: host } : {}),
    ...(liveSession !== undefined ? { liveSession } : {}),
  }

  // Resolve the active section: the path id, else ?edit ⇒ Endpoints, ?discover ⇒ Get started, else default.
  const pathId = url.pathname.startsWith('/settings/')
    ? decodeURIComponent(url.pathname.slice('/settings/'.length)).replace(/\/+$/, '')
    : ''
  const requested = pathId || (editParam ? 'endpoints' : wantDiscover ? 'get-started' : defaultSectionId(data))
  const active = sectionById(requested) ?? sectionById(defaultSectionId(data))!

  // Discovery (localhost probes) runs ONLY for the two sections that render its result — Get-started's
  // capability lens and Local-runtimes' detected-servers block — so navigating any other section stays
  // cheap. A probe that names a keyRef (omlx) is retried with the stored secret; the value never leaves
  // the call, only the ref is named.
  if (active.id === 'get-started' || active.id === 'local-runtimes') {
    data.discovery = await discoverFabric(ctx.discovery.probeList(), ctx.discovery.capabilityMap(), {
      resolveKey: (ref) => ctx.secrets.resolve(ref),
    })
  }

  // The Audit ledger (#65) is assembled ONLY when its section is active — cheap in-process reads of the
  // default workspace's recorded passes, turned into hop trails. Every other section stays free of the
  // read, mirroring the discovery-only-when-relevant discipline above. #116 folds the moment / field /
  // judge / guard-hold records onto their trails (multi-hop), keeping the flat "all passes" table working.
  if (active.id === 'ledger') {
    data.guardHolds = ctx.guardHolds.list('default')
    data.ledger = buildLedger(ctx.store.listDistillates('default'), ctx.store.listOcrResults('default'), {
      moments: ctx.store.listMoments('default'),
      fieldValues: ctx.fieldValues.list('default'),
      guardHolds: data.guardHolds,
    })
  }

  // The Trace section (#116) — same read discipline. Assembly failures land as `problem` so the page
  // renders the TRUE reason as visible text; a broken read must never blank a diagnostics surface.
  if (active.id === 'trace') {
    try {
      const records = {
        sttSegments: ctx.store.listSttSegments('default'),
        distillates: ctx.store.listDistillates('default'),
        moments: ctx.store.listMoments('default'),
        fieldValues: ctx.fieldValues.list('default'),
        guardHolds: ctx.guardHolds.list('default'),
        ocrResults: ctx.store.listOcrResults('default'),
      }
      const selected = url.searchParams.get('input')
      const trace: TraceData = { inputs: buildTraceInputs(records) }
      if (selected !== null && selected !== '') {
        trace.selectedId = selected
        const trail = buildTrace(selected, records)
        if (trail !== undefined) trace.trail = trail
      }
      data.trace = trace
    } catch (error) {
      data.trace = { inputs: [], problem: error instanceof Error ? error.message : String(error) }
    }
  }

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(renderSettingsPage(data, active.id))
}

/**
 * GET /senses (issue #7) — the per-sense gate-chain verdict as JSON, for a support flow AND the client
 * tray's blocking-gate line. Composes the EXISTING signals into one named "what is blocking this sense"
 * answer: the live flags, the live fabric's slots, the queue's last classified drain failure, and a LIVE
 * checkEndpoint probe of the configured stt endpoints plus the screen slots the active owner actually
 * requires (legacy OCR, or enabled workflow OCR/VLM steps). The route can afford the probe the pure
 * Status render cannot. Append-only, read-only; reuses checkEndpoint/EndpointHealth rather than
 * re-implementing any health logic. The CLIENT-side gates (sense off, OS permission, engine reachable)
 * chain in FRONT of this on the tray — the engine cannot see those.
 */
async function getSenses(res: ServerResponse, ctx: HandlerContext): Promise<void> {
  const fabric = ctx.fabric.load()
  const flags = readFlags(ctx.store)
  const activeWorkflow = ctx.workflow.active()
  const queue = await surfacedQueueStatus(ctx)
  // Probe STT plus exactly the screen slots the active owner can invoke (deduped by endpoint name).
  // Best-effort: a probe that throws is caught inside checkEndpoint and returns ok:false with its error.
  const screenSlots = requiredScreenSenseSlots({ flags, activeWorkflow })
  const probeSlots = [...fabric.slots.stt, ...screenSlots.flatMap((slot) => fabric.slots[slot])]
  const seen = new Set<string>()
  const health: Record<string, EndpointHealth> = {}
  for (const endpoint of probeSlots) {
    if (seen.has(endpoint.name)) continue
    seen.add(endpoint.name)
    health[endpoint.name] = await checkEndpoint(endpoint, 2_000, (ref) => ctx.secrets.resolve(ref), ctx.runtime)
  }
  const chains = evaluateSenseGates({
    flags,
    fabric,
    activeWorkflow,
    ...(queue.lastFailure ? { lastFailure: queue.lastFailure } : {}),
    health,
  })
  send(res, 200, chains)
}

/**
 * GET /senses/live (#174) — the process-local metadata read model for the three physical lanes. It is
 * deliberately separate from GET /senses (configuration/health gate chains): this route answers what
 * this engine process actually observed. With no lifecycle event this launch it always materializes
 * mic/system-audio/screen as stopped, even when an old unended Session exists on disk.
 *
 * `workspace` defaults to `default`; an empty `session` is normalized to absent so the response always
 * validates its Id contract. Supplying a session asks for that exact process-observed scope; an unknown
 * id still returns all three stopped rows rather than borrowing another session's state.
 */
function getLiveSenses(res: ServerResponse, ctx: HandlerContext, url: URL): void {
  const workspaceParam = url.searchParams.get('workspace')
  const workspaceId = workspaceParam !== null && workspaceParam.length > 0 ? workspaceParam : 'default'
  const sessionParam = url.searchParams.get('session')
  const sessionId = sessionParam !== null && sessionParam.length > 0 ? sessionParam : undefined
  send(res, 200, ctx.senseLanes.snapshotSet(workspaceId, sessionId))
}

/**
 * POST /screen/observations (#174) — accept one closed, metadata-only account of a client capture
 * attempt. Pixels and derived content are structurally impossible at this boundary: TypeBox rejects
 * every extra field before the observation reaches the live read model. The route is mounted inside the
 * ordinary control-plane router, so Host/Origin/auth/JSON checks have already run before the body is read.
 *
 * A queued observation normally follows POST /capture/screen, whose durable append already announced the
 * same capture. Its first exact confirmation may emit a second transition because it adds capture-side
 * health evidence; duplicate confirmations are strict no-ops. Invalid, stale, or otherwise non-advancing
 * observations likewise cannot mutate or emit. Returning the current row gives this best-effort client
 * telemetry a stable closed response without inventing a new error/content channel.
 */
async function postScreenCaptureObservation(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext): Promise<void> {
  const body = await readJson(req)
  const errors = validationErrors('ScreenCaptureObservation', body)
  if (errors.length > 0) return send(res, 400, { error: 'invalid ScreenCaptureObservation', details: errors })
  const observation = body as ScreenCaptureObservation
  const update = ctx.senseLanes.recordScreenCaptureObservation(observation)
  await publishSenseLaneUpdates(ctx.bus, update)
  const current = update ?? ctx.senseLanes.snapshotSet(observation.workspaceId, observation.sessionId).lanes[2]
  send(res, 200, current)
}

/**
 * Serve the HUD-layout editor for one surface (GET /setup?surface=<id>) — forms over the surface
 * document, closing the HUD-customization gap. Composes only the surface routes the
 * browser script calls (GET/PUT /layouts/surfaces[/:id]); no new engine capability. Unknown id ⇒ a
 * plain 404 HTML page with a way back (not a JSON error — this is a browser surface). The HUD default
 * is the shipped surface id (the client's own config picks which surface it renders; the engine marks
 * the shipped default).
 */
function getSurfaceEditor(res: ServerResponse, ctx: HandlerContext, id: string): void {
  const surface = ctx.surfaces.get(id)
  if (!surface) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#101216;color:#e8eaee;padding:40px"><p>No such surface: <code>${id.replace(/[&<>]/g, '')}</code>.</p><p><a style="color:#e06a3c" href="/setup">← back to setup</a></p></body>`)
    return
  }
  const html = renderSurfaceEditorPage({ surface, surfaces: ctx.surfaces.list(), defaultSurfaceId: defaultHudSurface.id })
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html)
}

/**
 * Onboarding discovery: probe well-known local model servers, classify what is loaded, and synthesize
 * a config-1 suggestion (ARCHITECTURE §8). Read-only, never throws, no secrets (localhost). This is the
 * one new engine capability the Get-Started lens needs; the "Use this setup" button then writes the
 * suggestion through the EXISTING profile routes (no new write semantics).
 */
async function discover(res: ServerResponse, ctx: HandlerContext): Promise<void> {
  // A probe that names a keyRef (omlx) is retried with the stored secret so an authed-but-present server
  // is enumerated; the value never leaves this call (only the ref is named in the result). A 401 with no
  // stored key still surfaces as authRequired — present, needs a key — never a silent miss.
  const result = await discoverFabric(ctx.discovery.probeList(), ctx.discovery.capabilityMap(), {
    resolveKey: (ref) => ctx.secrets.resolve(ref),
  })
  send(res, 200, result)
}

/**
 * The host-scan (POST /fabric/scan) — pick host, scan common ports, list models, get a
 * capabilities list; backs the Endpoints editor's Scan button. Exactly one of url|host: an exact
 * url probes that base URL; a bare host tries the probe-list DOCUMENT's ports against it. Models come
 * back classified through the capability map; failures come back in the invoke taxonomy's classes.
 * POSTURE: the engine is localhost-only (auth is P7) and this is a USER-DIRECTED probe of a host the
 * user typed — a few GETs to /v1/models, not an unsolicited subnet sweep (that consent-gated LAN sweep
 * stays future). Fresh per call (no cache, the user's explicit call); value-free re keys — the
 * keyRef resolves server-side and no response ever carries key material.
 */
async function scanFabric(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext): Promise<void> {
  const body = await readJson(req)
  const errors = validationErrors('ScanRequest', body)
  if (errors.length > 0) return send(res, 400, { error: 'invalid ScanRequest', details: errors })
  const request = body as ScanRequest
  if ((request.url !== undefined) === (request.host !== undefined)) {
    return send(res, 400, { error: 'provide exactly one of url or host' })
  }
  if (request.host !== undefined && /[/:@\s]/.test(request.host)) {
    return send(res, 400, { error: 'host must be a bare hostname or IP (no scheme, port, or path)' })
  }
  const result = await scanHosts(request, ctx.discovery.probeList(), ctx.discovery.capabilityMap(), {
    resolveKey: (ref) => ctx.secrets.resolve(ref),
  })
  send(res, 200, result)
}

/**
 * Begin downloading ONE starter model into the data root models/ dir (tier zero, slice c). The EXPLICIT
 * user click — never auto-downloads. The download runs in the background (resume + size check); this
 * returns the model's current LocalModelStatus immediately and the browser polls GET /fabric/local/models
 * for progress. Unknown model id ⇒ 404. Once ready, the "Set up a starter model" flow writes a `local`
 * endpoint into config-1 through the existing profile routes (no new write semantics), and the runtime
 * manager spawns it on the first invoke/health.
 */
async function downloadModel(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext): Promise<void> {
  const body = await readJson(req)
  const errors = validationErrors('LocalDownloadRequest', body)
  if (errors.length > 0) return send(res, 400, { error: 'invalid LocalDownloadRequest', details: errors })
  const status = ctx.models.download((body as LocalDownloadRequest).modelId)
  if (!status) return send(res, 404, { error: `no such starter model: ${(body as LocalDownloadRequest).modelId}` })
  send(res, 200, status)
}

/**
 * Test-button backing: probe ONE endpoint's reachability (the setup page's per-row Test). A thin,
 * read-only helper over the existing health check (fabric/health.ts) — it never invokes a model, it
 * pings. The keyRef (if any) is resolved from the secret store and injected as a bearer for the
 * probe, so an authed endpoint is tested honestly; a 401/403 or an unresolved keyRef becomes an
 * actionable `hint`. The body is an Endpoint (the row's current, possibly-unsaved values), so a user
 * can test before saving. Any previously MEASURED tok/s on the endpoint doc is echoed (not measured here).
 */
async function testEndpoint(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext): Promise<void> {
  const raw = await readJson(req)
  // `probe` + `slot` are additive TEST-request fields, stripped before Endpoint validation (the Endpoint
  // schema is additionalProperties:false, and they are not part of the stored document). `probe:'generate'`
  // asks for a REAL 1-token completion through the invoke path; `slot` lets the server skip generation for
  // an stt row (a generation probe needs audio — out of scope).
  const probeMode = (raw as { probe?: unknown }).probe
  const slot = (raw as { slot?: unknown }).slot
  const { probe: _p, slot: _s, ...rest } = raw as Record<string, unknown>
  const errors = validationErrors('Endpoint', rest)
  if (errors.length > 0) return send(res, 400, { error: 'invalid Endpoint', details: errors })
  const endpoint = rest as Endpoint

  const health = await checkEndpoint(endpoint, 4_000, (ref) => ctx.secrets.resolve(ref), ctx.runtime)
  const probe: EndpointProbe = { ok: health.ok }
  if (health.latencyMs !== undefined) probe.latencyMs = health.latencyMs
  const tokPerSec = endpoint.measured?.tokPerSec
  if (tokPerSec !== undefined) probe.tokPerSec = tokPerSec
  if (!health.ok && health.error !== undefined) {
    probe.error = health.error
    const hint = probeHint(health.error, endpoint)
    if (hint !== undefined) probe.hint = hint
  }
  if (probeMode === 'generate') probe.generate = await runGenerateProbe(endpoint, typeof slot === 'string' ? slot : undefined, ctx)
  send(res, 200, probe)
}

/** The probe prompt — a plain, model-answerable question so the reply is real text we can show back. */
const PROBE_PROMPT = "We are testing access from this host — simply respond 'yes' if you can hear us."

/** Cap the reply shown in the Test area (~200 chars) — proof it answered, not the whole completion. */
const truncateSample = (text: string): string | undefined => {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed
}

/**
 * Run a REAL-generation probe against ONE endpoint — an actual completion through the ACTUAL invoke
 * path, so a server that pings 200 but can't load its model (the user's LM Studio 400) is caught
 * honestly and CLASSIFIED (unreachable/timeout/auth/model-load/bad-response). On success it carries the
 * model's actual reply (`sample`) so Test shows proof, not a checkmark. An stt endpoint is
 * skipped-with-note (audio is out of scope). On a model-load failure the hint gains the loaded-model
 * suggestion (what the server DOES have). Value-free re keys — an auth failure names the keyRef only.
 */
async function runGenerateProbe(endpoint: Endpoint, slot: string | undefined, ctx: HandlerContext): Promise<GenerateProbe> {
  if (slot === 'stt') {
    return { ok: false, skipped: true, note: 'a generation probe needs audio — not run for stt endpoints' }
  }
  const genFabric: Fabric = { slots: { stt: [], tts: [], llm: [endpoint], vlm: [], ocr: [], embed: [] } }
  const started = performance.now()
  try {
    // A REAL prompt at a REAL budget: the point is proof the host can reach a live model, so we ask a
    // question a model actually answers and give it room to answer (~128 tokens). At 1 token every
    // reasoner looked "exhausted"; at 128 most return genuine text we can show back as the sample.
    const result = await invokeLlm(genFabric, [{ role: 'user', content: PROBE_PROMPT }], {
      maxTokens: 128,
      // A cold 12B load (~6.3s) plus generation exceeded the old 8s budget, so the first Test press on a
      // cold model timed out; 30s covers a cold load + the completion. The reachability ping
      // (checkEndpoint above) stays snappy — it only proves the socket answers, not that a model loaded.
      timeoutMs: 30_000,
      resolveKey: (ref) => ctx.secrets.resolve(ref),
      runtimeManager: ctx.runtime,
    })
    const latencyMs = Math.round(performance.now() - started)
    const sample = truncateSample(result.text)
    return { ok: true, latencyMs, ...(sample !== undefined ? { sample } : {}) }
  } catch (error) {
    const classified = describeInvokeFailure(error)
    if (!classified) return { ok: false, error: error instanceof Error ? error.message : String(error) }
    // A reasoning model spends the probe's whole 1-token budget THINKING (qwen3.5/LFM2.5-class) — the
    // server answered, the model LOADED and generated a token, which is exactly what this probe exists
    // to prove. Count it as generation ✓ with a note; real invocations run with a real token budget.
    if (classified.class === 'reasoning-exhausted') {
      return { ok: true, latencyMs: Math.round(performance.now() - started), note: 'reasoning model — probe budget went to thinking; the model loaded and generated' }
    }
    const hint = await enrichFailureHint(classified)
    return {
      ok: false,
      class: classified.class,
      ...(classified.serverMessage !== undefined ? { error: classified.serverMessage } : {}),
      hint,
    }
  }
}

/** Map a probe failure to an actionable next step — the honest "why it failed, what to do" line. */
function probeHint(error: string, endpoint: Endpoint): string | undefined {
  const keyRef = endpoint.kind === 'http' ? endpoint.auth?.keyRef : undefined
  if (/unresolved secret keyRef/.test(error)) return 'no value stored for this keyRef yet — add it under Keys below'
  if (/HTTP 401|HTTP 403/.test(error)) {
    return keyRef !== undefined
      ? `authorization rejected — the stored value for keyRef "${keyRef}" may be wrong`
      : 'authorization required — add a key under Keys below and reference it via keyRef'
  }
  return undefined
}

/** Serve one fabric profile document by id. Unknown id ⇒ 404. */
function getProfile(res: ServerResponse, ctx: HandlerContext, id: string): void {
  const found = ctx.fabric.profiles.get(id)
  if (!found) return send(res, 404, { error: `no such profile: ${id}` })
  send(res, 200, found)
}

/**
 * Create or update a fabric profile (everything user-configurable is a versioned, cloneable
 * document). The body must validate as a FabricProfile and its id must match the route; the store
 * stamps the next version. If this profile is the active one, the live fabric changed → fabric.changed.
 */
async function putProfile(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext, id: string): Promise<void> {
  const body = await readJson(req)
  const errors = validationErrors('FabricProfile', body)
  if (errors.length > 0) return send(res, 400, { error: 'invalid FabricProfile', details: errors })
  const incoming = body as FabricProfile
  if (incoming.id !== id) return send(res, 400, { error: 'profile id does not match route' })
  const saved = ctx.fabric.profiles.save(incoming)
  if (ctx.fabric.profiles.activeId() === id) await ctx.bus.publish('fabric.changed', ctx.fabric.load())
  send(res, 200, saved)
}

/**
 * Delete a fabric profile. Refuses (409) to delete the ACTIVE profile — activate another first, so
 * the live fabric is never silently emptied. Unknown id ⇒ 404. Returns the deleted profile.
 */
function deleteProfile(res: ServerResponse, ctx: HandlerContext, id: string): void {
  const found = ctx.fabric.profiles.get(id)
  if (!found) return send(res, 404, { error: `no such profile: ${id}` })
  if (ctx.fabric.profiles.activeId() === id) {
    return send(res, 409, { error: 'cannot delete the active profile; activate another first' })
  }
  ctx.fabric.profiles.delete(id)
  send(res, 200, found)
}

/** Clone a profile under a new id (copying a document). Source unknown ⇒ 404. Returns the clone. */
async function cloneProfile(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext, sourceId: string): Promise<void> {
  const body = await readJson(req)
  const errors = validationErrors('CloneProfileRequest', body)
  if (errors.length > 0) return send(res, 400, { error: 'invalid CloneProfileRequest', details: errors })
  const request = body as CloneProfileRequest
  if (ctx.fabric.profiles.get(request.id)) return send(res, 409, { error: `profile already exists: ${request.id}` })
  const clone = ctx.fabric.profiles.clone(sourceId, request.id, request.name)
  if (!clone) return send(res, 404, { error: `no such profile: ${sourceId}` })
  send(res, 200, clone)
}

/**
 * Activate a profile — its map becomes the live fabric (what invoke/health/bench run against).
 * Unknown id ⇒ 404. Emits fabric.changed with the now-live fabric. Returns the activated profile.
 */
async function activateProfile(res: ServerResponse, ctx: HandlerContext, id: string): Promise<void> {
  const activated = ctx.fabric.profiles.activate(id)
  if (!activated) return send(res, 404, { error: `no such profile: ${id}` })
  await ctx.bus.publish('fabric.changed', ctx.fabric.load())
  send(res, 200, activated)
}

/**
 * Store a secret VALUE under a ref (write-only inbound path). The value is validated as a
 * SecretValue and handed to the secret store; the response is a bare SecretRef — the value is NEVER
 * echoed back. This is the never-echo-to-UI discipline: no response/event/document carries the key.
 */
async function putSecret(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext, ref: string): Promise<void> {
  const body = await readJson(req)
  const errors = validationErrors('SecretValue', body)
  if (errors.length > 0) return send(res, 400, { error: 'invalid SecretValue', details: errors })
  ctx.secrets.set(ref, (body as SecretValue).value)
  send(res, 200, { ref })
}

/** Forget a secret. Unknown ref ⇒ 404. Returns the ref (never a value). */
function deleteSecret(res: ServerResponse, ctx: HandlerContext, ref: string): void {
  if (!ctx.secrets.delete(ref)) return send(res, 404, { error: `no such secret: ${ref}` })
  send(res, 200, { ref })
}

async function saveFlag(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext, key: string): Promise<void> {
  const body = await readJson(req)
  const errors = validationErrors('Flag', body)
  if (errors.length > 0) return send(res, 400, { error: 'invalid Flag', details: errors })
  const flag = body as Flag
  if (flag.key !== key) return send(res, 400, { error: 'flag key does not match route' })
  ctx.store.layouts.put('flag', flag.key, flag)
  await ctx.bus.publish('flag.changed', flag)
  send(res, 200, flag)
}

async function captureChunk(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext, source: string): Promise<void> {
  const body = await readJson(req)
  const errors = validationErrors('CaptureChunk', body)
  if (errors.length > 0) return send(res, 400, { error: 'invalid CaptureChunk', details: errors })
  const chunk = body as CaptureChunk
  if (chunk.source !== source) return send(res, 400, { error: 'capture source does not match route' })
  // The client cannot choose this field: the closed CaptureChunk contract was validated above. Stamp the
  // current screen owner only now, then persist and publish the same engine-owned row so ingest and drain
  // cannot make independent decisions if workflow.enabled changes while the frame is in flight.
  const queuedChunk = latchScreenRecognitionOwner(chunk, isFlagEnabled(ctx.store, 'workflow.enabled'))
  await ctx.queue.append(queuedChunk)
  // Append succeeded: only now may the live read model claim the physical capture was queued. Publish the
  // safe metadata row before capture.received wakes the fire-and-forget screen processor, so a very fast
  // OCR completion can never overtake and then be visually regressed by a stale queued event.
  await publishSenseLaneUpdates(ctx.bus, ctx.senseLanes.recordCapture(queuedChunk))
  ctx.onCapture?.(queuedChunk)
  await ctx.bus.publish('capture.received', queuedChunk)
  ctx.queue.scheduleDrain(ctx.log)
  await ctx.bus.publish('queue.updated', await surfacedQueueStatus(ctx))
  const ack: Ack = { ok: true, chunkId: chunk.id, sequence: chunk.sequence, receivedAt: new Date().toISOString() }
  send(res, 200, ack)
}

function sendContract(url: URL, res: ServerResponse): void {
  const name = decodeURIComponent(url.pathname.slice('/contracts/'.length))
  const schema = schemaByName(name)
  if (!schema) return send(res, 404, { error: `unknown contract: ${name}` })
  send(res, 200, schema)
}

/**
 * List a workspace's sessions (default `default`), most recently started first. `?live=true`
 * narrows to the (at most one) unended session — the HUD's Now line keys off it. Mirrors
 * readMoments: unknown workspace is an empty list, not an error.
 */
function readSessions(store: WorkspaceRegistry, url: URL): Session[] {
  const workspaceId = url.searchParams.get('workspace') ?? 'default'
  const live = url.searchParams.get('live') === 'true'
  return store.listSessions(workspaceId, live ? { live: true } : {})
}

/**
 * Start a manual session. The caller supplies workspaceId + modeId (+ optional registerId/title);
 * the engine stamps id/startedAt and a single 'manual' attribution at confidence 1.0. Concurrency
 * (see PHASE2-NOTES): ONE live session per workspace — if one is already live, it is auto-ended
 * (session.ended emitted) before the new one starts. No session.switched: that event is the
 * router's (P3); a manual start is two discrete lifecycle events, not a detected context switch.
 */
async function startSession(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext): Promise<void> {
  const body = await readJson(req)
  const errors = validationErrors('StartSessionRequest', body)
  if (errors.length > 0) return send(res, 400, { error: 'invalid StartSessionRequest', details: errors })
  const request = body as StartSessionRequest
  const now = new Date().toISOString()

  const live = ctx.store.liveSession(request.workspaceId)
  if (live) {
    const ended: Session = { ...live, endedAt: now }
    ctx.store.saveSession(ended)
    await ctx.bus.publish('session.ended', ended)
    ctx.log(`auto-ended live session ${live.id} on start-while-live in workspace ${request.workspaceId}`)
  }

  const session: Session = {
    id: randomUUID(),
    workspaceId: request.workspaceId,
    modeId: request.modeId,
    startedAt: now,
    attribution: { evidence: [{ kind: 'manual', detail: 'started manually', weight: 1 }], confidence: 1 },
    ...(request.registerId !== undefined ? { registerId: request.registerId } : {}),
    ...(request.title !== undefined ? { title: request.title } : {}),
  }
  ctx.store.saveSession(session)
  await ctx.bus.publish('session.started', session)
  send(res, 200, session)
}

/**
 * End a session by id (server-stamps endedAt). Idempotent: ending an already-ended session returns
 * it unchanged and emits no second session.ended. Unknown id ⇒ 404. The session is looked up across
 * workspaces (ids are globally unique) since the route addresses it without its workspace.
 */
async function endSession(res: ServerResponse, ctx: HandlerContext, id: string): Promise<void> {
  const session = ctx.store.findSession(id)
  if (!session) return send(res, 404, { error: `no such session: ${id}` })
  if (session.endedAt !== undefined) return send(res, 200, session)
  const ended: Session = { ...session, endedAt: new Date().toISOString() }
  ctx.store.saveSession(ended)
  await ctx.bus.publish('session.ended', ended)
  send(res, 200, ended)
}

/**
 * Retroactively reroute a session to another workspace (Phase 3 — the correction loop the router's
 * mistakes require; shipped BEFORE the detector per IMPLEMENTATION §3's risk register, so corrections
 * exist before the mistakes do). Body is a RerouteRequest { toWorkspaceId }; the session is addressed
 * by the route id. Policy lives in route/reroute.ts (route decides, store moves — the DB-handle rule):
 * 404 unknown session, 400 same/unknown workspace, 409 a still-live session. On success the moved
 * session (reroutedFrom stamped, a manual attribution appended) is returned and session.rerouted is
 * emitted + WS-broadcast — a NEW event, distinct from the router's live session.switched (see events.ts).
 */
async function reroute(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext, id: string): Promise<void> {
  const body = await readJson(req)
  const errors = validationErrors('RerouteRequest', body)
  if (errors.length > 0) return send(res, 400, { error: 'invalid RerouteRequest', details: errors })
  const result = rerouteSession(ctx.store, id, (body as RerouteRequest).toWorkspaceId)
  if (result.status !== 200) return send(res, result.status, { error: result.error })
  await ctx.bus.publish('session.rerouted', result.session)
  ctx.log(`rerouted session ${id} → workspace ${result.session.workspaceId} (from ${result.session.reroutedFrom})`)
  send(res, 200, result.session)
}

/**
 * Serve extracted moments for a workspace (default `default`), optionally narrowed to a session.
 * Mirrors how registers/distillates are served — a read over store/, the only DB-handle holder.
 * An unknown workspace is an empty list, not an error.
 */
function readMoments(store: WorkspaceRegistry, url: URL): Moment[] {
  const workspaceId = url.searchParams.get('workspace') ?? 'default'
  if (!store.all().some((ws) => ws.id === workspaceId)) return []
  const sessionId = url.searchParams.get('session')
  return sessionId ? store.listMoments(workspaceId, sessionId) : store.listMoments(workspaceId)
}

/**
 * Serve the entity index for a workspace (default `default`), most recently seen first. Mirrors
 * readMoments: a read over store/, unknown workspace is an empty list, not an error.
 */
function readEntities(store: WorkspaceRegistry, url: URL): Entity[] {
  const workspaceId = url.searchParams.get('workspace') ?? 'default'
  if (!store.all().some((ws) => ws.id === workspaceId)) return []
  return store.listEntities(workspaceId)
}

/**
 * Serve the relevant-now join: entities ranked by recency×frequency, each with the recent moments
 * that reference it (`?workspace=&session=&limit=`). The join itself lives in index/relevant.ts.
 */
function readRelevant(store: WorkspaceRegistry, url: URL): RelevantEntity[] {
  const workspaceId = url.searchParams.get('workspace') ?? 'default'
  const sessionId = url.searchParams.get('session')
  const limitRaw = Number(url.searchParams.get('limit'))
  return relevantNow(store, workspaceId, {
    ...(sessionId !== null ? { sessionId } : {}),
    ...(Number.isInteger(limitRaw) && limitRaw > 0 ? { limit: limitRaw } : {}),
  })
}

/**
 * Serve prepared follow-up drafts for a workspace (default `default`), optionally narrowed to a
 * session. Mirrors readMoments: a read over store/, the only DB-handle holder; an unknown workspace
 * is an empty list, not an error. This is how a draft is retrieved after the call (Phase-2 exit).
 */
function readDrafts(store: WorkspaceRegistry, url: URL): Draft[] {
  const workspaceId = url.searchParams.get('workspace') ?? 'default'
  if (!store.all().some((ws) => ws.id === workspaceId)) return []
  const sessionId = url.searchParams.get('session')
  return sessionId ? store.listDrafts(workspaceId, sessionId) : store.listDrafts(workspaceId)
}

/**
 * Serve a session's to-do document by session id — the read seam the HUD renders (a resource route,
 * no flag, mirroring GET /drafts and GET /layouts/surfaces/:id; the DATA is gated upstream by act.tasks
 * which produces it). Unknown session ⇒ 404 (no list exists until extraction or a user edit creates it).
 */
function getTodo(res: ServerResponse, ctx: HandlerContext, sessionId: string): void {
  const list = ctx.todos.get(sessionId)
  if (!list) return send(res, 404, { error: `no to-do list for session: ${sessionId}` })
  send(res, 200, list)
}

/**
 * Persist an edited to-do document (everything user-configurable is a versioned, cloneable document —
 * this is the editable half of the constrain/unconstrain loop). The body must validate as a TodoList
 * and its sessionId must match the route; the store stamps the next version and preserves history, so
 * the NEXT follow-up draft reads the user's edited items via {{todo}}. No flag — a document write is a
 * resource route, not a gated behavior (rule 3, consistent with PUT /layouts/surfaces/:id).
 */
async function putTodo(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext, sessionId: string): Promise<void> {
  const body = await readJson(req)
  const errors = validationErrors('TodoList', body)
  if (errors.length > 0) return send(res, 400, { error: 'invalid TodoList', details: errors })
  const incoming = body as TodoList
  if (incoming.sessionId !== sessionId) return send(res, 400, { error: 'to-do list sessionId does not match route' })
  send(res, 200, ctx.todos.save(incoming))
}

/**
 * Serve a workflow document by id — the read seam the workflow editor renders (a resource route, no
 * flag, mirroring GET /layouts/surfaces/:id and GET /todos/:id). `workflow-default` always resolves
 * (seeded + code fallback); an unknown id ⇒ 404 (only `workflow-default` exists today, until a user
 * authors another via PUT). The executor reads the SAME record fresh per drain, so this is exactly the
 * document it runs.
 */
function getWorkflow(res: ServerResponse, ctx: HandlerContext, id: string): void {
  const spec = ctx.workflow.get(id)
  if (!spec) return send(res, 404, { error: `no such workflow: ${id}` })
  send(res, 200, spec)
}

/**
 * Persist an edited workflow document — the highest-leverage write in the P4 tail: it makes the
 * PIPELINE user-composable over the API. The body must validate as a WorkflowSpec (Tier-A gate: the
 * CLOSED `kind` union rejects an unrunnable step kind AT WRITE TIME, so a wrong document never reaches
 * the executor as a silent no-op) and its id must match the route; the store stamps the next version
 * and keeps history. The executor reads `active()` fresh per drain / session-end, so a stored edit
 * takes effect with NO restart and NO executor change (the whole point of the read-fresh seam). The saved
 * document is published as workflow.updated so clients invalidate derived `/senses` diagnostics even when
 * workflow.enabled was already on and no flag/fabric event accompanies the edit.
 *
 * PUT-unknown-id policy: an unknown id CREATES a new workflow (version 1), it does NOT 404 — mirroring
 * PUT /todos (which creates a session's list on first write) and PUT /layouts/surfaces/:id. Only
 * `workflow-default` exists today, but the executor's `active()` is pinned to that id, so authoring a
 * NEW named workflow is inert until a future "which workflow is active" selector wires it in — creating
 * it here is a harmless, forward-compatible document write, and refusing it would make the resource
 * write-once for the default alone, out of step with every other document route. A malformed body
 * (bad kind, missing steps) is still rejected by save()'s validation → 400 via the invalid-body guard.
 */
async function putWorkflow(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext, id: string): Promise<void> {
  const body = await readJson(req)
  const errors = validationErrors('WorkflowSpec', body)
  if (errors.length > 0) return send(res, 400, { error: 'invalid WorkflowSpec', details: errors })
  const incoming = body as WorkflowSpec
  if (incoming.id !== id) return send(res, 400, { error: 'workflow id does not match route' })
  const saved = ctx.workflow.save(incoming)
  await ctx.bus.publish('workflow.updated', saved)
  send(res, 200, saved)
}

/**
 * Serve an app-bundle document by id — the read seam the tray Apps catalog and (later) a bundle editor
 * render (a resource route, no flag, mirroring GET /workflows/:id). `bundle-standard-app` always resolves
 * (seeded + code fallback); an unknown id ⇒ 404 (only the Standard App exists today, until a user authors
 * another via PUT).
 */
function getBundle(res: ServerResponse, ctx: HandlerContext, id: string): void {
  const doc = ctx.bundles.get(id)
  if (!doc) return send(res, 404, { error: `no such bundle: ${id}` })
  send(res, 200, doc)
}

/**
 * Persist an edited app-bundle document — the write half of the document seam. The body must validate as a
 * Bundle (Tier-A gate: the CLOSED face-kind / chat-source unions reject an unrunnable face role or an
 * ungatherable chat source AT WRITE TIME) and its id must match the route; the store stamps the next
 * version and keeps history.
 *
 * PUT-unknown-id policy: an unknown id CREATES a new bundle (version 1), it does NOT 404 — mirroring PUT
 * /workflows /todos /layouts/surfaces/:id (no other document write 404s on a fresh id). This slice is
 * read-only consumption on the client; authoring a NEW named bundle over the API is a forward-compatible
 * document write. A malformed body ⇒ 400 via save()'s validation, never persisted.
 */
async function putBundle(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext, id: string): Promise<void> {
  const body = await readJson(req)
  const errors = validationErrors('Bundle', body)
  if (errors.length > 0) return send(res, 400, { error: 'invalid Bundle', details: errors })
  const incoming = body as Bundle
  if (incoming.id !== id) return send(res, 400, { error: 'bundle id does not match route' })
  send(res, 200, ctx.bundles.save(incoming))
}

/**
 * Serve a prompt-template document by id — the read seam the (future) prompt editor renders, mirroring
 * GET /workflows/:id. The three shipped defaults (tpl-distill/extract/entities-default) always resolve
 * (seeded + code fallback); an unknown id ⇒ 404 until a user authors one via PUT. The pipeline reads the
 * SAME record fresh per pass, so this is exactly the template it runs.
 */
function getTemplate(res: ServerResponse, ctx: HandlerContext, id: string): void {
  const doc = ctx.distill.templateById(id)
  if (!doc) return send(res, 404, { error: `no such template: ${id}` })
  send(res, 200, doc)
}

/**
 * Persist an edited prompt template — the write that makes the PROMPT layer user-composable over the API
 * (the prerequisite for the fast-fields prompt-document layer, #61). The body must validate as a
 * PromptTemplate and its id must match the route; the store keeps version history. An unknown id CREATES
 * (mirroring PUT /workflows /todos /hints — no other document write 404s on a fresh id), so authoring a
 * new named template is a forward-compatible document write. A malformed body ⇒ 400, never persisted.
 */
async function putTemplate(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext, id: string): Promise<void> {
  const body = await readJson(req)
  const errors = validationErrors('PromptTemplate', body)
  if (errors.length > 0) return send(res, 400, { error: 'invalid PromptTemplate', details: errors })
  const incoming = body as PromptTemplate
  if (incoming.id !== id) return send(res, 400, { error: 'template id does not match route' })
  send(res, 200, ctx.distill.saveTemplate(incoming))
}

/**
 * GET /active-preset?workspace=<id> — the workspace's ACTIVE context-preset selection plus the five
 * choices (pill P2). `presetId` is null when unset (⇒ no injection, today's behavior). `presets` is the
 * list a picker renders (client UI is a later slice; the read is honest now). No 404: an unset workspace
 * is a valid state, not a missing resource.
 */
function getActivePreset(res: ServerResponse, ctx: HandlerContext, url: URL): void {
  const workspaceId = url.searchParams.get('workspace') ?? 'default'
  const presetId = ctx.presets.activeId(workspaceId) ?? null
  send(res, 200, { workspaceId, presetId, presets: ctx.presets.list() })
}

/**
 * PUT /active-preset?workspace=<id> — set (or clear) the workspace's active context preset. Body:
 * `{ presetId: string | null }`. HONEST validation: an absent or explicitly `null` presetId clears the
 * selection (back to no injection); a present, non-null presetId that is not a string ⇒ 400; selecting a
 * preset id that does not resolve to a live preset document ⇒ 400 (never silently ignored). On success the
 * workspace's next distill pass prepends the selected preset (read-fresh — no restart), and the response
 * echoes the new state.
 */
async function putActivePreset(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext, url: URL): Promise<void> {
  const workspaceId = url.searchParams.get('workspace') ?? 'default'
  const body = (await readJson(req)) as { presetId?: unknown }
  const raw = body.presetId
  if (raw === null || raw === undefined) {
    ctx.presets.setActive(workspaceId, undefined)
    return send(res, 200, { workspaceId, presetId: null })
  }
  if (typeof raw !== 'string') return send(res, 400, { error: 'presetId must be a string or null' })
  if (!ctx.presets.isPreset(raw)) return send(res, 400, { error: `no such preset: ${raw}` })
  ctx.presets.setActive(workspaceId, raw)
  send(res, 200, { workspaceId, presetId: raw })
}

/**
 * Serve a register (voice preset) by id — the by-id read symmetric with GET /workflows/:id. The shipped
 * builtins always resolve (seeded + code fallback); an unknown id ⇒ 404. GET /registers stays the list.
 */
function getRegister(res: ServerResponse, ctx: HandlerContext, id: string): void {
  const doc = ctx.voice.registerById(id)
  if (!doc) return send(res, 404, { error: `no such register: ${id}` })
  send(res, 200, doc)
}

/**
 * Persist an edited register — registers were read-only (GET /registers only); #23 exposes the existing
 * VoiceDocuments.saveRegister over PUT, mirroring PUT /workflows. Validated as a Register, id must match
 * the route, unknown id CREATES (saveRegister appends to the register index). Malformed body ⇒ 400.
 */
async function putRegister(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext, id: string): Promise<void> {
  const body = await readJson(req)
  const errors = validationErrors('Register', body)
  if (errors.length > 0) return send(res, 400, { error: 'invalid Register', details: errors })
  const incoming = body as Register
  if (incoming.id !== id) return send(res, 400, { error: 'register id does not match route' })
  send(res, 200, ctx.voice.saveRegister(incoming))
}

/**
 * Serve a mode (capture/distill preset) by id — the by-id read the route table already declared. The
 * shipped meeting mode always resolves; an unknown id ⇒ 404. GET /modes stays the list.
 */
function getMode(res: ServerResponse, ctx: HandlerContext, id: string): void {
  const doc = ctx.distill.modeById(id)
  if (!doc) return send(res, 404, { error: `no such mode: ${id}` })
  send(res, 200, doc)
}

/**
 * Persist an edited mode — modes were read-only (GET /modes only) despite the route table declaring PUT
 * /modes/:id; #23 wires the handler over DistillDocuments.saveMode, mirroring PUT /workflows. Validated
 * as a Mode, id must match the route, unknown id CREATES. Malformed body ⇒ 400, never persisted.
 */
async function putMode(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext, id: string): Promise<void> {
  const body = await readJson(req)
  const errors = validationErrors('Mode', body)
  if (errors.length > 0) return send(res, 400, { error: 'invalid Mode', details: errors })
  const incoming = body as Mode
  if (incoming.id !== id) return send(res, 400, { error: 'mode id does not match route' })
  send(res, 200, ctx.distill.saveMode(incoming))
}

/**
 * Serve a workspace's pins — pinned canon (P4D). A pin is a WORKSPACE-level record (like an entity, not
 * session-keyed), so it is workspace-scoped via `?workspace=` (default `default`); mirrors readEntities:
 * a read over store/, unknown workspace is an empty list, not an error. The pin's `ingest.status` tells
 * the truth about whether it has been fetched/chunked yet (pending → POST /pins/:id/ingest resolves it).
 */
function readPins(store: WorkspaceRegistry, url: URL): Pin[] {
  const workspaceId = url.searchParams.get('workspace') ?? 'default'
  if (!store.all().some((ws) => ws.id === workspaceId)) return []
  return store.listPins(workspaceId)
}

/**
 * Create a pin record (its workspace comes from the body's `workspaceId`, so no route param). The body
 * must validate as a Pin — a freshly created pin carries `ingest.status: 'pending'` and no chunks until
 * POST /pins/:id/ingest fetches + page-anchors it; the store persists it to the workspace's own sqlite
 * file (DB-handle rule). Validation-first mirrors the other POST/PUT document routes (400 on a bad body).
 */
async function createPin(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext): Promise<void> {
  const body = await readJson(req)
  const errors = validationErrors('Pin', body)
  if (errors.length > 0) return send(res, 400, { error: 'invalid Pin', details: errors })
  send(res, 200, ctx.store.savePin(body as Pin))
}

/**
 * Run the ingest lifecycle for a pin (fetch → page-anchored chunk → persist pin_chunks + a terminal
 * `ingest.status`). The pin is addressed by id within its `?workspace=` (default `default`); unknown pin
 * ⇒ 404. The fetcher registry is the honest v0 set (file/url + the pdf HONEST STUB); `gdoc` is added ONLY
 * when the seeded `ingest.gdoc` flag is on (the seam, read per-call so it is hot-flippable). ingestPin
 * NEVER throws on a fetch failure — it records `ingest.status: 'failed'` with the fetcher's message and
 * returns that pin — so a pdf/gdoc/unreachable-url failure comes back as a 200 whose `ingest` states the
 * failure verbatim (the module reports it; the route does not fabricate success). NO logic change: this
 * is `ingestPin` over the existing store + fetcher seams.
 */
async function ingestPinRoute(res: ServerResponse, ctx: HandlerContext, id: string, url: URL): Promise<void> {
  const workspaceId = url.searchParams.get('workspace') ?? 'default'
  const pin = ctx.store.getPin(workspaceId, id)
  if (!pin) return send(res, 404, { error: `no such pin: ${id}` })
  const fetchers = defaultFetchers(isFlagEnabled(ctx.store, 'ingest.gdoc') ? { gdoc: true } : {})
  send(res, 200, await ingestPin(pin, { store: ctx.store, fetchers, log: ctx.log }))
}

/**
 * Serve a pin's page-anchored chunks in stable ordinal order — the "cite p. 42" read (each chunk keeps
 * the `page` it came from, absent for pageless sources). Addressed by pin id within its `?workspace=`
 * (default `default`); unknown pin ⇒ 404 (a not-yet-ingested pin returns []). A read over store/.
 */
function getPinChunks(res: ServerResponse, ctx: HandlerContext, id: string, url: URL): void {
  const workspaceId = url.searchParams.get('workspace') ?? 'default'
  const pin = ctx.store.getPin(workspaceId, id)
  if (!pin) return send(res, 404, { error: `no such pin: ${id}` })
  send(res, 200, ctx.store.listPinChunks(workspaceId, id))
}

/**
 * Serve SUGGESTED attribution-hint candidates for a workspace (`?workspace=`, default `default`) — the
 * teach loop's derivation (`deriveHintCandidates` over `TeachStore.list`) turned into inspectable, citable
 * chips. READ-ONLY and PURE: it never writes hints and never edits route/ (the loop suggests, the user
 * applies — auto-applying is a separate future slice). The TeachStore is stateless over store/, so it is
 * constructed per read; the derivation is the same one a future teach surface renders. NO logic change.
 */
function readTeachCandidates(store: WorkspaceRegistry, url: URL): HintCandidate[] {
  const workspaceId = url.searchParams.get('workspace') ?? 'default'
  return deriveHintCandidates(new TeachStore(store).list(workspaceId))
}

/**
 * POST /teach/entity — the #75 clarify affordance's answer. The user resolved an AMBIGUOUS entity mention
 * (a rival within the resolver's margin) by picking the linked candidate (`confirm`) or the rival
 * (`disambiguate`). We turn that ONE explicit action into two ENGINE-STAMPED writes over the store seam:
 *  1. a sovereign `EntityOverride` — the durable resolver short-circuit. On `confirm` it pins `heard` to the
 *     linked entity and rejects the rival; on `disambiguate` it pins `heard` to the RIVAL and rejects the
 *     once-linked entity (whose stale ambiguity is then cleared so its ask cannot re-appear). Recording
 *     `rejectedRivalId` is what stops the same wrong rival being re-offered.
 *  2. a labeled `TeachSignal` (kind alias-confirm / disambiguate) into the TeachStore — the audit + teach
 *     loop entry, keyed by the entity's workspace.
 * Provenance is engine-stamped (`at`, the signal id, `by:'the user'`) — never client-trusted; SUGGEST-NEVER-
 * AUTO-APPLY holds because nothing writes without this explicit user action. Publishing `entity.updated`
 * re-hydrates the HUD, so the now-settled row drops its ≟. Unknown entity/rival ⇒ 404; a `disambiguate`
 * with no rival ⇒ 400. Responds with the overridden (settled) entity.
 */
async function postEntityCorrection(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext): Promise<void> {
  const body = await readJson(req)
  const errors = validationErrors('EntityCorrection', body)
  if (errors.length > 0) return send(res, 400, { error: 'invalid EntityCorrection', details: errors })
  const correction = body as EntityCorrection
  const { workspaceId, entityId, heard, verdict, rivalId, rivalName } = correction
  const at = new Date().toISOString()

  if (verdict === 'disambiguate' && (rivalId === undefined || rivalId.length === 0)) {
    return send(res, 400, { error: 'disambiguate verdict requires a rivalId (the entity the mention really meant)' })
  }

  // The linked entity (the row the affordance rendered on) — needed for its name on a disambiguate reject.
  const linked = ctx.store.listEntities(workspaceId).find((e) => e.id === entityId)
  if (!linked) return send(res, 404, { error: `no entity ${entityId} in workspace ${workspaceId}` })

  const kind = verdict === 'confirm' ? 'alias-confirm' : 'disambiguate'
  // The host of the override is the entity the heard form is pinned TO: the linked candidate on a confirm,
  // the rival on a disambiguate. The rejectedRivalId is the OTHER one — never re-scored for this form again.
  const hostId = verdict === 'confirm' ? entityId : rivalId!
  const rejectedRivalId = verdict === 'confirm' ? rivalId : entityId
  const rejectedRivalName = verdict === 'confirm' ? rivalName : linked.name
  const override: EntityOverride = {
    at,
    by: 'the user',
    pinnedName: heard,
    ...(rejectedRivalId !== undefined ? { rejectedRivalId } : {}),
    ...(rejectedRivalName !== undefined ? { rejectedRivalName } : {}),
  }

  const settled = ctx.store.overrideEntity(workspaceId, hostId, override)
  if (!settled) return send(res, 404, { error: `no entity ${hostId} in workspace ${workspaceId}` })
  // On a disambiguate the ONCE-LINKED entity keeps a stale ambiguity marker — clear it so its ≟ is gone too.
  if (verdict === 'disambiguate') ctx.store.clearEntityAmbiguity(workspaceId, entityId)

  new TeachStore(ctx.store).record(
    captureEntityCorrection({
      kind,
      workspaceId,
      entityId,
      heard,
      ...(rivalId !== undefined ? { rivalId } : {}),
      ...(rivalName !== undefined ? { rivalName } : {}),
      pinnedEntityId: hostId,
      at,
    }),
  )

  await ctx.bus.publish('entity.updated', settled)
  ctx.log(`teach: entity correction ${kind} in ${workspaceId} — "${heard}" pinned to ${hostId} (rejected ${rejectedRivalId ?? 'none'})`)
  send(res, 200, settled)
}

/**
 * Serve a workspace's attribution-hints document by id — the read seam the /teach review surface renders
 * (a resource route, no flag, mirroring GET /workflows/:id and GET /todos/:id). Unknown workspace ⇒ 404:
 * only the default workspace is seeded with an (empty) hints doc; any other workspace has none until a
 * user PUTs one, so there is genuinely nothing to serve. GET /hints (the list) is the whole-fabric view
 * the detector scores against (hintsDocs.all()); this is the single-workspace view for editing.
 */
function getHints(res: ServerResponse, ctx: HandlerContext, workspaceId: string): void {
  const doc = ctx.hints.get(workspaceId)
  if (!doc) return send(res, 404, { error: `no hints document for workspace: ${workspaceId}` })
  send(res, 200, doc)
}

/**
 * Persist a workspace's attribution-hints document — the APPLY half of the teach loop. The user reviews a
 * SUGGESTED candidate from GET /teach/candidates and PUTs a hints doc that includes its pattern; the
 * detector reads hintsDocs.all() fresh per window, so an applied pattern takes effect with NO restart.
 * This is a PLAIN document edit (versioned, history-preserving via the store), NOT an auto-apply — the
 * route adds no derivation and touches no route/ logic (the loop suggests, the user applies).
 *
 * The body must validate as a WorkspaceHints and its workspaceId must match the route (mirroring PUT
 * /workflows/:id and PUT /todos/:id — a bad body ⇒ 400, an id/route mismatch ⇒ 400). Like those routes,
 * an unknown workspaceId is NOT a 404: the PUT CREATES the workspace's hints doc (version 1). We do not
 * gate on the workspace record existing — no other document write does (PUT /workflows creates on an
 * unknown id, createPin persists without a workspace-existence check), and inventing that policy here
 * would be out of step; an empty patterns array simply matches nothing.
 */
async function putHints(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext, workspaceId: string): Promise<void> {
  const body = await readJson(req)
  const errors = validationErrors('WorkspaceHints', body)
  if (errors.length > 0) return send(res, 400, { error: 'invalid WorkspaceHints', details: errors })
  const incoming = body as WorkspaceHints
  if (incoming.workspaceId !== workspaceId) return send(res, 400, { error: 'hints workspaceId does not match route' })
  send(res, 200, ctx.hints.put(incoming))
}

/**
 * Serve a surface (HUD layout) document by id — the first UI's single source of truth: the client
 * fetches this and renders it through the block renderer (no hardcoded layout). Unknown id ⇒ 404.
 */
function getSurface(res: ServerResponse, ctx: HandlerContext, id: string): void {
  const surface = ctx.surfaces.get(id)
  if (!surface) return send(res, 404, { error: `no such surface: ${id}` })
  send(res, 200, surface)
}

/**
 * Persist an edited surface document (everything user-configurable is a versioned, cloneable
 * document). The body must validate as a Surface and its id must match the route; the store stamps
 * the next version. No flag — serving/saving a layout document is a resource route, not a gated
 * behavior (consistent with /workspaces, /sessions; see PHASE2-NOTES). Publishes surface.updated with
 * the saved (version-bumped) document → WS, same pattern as fabric.changed — so a HUD rendering THIS
 * surface hot-reloads its layout within a second, no restart (PHASE3-NOTES).
 */
async function putSurface(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext, id: string): Promise<void> {
  const body = await readJson(req)
  const errors = validationErrors('Surface', body)
  if (errors.length > 0) return send(res, 400, { error: 'invalid Surface', details: errors })
  const incoming = body as Surface
  if (incoming.id !== id) return send(res, 400, { error: 'surface id does not match route' })
  const saved = ctx.surfaces.save(incoming)
  await ctx.bus.publish('surface.updated', saved)
  send(res, 200, saved)
}

/**
 * Compile a BlockQuery to store calls and return the hydrated QueryResult (surfaces.ts Phase-0
 * decision — the query is compiled server-side, so a custom block can never reach past what the
 * engine allows). This is how every block hydrates: GET the surface for the layout, POST /query per
 * block for its data. Session `current` binds to the workspace's live session at query time.
 *
 * APP INSTANCES (#99): `?surface=<id>` names the app instance this query runs under. When that surface
 * carries a `workspaceId` binding, it becomes the DEFAULT workspace for the query — so a context-agnostic
 * block reads the instance's OWN silo without the block naming a workspace. An explicit `params.workspace`
 * still wins (resolveScope). An unknown / unbound surface id is ignored (falls back to 'default') — the
 * binding is an optional convenience, never a hard dependency, so a plain block query is unchanged.
 */
async function runQuery(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext, surfaceId: string | null): Promise<void> {
  const body = await readJson(req)
  const errors = validationErrors('BlockQuery', body)
  if (errors.length > 0) return send(res, 400, { error: 'invalid BlockQuery', details: errors })
  const query = body as BlockQuery
  const boundWorkspace = surfaceId !== null ? ctx.surfaces.get(surfaceId)?.workspaceId : undefined
  // Injected sources are operational/computed engine state, NOT store records (the `queue` pattern): built
  // by the route and handed to compileQuery for exactly the source that needs them. status() and the ring
  // are cheap, but async status() is awaited only when needed. Every other source reads through store/.
  const sources = await buildQuerySources(query, ctx, boundWorkspace)
  send(res, 200, compileQuery(ctx.store, query, new Date(), sources, boundWorkspace))
}

/**
 * POST /chat (#134, context-assembly reads the declaration in pill P1) — the below-HUD chat shell's turn.
 * Resolves the governing bundle's DECLARED context-assembly plan and delegates the ordered, per-source-capped
 * corpus assembly + honest budget + the egress-gated invoke to chat.ts::runChat over a ChatDeps built from the
 * store/fabric here (the gatherers do the impure per-source reads the pure assembler consumes). Reuses the SAME
 * #63 guard config the distiller builds (guard.egress flag + policy + the fabric guard slot), so the chat
 * hop is filtered exactly like a distill hop. A FAILURE (empty llm slot, guard hold, transport) is caught
 * and returned as a 502 whose `error` the input block paints as visible text — the QA doctrine, no silent
 * no-op. A malformed body is a 400 before any model is touched.
 */
async function postChat(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext): Promise<void> {
  const body = await readJson(req)
  const errors = validationErrors('ChatRequest', body)
  if (errors.length > 0) return send(res, 400, { error: 'invalid ChatRequest', details: errors })
  const request = body as ChatRequest

  // The ephemeral-stream key for this turn's chat.delta frames — client-minted (so the sender can paint
  // its own in-flight turn) or engine-minted when absent (uniform frames; no one is listening for them).
  const turnId = request.turnId ?? `turn-${randomUUID()}`
  let seq = 0

  const fabric = ctx.fabric.load()
  const guardOn = isFlagEnabled(ctx.store, 'guard.egress')
  const policy = ctx.guardDocs.policy()
  const guard = guardOn
    ? { endpoints: fabric.slots.guard ?? [], behavior: policy.behavior, acknowledgeUnguardedEgress: policy.acknowledgeUnguardedEgress, resolveKey: (ref: string) => ctx.secrets.resolve(ref) }
    : undefined

  // Resolve the GOVERNING bundle and read its declared chat context-assembly plan — assembly is DATA (the
  // route reads the declaration), NOT code (pill P1). Chat is scoped to the workspace today and one app ships
  // (the Standard App), so the governing bundle is the seeded standard-app; editing its `chat` plan over PUT
  // /bundles changes assembly with no code change. A bundle that declares no plan falls back to the engine
  // default order (a safety net — the shipped bundle always declares one).
  const bundle = ctx.bundles.get(DEFAULT_BUNDLE_ID)
  const contextSources = bundle?.chat?.sources ?? DEFAULT_CONTEXT_SOURCES

  const known = (workspaceId: string): boolean => ctx.store.all().some((w) => w.id === workspaceId)
  const deps: ChatDeps = {
    fabric,
    contextSources,
    // The Standard App carries no custom prompt document yet, so its priming is the shipped engine default,
    // delivered through the declared `bundle-prompt` source (drop that source and the app runs without priming).
    bundlePrompt: BUNDLE_PROMPT,
    relevant: (workspaceId) => (known(workspaceId) ? relevantNow(ctx.store, workspaceId, {}) : []),
    // The underlying live-transcript ring remains process-global for diagnostics, but chat sees only
    // updates from sessions currently owned by its workspace. TranscriptUpdate carries sessionId (not a
    // duplicated workspaceId), so resolve the workspace's persisted session set at gather time; a rerouted
    // session therefore follows its current owner. Keep the structured records intact — the pure assembler
    // orders by capturedAt and renders a machine-owned physical-source/provenance envelope. Flattening text
    // here would make equal words from microphone and system audio indistinguishable.
    transcript: (workspaceId) => {
      const sessionIds = new Set(
        ctx.transcripts.recent().map((update) => update.sessionId)
          .filter((sessionId) => ctx.store.getSession(workspaceId, sessionId) !== undefined),
      )
      return ctx.transcripts.recentForSessions(sessionIds).filter((update) => update.text.trim() !== '')
    },
    // Session insights = the distillate summaries (oldest-first); the assembler keeps the most recent `limit`.
    insights: (workspaceId) => (known(workspaceId) ? ctx.store.listDistillates(workspaceId).map((d) => d.text).filter((t) => t.trim() !== '') : []),
    pinTitle: (workspaceId, pinId) => ctx.store.getPin(workspaceId, pinId)?.title,
    pinChunks: (workspaceId, pinId) => (ctx.store.getPin(workspaceId, pinId) ? ctx.store.listPinChunks(workspaceId, pinId) : []),
    // active-preset read-seam (pill P1×P2 integration): P2 owns preset documents/selection; here we FILL P1's
    // optional seam with `ctx.presets.resolveActive`, mapping the resolved preset document → P1's narrow
    // ActivePresetRef {label, text}. The seam is now PRESENT, so the `active-preset` source reports `empty`
    // (wired, none selected) rather than `unavailable`, and `included` once a workspace selects a preset —
    // the SAME resolver the distiller injects from, so chat context and distill injection agree on one truth.
    resolveActivePreset: (workspaceId) => {
      const preset = ctx.presets.resolveActive(workspaceId)
      return preset !== undefined ? { label: preset.name, text: preset.body } : undefined
    },
    workspaceDeniesEgress: (workspaceId) => ctx.store.all().find((w) => w.id === workspaceId)?.egress?.deny === true,
    ...(guard !== undefined ? { guard } : {}),
    resolveKey: (ref: string) => ctx.secrets.resolve(ref),
    runtimeManager: ctx.runtime,
    // Ask face `screen` source: read the send's one frame into text through the SAME screen-understanding
    // path the P4B processor uses (invokeOcr: paddle-serving blocks, or an openai-compat VLM in the ocr
    // slot). Consent is content-class `screen` — resolveEgress DENIES egress for screen content outright
    // (egress.ts, most-specific-denial-wins), and invokeOcr further restricts raw frame bytes to an
    // engine-managed runtime, loopback URL, or an explicitly `trustRawFrames`-flagged LAN-local endpoint;
    // untrusted LAN, wildcard, and public destinations are skipped before fetch.
    // Only the DERIVED TEXT then rides the chat hop, which runs the normal typed-content gate + #63 guard.
    screenText: async (workspaceId: string, screenshot: ChatScreenshot) => {
      const consent = resolveEgress({ contentClass: 'screen', workspaceDenies: ctx.store.all().find((w) => w.id === workspaceId)?.egress?.deny === true })
      const read = await invokeOcr(
        fabric,
        { image: screenshot.data, contentType: screenshot.contentType, timeoutMs: 30_000 },
        { resolveKey: (ref: string) => ctx.secrets.resolve(ref), runtimeManager: ctx.runtime, egress: consent },
      )
      return read.text
    },
    // Ask-history: the persisted per-workspace thread is what the recent-turns source reads (the store is
    // the truth; the request's history remains the fallback against an empty store — see runChat).
    recentTurns: (workspaceId: string) => ctx.store.listChatTurns(workspaceId, CHAT_HISTORY_LIMIT),
    // Streaming (the Ask face): publish each model-emitted chunk as an ephemeral chat.delta keyed by the
    // request's client-minted turnId (engine-minted when absent — nobody listens, but the shape is uniform).
    onDelta: (text: string) => {
      void ctx.bus.publish('chat.delta', { turnId, seq: seq++, text, done: false })
    },
  }

  try {
    const reply = await runChat(deps, request)
    // Persist the exchange to the workspace's app-scoped thread (ask-history) — the durable record the
    // chat window rehydrates from on open. Deliberately AFTER the turn succeeded (a failed turn leaves no
    // half-exchange) and after gathering (recent-turns must not see this turn's own user message).
    const workspaceId = request.workspace ?? 'default'
    ctx.store.appendChatTurn(workspaceId, { role: 'user', content: request.message })
    ctx.store.appendChatTurn(workspaceId, { role: 'assistant', content: reply.answer })
    send(res, 200, reply)
  } catch (error) {
    // Honest failure: name the reason (empty slot / held hop / transport) so the input block shows it.
    send(res, 502, { error: error instanceof Error ? error.message : String(error) })
  } finally {
    // The terminal stream frame — done:true whether the turn succeeded or failed, so a listener keyed to
    // this turnId always sees the end. Failure detail travels on the HTTP reply, never in the stream.
    void ctx.bus.publish('chat.delta', { turnId, seq, text: '', done: true })
  }
}

/** How many persisted turns the recent-turns gatherer and GET /chat/history read (the honest, disclosed tail). */
export const CHAT_HISTORY_LIMIT = 50

/**
 * GET /chat/history?workspace=<id> (the Ask face) — the workspace's persisted app-scoped chat thread,
 * oldest-first, capped at CHAT_HISTORY_LIMIT with the cut DISCLOSED (total + truncated), so the chat
 * window renders the recent conversation on open and never silently pretends the thread starts at the cap.
 * An unknown workspace reads as an empty thread (asking is not an error), mirroring listPins.
 */
function getChatHistory(res: ServerResponse, ctx: HandlerContext, url: URL): void {
  const workspaceId = url.searchParams.get('workspace') ?? 'default'
  const turns = ctx.store.listChatTurns(workspaceId, CHAT_HISTORY_LIMIT)
  const total = ctx.store.countChatTurns(workspaceId)
  const history: ChatHistory = { turns, total, truncated: total > turns.length }
  send(res, 200, history)
}

/**
 * The stt slot as the inspector's SttSlotEndpoint list — the CURRENT config (endpoint · model), the honest
 * separate line the inspector renders since per-chunk stt provenance is not recorded (#65). Empty stt slot
 * ⇒ [] (the block renders "stt slot: none configured"). Reads only endpoint name + model — never a secret.
 */
function sttSlotEndpoints(fabric: Fabric): SttSlotEndpoint[] {
  return fabric.slots.stt.map((e) => ({ endpoint: e.name, ...(e.model !== undefined && e.model !== '' ? { model: e.model } : {}) }))
}

/**
 * Build the injected QuerySources for a query, per source (the `queue` operational-state pattern extended to
 * #101's `transcript` inspector + `senses` gate chains and #174's live sense lanes). Each arm is operational/
 * computed engine state, not a store record, so the route composes it and compileQuery just wraps it into
 * the QueryResult. A source that needs no injection returns {} (unchanged behavior).
 */
async function buildQuerySources(query: BlockQuery, ctx: HandlerContext, defaultWorkspaceId?: string): Promise<QuerySources> {
  if (query.source === 'queue') return { queueStatus: await surfacedQueueStatus(ctx) }
  if (query.source === 'transcript') {
    return { transcript: { chunks: ctx.transcripts.recent(), sttSlot: sttSlotEndpoints(ctx.fabric.load()), ringLimit: ctx.transcripts.capacity } }
  }
  if (query.source === 'senses') {
    // The SAME pure verdict the Status-section render uses (flags + fabric + the queue's last classified
    // failure), WITHOUT the live checkEndpoint probe GET /senses affords — the block re-hydrates often, so a
    // per-refresh network probe would be wrong here; the health gate leans on lastFailure alone (disclosed).
    const status = await surfacedQueueStatus(ctx)
    return {
      senseGates: evaluateSenseGates({
        flags: readFlags(ctx.store),
        fabric: ctx.fabric.load(),
        activeWorkflow: ctx.workflow.active(),
        ...(status.lastFailure ? { lastFailure: status.lastFailure } : {}),
      }),
    }
  }
  if (query.source === 'live-senses') {
    // Scope exactly like every persisted query source: an explicit params.workspace wins over the bound
    // app-instance workspace, then `default`. Session truth is deliberately different: `current` (and an
    // omitted session) means the TRACKER'S current session for this process, never a stale persisted live
    // Session. Only a concrete id is passed through. snapshotSet owns canonical lane ordering and returns
    // the closed metadata-only SenseLaneSnapshot rows used by GET /senses/live.
    const { workspaceId } = resolveQueryScope(ctx.store, query.params, defaultWorkspaceId)
    const sessionParam = query.params['session']
    const explicitSessionId = typeof sessionParam === 'string' && sessionParam !== 'current' && sessionParam.length > 0
      ? sessionParam
      : undefined
    return { liveSenses: [...ctx.senseLanes.snapshotSet(workspaceId, explicitSessionId).lanes] }
  }
  return {}
}

/**
 * Instantiate an app INSTANCE from a template surface (#99): server-side deep-clone of the source doc's
 * blocks into a NEW surface with a fresh id and a bound workspace silo — so "the HUD for repo X" is one
 * call, and the instance's block queries read its own workspace (POST /query?surface=<newId>). Body (all
 * optional): `{ newId?, workspaceId?, title? }`. Defaults: `newId` is generated (`surf-<uuid>`); `title`
 * is "<source name> (copy)"; `workspaceId` is a slug derived from the title (`ws-<slug>`), else generated.
 * The bound workspace is ensureWorkspace'd so the silo is concrete (lazy-create means seeding would make it
 * anyway; binding it up front makes the instance immediately queryable). Version resets to 1 (a fresh doc,
 * not a version bump of the template). 404 unknown source; 409 if the chosen/generated newId already exists
 * (never silently clobber a surface). The cloned doc is contract-validated before write (last line of
 * defense). Publishes surface.updated so a subscribed shell sees the new instance without a restart.
 */
async function instantiateSurface(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext, sourceId: string): Promise<void> {
  const source = ctx.surfaces.get(sourceId)
  if (!source) return send(res, 404, { error: `no such surface: ${sourceId}` })
  const body = (await readJson(req)) as { newId?: unknown; workspaceId?: unknown; title?: unknown }
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined)

  const newId = str(body.newId) ?? `surf-${randomUUID()}`
  if (ctx.surfaces.get(newId)) return send(res, 409, { error: `surface id already exists: ${newId}` })
  const title = str(body.title) ?? `${source.name} (copy)`
  const workspaceId = str(body.workspaceId) ?? workspaceSlug(title)

  const instance: Surface = {
    ...structuredClone(source),
    id: newId,
    name: title,
    version: 1,
    workspaceId,
  }
  const errors = validationErrors('Surface', instance)
  if (errors.length > 0) return send(res, 400, { error: 'invalid Surface', details: errors })

  ctx.store.ensureWorkspace({ id: workspaceId, name: title })
  const saved = ctx.surfaces.save(instance)
  await ctx.bus.publish('surface.updated', saved)
  send(res, 201, saved)
}

/**
 * A stable, readable workspace id from an instance title (#99): `ws-<slug>` where the slug is the title
 * lowercased, non-alphanumerics collapsed to single hyphens, trimmed. An empty slug (a title of only
 * punctuation) falls back to a uuid so the id is always non-empty (the Id contract requires minLength 1).
 */
function workspaceSlug(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `ws-${slug.length > 0 ? slug : randomUUID()}`
}

/**
 * Record a per-item user signal (#66) — the write path behind the dismiss / mark-for-follow-up glyph
 * verbs, the honest end of "dismiss is currently inert". `at` is SERVER-stamped (timestamps are never
 * client-controlled), so the body carries only workspace/source/itemId/kind and this route stamps the
 * time before validating the full ItemSignal. The store de-dupes per (source, itemId, kind), so a
 * double-dismiss is idempotent. A `dismiss` signal is the SUPPRESSION record POST /query honors; a
 * `follow-up` signal is persisted in the same store, queryable. No flag — recording a user signal is a
 * resource write, not a gated engine behavior (mirrors createPin). The ItemSignalStore is stateless over
 * store/, constructed per call exactly like TeachStore in readTeachCandidates.
 */
async function postItemSignal(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext): Promise<void> {
  const body = await readJson(req)
  const stamped = { ...(body as Record<string, unknown>), at: new Date().toISOString() }
  const errors = validationErrors('ItemSignal', stamped)
  if (errors.length > 0) return send(res, 400, { error: 'invalid ItemSignal', details: errors })
  send(res, 200, new ItemSignalStore(ctx.store).add(stamped as ItemSignal))
}

/**
 * POST /guard-holds/resolve — RELEASE (let it proceed) or DENY (drop) a suspended egress hop (#63). Body:
 * `{ workspaceId, id, action: 'release'|'deny' }`. The status transition is stamped and the updated hold is
 * published on guard.hold.updated so the ledger's held indicator refreshes. This is the release/deny
 * affordance's HTTP action; automatically RE-DRIVING the exact held pass on release is deferred (the raw
 * content is not retained — fail closed), so release marks the hold resolved and surfaces it as such.
 */
async function resolveGuardHold(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext): Promise<void> {
  const body = (await readJson(req)) as { workspaceId?: unknown; id?: unknown; action?: unknown }
  const workspaceId = typeof body.workspaceId === 'string' && body.workspaceId !== '' ? body.workspaceId : 'default'
  const id = body.id
  const action = body.action
  if (typeof id !== 'string' || id === '') return send(res, 400, { error: 'guard-hold resolve requires an id' })
  if (action !== 'release' && action !== 'deny') return send(res, 400, { error: "guard-hold resolve requires action 'release' or 'deny'" })
  const status = action === 'release' ? 'released' : 'denied'
  const updated = ctx.guardHolds.resolve(workspaceId, id, status, new Date().toISOString())
  if (updated === undefined) return send(res, 404, { error: `no held hop "${id}" in workspace "${workspaceId}"` })
  await ctx.bus.publish('guard.hold.updated', updated)
  send(res, 200, updated)
}

/** PUT /guard/policy — edit the egress-guard verdict→behavior policy document (#63). Contract-validated,
 * version-bumped append-only via GuardDocuments; mirrors PUT /flags and saveFabric. */
async function saveGuardPolicy(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext): Promise<void> {
  const body = await readJson(req)
  const errors = validationErrors('GuardPolicy', body)
  if (errors.length > 0) return send(res, 400, { error: 'invalid GuardPolicy', details: errors })
  send(res, 200, ctx.guardDocs.savePolicy(body as GuardPolicy))
}

function readFlags(store: WorkspaceRegistry): Flag[] {
  // Ensure the shipped controls exist, then enumerate the live documents rather than only the seed list:
  // workflow steps may legally name a custom/alternate flag, and both the executor and screen-owner
  // diagnostics must observe that same stored value.
  ensureDefaultFlags(store)
  return store.layouts.latestOfKind<Flag>('flag').map((document) => document.body)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new MalformedJsonError('request body is not valid JSON')
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body, null, 2))
}
