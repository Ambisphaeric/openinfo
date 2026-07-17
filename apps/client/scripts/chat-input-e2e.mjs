/**
 * Driven-input e2e for the chat window (S1 — the "basics bar" policy: every served surface gets an e2e that
 * drives REAL keys/clicks in the SERVED window). Green unit tests are not proof the served window accepts
 * typing or obeys its panel extents — this launches REAL Electron with the REAL hud.html + REAL compiled
 * preload against a minimal fake engine serving the seeded chat surface, then:
 *
 *   1) asserts the window opens at the panel COLLAPSED extent (≈120px) — BELOW the old auto-resize floor of
 *      HUD_MIN_HEIGHT(144). If the auto-resizer were still fighting the PanelController (the bug this slice
 *      fixes), the floor would win and this would be ≥144. So 120 proves ONE height authority per window.
 *   2) user expand() → the window grows to the EXPANDED extent (≈432px).
 *   3) focuses the `.in-text` textarea and sends REAL character key events (webContents.sendInputEvent) — the
 *      exact path that NSBeeps into the void when the window is `focusable:false`. It asserts the characters
 *      LAND in the input. This is impossible unless the chat's per-surface `focusable` override took effect.
 *   4) (#222) broadcasts a REAL `transcript.updated` WS event mid-type — the live refresh that re-renders the
 *      whole panel (renderInto wipes innerHTML, destroying the focused textarea) — and asserts keyboard focus,
 *      the caret, and the in-progress text all SURVIVE, so typing keeps landing. This is the rig "typing into
 *      nothing" defect proven in a real window; the deterministic DOM-level coverage lives in input-submit.test.
 *
 * The window is built from surfaceWindowSpec('surf-openinfo-chat', …) — the SAME resolver the shell factory
 * uses — so the test drives the real shipped window config (chrome + width + focusability), not a hand-rolled
 * one. It mirrors shell.ts's `hud:panel-size` handler verbatim (the height code path under test).
 *
 * Run: pnpm --filter @openinfo/client test:e2e:chat  (builds first). Needs a GUI (darwin) — not in the
 * default `test` (headless CI has no display), exactly like hud-bounds-e2e / panel-bounds-e2e.
 */
import http from 'node:http'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { surfaceWindowSpec, HUD_MIN_HEIGHT, windowTitleFor } from '../dist/main/window-options.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_DIR = path.join(__dirname, '..')
const HUD_HTML = path.join(CLIENT_DIR, 'hud.html')
const PRELOAD_JS = path.join(CLIENT_DIR, 'dist', 'main', 'preload.cjs')

const CHAT_SURFACE = {
  id: 'surf-openinfo-chat',
  name: 'Chat',
  context: 'any',
  version: 1,
  panel: { edge: 'below', collapsed: 120, expanded: 432, reveal: 'user', startExpanded: false },
  stack: [{ block: 'now' }, { block: 'input', input: { target: 'chat', submit: '/chat', mode: 'both' } }],
}

const sockets = new Set()
const wsFrame = (text) => {
  const payload = Buffer.from(text)
  const len = payload.length
  const header = len < 126 ? Buffer.from([0x81, len]) : Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff])
  return Buffer.concat([header, payload])
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const json = (body) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === '/health') return json({ status: 'ok', version: 'e2e' })
  if (url.pathname.startsWith('/layouts/surfaces/')) return json(CHAT_SURFACE)
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
const near = (a, b, tol = 8) => Math.abs(a - b) <= tol

/** Broadcast a WS event frame ({name,payload}) to the connected client — the real live-refresh trigger. */
const broadcast = (name, payload) => {
  const frame = wsFrame(JSON.stringify({ name, payload }))
  for (const s of sockets) s.write(frame)
}

let win
const drive = (expr) => win.webContents.executeJavaScript(expr)

const waitFor = async (expr, what) => {
  for (let i = 0; i < 100; i += 1) {
    const ok = await drive(expr).catch(() => false)
    if (ok) return
    await delay(100)
  }
  throw new Error(`${what} never became available (chat wiring or boot broken)`)
}

/** Type text into the focused element with REAL key events (the path that NSBeeps when non-focusable). */
const typeText = async (text) => {
  for (const ch of text) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch })
    win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch })
    await delay(20)
  }
}

const run = async () => {
  await waitFor('!!(window.openinfoPanel && document.querySelector(".in-text"))', 'openinfoPanel / .in-text')
  await delay(400) // let the initial panel-size report land + setContentSize apply

  // 1) opens at the COLLAPSED panel extent — below the OLD auto-resize floor (144). One height authority.
  const collapsed = win.getBounds().height
  console.log(`[e2e] chat COLLAPSED bounds.height=${collapsed}  (old floor HUD_MIN_HEIGHT=${HUD_MIN_HEIGHT})`)
  if (collapsed >= HUD_MIN_HEIGHT) return fail(`collapsed height ${collapsed} ≥ old floor ${HUD_MIN_HEIGHT} — the auto-resizer is still fighting the panel`)
  if (!near(collapsed, 120)) return fail(`collapsed height ${collapsed} ≉ panel collapsed extent 120`)

  // 2) user expand → the window grows to the expanded extent (so the input is comfortably visible to type in)
  await drive('window.openinfoPanel.expand()')
  await delay(300)
  const expanded = win.getBounds().height
  console.log(`[e2e] chat EXPANDED bounds.height=${expanded}`)
  if (!near(expanded, 432, 12)) return fail(`expanded height ${expanded} ≉ panel expanded extent 432`)

  // 3) focus the input and drive REAL keystrokes — they must LAND (no silent NSBeep dead path)
  win.focus()
  await drive('document.querySelector(".in-text").focus()')
  await delay(80)
  const focused = await drive('document.activeElement === document.querySelector(".in-text")')
  if (focused !== true) return fail('the .in-text input never became the active element (window cannot take focus?)')
  await typeText('hello ')
  await delay(120)

  // 4) #222 focus-across-refresh (the critical rig defect): a live transcript/distillate event re-renders the
  //    whole panel — renderInto wipes innerHTML, destroying the very textarea being typed into. Keyboard focus,
  //    the caret, and the in-progress text MUST survive; the rig bug was "typing into nothing" as the ~1/s
  //    refresh stole focus. Fire the REAL WS event the client listens for, then prove focus is retained AND
  //    live (typing continues to land in the same, now re-rendered, input).
  broadcast('transcript.updated', { source: 'mic', text: 'a distilled line arriving mid-type', capturedAtRange: { end: new Date().toISOString() } })
  await delay(250)
  const stillFocused = await drive('document.activeElement === document.querySelector(".in-text")')
  if (stillFocused !== true) return fail('the live refresh STOLE focus from the chat input (the #222 "typing into nothing" bug)')
  const afterRefresh = await drive('document.querySelector(".in-text").value')
  if (afterRefresh !== 'hello ') return fail(`the in-progress text was lost across the refresh: ${JSON.stringify(afterRefresh)} ≠ "hello "`)

  await typeText('openinfo')
  await delay(120)
  const value = await drive('document.querySelector(".in-text").value')
  console.log(`[e2e] typed across a live refresh  input.value=${JSON.stringify(value)}`)
  if (value !== 'hello openinfo') return fail(`keystrokes did not land across the refresh: input.value=${JSON.stringify(value)} ≠ "hello openinfo"`)

  console.log('\n[e2e] PASS — chat keeps keyboard focus + caret + text across a live refresh and obeys its panel extents')
  app.exit(0)
}

app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const engineUrl = `http://127.0.0.1:${server.address().port}`

  // Build the window from the SAME resolver the shell factory uses — real chrome + width + focusability.
  const spec = surfaceWindowSpec('surf-openinfo-chat', { startVisible: true })
  win = new BrowserWindow({
    ...spec.browserWindow,
    title: windowTitleFor('surf-openinfo-chat'),
    webPreferences: { ...spec.browserWindow.webPreferences, preload: PRELOAD_JS },
  })
  win.webContents.on('console-message', (d) => {
    if (d.level === 'error') console.error(`[hud] ${d.message}`)
  })

  // Mirror shell.ts's hud:panel-size handler verbatim — the height code path under test.
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
  // A hud:resize arriving for THIS panel window would mean the auto-resizer is ALSO installed (the bug).
  ipcMain.on('hud:resize', () => console.error('[e2e] UNEXPECTED hud:resize on a panel surface — two height authorities'))

  win.loadFile(HUD_HTML, { search: new URLSearchParams({ engine: engineUrl, surface: 'surf-openinfo-chat' }).toString() })
  win.showInactive()
  run().catch((err) => fail(String(err?.stack ?? err)))
})

setTimeout(() => fail('timed out after 30s'), 30_000)
