/**
 * Driven e2e for the multi-window app registry (#19). Green unit tests are not proof that N REAL Electron
 * windows each render their OWN surface; this launches real Electron with the real hud.html + real
 * compiled preload against a minimal fake engine serving TWO surfaces, drives the REAL compiled
 * WindowRegistry to open both, and asserts:
 *
 *   Open two   → two live windows exist; each requested + rendered its OWN surface document (?surface=)
 *   Isolation  → closing ONE window destroys only it; the other stays alive with its panel intact
 *
 * It is a "probe main" (the hud-bounds-e2e precedent): the real window factory pieces (window-options,
 * app-registry) against a fake engine — no tray/capture/engine-supervisor, so the test is about the
 * windows + registry, nothing else.
 *
 * Run: pnpm --filter @openinfo/client test:e2e:multiwindow  (builds first). Needs a GUI (darwin) — not
 * wired into the default headless `test`.
 */
import http from 'node:http'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'
import { hudWindowSpec } from '../dist/main/window-options.js'
import { WindowRegistry } from '../dist/main/app-registry.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_DIR = path.join(__dirname, '..')
const HUD_HTML = path.join(CLIENT_DIR, 'hud.html')
const PRELOAD_JS = path.join(CLIENT_DIR, 'dist', 'main', 'preload.cjs')

// --- two distinct surfaces: A is the full HUD, B is a now-only minimal readout ---
const SURFACES = {
  'surf-a': {
    id: 'surf-a',
    name: 'App A',
    context: 'meeting',
    version: 1,
    stack: [{ block: 'now' }, { block: 'moments', collapsed: false, query: { source: 'moments', params: { session: 'current' }, top: 20 } }],
  },
  'surf-b': { id: 'surf-b', name: 'App B', context: 'any', version: 1, stack: [{ block: 'now' }] },
}

const requestedSurfaceIds = new Set()

const sockets = new Set()
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const json = (body) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === '/health') return json({ status: 'ok', version: 'e2e' })
  if (url.pathname === '/layouts/surfaces') return json(Object.values(SURFACES).map((s) => ({ id: s.id, name: s.name })))
  const match = url.pathname.match(/^\/layouts\/surfaces\/(.+)$/)
  if (match) {
    const id = decodeURIComponent(match[1])
    requestedSurfaceIds.add(id)
    return SURFACES[id] ? json(SURFACES[id]) : (res.writeHead(404), res.end())
  }
  if (url.pathname === '/sessions') return json([])
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

const fail = (msg) => {
  console.error(`\n[e2e] FAIL: ${msg}`)
  app.exit(1)
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/** Wait until a window's renderer has painted its `.hud` panel. */
const waitForPanel = async (win, label) => {
  for (let i = 0; i < 100; i += 1) {
    const ok = await win.webContents.executeJavaScript('!!document.querySelector(".hud")').catch(() => false)
    if (ok) return
    await delay(100)
  }
  throw new Error(`${label}: .hud never mounted`)
}
const surfaceParam = (win) => win.webContents.executeJavaScript('new URLSearchParams(location.search).get("surface")')

app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const engineUrl = `http://127.0.0.1:${server.address().port}`

  // The REAL registry, opening each surface into a real HUD-style window (the shell's exact create path).
  const registry = new WindowRegistry({
    create: (surfaceId) => {
      const spec = hudWindowSpec({ startVisible: true })
      const win = new BrowserWindow({ ...spec.browserWindow, webPreferences: { ...spec.browserWindow.webPreferences, preload: PRELOAD_JS } })
      win.webContents.on('console-message', (d) => {
        if (d.level === 'error') console.error(`[${surfaceId}] ${d.message}`)
      })
      win.loadFile(HUD_HTML, { search: new URLSearchParams({ engine: engineUrl, surface: surfaceId }).toString() })
      win.on('closed', () => registry.retire(surfaceId, win))
      win.showInactive()
      return win
    },
    focus: (win) => win.showInactive(),
    close: (win) => win.close(),
    isAlive: (win) => !win.isDestroyed(),
  })

  const run = async () => {
    const a = registry.openOrFocus('surf-a')
    const b = registry.openOrFocus('surf-b')

    // openOrFocus must not create a duplicate for an already-open surface.
    if (registry.openOrFocus('surf-a') !== a) return fail('openOrFocus recreated surf-a instead of focusing it')

    await waitForPanel(a, 'surf-a')
    await waitForPanel(b, 'surf-b')

    const live = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    console.log(`[e2e] OPEN    windows=${live.length}  openIds=${JSON.stringify(registry.openSurfaceIds())}`)
    if (live.length !== 2) return fail(`expected 2 windows, got ${live.length}`)

    // Each window rendered its OWN surface (?surface= binding) and fetched its own document.
    const [pa, pb] = [await surfaceParam(a), await surfaceParam(b)]
    console.log(`[e2e] BINDING surf-a?→${pa}  surf-b?→${pb}  serverFetched=${JSON.stringify([...requestedSurfaceIds])}`)
    if (pa !== 'surf-a' || pb !== 'surf-b') return fail(`window/surface binding wrong (a=${pa}, b=${pb})`)
    if (!requestedSurfaceIds.has('surf-a') || !requestedSurfaceIds.has('surf-b')) return fail('engine did not receive both surface fetches')

    // ISOLATION: close surf-a; surf-b must be untouched.
    registry.close('surf-a')
    await delay(600)
    if (!a.isDestroyed()) return fail('surf-a window did not close')
    if (b.isDestroyed()) return fail('closing surf-a also destroyed surf-b')
    const stillPainted = await b.webContents.executeJavaScript('!!document.querySelector(".hud")').catch(() => false)
    if (!stillPainted) return fail('surf-b lost its panel when surf-a closed')
    if (registry.isOpen('surf-a')) return fail('registry still reports surf-a open after close')
    if (!registry.isOpen('surf-b')) return fail('registry lost surf-b after closing surf-a')
    console.log(`[e2e] ISOLATE surf-a destroyed=${a.isDestroyed()}  surf-b alive=${!b.isDestroyed()}  openIds=${JSON.stringify(registry.openSurfaceIds())}`)

    console.log('\n[e2e] PASS — two windows each render their own surface; closing one leaves the other intact')
    app.exit(0)
  }
  run().catch((err) => fail(String(err?.stack ?? err)))
})

setTimeout(() => fail('timed out after 30s'), 30_000)
