/**
 * Driven e2e for the content-sized HUD (the fix in window-options.ts / hud-height.ts / auto-resize.ts /
 * preload.cts / shell.ts). Green unit tests are not proof the SERVED window resizes — this launches REAL
 * Electron with the REAL hud.html + REAL compiled preload against a minimal fake engine, then drives
 * content through the fake engine and asserts the REAL window bounds follow.
 *
 * It is a "probe main" (the PHASE4-NOTES precedent): it recreates the HUD window with the shell's exact
 * webPreferences + preload and mirrors shell.ts's `hud:resize` handler verbatim (resolveHudHeight →
 * setContentSize) — no tray/engine-supervisor/capture, so the test is about the window, nothing else.
 *
 *   Empty  → window height < 720, >= HUD_MIN_HEIGHT, ≈ the painted content height (±4px)
 *   Grow   → push moments over WS → window height grows
 *   Shrink → clear moments → window height shrinks back toward the floor
 *
 * Run: pnpm --filter @openinfo/client test:e2e:hud  (builds first). Needs a GUI (darwin) — not wired
 * into the default `test` (headless CI has no display).
 */
import http from 'node:http'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { hudWindowSpec, HUD_MIN_HEIGHT } from '../dist/main/window-options.js'
import { resolveHudHeight } from '../dist/main/hud-height.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_DIR = path.join(__dirname, '..')
const HUD_HTML = path.join(CLIENT_DIR, 'hud.html')
const PRELOAD_JS = path.join(CLIENT_DIR, 'dist', 'main', 'preload.cjs')

// --- minimal fake engine: only what the HUD boot actually fetches (surface + sessions + query + WS) ---
const SURFACE = {
  id: 'surf-openinfo-hud',
  name: 'openinfo HUD',
  context: 'meeting',
  version: 1,
  stack: [
    { block: 'now' },
    { block: 'relevant-now', top: 4, show: 'always', query: { source: 'relevant-now', params: { session: 'current' }, top: 4 } },
    { block: 'moments', collapsed: false, query: { source: 'moments', params: { session: 'current' }, top: 20 } },
  ],
}

let moments = []
const makeMoment = (i) => ({
  id: `mom-${i}`,
  sessionId: 'ses-e2e',
  workspaceId: 'default',
  at: new Date(Date.now() - i * 1000).toISOString(),
  kind: 'note',
  text: `Fake moment ${i} — a line of content that forces the panel to paint another row.`,
  refs: [],
  source: 'mic',
  confidence: 0.9,
})

const sockets = new Set()
/** Server→client text frame (unmasked, ≤64KiB payloads — plenty for a tiny event). */
const wsFrame = (text) => {
  const payload = Buffer.from(text)
  const len = payload.length
  const header = len < 126 ? Buffer.from([0x81, len]) : Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff])
  return Buffer.concat([header, payload])
}
const broadcast = (name, payload) => {
  const frame = wsFrame(JSON.stringify({ name, payload }))
  for (const s of sockets) s.write(frame)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const json = (body) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === '/health') return json({ status: 'ok', version: 'e2e' })
  if (url.pathname.startsWith('/layouts/surfaces/')) return json(SURFACE)
  if (url.pathname === '/sessions') return json([]) // no live session — the honest empty Now line
  if (url.pathname === '/query' && req.method === 'POST') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      let source = 'moments'
      try {
        source = JSON.parse(raw).source ?? 'moments'
      } catch {
        /* default */
      }
      const items = source === 'moments' ? moments : []
      json({ source, items, truncated: false })
    })
    return
  }
  res.writeHead(404)
  res.end()
})

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key']
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
  socket.on('error', () => sockets.delete(socket))
})

const fail = (msg) => {
  console.error(`\n[e2e] FAIL: ${msg}`)
  app.exit(1)
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

let win
/** Wait until the renderer has actually painted the `.hud` panel, then settle one more frame. */
const waitForPanel = async () => {
  for (let i = 0; i < 100; i += 1) {
    const ok = await win.webContents.executeJavaScript('!!document.querySelector(".hud")').catch(() => false)
    if (ok) return
    await delay(100)
  }
  throw new Error('.hud never mounted (engine fake or boot broken)')
}
/** The panel's painted height + stage padding — the height the window SHOULD adopt, read from the DOM. */
const contentHeight = () =>
  win.webContents.executeJavaScript('Math.ceil(document.querySelector(".hud").getBoundingClientRect().height) + 24')

const run = async () => {
  await waitForPanel()
  await delay(400) // let the initial auto-resize report land + setContentSize apply

  const empty = win.getBounds().height
  const emptyContent = await contentHeight()
  console.log(`[e2e] EMPTY   bounds.height=${empty}  paintedContent=${emptyContent}  (HUD_MIN_HEIGHT=${HUD_MIN_HEIGHT})`)
  if (empty >= 720) return fail(`empty height ${empty} is not < 720 (dead zone not removed)`)
  if (empty < HUD_MIN_HEIGHT) return fail(`empty height ${empty} is below the floor ${HUD_MIN_HEIGHT}`)
  if (Math.abs(empty - Math.max(emptyContent, HUD_MIN_HEIGHT)) > 4)
    return fail(`empty window height ${empty} ≉ painted content ${emptyContent} (floored at ${HUD_MIN_HEIGHT})`)

  moments = Array.from({ length: 12 }, (_, i) => makeMoment(i))
  broadcast('moment.created', {})
  await delay(900)
  const grown = win.getBounds().height
  const grownContent = await contentHeight()
  console.log(`[e2e] GROWN   bounds.height=${grown}  paintedContent=${grownContent}`)
  if (grown <= empty) return fail(`window did not grow with content (${empty} → ${grown})`)
  if (Math.abs(grown - grownContent) > 4) return fail(`grown window height ${grown} ≉ painted content ${grownContent}`)

  moments = []
  broadcast('moment.created', {})
  await delay(900)
  const shrunk = win.getBounds().height
  const shrunkContent = await contentHeight()
  console.log(`[e2e] SHRUNK  bounds.height=${shrunk}  paintedContent=${shrunkContent}`)
  if (shrunk >= grown) return fail(`window did not shrink after clearing content (${grown} → ${shrunk})`)
  if (Math.abs(shrunk - empty) > 4) return fail(`shrunk height ${shrunk} did not return toward the floor ${empty}`)

  console.log('\n[e2e] PASS — window is content-sized and tracks content grow/shrink')
  app.exit(0)
}

app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const engineUrl = `http://127.0.0.1:${server.address().port}`
  const spec = hudWindowSpec({ startVisible: true })
  win = new BrowserWindow({
    ...spec.browserWindow,
    webPreferences: { ...spec.browserWindow.webPreferences, preload: PRELOAD_JS },
  })

  // Mirror shell.ts's hud:resize handler verbatim — this is the code path under test.
  ipcMain.on('hud:resize', (_e, measured) => {
    if (!win) return
    const max = screen.getDisplayMatching(win.getBounds()).workArea.height
    const height = resolveHudHeight(measured, { min: HUD_MIN_HEIGHT, max })
    const [w = 0, currentHeight = 0] = win.getContentSize()
    if (height === currentHeight) return
    win.setContentSize(w, height)
    const b = win.getBounds()
    console.log(`[e2e] hud:resize measured=${measured} → content ${w}×${height} · bounds ${b.width}×${b.height}`)
  })

  win.webContents.on('console-message', (d) => {
    if (d.level === 'error') console.error(`[hud] ${d.message}`)
  })
  win.loadFile(HUD_HTML, { search: new URLSearchParams({ engine: engineUrl, surface: 'surf-openinfo-hud' }).toString() })
  win.showInactive()
  run().catch((err) => fail(String(err?.stack ?? err)))
})

// Safety net: never hang a CI-less GUI run forever.
setTimeout(() => fail('timed out after 30s'), 30_000)
