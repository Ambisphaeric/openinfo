/**
 * Driven e2e for the S5 clip MECHANISM (stage/hud CSS + the window sizing contract). Green unit tests are
 * not proof the SERVED narrow windows stop clipping — this launches REAL Electron with the REAL hud.html +
 * REAL stylesheet against a fake engine, opens the known-narrow HUD-chrome surfaces (fields 480,
 * glass-minimal 520) with deliberately WIDE content, and asserts the painted `.hud` panel sits FULLY inside
 * the window: neither edge is pushed off-screen.
 *
 * The bug: `.hud` had a default `min-width:auto`, so content wider than a narrow window forced the panel
 * wider than the window; `.stage`'s `justify-content:center` then split that overflow across BOTH edges and
 * the left overflow was unreachable (you cannot scroll a frameless window left) — content silently lost.
 * The fix makes `.hud` fluid (`width:100%;max-width:660px;min-width:0`) so it can never exceed the window.
 * We reproduce the trigger with a long unbreakable token (max min-content) and assert `.hud.left >= 0` and
 * `.hud.right <= innerWidth` — impossible under the old centered-overflow clip.
 *
 * Run: pnpm --filter @openinfo/client test:e2e:clip  (builds first). Needs a GUI (darwin) — not in `test`.
 */
import http from 'node:http'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { surfaceWindowSpec, HUD_MIN_HEIGHT } from '../dist/main/window-options.js'
import { resolveHudHeight } from '../dist/main/hud-height.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_DIR = path.join(__dirname, '..')
const HUD_HTML = path.join(CLIENT_DIR, 'hud.html')
const PRELOAD_JS = path.join(CLIENT_DIR, 'dist', 'main', 'preload.cjs')

// A very long UNBREAKABLE token forces the panel's min-content wide — the exact trigger for the old clip.
const LONG = 'Supercalifragilisticexpialidocious-antidisestablishmentarianism-pneumonoultramicroscopicsilicovolcanoconiosis'
const surfaceDoc = (id) => ({
  id,
  name: id,
  context: 'meeting',
  version: 1,
  stack: [
    { block: 'now' },
    { block: 'moments', collapsed: false, query: { source: 'moments', params: { session: 'current' }, top: 20 } },
  ],
})
// Reuse hud-bounds-e2e's proven moment shape (it mounts `.hud` reliably), but with a wide unbreakable token.
const ITEMS = [
  {
    id: 'mom-clip',
    sessionId: 'ses-e2e',
    workspaceId: 'default',
    at: new Date().toISOString(),
    kind: 'note',
    text: LONG,
    refs: [],
    source: 'mic',
    confidence: 0.9,
  },
]

const sockets = new Set()
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const json = (body) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === '/health') return json({ status: 'ok', version: 'e2e' })
  if (url.pathname.startsWith('/layouts/surfaces/')) {
    const id = decodeURIComponent(url.pathname.slice('/layouts/surfaces/'.length))
    return json(surfaceDoc(id))
  }
  if (url.pathname === '/sessions') return json([])
  if (url.pathname === '/query' && req.method === 'POST') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      let source = 'moments'
      try {
        source = JSON.parse(raw).source ?? source
      } catch {
        /* default */
      }
      json({ source, items: source === 'moments' ? ITEMS : [], truncated: false })
    })
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

const fail = (msg) => {
  console.error(`\n[e2e] FAIL: ${msg}`)
  app.exit(1)
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

// ONE reused window (navigating to each surface) — creating a second BrowserWindow spawns a second renderer
// process, which a sandboxed/headless-ish host can refuse (mach-port rendezvous). Re-loadFile navigates the
// SAME renderer, so we still exercise each surface's real width + the shared stylesheet.
let win
const checkSurface = async (engineUrl, surfaceId) => {
  // The window's outer WIDTH is the surface's declared config — resize this reused window to match it.
  const spec = surfaceWindowSpec(surfaceId, { startVisible: true })
  win.setContentSize(spec.browserWindow.width, spec.browserWindow.height)
  await win.loadFile(HUD_HTML, { search: new URLSearchParams({ engine: engineUrl, surface: surfaceId }).toString() })
  let mounted = false
  for (let i = 0; i < 100; i += 1) {
    mounted = await win.webContents.executeJavaScript('!!document.querySelector(".hud")').catch(() => false)
    if (mounted) break
    await delay(100)
  }
  if (!mounted) return `${surfaceId}: .hud never mounted (engine fake or boot broken)`
  await delay(400)
  const geom = await win.webContents.executeJavaScript(`(() => {
    const hud = document.querySelector('.hud');
    const r = hud.getBoundingClientRect();
    return { left: r.left, right: r.right, width: r.width, inner: window.innerWidth };
  })()`)
  const bounds = win.getBounds()
  console.log(`[e2e] ${surfaceId} (window ${bounds.width}px): .hud left=${geom.left.toFixed(1)} right=${geom.right.toFixed(1)} width=${geom.width.toFixed(1)} inner=${geom.inner}`)
  // The both-edges clip: a panel wider than the window centered off-screen on the LEFT (unreachable).
  if (geom.left < -1) return `${surfaceId}: .hud left edge ${geom.left.toFixed(1)} is off-screen (both-edges clip not fixed)`
  if (geom.right > geom.inner + 1) return `${surfaceId}: .hud right edge ${geom.right.toFixed(1)} overflows the ${geom.inner}px window`
  if (geom.width > geom.inner + 1) return `${surfaceId}: .hud width ${geom.width.toFixed(1)} exceeds the ${geom.inner}px window`
  return null
}

app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const engineUrl = `http://127.0.0.1:${server.address().port}`

  const spec = surfaceWindowSpec('surf-openinfo-fields', { startVisible: true })
  win = new BrowserWindow({
    ...spec.browserWindow,
    webPreferences: { ...spec.browserWindow.webPreferences, preload: PRELOAD_JS },
  })
  win.webContents.on('console-message', (d) => {
    if (d.level === 'error') console.error(`[hud] ${d.message}`)
  })
  // Mirror the content-sizer so each window is its natural served height (realistic paint; not the clip axis).
  ipcMain.on('hud:resize', (e, measured) => {
    if (BrowserWindow.fromWebContents(e.sender) !== win || win.isDestroyed()) return
    const max = screen.getDisplayMatching(win.getBounds()).workArea.height
    const [w = 0, ch = 0] = win.getContentSize()
    const height = resolveHudHeight(measured, { min: HUD_MIN_HEIGHT, max })
    if (height !== ch) win.setContentSize(w, height)
  })
  win.showInactive()

  for (const surfaceId of ['surf-openinfo-fields', 'surf-glass-minimal']) {
    const err = await checkSurface(engineUrl, surfaceId)
    if (err) return fail(err)
  }
  console.log('\n[e2e] PASS — narrow HUD windows fit their content; neither edge is clipped off-screen')
  app.exit(0)
})

setTimeout(() => fail('timed out after 30s'), 30_000)
