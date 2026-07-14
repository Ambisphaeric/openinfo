/**
 * Driven e2e for THE PILL (the-pill: the MVP Standard App window assembly). Green unit tests are not proof
 * the SERVED window behaves — this launches REAL Electron with the REAL hud.html + REAL compiled preload
 * against a minimal fake engine, opens surf-openinfo-pill, and proves the pill end-to-end in the served DOM
 * + REAL window bounds:
 *
 *   1) the window SELF-IDENTIFIES — document.title is the pill surface's name (S4), and the header
 *      rectangle carries Listen / Ask / Show-Hide / settings.
 *   2) LIVE SENSES hydrate as the canonical mic / system-audio / screen trio through the real
 *      `sense-lanes` renderer. A metadata-only `sense.lane.updated` frame patches the visible screen row
 *      (capture time + measured lag) without another `/query` request or rendering private/model fields.
 *   3) faces RESOLVE FROM THE BUNDLE — GET /bundles → the chat face surfaceRef → its surface doc; the Ask
 *      affordance lights up (leaves its honest disabled state) once the chat face resolves.
 *   4) clicking Ask expands the window to the ask extent (~3× the bar) and mounts the RESOLVED chat organ;
 *      a typed send flows end-to-end through the EXISTING Ask path (one captured frame + client-minted
 *      turnId POSTed to /chat; the reply STREAMS then the authoritative answer lands).
 *   5) Show-Hide COLLAPSES the window to the bar (the real height changes to the bar extent) and back.
 *   6) clicking Listen returns to the Listen extent and glance content.
 *   7) the settings-on-hover affordance opens the EXISTING settings path (the hud:open-settings bridge
 *      fires — the same signal the tray's Settings command sends).
 *
 * SCENE 0 — the ANCHOR PATH (the user's door). POLICY: a driven e2e must enter through the user's ENTRY
 * POINTS, not reach past them. Scenes 1-6 drove the pill window DIRECTLY (surfaceWindowSpec(PILL) by hand),
 * so they stayed green while the ⌘\/tray anchor still opened the OLD hud and the pill was undiscoverable
 * (the owner's 0.0.14 live-QA gap). Scene 0 closes that hole: it resolves the shell config the way boot
 * does (resolveShellConfig with an empty env → DEFAULTS) and builds the anchor window from cfg.surfaceId
 * through the SAME production constructor createHudWindow calls, then proves (a) the anchor default IS the
 * pill (not the old hud), (b) `.pill-app` actually FILLS the window width at the bar/listen/ask states —
 * DOM rect ≥ window width minus the stage padding, so the shrink-wrapped microsquare class can never come
 * back green, and (c) the anchor show/hide path (hide()/showInactive(), the ⌘\ toggle) just shows/hides the
 * window without disturbing the pill's height (the PillController extents are not fought).
 *
 * THE PRODUCTION WINDOW PATH (#194): every window this harness drives is built by `constructSurfaceWindow`
 * — the EXACT function the shell's `createSurfaceWindow` factory runs (extracted to dist/main/
 * surface-window.js so it is invocable without booting shell.ts, whose import would resolve the real
 * config, spawn engines, and register the tray). The contract assertion, spec resolution, title stamp,
 * preload, hardening, observability, and hud.html load are therefore the production body, not a mirror —
 * a regression inside the constructor now fails this proof. What REMAINS mirrored (each with its reason):
 *   - `SurfaceWindowEnv` hooks are left absent: engine auth is injected at the defaultSession webRequest
 *     seam below (production pins per-webContents via RendererEngineAuth, which needs the shell's
 *     configured credential source — the fake engine uses a fixed bearer), and the meta/position-store
 *     hooks are per-user shell state a throwaway harness must not read or write.
 *   - Probe main (the ask-face / panel-bounds precedent): shell.ts's hud:panel-size / hud:capture-frame /
 *     hud:open-settings IPC handlers are mirrored verbatim — they live in shell.ts's whenReady wiring, and
 *     TCC cannot be granted to a throwaway harness, so the frame source is injected at the IPC seam (as
 *     ask-face-e2e does); the renderer path is the REAL shipped code.
 *
 * Run: pnpm --filter @openinfo/client test:e2e:pill  (builds first). Needs a GUI (darwin) — not in `test`.
 */
import http from 'node:http'
import crypto from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { app, BrowserWindow, ipcMain, screen, session as electronSession } from 'electron'
import { configForSurface } from '../dist/main/window-options.js'
import { constructSurfaceWindow } from '../dist/main/surface-window.js'
import { resolveShellConfig } from '../dist/main/config.js'

const FAKE_FRAME_B64 = Buffer.from('one synthetic pill ask frame').toString('base64')
const ASK_DEFAULT_BODY = 'Explain what is on my screen right now, briefly and in plain terms.'
const PILL_SURFACE_ID = 'surf-openinfo-pill'
const WORKSPACE_ID = 'default'
const SESSION_ID = 'session-live-e2e'
const ENGINE_TOKEN = 'pill-e2e-bearer-token-000000000000000000000001'

// The pill surface (the Listen glance face) — bar 56 / ask 432, startExpanded so it opens as the pill.
const PILL_SURFACE = {
  id: PILL_SURFACE_ID,
  name: 'openinfo',
  context: 'meeting',
  version: 2,
  panel: { edge: 'below', collapsed: 56, expanded: 432, reveal: 'user', startExpanded: true },
  stack: [
    { block: 'now', id: 'pill-listen-now' },
    { block: 'sense-lanes', id: 'pill-listen-sense-lanes', show: 'always', top: 3, query: { source: 'live-senses', params: { session: 'current' }, top: 3 } },
    { block: 'moments', id: 'pill-listen-moments', show: 'on-match', query: { source: 'moments', params: { session: 'current' }, top: 20 } },
    { block: 'fields', id: 'pill-listen-fields', show: 'on-match', top: 8, query: { source: 'fields', params: { session: 'current' }, top: 8 } },
  ],
}
// The chat surface the bundle's chat face RESOLVES to — the pill mounts its input block for the Ask face.
const CHAT_SURFACE = {
  id: 'surf-openinfo-chat',
  name: 'Chat',
  context: 'any',
  version: 1,
  panel: { edge: 'below', collapsed: 120, expanded: 432, reveal: 'user', startExpanded: false },
  stack: [{ block: 'now' }, { block: 'input', input: { target: 'chat', submit: '/chat', mode: 'both' } }],
}
const SURFACES = { [PILL_SURFACE_ID]: PILL_SURFACE, 'surf-openinfo-chat': CHAT_SURFACE }
// The bundle: the pill is the hud face; the chat face is what the pill's Ask face resolves to (data-driven).
const BUNDLE = {
  id: 'bundle-standard-app',
  name: 'Standard App',
  version: 1,
  faces: [
    { kind: 'hud', surfaceRef: PILL_SURFACE_ID },
    { kind: 'chat', surfaceRef: 'surf-openinfo-chat' },
    { kind: 'support', surfaceRef: 'surf-openinfo-fields' },
  ],
}

const LIVE_SESSION = {
  id: SESSION_ID,
  workspaceId: WORKSPACE_ID,
  modeId: 'mode-e2e',
  startedAt: '2026-07-13T18:40:00.000Z',
  attribution: { evidence: [], confidence: 1 },
}

// Exact fake-engine hydration shape: the engine owns canonical ordering; the renderer preserves it.
const INITIAL_SENSE_LANES = [
  {
    workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, source: 'mic',
    disposition: 'waiting', health: 'unknown', reason: 'awaiting-capture',
    updatedAt: '2026-07-13T18:45:00.000Z',
  },
  {
    workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, source: 'system-audio',
    disposition: 'queued', health: 'unknown', reason: 'awaiting-processing',
    updatedAt: '2026-07-13T18:45:01.000Z',
    latestCapture: { id: 'system-capture-e2e-001', capturedAt: '2026-07-13T18:45:01.000Z' },
  },
  {
    workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, source: 'screen',
    disposition: 'delta-skipped', health: 'healthy', reason: 'delta-skipped',
    updatedAt: '2026-07-13T18:45:02.000Z',
    latestObservation: { id: 'screen-observation-e2e-001', occurredAt: '2026-07-13T18:45:02.000Z', outcome: 'delta-skipped' },
  },
]

const SCREEN_LANE_UPDATE = {
  workspaceId: WORKSPACE_ID,
  sessionId: SESSION_ID,
  source: 'screen',
  disposition: 'processed',
  health: 'healthy',
  reason: 'processed',
  updatedAt: '2026-07-13T18:46:01.200Z',
  latestCapture: { id: 'screen-capture-e2e-007', capturedAt: '2026-07-13T18:46:00.000Z' },
  latestProcessing: {
    captureId: 'screen-capture-e2e-007',
    capturedAt: '2026-07-13T18:46:00.000Z',
    completedAt: '2026-07-13T18:46:01.200Z',
    outcome: 'processed',
    lagMs: 1_200,
    basis: 'capture-to-processing-completion',
  },
}

// The public event fixture itself is part of the privacy proof: widening it with any captured/derived or
// machine-specific key must make the driven harness fail before Electron starts.
const FORBIDDEN_LANE_KEYS = new Set(['data', 'text', 'preview', 'hash', 'error', 'blocks', 'endpoint', 'model', 'deltaScore'])
const assertMetadataOnly = (value, path = 'lane') => {
  if (Array.isArray(value)) return value.forEach((item, index) => assertMetadataOnly(item, `${path}[${index}]`))
  if (!value || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_LANE_KEYS.has(key)) throw new Error(`${path}.${key} is forbidden from the live-sense fixture`)
    assertMetadataOnly(nested, `${path}.${key}`)
  }
}
assertMetadataOnly(INITIAL_SENSE_LANES)
assertMetadataOnly(SCREEN_LANE_UPDATE)

// ---- the fake engine (chat-input-e2e harness + /bundles) ----
const sockets = new Set()
const wsFrame = (text) => {
  const payload = Buffer.from(text)
  const len = payload.length
  const header = len < 126 ? Buffer.from([0x81, len]) : Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff])
  return Buffer.concat([header, payload])
}
const broadcast = (name, payload) => {
  const frame = wsFrame(JSON.stringify({ name, payload }))
  for (const socket of sockets) socket.write(frame)
}

const persistedTurns = []
const chatPosts = []
const queryPosts = []
const authenticatedRequests = []
const unauthorizedRequests = []

const authorize = (req, res) => {
  if (req.headers.authorization === `Bearer ${ENGINE_TOKEN}`) {
    authenticatedRequests.push(`${req.method} ${req.url}`)
    return true
  }
  unauthorizedRequests.push(`${req.method} ${req.url}`)
  res.writeHead(401, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'authentication required' }))
  return false
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const json = (body) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === '/health') return json({ status: 'ok', version: 'e2e' })
  if (!authorize(req, res)) return
  if (url.pathname === '/bundles') return json([BUNDLE])
  if (url.pathname.startsWith('/layouts/surfaces/')) {
    const id = decodeURIComponent(url.pathname.slice('/layouts/surfaces/'.length))
    return json(SURFACES[id] ?? PILL_SURFACE)
  }
  if (url.pathname === '/sessions') return json([LIVE_SESSION])
  if (url.pathname === '/templates/tpl-ask-default') {
    return json({ id: 'tpl-ask-default', name: 'Explain my screen', kind: 'ask', builtin: true, body: ASK_DEFAULT_BODY })
  }
  if (url.pathname === '/chat/history') return json({ turns: persistedTurns, total: persistedTurns.length, truncated: false })
  if (url.pathname === '/chat' && req.method === 'POST') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = JSON.parse(raw)
      chatPosts.push(body)
      broadcast('chat.delta', { turnId: body.turnId, seq: 0, text: 'Hello ', done: false })
      broadcast('chat.delta', { turnId: body.turnId, seq: 1, text: 'from the pill.', done: false })
      setTimeout(() => {
        broadcast('chat.delta', { turnId: body.turnId, seq: 2, text: '', done: true })
        persistedTurns.push({ role: 'user', content: body.message }, { role: 'assistant', content: 'Hello from the pill.' })
        json({
          answer: 'Hello from the pill.',
          citations: [],
          budget: { contextTokens: 40, maxTokens: 512, turnsRemaining: 9, truncated: false, note: 'Context: screen(1).' },
        })
      }, 700)
    })
    return
  }
  if (url.pathname === '/query' && req.method === 'POST') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      let query = { source: 'moments' }
      try {
        query = JSON.parse(raw)
      } catch {
        /* default */
      }
      queryPosts.push({ query, surface: url.searchParams.get('surface'), authorization: req.headers.authorization })
      if (query.source === 'live-senses') {
        return json({ source: 'live-senses', items: INITIAL_SENSE_LANES, truncated: false })
      }
      json({ source: query.source ?? 'moments', items: [], truncated: false })
    })
    return
  }
  res.writeHead(404)
  res.end()
})

server.on('upgrade', (req, socket) => {
  if (req.headers.authorization !== `Bearer ${ENGINE_TOKEN}`) {
    unauthorizedRequests.push(`UPGRADE ${req.url}`)
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  authenticatedRequests.push(`UPGRADE ${req.url}`)
  const key = req.headers['sec-websocket-key']
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`)
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
  socket.on('error', () => sockets.delete(socket))
})

// ---- harness plumbing ----
const fail = (msg) => {
  console.error(`\n[e2e] FAIL: ${msg}`)
  app.exit(1)
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const near = (a, b, tol = 10) => Math.abs(a - b) <= tol

/** Wait until the renderer's startup + synthetic ws.open hydration burst has stopped issuing queries. */
const waitForQueryQuiet = async (quietMs = 400, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs
  let seen = queryPosts.length
  let quietSince = Date.now()
  while (Date.now() < deadline) {
    await delay(50)
    if (queryPosts.length !== seen) {
      seen = queryPosts.length
      quietSince = Date.now()
    } else if (Date.now() - quietSince >= quietMs) {
      return seen
    }
  }
  throw new Error('query traffic never became quiet')
}

let win
let settingsOpened = 0
const drive = (expr) => win.webContents.executeJavaScript(expr)

const waitFor = async (expr, what, tries = 100) => {
  for (let i = 0; i < tries; i += 1) {
    const ok = await drive(expr).catch(() => false)
    if (ok) return
    await delay(100)
  }
  throw new Error(`${what} never became true (pill wiring or boot broken)`)
}

const typeText = async (text) => {
  for (const ch of text) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch })
    win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch })
    await delay(15)
  }
}

// Scenes 1-6 build the pill the way the shell's Apps folder does: the PRODUCTION constructor with the
// registry's exact shape (declared chrome, not the default HUD, startVisible + showInactive — see
// appRegistry.create in shell.ts). Only the fake-engine URL is bound; the shell-state hooks stay absent
// (see the header). Renderer error observability now comes from the production constructor itself.
const makeWindow = (engineUrl) => {
  const w = constructSurfaceWindow(
    PILL_SURFACE_ID,
    { chrome: configForSurface(PILL_SURFACE_ID).chrome, isDefaultHud: false, startVisible: true },
    { engineUrl },
  )
  w.showInactive()
  return w
}

// SCENE 0 — enter through the user's DOOR: build the anchor window the way the shell's createHudWindow does
// (from the config-resolved default surface), and prove the pill loads there, fills its frame, and survives
// the anchor show/hide toggle. This is the scene that would have caught the 0.0.14 anchor gap.
const runAnchorScene = async (engineUrl) => {
  // Resolve the shell config the way boot does, but with an EMPTY env so we read the shipped DEFAULTS
  // (not a dev OPENINFO_SURFACE that might be set in the harness's own environment).
  const cfg = resolveShellConfig({})
  if (cfg.surfaceId !== PILL_SURFACE_ID) {
    return fail(`the ANCHOR default is not the pill: cfg.surfaceId=${JSON.stringify(cfg.surfaceId)} (⌘\\ + tray Show/Hide would reveal the wrong surface — the pill would be undiscoverable)`)
  }
  console.log(`[e2e:anchor] resolveShellConfig → anchor surface ${cfg.surfaceId} (the pill)`)

  // Build the anchor THROUGH the production constructor with createHudWindow's exact arguments — the
  // config-resolved surface, hud chrome, the singular default HUD, startVisible:false — then reveal it with
  // showInactive() (the same glance-reveal showHud uses for the ⌘\ / tray Show command). This is no longer
  // a mirror: constructSurfaceWindow IS the body the shell's factory runs (#194).
  const aw = constructSurfaceWindow(cfg.surfaceId, { chrome: 'hud', isDefaultHud: true, startVisible: false }, { engineUrl })
  aw.showInactive()

  const driveA = (expr) => aw.webContents.executeJavaScript(expr)
  const waitForA = async (expr, what, tries = 100) => {
    for (let i = 0; i < tries; i += 1) {
      const ok = await driveA(expr).catch(() => false)
      if (ok) return
      await delay(100)
    }
    throw new Error(`${what} never became true (anchor pill wiring or boot broken)`)
  }

  // (a) the PILL loads at the anchor — not the old hud. Self-identifies + shows the header rectangle.
  await waitForA('!!(window.openinfoPill && document.querySelector(".pill-bar"))', 'the anchor pill booting')
  await delay(400)
  const title = await driveA('document.title')
  if (title !== 'openinfo') return fail(`[anchor] the pill did not load at the anchor (title=${JSON.stringify(title)} — the old hud, not the pill?)`)
  if (await driveA('!!document.querySelector(".nowline") && !document.querySelector(".pill-bar")')) {
    return fail('[anchor] the anchor rendered the old full HUD chrome, not the pill')
  }
  console.log('[e2e:anchor] the pill loaded AT the anchor default and self-identified')

  // (b) `.pill-app` FILLS the window width — catches the shrink-wrapped microsquare forever. We measure the
  // pill-app rect against the window's inner width minus the stage's horizontal padding; a fill leaves at
  // most that padding of slack on each side, a microsquare leaves hundreds of px. Asserted at EVERY state
  // (bar / listen / ask) because the collapsed bar is exactly what the owner saw adrift.
  // The .stage floats its panel with a fixed horizontal margin each side (WINDOW_MARGIN=24, the same margin
  // the 708px window wraps the 660px panel with). A FILLED pill covers the whole content box (window width
  // minus 2×24); the microsquare (≈295 in a 708px window) leaves hundreds of px of slack and fails this hard.
  const STAGE_MARGIN_EACH = 24
  const measureFill = async (label) => {
    const m = await driveA(`(() => {
      const app = document.querySelector('.pill-app');
      const r = app.getBoundingClientRect();
      return { w: Math.round(r.width), inner: window.innerWidth };
    })()`)
    const floor = m.inner - STAGE_MARGIN_EACH * 2 - 8 // 8px anti-alias/rounding slack
    console.log(`[e2e:anchor] .pill-app ${label}: width=${m.w} innerWidth=${m.inner} → fill-floor ${floor}`)
    if (m.w < floor) throw new Error(`[anchor] .pill-app does NOT fill at ${label}: width ${m.w} < ${floor} (the microsquare class is back)`)
  }

  // listen state (the pill opens on the Listen face, startExpanded)
  await measureFill('listen')

  // bar state — collapse to the bar via Show-Hide; the naked-buttons microsquare was the COLLAPSED bar
  await driveA(`document.querySelector('[data-verb="pill-toggle"]').click()`)
  await delay(300)
  if ((await driveA('window.openinfoPill.state().open')) !== false) return fail('[anchor] Show-Hide did not collapse the pill to the bar')
  await measureFill('bar')

  // ask state — reopen to a face; resolve the bundle Ask first, then measure at the ask extent
  await waitForA('window.openinfoPill.state().askAvailable === true', 'the anchor pill Ask face resolving from the bundle')
  await driveA(`document.querySelector('[data-verb="pill-face"][data-face="ask"]').click()`)
  await delay(300)
  await measureFill('ask')

  // (c) the ANCHOR show/hide toggle path (⌘\ / tray Show-Hide = hide()/showInactive()) just shows/hides the
  // window WITHOUT fighting the pill's height — the PillController extents must survive the visibility flip.
  const heightBefore = aw.getBounds().height
  aw.hide()
  await delay(150)
  if (aw.isVisible()) return fail('[anchor] hideHud did not hide the anchor window')
  aw.showInactive()
  await delay(250)
  if (!aw.isVisible()) return fail('[anchor] showHud did not re-show the anchor window')
  const heightAfter = aw.getBounds().height
  if (!near(heightBefore, heightAfter, 4)) return fail(`[anchor] show/hide fought the panel height: ${heightBefore} → ${heightAfter}`)
  console.log(`[e2e:anchor] anchor show/hide preserved the pill height (${heightBefore} → ${heightAfter}); no fight with the PillController`)

  aw.destroy()
  console.log('[e2e:anchor] PASS — the pill IS the anchor: loads at the default, fills its frame at bar/listen/ask, survives show/hide')
}

const run = async (engineUrl) => {
  // ---- 1) the pill boots, names itself, and shows the header rectangle ----
  await waitFor('!!(window.openinfoPill && document.querySelector(".pill-bar"))', 'openinfoPill / .pill-bar')
  await delay(400)
  const title = await drive('document.title')
  if (title !== 'openinfo') return fail(`the window did not self-identify: document.title=${JSON.stringify(title)}`)
  for (const sel of ['[data-verb="pill-face"][data-face="listen"]', '[data-verb="pill-toggle"]', '[data-verb="pill-settings"]']) {
    if (!(await drive(`!!document.querySelector('${sel}')`))) return fail(`the header is missing ${sel}`)
  }
  console.log('[e2e] pill booted, self-identified, header rectangle present')

  // opens on the Listen face at the listen extent (~300)
  const listenH = win.getBounds().height
  console.log(`[e2e] LISTEN bounds.height=${listenH}`)
  if (!near(listenH, 300)) return fail(`pill listen height ${listenH} ≉ 300`)

  // ---- 2) LIVE SENSES: authenticated hydration + metadata event patch, with NO re-query ----
  await waitFor(
    `document.querySelectorAll('.sense-lanes .sense-lane').length === 3`,
    'the three hydrated physical-sense lanes',
  )
  const initialSources = await drive(
    `Array.from(document.querySelectorAll('.sense-lanes .sense-lane')).map((row) => row.getAttribute('data-sense-source'))`,
  )
  if (JSON.stringify(initialSources) !== JSON.stringify(['mic', 'system-audio', 'screen'])) {
    return fail(`live senses are not in canonical order: ${JSON.stringify(initialSources)}`)
  }
  const initialTitles = await drive(
    `Array.from(document.querySelectorAll('.sense-lanes .sense-lane .ttl')).map((row) => row.textContent)`,
  )
  if (JSON.stringify(initialTitles) !== JSON.stringify([
    'Microphone · Waiting · Status unknown',
    'System audio · Queued · Status unknown',
    'Screen · No screen change · Healthy',
  ])) return fail(`live-sense hydration painted unexpected truth: ${JSON.stringify(initialTitles)}`)

  // DOM presence is not a visual proof in a clipped transparent HUD. All three rows—especially Screen,
  // the last one—must be fully inside both the Listen panel and the real 300px Electron viewport without
  // requiring a scroll gesture.
  const laneGeometry = await drive(`(() => {
    const panel = document.querySelector('.pill-panel').getBoundingClientRect();
    const viewport = { top: 0, bottom: window.innerHeight };
    const rows = Array.from(document.querySelectorAll('.sense-lanes .sense-lane')).map((row) => {
      const rect = row.getBoundingClientRect();
      return {
        source: row.getAttribute('data-sense-source'),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        withinPanel: rect.top >= panel.top - 1 && rect.bottom <= panel.bottom + 1,
        withinViewport: rect.top >= viewport.top && rect.bottom <= viewport.bottom,
      };
    });
    return { viewportHeight: window.innerHeight, panel: { top: Math.round(panel.top), bottom: Math.round(panel.bottom) }, rows };
  })()`)
  const clippedLanes = laneGeometry.rows.filter((row) => !row.withinPanel || !row.withinViewport)
  console.log(`[e2e] Live-sense geometry ${JSON.stringify(laneGeometry)}`)
  if (clippedLanes.length > 0) return fail(`live-sense rows are present but clipped at Listen height: ${JSON.stringify(clippedLanes)}`)
  const emptyMomentsLabel = await drive(`document.body.textContent.includes('Moments · this session')`)
  if (emptyMomentsLabel) return fail('the empty moments block is partially visible beneath the live lanes')

  const liveQuery = queryPosts.findLast((entry) => entry.query?.source === 'live-senses')
  if (!liveQuery) return fail('the sense-lanes block never hydrated through POST /query')
  if (liveQuery.surface !== PILL_SURFACE_ID) return fail(`live-senses query was not surface-bound to the pill: ${JSON.stringify(liveQuery.surface)}`)
  if (liveQuery.authorization !== `Bearer ${ENGINE_TOKEN}`) return fail('live-senses query did not cross the authenticated renderer boundary')
  if (liveQuery.query?.params?.session !== 'current' || liveQuery.query?.top !== 3) {
    return fail(`live-senses query lost its app-instance scope: ${JSON.stringify(liveQuery.query)}`)
  }

  const queriesBeforeEvent = await waitForQueryQuiet()
  const liveQueriesBeforeEvent = queryPosts.filter((entry) => entry.query?.source === 'live-senses').length
  const improperlyBound = queryPosts.filter(
    (entry) => entry.surface !== PILL_SURFACE_ID || entry.authorization !== `Bearer ${ENGINE_TOKEN}`,
  )
  if (improperlyBound.length > 0) {
    return fail(`not every pill query was surface-bound + authenticated: ${JSON.stringify(improperlyBound)}`)
  }
  broadcast('sense.lane.updated', SCREEN_LANE_UPDATE)
  await waitFor(
    `document.querySelector('.sense-lane[data-sense-source="screen"] .ttl')?.textContent === 'Screen · Processed · Healthy'`,
    'the payload-fed screen lane repaint',
    30,
  )
  const screenWhy = await drive(
    `document.querySelector('.sense-lane[data-sense-source="screen"] .why')?.textContent ?? ''`,
  )
  if (!/^Last captured \d{1,2}:\d{2}[ap] · Processing complete in 1\.2 s$/.test(screenWhy)) {
    return fail(`the updated screen row did not show human capture/lag provenance: ${JSON.stringify(screenWhy)}`)
  }
  if (process.env.OPENINFO_E2E_SCREENSHOT) {
    const screenshot = await win.webContents.capturePage()
    const { width, height } = screenshot.getSize()
    await writeFile(process.env.OPENINFO_E2E_SCREENSHOT, screenshot.toPNG())
    console.log(`[e2e] BrowserWindow screenshot ${width}x${height} → ${process.env.OPENINFO_E2E_SCREENSHOT}`)
  }
  await delay(500)
  if (queryPosts.length !== queriesBeforeEvent) {
    return fail(`sense.lane.updated caused ${queryPosts.length - queriesBeforeEvent} extra /query request(s)`)
  }
  const liveQueriesAfterEvent = queryPosts.filter((entry) => entry.query?.source === 'live-senses').length
  if (liveQueriesAfterEvent !== liveQueriesBeforeEvent) {
    return fail(`sense.lane.updated caused ${liveQueriesAfterEvent - liveQueriesBeforeEvent} extra live-senses query request(s)`)
  }
  const senseText = await drive(`document.querySelector('.sense-lanes')?.textContent ?? ''`)
  for (const forbidden of [
    SCREEN_LANE_UPDATE.latestCapture.id,
    SCREEN_LANE_UPDATE.latestCapture.capturedAt,
    SCREEN_LANE_UPDATE.latestProcessing.completedAt,
    SCREEN_LANE_UPDATE.latestProcessing.basis,
    'PRIVATE_RAW_FRAME',
    'PRIVATE_OCR_TEXT',
    'http://machine-endpoint.invalid',
  ]) {
    if (senseText.includes(forbidden)) return fail(`live senses copied private/machine provenance into the HUD: ${forbidden}`)
  }
  console.log('[e2e] Live senses hydrated mic/sys/screen in order; metadata event repainted capture+lag with zero /query and no private/machine copy')

  // ---- 3) the Ask face RESOLVES FROM THE BUNDLE (leaves its honest disabled state) ----
  await waitFor('window.openinfoPill.state().askAvailable === true', 'the Ask face resolving from the bundle')
  await waitFor(`!document.querySelector('[data-face="ask"]').disabled`, 'the Ask affordance leaving its disabled state')
  console.log('[e2e] Ask face resolved from GET /bundles → chat face surface; affordance is live')

  // ---- 4) click Ask → window expands to the ask extent (~432) + the resolved chat input mounts ----
  await drive(`document.querySelector('[data-verb="pill-face"][data-face="ask"]').click()`)
  await waitFor('!!document.querySelector(".in-text")', 'the resolved chat input block on the Ask face')
  await delay(300)
  const askH = win.getBounds().height
  console.log(`[e2e] ASK bounds.height=${askH}`)
  if (!near(askH, 432)) return fail(`pill ask height ${askH} ≉ 432 (~3× the bar)`)

  // a typed send flows end-to-end through the EXISTING Ask path
  win.focus()
  await drive('document.querySelector(".in-text").focus()')
  await delay(80)
  const question = 'what did we decide'
  await typeText(question)
  const typed = await drive('document.querySelector(".in-text").value')
  if (typed !== question) return fail(`keystrokes did not land: ${JSON.stringify(typed)}`)
  await drive(`document.querySelector('[data-verb="input-submit"]').click()`)
  await waitFor(
    `(() => { const el = document.querySelector('.in-turn.assistant.streaming'); return !!el && el.textContent.includes('Hello ') })()`,
    'the provisional streamed turn (chat.delta paint before the reply)',
    30,
  )
  await waitFor(
    `(() => { const log = document.querySelector('.in-log'); return !!log && log.innerHTML.includes('Hello from the pill.') && !log.innerHTML.includes('streaming') })()`,
    'the authoritative answer replacing the streamed turn',
  )
  if (chatPosts.length !== 1) return fail(`expected 1 POST /chat, saw ${chatPosts.length}`)
  const post = chatPosts[0]
  if (post.message !== question) return fail(`POST message ${JSON.stringify(post.message)} !== typed question`)
  if (typeof post.turnId !== 'string' || !post.turnId.startsWith('turn-')) return fail(`no client-minted turnId: ${post.turnId}`)
  if (!post.screenshot || post.screenshot.data !== FAKE_FRAME_B64) return fail('the send did not ship the captured frame')
  console.log('[e2e] Ask send flowed end-to-end: one frame + turnId POSTed, streamed then reconciled')

  // ---- 5) Show-Hide COLLAPSES the window to the bar (~56) and back ----
  await drive(`document.querySelector('[data-verb="pill-toggle"]').click()`)
  await delay(300)
  const barH = win.getBounds().height
  console.log(`[e2e] SHOW-HIDE (collapsed) bounds.height=${barH}`)
  if (!near(barH, 56)) return fail(`pill collapsed height ${barH} ≉ 56 (the bar)`)
  if ((await drive('window.openinfoPill.state().open')) !== false) return fail('Show-Hide did not close the panel')
  await drive(`document.querySelector('[data-verb="pill-toggle"]').click()`)
  await delay(300)
  const reopenH = win.getBounds().height
  if (!near(reopenH, 432)) return fail(`pill re-shown height ${reopenH} ≉ 432 (back to the Ask face)`)
  console.log('[e2e] Show-Hide collapsed to the bar and back — the real window height followed')

  // ---- 6) click Listen → back to the Listen extent + glance content ----
  await drive(`document.querySelector('[data-verb="pill-face"][data-face="listen"]').click()`)
  await delay(300)
  const backH = win.getBounds().height
  if (!near(backH, 300)) return fail(`pill back-to-listen height ${backH} ≉ 300`)
  if (await drive('!!document.querySelector(".in-text")')) return fail('the chat input is still mounted on the Listen face')
  console.log('[e2e] Listen face restored — the glance panel, not the chat input')

  // ---- 7) settings-on-hover opens the EXISTING settings path (the shell bridge fires) ----
  const before = settingsOpened
  await drive(`document.querySelector('[data-verb="pill-settings"]').click()`)
  await delay(200)
  if (settingsOpened !== before + 1) return fail('the settings affordance did not open the existing settings path')
  console.log('[e2e] settings-on-hover opened the existing settings path (hud:open-settings fired)')

  if (unauthorizedRequests.length !== 0) return fail(`fake engine saw unauthenticated renderer traffic: ${unauthorizedRequests.join(', ')}`)
  if (authenticatedRequests.length === 0) return fail('fake engine did not observe authenticated renderer traffic')

  console.log('\n[e2e] PASS — the pill: live-sense hydration/event patch, bundle-resolved Ask, faces toggle window height, typed send end-to-end, Show-Hide collapse, settings path')
  app.exit(0)
}

// Scene 0 destroys its anchor window before scenes 1-6 build theirs; without this guard that momentary
// zero-window gap trips Electron's default all-windows-closed quit and scenes 1-6 never run. The harness
// controls its own lifetime via app.exit() on PASS/FAIL.
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const engineUrl = `http://127.0.0.1:${server.address().port}`
  const eventUrl = engineUrl.replace(/^http/, 'ws')

  // Production injects the engine bearer in Electron's centralized webRequest listener so it never enters
  // renderer JS. Mirror that boundary here for both HTTP and the event-socket upgrade; the fake engine
  // rejects every protected request without it.
  electronSession.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const isEngineRequest = details.url.startsWith(engineUrl) || details.url.startsWith(eventUrl)
    callback({
      requestHeaders: isEngineRequest
        ? { ...details.requestHeaders, Authorization: `Bearer ${ENGINE_TOKEN}` }
        : details.requestHeaders,
    })
  })

  // Mirror shell.ts's panel-size handler verbatim (the height authority under test).
  ipcMain.on('hud:panel-size', (e, size) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (!w || w.isDestroyed()) return
    const area = screen.getDisplayMatching(w.getBounds()).workArea
    const [cw = 0, ch = 0] = w.getContentSize()
    const width = size.width !== undefined ? Math.max(0, Math.min(Math.ceil(size.width), area.width)) : cw
    const height = size.height !== undefined ? Math.max(0, Math.min(Math.ceil(size.height), area.height)) : ch
    if (width === cw && height === ch) return
    w.setContentSize(width, height)
  })
  // The Ask face capture bridge (frame injected at the IPC seam — TCC can't be granted to a harness).
  ipcMain.handle('hud:capture-frame', () => ({ ok: true, frame: { contentType: 'image/jpeg', data: FAKE_FRAME_B64 } }))
  // The pill's settings-on-hover bridge — count the opens (shell.ts opens GET /settings externally here).
  ipcMain.on('hud:open-settings', () => {
    settingsOpened += 1
  })

  // SCENE 0 first — enter through the anchor (the user's door), THEN the direct-driven scenes 1-6.
  runAnchorScene(engineUrl)
    .then(() => {
      win = makeWindow(engineUrl)
      return run(engineUrl)
    })
    .catch((err) => fail(String(err?.stack ?? err)))
})

setTimeout(() => fail('timed out after 60s'), 60_000)
