import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import { AllSchemas, Routes, type Ack, type BlockQuery, type CaptureChunk, type CloneProfileRequest, type Draft, type Endpoint, type EndpointProbe, type Entity, type Fabric, type GenerateProbe, type FabricProfile, type Flag, type ItemSignal, type LocalDownloadRequest, type Mode, type Moment, type Pin, type PinChunk, type PromptTemplate, type Register, type RelevantEntity, type RerouteRequest, type ScanRequest, type SecretValue, type Session, type StartSessionRequest, type Surface, type TodoList, type WorkflowSpec, type WorkspaceHints } from '@openinfo/contracts'
import { Actor, ActDocuments, TodoDocuments, TaskExtractor } from '../act/index.js'
import { EventBus, type EngineEvents } from '../bus/index.js'
import { DistillDocuments, Distiller, DistillCadence, DEFAULT_DISTILL_CADENCE_MS, FieldValueStore, FastFieldScheduler, JudgeScheduler, transcribeChunks, buildTranscriptUpdates, type DistillOptions } from '../distill/index.js'
import { DiscoveryDocuments, FabricDocuments, FileSecretStore, LocalModelStore, LocalRuntimeManager, StarterModelsDocuments, checkEndpoint, discoverFabric, invokeLlm, invokeStt, describeInvokeFailure, enrichFailureHint, scanHosts, toQueueFailure, DEFAULT_NO_SPEECH_THRESHOLD, type SecretStore } from '../fabric/index.js'
import { relevantNow, ingestPin, defaultFetchers } from '../index/index.js'
import { TeachStore, deriveHintCandidates, type HintCandidate } from '../teach/index.js'
import { Attributor, HintsDocuments, extractFocusSignals, rerouteSession } from '../route/index.js'
import { isFlagEnabled } from '../flags/read.js'
import { CaptureQueue, DEFAULT_MAX_AGE_MINUTES } from '../queue/spool.js'
import { WorkspaceRegistry, resolveSecretsPath } from '../store/index.js'
import { WorkflowDocuments, WorkflowExecutor, type ScreenRunner } from '../workflow/index.js'
import { SurfaceDocuments, compileQuery, ItemSignalStore, renderSettingsPage, sectionById, defaultSectionId, renderSurfaceEditorPage, defaultHudSurface, evaluateSenseGates, type SetupData } from '../surfaces/index.js'
import type { EndpointHealth } from '../fabric/health.js'
import { handleScreen, getScreenProcessor } from '../screen/index.js'
import { VoiceDocuments } from '../voice/index.js'
import { ensureDefaultFlags } from './defaults.js'
import { schemaByName, validationErrors } from './validation.js'
import { readEngineVersion, readEngineBuild } from './version.js'
import { EventSocketHub } from './ws.js'

// Read ONCE at module load ("at startup") — the engine's own version + an optional build id, echoed on
// every /health so the client's version handshake needs no extra route. Static for the process lifetime.
const ENGINE_VERSION = readEngineVersion()
const ENGINE_BUILD = readEngineBuild()

export interface EngineApp {
  server: ReturnType<typeof createServer>
  bus: EventBus<EngineEvents>
  store: WorkspaceRegistry
  /** The context-switch router (route.detect). Exposed so the engine-side calendar collector, mounted
   * POST-createEngineApp by startCalendarCollector (P4C), feeds the SAME detector buffer the focus drain
   * feeds — mirroring how wireScreenOcr reaches the screen processor from main.ts. */
  attributor: Attributor
  close: () => Promise<void>
}

export interface EngineOptions {
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
}

interface HandlerContext {
  bus: EventBus<EngineEvents>
  fabric: FabricDocuments
  discovery: DiscoveryDocuments
  secrets: SecretStore
  voice: VoiceDocuments
  surfaces: SurfaceDocuments
  distill: DistillDocuments
  todos: TodoDocuments
  workflow: WorkflowDocuments
  hints: HintsDocuments
  queue: CaptureQueue
  store: WorkspaceRegistry
  runtime: LocalRuntimeManager
  models: LocalModelStore
  onCapture?: (chunk: CaptureChunk) => void
  log: (message: string) => void
}

export function createEngineApp(options: EngineOptions = {}): EngineApp {
  const log = options.log ?? console.log
  const store = new WorkspaceRegistry(options.dataRoot ?? options.dataDir)
  const bus = new EventBus<EngineEvents>()
  const ws = new EventSocketHub()
  const fabric = new FabricDocuments(store)
  // Engine-side secret store: v0 chmod-600 file in its own secrets/ dir (see resolveSecretsPath),
  // never in a DB or workspace export. Values are injected ONLY at invoke time; the API is write-only.
  const secrets: SecretStore = new FileSecretStore(resolveSecretsPath(store.dataDir))
  const resolveKey = (ref: string): string | undefined => secrets.resolve(ref)
  const voice = new VoiceDocuments(store)
  const distillDocs = new DistillDocuments(store)
  const actDocs = new ActDocuments(store)
  const todoDocs = new TodoDocuments(store)
  const hintsDocs = new HintsDocuments(store)
  const surfaces = new SurfaceDocuments(store)
  const discovery = new DiscoveryDocuments(store)
  const starterModels = new StarterModelsDocuments(store)
  const workflow = new WorkflowDocuments(store)
  // Tier zero (ARCHITECTURE §8, slice c): the engine downloads + spawns managed local runtimes.
  // The model store maps a `local` endpoint's model ref to its on-disk path; the runtime manager
  // spawns llama.cpp/whisper.cpp on demand and is threaded into invoke/health so local endpoints
  // ride the SAME seams as http ones. Models live under the data root models/ dir.
  const models = new LocalModelStore(join(store.dataDir, 'models'), () => starterModels.models())
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
  voice.ensureDefaults()
  distillDocs.ensureDefaults()
  actDocs.ensureDefaults()
  hintsDocs.ensureDefaults()
  surfaces.ensureDefaults()
  discovery.ensureDefaults()
  starterModels.ensureDefaults()
  workflow.ensureDefaults()

  const distiller = new Distiller({
    store,
    voice,
    fabric,
    docs: distillDocs,
    resolveKey,
    runtimeManager: runtime,
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
  // The pre-distill transcription stage (distill.transcribe): rewrites base64 audio/* chunks (mic →
  // "me", system-audio → "them") to utf8 text via the stt slot BEFORE the distiller's utf8 filter;
  // non-audio chunks pass through. A transcription transport failure propagates → the drain re-queues
  // the file (retry-at-idle), exactly like distill/moments. Shared verbatim by the legacy drain path
  // and the workflow executor's transcribe seam, so the two are byte-for-byte identical.
  // Transcript fast-path (#58): as each audio chunk transcribes we collect (session, source, text,
  // capturedAt), then publish EPHEMERAL transcript.updated events — one per (session, source) in the
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
  const runTranscribe = async (chunks: readonly CaptureChunk[]): Promise<CaptureChunk[]> => {
    const segments: { sessionId: string; source: CaptureChunk['source']; text: string; capturedAt: string }[] = []
    // Skipped-as-silence accounting (#69): count windows fully filtered to nothing and total segments
    // dropped across the drain, so filtered content is VISIBLE in a log line rather than silently vanished.
    let skippedWindows = 0
    let droppedSegments = 0
    const ready = await transcribeChunks(chunks, {
      invoke: (audio, opts) => invokeStt(fabric.load(), audio, { ...opts, resolveKey, runtimeManager: runtime }),
      onTranscribed: (chunk, text) => segments.push({ sessionId: chunk.sessionId, source: chunk.source, text, capturedAt: chunk.capturedAt }),
      onSilenceSkipped: (_chunk, info) => {
        droppedSegments += info.dropped
        if (info.windowSkipped) skippedWindows += 1
      },
      noSpeechThreshold,
      log,
    })
    if (droppedSegments > 0) log(`transcribe: silence filter dropped ${droppedSegments} no-speech segment(s); ${skippedWindows} window(s) skipped as silence this drain`)
    for (const update of buildTranscriptUpdates(segments)) await bus.publish('transcript.updated', update)
    return ready
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
  // assigned just below (after the queue exists, so its drainNow seam can close over it) and referenced
  // here lazily — the drain callback only fires async, long after assignment. See PHASE4-NOTES.
  let executor: WorkflowExecutor
  const queue = new CaptureQueue(join(store.dataDir, 'queue'), async (chunks) => {
    // Focus chunks feed the detector, never the distiller (distill hygiene, PHASE3-NOTES). This is
    // routing CONTEXT, not a workflow step, so it stays OUTSIDE the executor and runs on BOTH paths.
    // Read the flag per-drain like the distill flags, so flipping it takes effect without a restart.
    if (isFlagEnabled(store, 'route.detect')) {
      const signals = extractFocusSignals(chunks, log)
      if (signals.length > 0) await attributor.observe(signals)
    }
    // workflow.enabled ON → the executor runs the workflow document (behavior-identical to the legacy
    // path below with the seeded default). Read per-drain so the flag is hot-flippable like the others.
    if (isFlagEnabled(store, 'workflow.enabled')) return executor.runDrain(chunks)
    // ---- legacy direct-wiring path (workflow.enabled OFF): untouched, byte-for-byte behavior ----
    if (!isFlagEnabled(store, 'distill.enabled')) return
    // Transcription is a pre-distill drain stage (distill.transcribe, OFF by default). It is gated
    // INSIDE distill.enabled on purpose — there is no persistence path for transcribed-but-undistilled
    // text, so running stt when nothing will distill it is pure waste (see PHASE2-NOTES).
    const ready = isFlagEnabled(store, 'distill.transcribe') ? await runTranscribe(chunks) : chunks
    // Throttled: accumulate across drains, distill only when the span crosses the cadence threshold
    // (or on session end). Transcription already ran above every drain (the live fast-path).
    await distillThrottled(ready, currentDistillOpts())
    // When a drain re-queues (a transcribe/distill invoke failed), classify WHY and record it on the queue
    // so GET /queue, Status, and the Try-it card surface the real reason instead of re-queuing silently
    // forever (the user's wall). A model-load failure's hint is enriched with the loaded-model suggestion.
  }, toQueueFailure,
    // Typed-queue envelope seams (P4A slice 3), READ-ONLY, injected so the queue keeps zero fabric/store
    // imports (the describeFailure precedent). measuredTokPerSec: the primary (fabric-order first) llm
    // endpoint's benchmarked tok/s — the envelope's measured side, surfaced as ETA context (never
    // converted to an ETA in v0). overflow: the active mode's declared overflow policy mapped to the
    // status tri-state; only queue-for-idle is enforced in v0 (degrade-cadence is client-side capture,
    // drop would violate never-lose-capture — both declared-but-inert, see PHASE4-NOTES).
    () => fabric.load().slots.llm[0]?.measured?.tokPerSec,
    () => {
      const raw = distillDocs.mode().overflow
      const policy = raw === 'degrade' ? 'degrade-cadence' : raw === 'drop' ? 'drop' : 'queue-for-idle'
      return { policy, enforced: policy === 'queue-for-idle' }
    },
    // Freshness-first drain (#70), READ-ONLY like the seams above (zero store import in the queue):
    // isSessionLive — a live capture session for the default workspace flips the drain to newest-first so
    // the surface renders the present, not a stalled backlog; at idle it stays oldest-first FIFO. The
    // 'default' workspace matches every other liveSession call site in this file (the HUD's Now line).
    () => store.liveSession('default') !== undefined,
    // maxAgeMinutes — the age-shed horizon: backlog whose newest activity is older than this is dropped
    // (with accounting), never processed into a live session's past. OPENINFO_QUEUE_MAX_AGE_MINUTES
    // overrides the default at wiring time (tunable without a rebuild); <= 0 disables shedding entirely.
    queueMaxAgeMinutes,
  )

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
    // session. Draining the spool first accumulates any last chunks, then flushDistill releases them.
    drainNow: async () => {
      await queue.drainNow(log)
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
        await queue.drainNow(log)
        await flushDistill()
        await actor.runFollowUpDraft(session)
      }
      // The distill cadence throttle (#58) means a short session's transcribed material never crossed the
      // 15s threshold and is still buffered (or still spooled un-drained). Session end MUST distill that
      // tail so the whole meeting is recorded — otherwise the throttle would silently drop sub-threshold
      // sessions. Drain any pending spool INTO the cadence, then flush it. Both steps are safe no-ops when
      // an act path above already ran them (drainNow with nothing pending; flush with an empty buffer).
      // Gated on distill.enabled — with distill off nothing ever accumulated.
      if (isFlagEnabled(store, 'distill.enabled')) {
        await queue.drainNow(log)
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
  bus.subscribe('moment.created', (moment) => ws.broadcast('moment.created', moment))
  bus.subscribe('entity.updated', (entity) => ws.broadcast('entity.updated', entity))
  // Fast-field fan-out (#61): rebroadcast a field's latest value the instant it lands (mirrors the #58
  // transcript.updated pattern). Unlike that ephemeral feed, the value is ALSO persisted (FieldValue).
  bus.subscribe('field.updated', (value) => ws.broadcast('field.updated', value))
  bus.subscribe('session.started', (session) => ws.broadcast('session.started', session))
  bus.subscribe('session.ended', (session) => ws.broadcast('session.ended', session))
  bus.subscribe('session.switched', (session) => ws.broadcast('session.switched', session))
  bus.subscribe('session.rerouted', (session) => ws.broadcast('session.rerouted', session))
  bus.subscribe('draft.created', (draft) => ws.broadcast('draft.created', draft))
  bus.subscribe('fabric.changed', (fabricDoc) => ws.broadcast('fabric.changed', fabricDoc))
  bus.subscribe('surface.updated', (surface) => ws.broadcast('surface.updated', surface))

  const server = createServer((req, res) => {
    const ctx: HandlerContext = { bus, fabric, discovery, secrets, voice, surfaces, distill: distillDocs, todos: todoDocs, workflow, hints: hintsDocs, queue, store, runtime, models, log }
    if (options.onCapture !== undefined) ctx.onCapture = options.onCapture
    void handle(req, res, ctx).catch((error: unknown) =>
      send(res, 500, { error: error instanceof Error ? error.message : String(error) }),
    )
  })
  server.on('upgrade', (req, socket) => {
    if (!ws.handleUpgrade(req, socket as Socket)) socket.destroy()
  })

  return {
    server,
    bus,
    store,
    attributor,
    close: async () => {
      ws.close()
      runtime.shutdown() // kill any spawned local runtimes (tier zero)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
      store.close()
    },
  }
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
  if (req.method === 'GET' && url.pathname === '/queue') return send(res, 200, await ctx.queue.status())
  if (req.method === 'GET' && url.pathname === '/senses') return getSenses(res, ctx)
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
  // P4-T2: pins ingest/read + teach candidates — the P4D store/derivation seams over HTTP, no logic change.
  if (req.method === 'GET' && url.pathname === '/pins') return send(res, 200, readPins(ctx.store, url))
  if (req.method === 'POST' && url.pathname === '/pins') return createPin(req, res, ctx)
  const pinIngest = url.pathname.match(/^\/pins\/([^/]+)\/ingest$/)
  if (req.method === 'POST' && pinIngest?.[1]) return ingestPinRoute(res, ctx, decodeURIComponent(pinIngest[1]), url)
  const pinChunks = url.pathname.match(/^\/pins\/([^/]+)\/chunks$/)
  if (req.method === 'GET' && pinChunks?.[1]) return getPinChunks(res, ctx, decodeURIComponent(pinChunks[1]), url)
  if (req.method === 'GET' && url.pathname === '/teach/candidates') return send(res, 200, readTeachCandidates(ctx.store, url))
  // P4-T3b: the APPLY-with-review half of the teach loop — GET/PUT the workspace's attribution-hints
  // document. /teach/candidates SUGGESTS a pattern; the user reviews it and PUTs an updated hints doc
  // here, and the detector then attributes on it. No auto-apply: "apply a candidate" is just this plain
  // document edit over the existing HintsDocuments store seam (no logic in route/ is touched).
  if (req.method === 'GET' && url.pathname === '/hints') return send(res, 200, ctx.hints.all())
  const hintsDoc = url.pathname.match(/^\/hints\/([^/]+)$/)
  if (req.method === 'GET' && hintsDoc?.[1]) return getHints(res, ctx, decodeURIComponent(hintsDoc[1]))
  if (req.method === 'PUT' && hintsDoc?.[1]) return putHints(req, res, ctx, decodeURIComponent(hintsDoc[1]))
  if (req.method === 'GET' && url.pathname === '/layouts/surfaces') return send(res, 200, ctx.surfaces.list())
  const surface = url.pathname.match(/^\/layouts\/surfaces\/([^/]+)$/)
  if (req.method === 'GET' && surface?.[1]) return getSurface(res, ctx, decodeURIComponent(surface[1]))
  if (req.method === 'PUT' && surface?.[1]) return putSurface(req, res, ctx, decodeURIComponent(surface[1]))
  if (req.method === 'POST' && url.pathname === '/query') return runQuery(req, res, ctx)
  // #66: dismiss / mark-for-follow-up write a per-item signal. Dismiss is the SUPPRESSION record that
  // runQuery above then honors (dismissed rows excluded). Self-contained: one POST over the store seam.
  if (req.method === 'POST' && url.pathname === '/item-signals') return postItemSignal(req, res, ctx)
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
    uptimeMs: process.uptime() * 1000,
    queue: await ctx.queue.status(),
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

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(renderSettingsPage(data, active.id))
}

/**
 * GET /senses (issue #7) — the per-sense gate-chain verdict as JSON, for a support flow AND the client
 * tray's blocking-gate line. Composes the EXISTING signals into one named "what is blocking this sense"
 * answer: the live flags, the live fabric's slots, the queue's last classified drain failure, and a LIVE
 * checkEndpoint probe of the configured stt/ocr endpoints (the route can afford the probe the pure
 * Status render cannot). Append-only, read-only; reuses checkEndpoint/EndpointHealth rather than
 * re-implementing any health logic. The CLIENT-side gates (sense off, OS permission, engine reachable)
 * chain in FRONT of this on the tray — the engine cannot see those.
 */
async function getSenses(res: ServerResponse, ctx: HandlerContext): Promise<void> {
  const fabric = ctx.fabric.load()
  const queue = await ctx.queue.status()
  // Probe the stt + ocr endpoints so the health gate reflects a live check (deduped by name). Best-effort:
  // a probe that throws is caught inside checkEndpoint and returns ok:false with its error.
  const probeSlots = [...fabric.slots.stt, ...fabric.slots.ocr]
  const seen = new Set<string>()
  const health: Record<string, EndpointHealth> = {}
  for (const endpoint of probeSlots) {
    if (seen.has(endpoint.name)) continue
    seen.add(endpoint.name)
    health[endpoint.name] = await checkEndpoint(endpoint, 2_000, (ref) => ctx.secrets.resolve(ref), ctx.runtime)
  }
  const chains = evaluateSenseGates({
    flags: readFlags(ctx.store),
    fabric,
    ...(queue.lastFailure ? { lastFailure: queue.lastFailure } : {}),
    health,
  })
  send(res, 200, chains)
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
  await ctx.queue.append(chunk)
  ctx.onCapture?.(chunk)
  await ctx.bus.publish('capture.received', chunk)
  ctx.queue.scheduleDrain(ctx.log)
  await ctx.bus.publish('queue.updated', await ctx.queue.status())
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
 * takes effect with NO restart and NO executor change (the whole point of the read-fresh seam).
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
  send(res, 200, ctx.workflow.save(incoming))
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
 */
async function runQuery(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext): Promise<void> {
  const body = await readJson(req)
  const errors = validationErrors('BlockQuery', body)
  if (errors.length > 0) return send(res, 400, { error: 'invalid BlockQuery', details: errors })
  const query = body as BlockQuery
  // The `queue` source is operational engine state (the live backlog/ETA/last-failure), not a store
  // record, so inject the queue's status() snapshot for that source; every other source reads through
  // store/ (see compileQuery / QuerySources). status() is async, so it is awaited only when needed.
  const sources = query.source === 'queue' ? { queueStatus: await ctx.queue.status() } : {}
  send(res, 200, compileQuery(ctx.store, query, new Date(), sources))
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

function readFlags(store: WorkspaceRegistry): Flag[] {
  return ensureDefaultFlags(store).map((flag) => store.layouts.getLatest<Flag>('flag', flag.key)?.body ?? flag)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body, null, 2))
}
