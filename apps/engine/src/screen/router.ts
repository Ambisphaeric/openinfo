import type { IncomingMessage, ServerResponse } from 'node:http'
import type { OcrResult, ScreenStatus } from '@openinfo/contracts'
import type { WorkspaceRegistry } from '../store/index.js'
import { screenRecognitionEnabledForStore } from './ownership.js'
import { getScreenProcessor } from './registry.js'

/**
 * The minimal slice of http.ts's HandlerContext this router needs — declared structurally so the router
 * never imports http.ts (that file is P4A-owned; the mount is one line passing its ctx). `store` is the
 * only field read: OcrResults are listed from it, and it is the key the processor was registered under.
 */
export interface ScreenRouterContext {
  store: WorkspaceRegistry
}

/**
 * The `/screen` router (P4B) — mounted from http.ts by a single delegating line. Two READ routes (not
 * flag-gated, per CONTRIBUTING rule 3 — the DATA is gated upstream by screen.ocr at recognition time):
 *   - GET /screen/results?workspace=&session= — the persisted OcrResults (raw recognized text + region
 *     blocks), the screen-understanding analogue of a distillate read.
 *   - GET /screen/status — the processor's health: current legacy/workflow owner state, processed/blank/
 *     skipped/failed counters, and the classified last-failures ring (the honest "why nothing was read").
 * Any other /screen path is a 404 with the same JSON shape http.ts uses.
 */
export async function handleScreen(req: IncomingMessage, res: ServerResponse, ctx: ScreenRouterContext): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (req.method === 'GET' && url.pathname === '/screen/results') {
    return sendJson(res, 200, readResults(ctx.store, url))
  }
  if (req.method === 'GET' && url.pathname === '/screen/status') {
    return sendJson(res, 200, readStatus(ctx.store))
  }
  return sendJson(res, 404, { error: `no such route: ${req.method ?? 'GET'} ${url.pathname}` })
}

/**
 * List a workspace's OcrResults (default `default`), oldest first; `?session=`/`?sessionId=` narrows to
 * one session (both accepted — sessionId matches the slice's route note, session matches /moments et al).
 * Mirrors readMoments: an unknown workspace is an empty list, not an error.
 */
function readResults(store: WorkspaceRegistry, url: URL): OcrResult[] {
  const workspaceId = url.searchParams.get('workspace') ?? 'default'
  if (!store.all().some((ws) => ws.id === workspaceId)) return []
  const sessionId = url.searchParams.get('sessionId') ?? url.searchParams.get('session')
  return sessionId ? store.listOcrResults(workspaceId, sessionId) : store.listOcrResults(workspaceId)
}

/** The processor's live status, or an honest zeroed status (with the real current-owner state) when unwired. */
function readStatus(store: WorkspaceRegistry): ScreenStatus {
  const processor = getScreenProcessor(store)
  if (processor) return processor.status()
  return { enabled: screenRecognitionEnabledForStore(store), processed: 0, blank: 0, skipped: 0, failed: 0, lastFailures: [] }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body, null, 2))
}
