/**
 * Driven e2e for the ASK-FACE RESOLVE RACE — the path the shipped bug entered through. The packaged shell
 * creates the pill window BEFORE `ensureEngine()` spawns the bundled engine (shell.ts: createHudWindow()
 * runs before `await ensureEngine()`), so the renderer's one-shot GET /bundles lost that race and
 * `setAskAvailable(false)` stuck FOREVER: the Ask button (which gates the entire chat text box) was
 * permanently disabled on every packaged cold boot. Every prior e2e started its fake engine BEFORE the
 * window, so the suite stayed green while the race shipped. This scene inverts the order:
 *
 *   1) the ANCHOR pill window opens at t=0 (built exactly as createHudWindow does, from the config-resolved
 *      default — the Scene-0 entry-point policy) with NOTHING listening on the engine port;
 *   2) while the engine is down, the window is honestly non-blank — the boot chip names the wait, and no
 *      pill paints yet (so Ask cannot be silently dead-looking-live);
 *   3) the fake engine starts listening ~2.5s later (the packaged spawn);
 *   4) Ask BECOMES enabled — the resolve retry loop wins once the engine is healthy (the shipped one-shot
 *      never did: this exact assertion is the regression lock);
 *   5) clicking Ask (the user's button, not a seam) mounts the resolved chat panel + text input in the
 *      served DOM at the REAL ask window height, and typed keystrokes land in the text box.
 *
 * Probe main (the pill-e2e / ask-face precedent): mirrors shell.ts's hud:panel-size / hud:capture-frame /
 * hud:open-settings handlers verbatim; the renderer path is the REAL shipped code over the REAL preload.
 *
 * Run: pnpm --filter @openinfo/client test:e2e:askrace  (builds first). Needs a GUI (darwin) — not in `test`.
 */
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { surfaceWindowSpec, windowTitleFor } from '../dist/main/window-options.js'
import { resolveShellConfig } from '../dist/main/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_DIR = path.join(__dirname, '..')
const HUD_HTML = path.join(CLIENT_DIR, 'hud.html')
const PRELOAD_JS = path.join(CLIENT_DIR, 'dist', 'main', 'preload.cjs')

const FAKE_FRAME_B64 = Buffer.from('one synthetic race frame').toString('base64')
const PILL_SURFACE_ID = 'surf-openinfo-pill'
const ENGINE_DELAY_MS = 2_500 // the window opens this long before the engine listens (the packaged spawn)

// The pill surface (the Listen glance face) — bar 56 / ask 432, startExpanded so it opens as the pill.
const PILL_SURFACE = {
  id: PILL_SURFACE_ID,
  name: 'openinfo',
  context: 'meeting',
  version: 1,
  panel: { edge: 'below', collapsed: 56, expanded: 432, reveal: 'user', startExpanded: true },
  stack: [{ block: 'now', id: 'pill-listen-now' }],
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
const BUNDLE = {
  id: 'bundle-standard-app',
  name: 'Standard App',
  version: 1,
  faces: [
    { kind: 'hud', surfaceRef: PILL_SURFACE_ID },
    { kind: 'chat', surfaceRef: 'surf-openinfo-chat' },
  ],
}

// ---- the fake engine (the pill-e2e harness, minus the chat-turn plumbing this scene does not need) ----
const sockets = new Set()
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const json = (body) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === '/health') return json({ status: 'ok', version: 'e2e' })
  if (url.pathname === '/bundles') return json([BUNDLE])
  if (url.pathname.startsWith('/layouts/surfaces/')) {
    const id = decodeURIComponent(url.pathname.slice('/layouts/surfaces/'.length))
    return json(SURFACES[id] ?? PILL_SURFACE)
  }
  if (url.pathname === '/sessions') return json([])
  if (url.pathname === '/chat/history') return json({ turns: [], total: 0, truncated: false })
  if (url.pathname === '/query' && req.method === 'POST') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => json({ source: 'moments', items: [], truncated: false }))
    return
  }
  res.writeHead(404)
  res.end()
})
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key']
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`)
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
  socket.on('error', () => sockets.delete(socket))
})

/** Reserve a free loopback port, then release it — the window must open BEFORE anything listens there. */
const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })

// ---- harness plumbing (the pill-e2e idiom) ----
const fail = (msg) => {
  console.error(`\n[e2e] FAIL: ${msg}`)
  app.exit(1)
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const near = (a, b, tol = 10) => Math.abs(a - b) <= tol

let win
const drive = (expr) => win.webContents.executeJavaScript(expr)
const waitFor = async (expr, what, tries = 150) => {
  for (let i = 0; i < tries; i += 1) {
    const ok = await drive(expr).catch(() => false)
    if (ok) return
    await delay(100)
  }
  throw new Error(`${what} never became true (the race was lost permanently — the one-shot resolve bug)`)
}
const typeText = async (text) => {
  for (const ch of text) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch })
    win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch })
    await delay(15)
  }
}

const run = async (engineUrl, enginePort) => {
  const t0 = Date.now()

  // ---- 1) the ANCHOR pill window opens FIRST — nothing listening on the engine port (the packaged order) ----
  const cfg = resolveShellConfig({})
  if (cfg.surfaceId !== PILL_SURFACE_ID) return fail(`the anchor default is not the pill: ${JSON.stringify(cfg.surfaceId)}`)
  const spec = surfaceWindowSpec(cfg.surfaceId, { startVisible: false })
  win = new BrowserWindow({
    ...spec.browserWindow,
    title: windowTitleFor(cfg.surfaceId),
    webPreferences: { ...spec.browserWindow.webPreferences, preload: PRELOAD_JS },
  })
  win.loadFile(HUD_HTML, { search: new URLSearchParams({ engine: engineUrl, surface: cfg.surfaceId }).toString() })
  win.showInactive()
  console.log(`[e2e] t=0 anchor pill window opened against ${engineUrl} — engine NOT listening yet`)

  // ---- 2) while the engine is down: honestly non-blank (boot chip), no pill yet, so Ask is not fake-live ----
  await delay(1_800)
  const down = await drive(`(() => ({
    pillBar: !!document.querySelector('.pill-bar'),
    chip: document.querySelector('.hud-boot-status')?.textContent ?? '',
  }))()`)
  if (down.pillBar) return fail('the pill painted before the engine existed — this harness is not exercising the race')
  if (!/waiting for engine/.test(down.chip)) return fail(`no honest boot status while the engine is down: ${JSON.stringify(down.chip)}`)
  console.log(`[e2e] t=1.8s engine still down — honest boot chip: ${JSON.stringify(down.chip)}`)

  // ---- 3) the engine starts listening ~2.5s after the window opened (the packaged spawn) ----
  await delay(ENGINE_DELAY_MS - 1_800)
  await new Promise((resolve) => server.listen(enginePort, '127.0.0.1', resolve))
  const tUp = Date.now() - t0
  console.log(`[e2e] t=${(tUp / 1000).toFixed(1)}s engine is now listening (ensureEngine finished, in packaged terms)`)

  // ---- 4) Ask BECOMES enabled once the engine is healthy — THE regression lock (the one-shot never did) ----
  await waitFor('!!(window.openinfoPill && document.querySelector(".pill-bar"))', 'the boot controller recovering the pill')
  await waitFor('window.openinfoPill.state().askAvailable === true', 'the Ask face resolve retry winning after the engine came up')
  await waitFor(`(() => { const b = document.querySelector('[data-face="ask"]'); return !!b && !b.disabled && b.getAttribute('data-verb') === 'pill-face' })()`, 'the Ask affordance leaving its disabled state for a live wired verb')
  const tAsk = Date.now() - t0
  console.log(`[e2e] t=${(tAsk / 1000).toFixed(1)}s Ask ENABLED — the resolve retry recovered from the engine-late race (was: dead forever)`)

  // ---- 5) click Ask (the user's button) → the chat panel + text input render at the REAL ask height ----
  await drive(`document.querySelector('[data-verb="pill-face"][data-face="ask"]').click()`)
  await waitFor('!!document.querySelector(".input-block") && !!document.querySelector(".in-text")', 'the resolved chat panel + text input on the Ask face')
  await delay(300)
  const askH = win.getBounds().height
  console.log(`[e2e] ASK bounds.height=${askH}`)
  if (!near(askH, 432)) return fail(`pill ask height ${askH} ≉ 432 (the ask extent)`)

  // typed keystrokes land in the text box — the chat input is REAL, not painted chrome
  win.focus()
  await drive('document.querySelector(".in-text").focus()')
  await delay(80)
  await typeText('hi there')
  const typed = await drive('document.querySelector(".in-text").value')
  if (typed !== 'hi there') return fail(`keystrokes did not land in the Ask text box: ${JSON.stringify(typed)}`)
  console.log('[e2e] the Ask text box accepted typed input after the race recovery')

  console.log('\n[e2e] PASS — engine-late race: honest wait, Ask enabled after the engine came up, chat panel + text input live at the ask extent')
  app.exit(0)
}

app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  // Mirror shell.ts's handlers verbatim (the pill-e2e precedent).
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
  ipcMain.handle('hud:capture-frame', () => ({ ok: true, frame: { contentType: 'image/jpeg', data: FAKE_FRAME_B64 } }))
  ipcMain.on('hud:open-settings', () => {})

  const port = await freePort()
  run(`http://127.0.0.1:${port}`, port).catch((err) => fail(String(err?.stack ?? err)))
})

setTimeout(() => fail('timed out after 60s'), 60_000)
