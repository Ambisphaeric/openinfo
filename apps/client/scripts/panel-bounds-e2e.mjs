/**
 * Driven e2e for the #134 attached-expansion-panel geometry (contract surface.panel + surfaces/hud/panel.ts
 * + preload.cts `panel` + shell.ts `hud:panel-size`). Green unit tests are not proof the SERVED window
 * resizes — this launches REAL Electron with the REAL hud.html + REAL compiled preload against a minimal
 * fake engine serving the two seeded panel surfaces, then drives expand/collapse (and an event-suggestion)
 * and asserts the REAL window bounds follow.
 *
 * A "probe main" (the hud-bounds-e2e precedent): it recreates the panel window with the shell's exact
 * webPreferences + preload and mirrors shell.ts's `hud:panel-size` handler verbatim (clamp → setContentSize).
 * Drives the sidebar (edge:right ⇒ WIDTH) on ONE renderer — the richest path (geometry + user toggle + the
 * event suggestion). The below-HUD (edge:below ⇒ HEIGHT) axis is the SAME code path with {height} for
 * {width}, covered by the panelSize unit test.
 *
 *   collapsed ≈ 0px width → user expand() → ≈ 320px → collapse() → ≈ 0px
 *   → a trigger event SUGGESTS open → ≈ 320px (state.suggested) → dismiss() → ≈ 0px
 *
 * Run: pnpm --filter @openinfo/client test:e2e:panel  (builds first). Needs a GUI — not in the default `test`.
 */
import http from 'node:http'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { hudWindowSpec } from '../dist/main/window-options.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_DIR = path.join(__dirname, '..')
const HUD_HTML = path.join(CLIENT_DIR, 'hud.html')
const PRELOAD_JS = path.join(CLIENT_DIR, 'dist', 'main', 'preload.cjs')

const SURFACES = {
  'surf-openinfo-chat': {
    id: 'surf-openinfo-chat', name: 'Chat', context: 'any', version: 1,
    panel: { edge: 'below', collapsed: 120, expanded: 432, reveal: 'user', startExpanded: false },
    stack: [{ block: 'now' }, { block: 'input', input: { target: 'chat', submit: '/chat', mode: 'both' } }],
  },
  'surf-openinfo-sidebar': {
    id: 'surf-openinfo-sidebar', name: 'Sidebar', context: 'any', version: 1,
    panel: { edge: 'right', collapsed: 0, expanded: 320, reveal: 'event', openOn: 'entity.updated', startExpanded: false },
    stack: [{ block: 'now' }, { block: 'relevant-now', top: 6, show: 'always', query: { source: 'relevant-now', params: { session: 'current' }, top: 6 } }],
  },
}

const sockets = new Set()
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
  if (url.pathname.startsWith('/layouts/surfaces/')) {
    const id = decodeURIComponent(url.pathname.slice('/layouts/surfaces/'.length))
    return json(SURFACES[id] ?? SURFACES['surf-openinfo-chat'])
  }
  if (url.pathname === '/sessions') return json([])
  if (url.pathname === '/query' && req.method === 'POST') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      let source = 'relevant-now'
      try {
        source = JSON.parse(raw).source ?? source
      } catch {
        /* default */
      }
      json({ source, items: [], truncated: false })
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
const near = (a, b, tol = 6) => Math.abs(a - b) <= tol

let win
const openWindow = (engineUrl, surfaceId) =>
  new Promise((resolve) => {
    const spec = hudWindowSpec({ startVisible: true })
    win = new BrowserWindow({ ...spec.browserWindow, webPreferences: { ...spec.browserWindow.webPreferences, preload: PRELOAD_JS } })
    win.webContents.on('console-message', (d) => {
      if (d.level === 'error') console.error(`[hud] ${d.message}`)
    })
    win.loadFile(HUD_HTML, { search: new URLSearchParams({ engine: engineUrl, surface: surfaceId }).toString() })
    win.showInactive()
    win.webContents.once('did-finish-load', () => resolve())
  })

const waitForPanelSeam = async () => {
  for (let i = 0; i < 100; i += 1) {
    const ok = await win.webContents.executeJavaScript('!!(window.openinfoPanel && document.querySelector(".hud"))').catch(() => false)
    if (ok) return
    await delay(100)
  }
  throw new Error('openinfoPanel / .hud never became available (panel wiring or boot broken)')
}
const drive = (expr) => win.webContents.executeJavaScript(expr)

const run = async (engineUrl) => {
  // ONE window on the sidebar surface (edge:right, reveal:event) — the richest scenario: WIDTH geometry,
  // user-driven expand/collapse, AND the event-driven dismissible suggestion, all on a single renderer.
  // (The below-HUD/HEIGHT axis is the same code path with {height} instead of {width} — covered by the
  // panelSize unit test; a single-renderer e2e keeps this robust on a headless-ish host.)
  await openWindow(engineUrl, 'surf-openinfo-sidebar')
  await waitForPanelSeam()
  await delay(400)

  // 1) starts collapsed (hidden, width 0)
  const collapsedW = win.getBounds().width
  console.log(`[e2e] sidebar COLLAPSED bounds.width=${collapsedW}`)
  if (!near(collapsedW, 0)) return fail(`sidebar collapsed width ${collapsedW} ≉ 0`)

  // 2) user expand → the window widens to the expanded extent
  await drive('window.openinfoPanel.expand()')
  await delay(300)
  const expandedW = win.getBounds().width
  console.log(`[e2e] sidebar EXPANDED (user) bounds.width=${expandedW}`)
  if (!near(expandedW, 320)) return fail(`sidebar expanded width ${expandedW} ≉ 320`)

  // 3) user collapse → back to hidden
  await drive('window.openinfoPanel.collapse()')
  await delay(300)
  const recollapsedW = win.getBounds().width
  if (!near(recollapsedW, 0)) return fail(`sidebar re-collapsed width ${recollapsedW} ≉ 0`)

  // 4) a classification trigger event SUGGESTS open (dismissible, never modal)
  broadcast('entity.updated', {})
  await delay(500)
  const suggestedW = win.getBounds().width
  const suggested = await drive('window.openinfoPanel.state().suggested')
  console.log(`[e2e] sidebar SUGGESTED bounds.width=${suggestedW} suggested=${suggested}`)
  if (!near(suggestedW, 320)) return fail(`sidebar suggested width ${suggestedW} ≉ 320`)
  if (suggested !== true) return fail('sidebar did not enter the suggested state on the trigger')

  // 5) dismiss the suggestion → collapses and won't re-nag
  await drive('window.openinfoPanel.dismissSuggestion()')
  await delay(300)
  const dismissedW = win.getBounds().width
  if (!near(dismissedW, 0)) return fail(`sidebar after dismiss width ${dismissedW} ≉ 0`)

  console.log('\n[e2e] PASS — attached panel honors collapsed/expanded bounds + the dismissible event-suggestion')
  app.exit(0)
}

app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const engineUrl = `http://127.0.0.1:${server.address().port}`

  // Mirror shell.ts's hud:panel-size handler verbatim — the code path under test.
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

  run(engineUrl).catch((err) => fail(String(err?.stack ?? err)))
})

setTimeout(() => fail('timed out after 30s'), 30_000)
