import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import { AllSchemas, Routes, type Ack, type BlockQuery, type CaptureChunk, type Draft, type Entity, type Fabric, type Flag, type Moment, type RelevantEntity, type Session, type StartSessionRequest, type Surface } from '@openinfo/contracts'
import { Actor, ActDocuments } from '../act/index.js'
import { EventBus, type EngineEvents } from '../bus/index.js'
import { DistillDocuments, Distiller } from '../distill/index.js'
import { FabricDocuments } from '../fabric/index.js'
import { relevantNow } from '../index/index.js'
import { isFlagEnabled } from '../flags/read.js'
import { CaptureQueue } from '../queue/spool.js'
import { WorkspaceRegistry } from '../store/index.js'
import { SurfaceDocuments, compileQuery } from '../surfaces/index.js'
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
}

interface HandlerContext {
  bus: EventBus<EngineEvents>
  fabric: FabricDocuments
  voice: VoiceDocuments
  surfaces: SurfaceDocuments
  queue: CaptureQueue
  store: WorkspaceRegistry
  onCapture?: (chunk: CaptureChunk) => void
  log: (message: string) => void
}

export function createEngineApp(options: EngineOptions = {}): EngineApp {
  const log = options.log ?? console.log
  const store = new WorkspaceRegistry(options.dataRoot ?? options.dataDir)
  const bus = new EventBus<EngineEvents>()
  const ws = new EventSocketHub()
  const fabric = new FabricDocuments(store)
  const voice = new VoiceDocuments(store)
  const distillDocs = new DistillDocuments(store)
  const actDocs = new ActDocuments(store)
  const surfaces = new SurfaceDocuments(store)
  ensureDefaultFlags(store)
  voice.ensureDefaults()
  distillDocs.ensureDefaults()
  actDocs.ensureDefaults()
  surfaces.ensureDefaults()

  const distiller = new Distiller({
    store,
    voice,
    fabric,
    docs: distillDocs,
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
    await distiller.distillChunks(chunks, {
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
  bus.subscribe('draft.created', (draft) => ws.broadcast('draft.created', draft))

  const server = createServer((req, res) => {
    const ctx: HandlerContext = { bus, fabric, voice, surfaces, queue, store, log }
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
  if (req.method === 'GET' && url.pathname === '/fabric') return send(res, 200, ctx.fabric.load())
  if (req.method === 'PUT' && url.pathname === '/fabric') return saveFabric(req, res, ctx)
  if (req.method === 'GET' && url.pathname === '/workspaces') return send(res, 200, ctx.store.all())
  if (req.method === 'GET' && url.pathname === '/registers') return send(res, 200, ctx.voice.registers())
  if (req.method === 'GET' && url.pathname === '/sessions') return send(res, 200, readSessions(ctx.store, url))
  if (req.method === 'POST' && url.pathname === '/sessions') return startSession(req, res, ctx)
  const sessionEnd = url.pathname.match(/^\/sessions\/([^/]+)\/end$/)
  if (req.method === 'POST' && sessionEnd?.[1]) return endSession(res, ctx, decodeURIComponent(sessionEnd[1]))
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

async function saveFabric(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext): Promise<void> {
  const body = await readJson(req)
  const errors = validationErrors('Fabric', body)
  if (errors.length > 0) return send(res, 400, { error: 'invalid Fabric', details: errors })
  send(res, 200, ctx.fabric.save(body as Fabric))
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
