import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import { AllSchemas, Routes, type Ack, type BlockQuery, type CaptureChunk, type CloneProfileRequest, type Draft, type Endpoint, type EndpointProbe, type Entity, type Fabric, type FabricProfile, type Flag, type LocalDownloadRequest, type Moment, type RelevantEntity, type RerouteRequest, type SecretValue, type Session, type StartSessionRequest, type Surface } from '@openinfo/contracts'
import { Actor, ActDocuments } from '../act/index.js'
import { EventBus, type EngineEvents } from '../bus/index.js'
import { DistillDocuments, Distiller, transcribeChunks } from '../distill/index.js'
import { DiscoveryDocuments, FabricDocuments, FileSecretStore, LocalModelStore, LocalRuntimeManager, StarterModelsDocuments, checkEndpoint, discoverFabric, invokeStt, type SecretStore } from '../fabric/index.js'
import { relevantNow } from '../index/index.js'
import { rerouteSession } from '../route/index.js'
import { isFlagEnabled } from '../flags/read.js'
import { CaptureQueue } from '../queue/spool.js'
import { WorkspaceRegistry, resolveSecretsPath } from '../store/index.js'
import { SurfaceDocuments, compileQuery, renderSetupPage } from '../surfaces/index.js'
import { VoiceDocuments } from '../voice/index.js'
import { ensureDefaultFlags } from './defaults.js'
import { schemaByName, validationErrors } from './validation.js'
import { EventSocketHub } from './ws.js'

export interface EngineApp {
  server: ReturnType<typeof createServer>
  bus: EventBus<EngineEvents>
  store: WorkspaceRegistry
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
  const surfaces = new SurfaceDocuments(store)
  const discovery = new DiscoveryDocuments(store)
  const starterModels = new StarterModelsDocuments(store)
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
  surfaces.ensureDefaults()
  discovery.ensureDefaults()
  starterModels.ensureDefaults()

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
  // Seam (see PHASE2-NOTES): distill rides the queue drain, gated on distill.enabled (OFF by
  // default). Flag off → the drain stays the Phase 1 no-op GC; on → each drained file distills.
  // Moments extraction (distill.moments) and entity indexing (distill.index) are further opt-ins
  // and require distill.enabled — all three flags are read per-drain, so flipping any of them over
  // the API takes effect without a restart. Moment.refs linking needs BOTH extras on: with
  // distill.index alone entities still index, but there are no same-pass moments to link.
  const queue = new CaptureQueue(join(store.dataDir, 'queue'), async (chunks) => {
    if (!isFlagEnabled(store, 'distill.enabled')) return
    // Transcription is a pre-distill drain stage (distill.transcribe, OFF by default). It rewrites
    // base64 audio/* chunks (mic → "me", system-audio → "them") to utf8 text via the stt slot BEFORE
    // the distiller's utf8 filter; non-audio chunks pass through. It is gated INSIDE distill.enabled
    // on purpose — there is no persistence path for transcribed-but-undistilled text, so running stt
    // when nothing will distill it is pure waste (see PHASE2-NOTES). A transcription transport failure
    // propagates → the drain re-queues the file (retry-at-idle), exactly like distill/moments.
    const ready = isFlagEnabled(store, 'distill.transcribe')
      ? await transcribeChunks(chunks, { invoke: (audio, opts) => invokeStt(fabric.load(), audio, { ...opts, resolveKey, runtimeManager: runtime }), log })
      : chunks
    await distiller.distillChunks(ready, {
      extractMoments: isFlagEnabled(store, 'distill.moments'),
      extractEntities: isFlagEnabled(store, 'distill.index'),
    })
  })

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
    resolveKey,
    runtimeManager: runtime,
    mode: (id) => distillDocs.mode(id),
    publish: (draft) => bus.publish('draft.created', draft),
    log,
  })
  bus.subscribe('session.ended', (session) => {
    if (!isFlagEnabled(store, 'act.enabled')) return
    void (async () => {
      await queue.drainNow(log)
      await actor.runFollowUpDraft(session)
    })().catch((error: unknown) =>
      log(`follow-up draft failed for session ${session.id}: ${error instanceof Error ? error.message : String(error)}`),
    )
  })

  bus.subscribe('capture.received', (chunk) => ws.broadcast('capture.received', chunk))
  bus.subscribe('queue.updated', (status) => ws.broadcast('queue.updated', status))
  bus.subscribe('flag.changed', (flag) => ws.broadcast('flag.changed', flag))
  bus.subscribe('distillate.updated', (distillate) => ws.broadcast('distillate.updated', distillate))
  bus.subscribe('moment.created', (moment) => ws.broadcast('moment.created', moment))
  bus.subscribe('entity.updated', (entity) => ws.broadcast('entity.updated', entity))
  bus.subscribe('session.started', (session) => ws.broadcast('session.started', session))
  bus.subscribe('session.ended', (session) => ws.broadcast('session.ended', session))
  bus.subscribe('session.rerouted', (session) => ws.broadcast('session.rerouted', session))
  bus.subscribe('draft.created', (draft) => ws.broadcast('draft.created', draft))
  bus.subscribe('fabric.changed', (fabricDoc) => ws.broadcast('fabric.changed', fabricDoc))

  const server = createServer((req, res) => {
    const ctx: HandlerContext = { bus, fabric, discovery, secrets, voice, surfaces, queue, store, runtime, models, log }
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
    return send(res, 200, { ok: true, phase: 1, uptimeMs: process.uptime() * 1000, checkedAt: new Date().toISOString() })
  }
  if (req.method === 'GET' && url.pathname === '/contracts') return send(res, 200, Object.keys(AllSchemas))
  if (req.method === 'GET' && url.pathname === '/routes') return send(res, 200, Routes)
  if (req.method === 'GET' && url.pathname === '/flags') return send(res, 200, readFlags(ctx.store))
  if (req.method === 'GET' && url.pathname === '/setup') return getSetup(res, ctx, url)
  if (req.method === 'GET' && url.pathname === '/fabric') return send(res, 200, ctx.fabric.load())
  if (req.method === 'PUT' && url.pathname === '/fabric') return saveFabric(req, res, ctx)
  if (req.method === 'GET' && url.pathname === '/fabric/discover') return discover(res, ctx)
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
  const surface = url.pathname.match(/^\/layouts\/surfaces\/([^/]+)$/)
  if (req.method === 'GET' && surface?.[1]) return getSurface(res, ctx, decodeURIComponent(surface[1]))
  if (req.method === 'PUT' && surface?.[1]) return putSurface(req, res, ctx, decodeURIComponent(surface[1]))
  if (req.method === 'POST' && url.pathname === '/query') return runQuery(req, res, ctx)
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
 * Serve the setup surface (ARCHITECTURE §8): forms over the profile + secret documents, rendered as
 * a self-contained HTML page. The FIRST engine-served surface (CODE_MAP homes it under
 * engine/surfaces/setup/). It composes only the existing profile/secret/fabric routes — no new engine
 * capability. `?edit=<id>` selects which profile the editor opens; default is the active profile, else
 * the first profile, else the legacy live fabric. localhost-only posture (no auth) is a P7 concern.
 */
async function getSetup(res: ServerResponse, ctx: HandlerContext, url: URL): Promise<void> {
  const profiles = ctx.fabric.profiles.list()
  const activeId = ctx.fabric.profiles.activeId()
  const editParam = url.searchParams.get('edit')
  const editing = editParam
    ? profiles.find((p) => p.id === editParam)
    : (activeId ? profiles.find((p) => p.id === activeId) : profiles[0])
  const liveFabric = ctx.fabric.load()
  // The Get-Started capability lens (ARCHITECTURE §8) leads when the live llm slot is empty (the
  // first-run condition — the page IS the onboarding), or when the user asks to re-detect (?discover=1).
  // Detection over configuration: we run discovery and show a RESULT, not a form. Localhost, no secrets.
  const wantLens = liveFabric.slots.llm.length === 0 || url.searchParams.get('discover') === '1'
  const discovery = wantLens
    ? await discoverFabric(ctx.discovery.probeList(), ctx.discovery.capabilityMap())
    : undefined
  const html = renderSetupPage({
    profiles,
    activeId,
    liveFabric,
    editing,
    secretRefs: ctx.secrets.listRefs(),
    ...(discovery !== undefined ? { discovery, localModels: ctx.models.statuses() } : {}),
  })
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
  const result = await discoverFabric(ctx.discovery.probeList(), ctx.discovery.capabilityMap())
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
  const body = await readJson(req)
  const errors = validationErrors('Endpoint', body)
  if (errors.length > 0) return send(res, 400, { error: 'invalid Endpoint', details: errors })
  const endpoint = body as Endpoint
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
  send(res, 200, probe)
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
 * behavior (consistent with /workspaces, /sessions; see PHASE2-NOTES).
 */
async function putSurface(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext, id: string): Promise<void> {
  const body = await readJson(req)
  const errors = validationErrors('Surface', body)
  if (errors.length > 0) return send(res, 400, { error: 'invalid Surface', details: errors })
  const incoming = body as Surface
  if (incoming.id !== id) return send(res, 400, { error: 'surface id does not match route' })
  send(res, 200, ctx.surfaces.save(incoming))
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
  send(res, 200, compileQuery(ctx.store, body as BlockQuery))
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
