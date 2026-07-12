/**
 * Driven e2e for THE PILL (the-pill: the MVP Standard App window assembly). Green unit tests are not proof
 * the SERVED window behaves — this launches REAL Electron with the REAL hud.html + REAL compiled preload
 * against a minimal fake engine, opens surf-openinfo-pill, and proves the pill end-to-end in the served DOM
 * + REAL window bounds:
 *
 *   1) the window SELF-IDENTIFIES — document.title is the pill surface's name (S4), and the header
 *      rectangle carries Listen / Ask / Show-Hide / settings.
 *   2) faces RESOLVE FROM THE BUNDLE — GET /bundles → the chat face surfaceRef → its surface doc; the Ask
 *      affordance lights up (leaves its honest disabled state) once the chat face resolves.
 *   3) clicking Ask expands the window to the ask extent (~3× the bar) and mounts the RESOLVED chat organ;
 *      a typed send flows end-to-end through the EXISTING Ask path (one captured frame + client-minted
 *      turnId POSTed to /chat; the reply STREAMS then the authoritative answer lands).
 *   4) Show-Hide COLLAPSES the window to the bar (the real height changes to the bar extent) and back.
 *   5) clicking Listen returns to the Listen extent and glance content.
 *   6) the settings-on-hover affordance opens the EXISTING settings path (the hud:open-settings bridge
 *      fires — the same signal the tray's Settings command sends).
 *
 * Probe main (the ask-face / panel-bounds precedent): recreates the window with the shell's exact
 * webPreferences + preload and mirrors shell.ts's hud:panel-size / hud:capture-frame / hud:open-settings
 * handlers verbatim. TCC cannot be granted to a throwaway harness, so the frame source is injected at the
 * IPC seam (as ask-face-e2e does); the renderer path is the REAL shipped code.
 *
 * Run: pnpm --filter @openinfo/client test:e2e:pill  (builds first). Needs a GUI (darwin) — not in `test`.
 */
import http from 'node:http'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { surfaceWindowSpec, windowTitleFor } from '../dist/main/window-options.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_DIR = path.join(__dirname, '..')
const HUD_HTML = path.join(CLIENT_DIR, 'hud.html')
const PRELOAD_JS = path.join(CLIENT_DIR, 'dist', 'main', 'preload.cjs')

const FAKE_FRAME_B64 = Buffer.from('one synthetic pill ask frame').toString('base64')
const ASK_DEFAULT_BODY = 'Explain what is on my screen right now, briefly and in plain terms.'
const PILL_SURFACE_ID = 'surf-openinfo-pill'

// The pill surface (the Listen glance face) — bar 56 / ask 432, startExpanded so it opens as the pill.
const PILL_SURFACE = {
  id: PILL_SURFACE_ID,
  name: 'openinfo',
  context: 'meeting',
  version: 1,
  panel: { edge: 'below', collapsed: 56, expanded: 432, reveal: 'user', startExpanded: true },
  stack: [
    { block: 'now', id: 'pill-listen-now' },
    { block: 'moments', id: 'pill-listen-moments', query: { source: 'moments', params: { session: 'current' }, top: 20 } },
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
      let source = 'moments'
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

// ---- harness plumbing ----
const fail = (msg) => {
  console.error(`\n[e2e] FAIL: ${msg}`)
  app.exit(1)
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const near = (a, b, tol = 10) => Math.abs(a - b) <= tol

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

const makeWindow = (engineUrl) => {
  const spec = surfaceWindowSpec(PILL_SURFACE_ID, { startVisible: true })
  const w = new BrowserWindow({
    ...spec.browserWindow,
    title: windowTitleFor(PILL_SURFACE_ID),
    webPreferences: { ...spec.browserWindow.webPreferences, preload: PRELOAD_JS },
  })
  w.webContents.on('console-message', (d) => {
    if (d.level === 'error') console.error(`[hud] ${d.message}`)
  })
  w.loadFile(HUD_HTML, { search: new URLSearchParams({ engine: engineUrl, surface: PILL_SURFACE_ID }).toString() })
  w.showInactive()
  return w
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

  // ---- 2) the Ask face RESOLVES FROM THE BUNDLE (leaves its honest disabled state) ----
  await waitFor('window.openinfoPill.state().askAvailable === true', 'the Ask face resolving from the bundle')
  await waitFor(`!document.querySelector('[data-face="ask"]').disabled`, 'the Ask affordance leaving its disabled state')
  console.log('[e2e] Ask face resolved from GET /bundles → chat face surface; affordance is live')

  // ---- 3) click Ask → window expands to the ask extent (~432) + the resolved chat input mounts ----
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

  // ---- 4) Show-Hide COLLAPSES the window to the bar (~56) and back ----
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

  // ---- 5) click Listen → back to the Listen extent + glance content ----
  await drive(`document.querySelector('[data-verb="pill-face"][data-face="listen"]').click()`)
  await delay(300)
  const backH = win.getBounds().height
  if (!near(backH, 300)) return fail(`pill back-to-listen height ${backH} ≉ 300`)
  if (await drive('!!document.querySelector(".in-text")')) return fail('the chat input is still mounted on the Listen face')
  console.log('[e2e] Listen face restored — the glance panel, not the chat input')

  // ---- 6) settings-on-hover opens the EXISTING settings path (the shell bridge fires) ----
  const before = settingsOpened
  await drive(`document.querySelector('[data-verb="pill-settings"]').click()`)
  await delay(200)
  if (settingsOpened !== before + 1) return fail('the settings affordance did not open the existing settings path')
  console.log('[e2e] settings-on-hover opened the existing settings path (hud:open-settings fired)')

  console.log('\n[e2e] PASS — the pill: self-identifies, bundle-resolved Ask, faces toggle window height, typed send end-to-end, Show-Hide collapse, settings path')
  app.exit(0)
}

app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const engineUrl = `http://127.0.0.1:${server.address().port}`

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

  win = makeWindow(engineUrl)
  run(engineUrl).catch((err) => fail(String(err?.stack ?? err)))
})

setTimeout(() => fail('timed out after 60s'), 60_000)
