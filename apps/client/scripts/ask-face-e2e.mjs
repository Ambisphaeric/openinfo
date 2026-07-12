/**
 * Driven e2e for the ASK FACE (the interaction bar: every served-surface slice gets an e2e that drives
 * real keys/clicks in the SERVED window — the QA doctrine after the broken-Save shipping green). Launches
 * REAL Electron with the REAL hud.html + REAL compiled preload against a minimal fake engine (the
 * chat-input-e2e harness), then proves the four Ask organs end-to-end in the served DOM:
 *
 *   1) type + send ⇒ the send captures ONE frame over the REAL preload bridge (`window.openinfoScreen`
 *      → ipc `hud:capture-frame`) and POSTs it with the message + a client-minted turnId; the reply
 *      STREAMS — the fake engine broadcasts `chat.delta` WS frames before answering, and the test
 *      observes the PROVISIONAL streamed turn painted in `.in-log` BEFORE the HTTP reply lands, then the
 *      authoritative answer replacing it (no streaming residue).
 *   2) EMPTY send ⇒ explain-my-screen: the POSTed message is the tpl-ask-default DOCUMENT body (served
 *      by the fake /templates route — resolved, not baked in), with the frame riding along.
 *   3) the thread PERSISTS across a window reopen: close + recreate the window, and the turns rehydrate
 *      from GET /chat/history into the served log.
 *   4) EMPTY send with capture REFUSED ⇒ an honest visible no-op ("Nothing to ask…" text in `.in-status`)
 *      and NO POST — never a silent swallow.
 *
 * DISCLOSED HARNESS SEAM: the macOS Screen-Recording TCC grant cannot be conferred on a throwaway
 * harness process, so the main-process frame source is injected at the IPC seam — this script registers
 * its own `ipcMain.handle('hud:capture-frame')` serving a synthetic JPEG (and later a refusal), exactly
 * where shell.ts registers captureAskFrame. The renderer path (preload bridge → InputSession → POST) is
 * the REAL shipped code; the desktopCapturer grab itself is covered by shell.ts sharing one grab helper
 * with the (manually verified) cadence path.
 *
 * Run: pnpm --filter @openinfo/client test:e2e:ask  (builds first). Needs a GUI (darwin) — not in the
 * default `test`, exactly like chat-input-e2e / attach-e2e.
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

const FAKE_FRAME_B64 = Buffer.from('one synthetic ask-face frame').toString('base64')
const ASK_DEFAULT_BODY = 'Explain what is on my screen right now, briefly and in plain terms.'

const CHAT_SURFACE = {
  id: 'surf-openinfo-chat',
  name: 'Chat',
  context: 'any',
  version: 1,
  panel: { edge: 'below', collapsed: 120, expanded: 432, reveal: 'user', startExpanded: false },
  stack: [{ block: 'now' }, { block: 'input', input: { target: 'chat', submit: '/chat', mode: 'both' } }],
}

// ---- the fake engine (chat-input-e2e harness + the Ask face routes) ----
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

const persistedTurns = [] // what POST /chat "persists" and GET /chat/history serves — the reopen proof
const chatPosts = [] // every POST /chat body, for the assertions

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const json = (body) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === '/health') return json({ status: 'ok', version: 'e2e' })
  if (url.pathname.startsWith('/layouts/surfaces/')) return json(CHAT_SURFACE)
  if (url.pathname === '/sessions') return json([])
  if (url.pathname === '/templates/tpl-ask-default') {
    return json({ id: 'tpl-ask-default', name: 'Explain my screen', kind: 'ask', builtin: true, body: ASK_DEFAULT_BODY })
  }
  if (url.pathname === '/chat/history') {
    return json({ turns: persistedTurns, total: persistedTurns.length, truncated: false })
  }
  if (url.pathname === '/chat' && req.method === 'POST') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = JSON.parse(raw)
      chatPosts.push(body)
      // Stream first (the ephemeral fast-path), answer later — the gap is what the progressive-paint
      // assertion lives in.
      broadcast('chat.delta', { turnId: body.turnId, seq: 0, text: 'Hello ', done: false })
      broadcast('chat.delta', { turnId: body.turnId, seq: 1, text: 'world.', done: false })
      setTimeout(() => {
        broadcast('chat.delta', { turnId: body.turnId, seq: 2, text: '', done: true })
        persistedTurns.push({ role: 'user', content: body.message }, { role: 'assistant', content: 'Hello world.' })
        json({
          answer: 'Hello world.',
          citations: [],
          budget: { contextTokens: 40, maxTokens: 512, turnsRemaining: 9, truncated: false, note: 'Context: screen(1).' },
        })
      }, 900)
    })
    return
  }
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

// ---- harness plumbing ----
const fail = (msg) => {
  console.error(`\n[e2e] FAIL: ${msg}`)
  app.exit(1)
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

let win
const drive = (expr) => win.webContents.executeJavaScript(expr)

const waitFor = async (expr, what, tries = 100) => {
  for (let i = 0; i < tries; i += 1) {
    const ok = await drive(expr).catch(() => false)
    if (ok) return
    await delay(100)
  }
  throw new Error(`${what} never became true (Ask face wiring or boot broken)`)
}

/** Type text into the focused element with REAL key events (the interaction bar — no synthetic value-set). */
const typeText = async (text) => {
  for (const ch of text) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch })
    win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch })
    await delay(15)
  }
}

const makeWindow = (engineUrl) => {
  const spec = surfaceWindowSpec('surf-openinfo-chat', { startVisible: true })
  const w = new BrowserWindow({
    ...spec.browserWindow,
    title: windowTitleFor('surf-openinfo-chat'),
    webPreferences: { ...spec.browserWindow.webPreferences, preload: PRELOAD_JS },
  })
  w.webContents.on('console-message', (d) => {
    if (d.level === 'error') console.error(`[hud] ${d.message}`)
  })
  w.loadFile(HUD_HTML, { search: new URLSearchParams({ engine: engineUrl, surface: 'surf-openinfo-chat' }).toString() })
  w.showInactive()
  return w
}

const run = async (engineUrl) => {
  await waitFor('!!(window.openinfoPanel && document.querySelector(".in-text"))', 'openinfoPanel / .in-text')
  await drive('window.openinfoPanel.expand()')
  await delay(300)

  // ---- 1) type + send: one captured frame ships; the reply streams into the served DOM ----
  win.focus()
  await drive('document.querySelector(".in-text").focus()')
  await delay(80)
  const question = 'what is on my screen'
  await typeText(question)
  const typed = await drive('document.querySelector(".in-text").value')
  if (typed !== question) return fail(`keystrokes did not land: ${JSON.stringify(typed)}`)
  await drive(`document.querySelector('[data-verb="input-submit"]').click()`)

  // Progressive paint: the PROVISIONAL streamed turn must appear BEFORE the (deliberately late) reply.
  await waitFor(
    `(() => { const el = document.querySelector('.in-turn.assistant.streaming'); return !!el && el.textContent.includes('Hello ') })()`,
    'the provisional streamed turn (chat.delta paint before the HTTP reply)',
    30,
  )
  console.log('[e2e] streamed provisional turn painted before the reply landed')

  // The authoritative reply replaces it — no streaming residue, the final answer stands.
  await waitFor(
    `(() => { const log = document.querySelector('.in-log'); return !!log && log.innerHTML.includes('Hello world.') && !log.innerHTML.includes('streaming') })()`,
    'the authoritative answer replacing the provisional streamed turn',
  )
  if (chatPosts.length !== 1) return fail(`expected 1 POST /chat, saw ${chatPosts.length}`)
  const first = chatPosts[0]
  if (first.message !== question) return fail(`POST message ${JSON.stringify(first.message)} !== typed question`)
  if (!first.screenshot || first.screenshot.data !== FAKE_FRAME_B64 || first.screenshot.contentType !== 'image/jpeg')
    return fail(`the send did not ship the captured frame: ${JSON.stringify(first.screenshot)?.slice(0, 80)}`)
  if (typeof first.turnId !== 'string' || !first.turnId.startsWith('turn-')) return fail(`no client-minted turnId: ${first.turnId}`)
  console.log('[e2e] send shipped ONE frame + turnId; streamed then reconciled')

  // ---- 2) EMPTY send ⇒ explain-my-screen (the default-ask DOCUMENT becomes the question) ----
  await drive(`document.querySelector('[data-verb="input-submit"]').click()`)
  await waitFor(
    `(() => { const log = document.querySelector('.in-log'); return !!log && log.textContent.includes(${JSON.stringify(ASK_DEFAULT_BODY)}) })()`,
    'the default-ask body painted as the user turn',
  )
  await waitFor(
    `(() => { const log = document.querySelector('.in-log'); return !!log && !log.innerHTML.includes('streaming') && log.textContent.split('Hello world.').length >= 3 })()`,
    'the empty-send turn resolving',
  )
  if (chatPosts.length !== 2) return fail(`expected 2 POSTs after the empty send, saw ${chatPosts.length}`)
  const second = chatPosts[1]
  if (second.message !== ASK_DEFAULT_BODY) return fail(`empty send posted ${JSON.stringify(second.message)} — not the tpl-ask-default body`)
  if (!second.screenshot) return fail('the empty send did not ship its frame')
  console.log('[e2e] empty send became the explain-my-screen document question')

  // ---- 3) the thread persists across a window REOPEN (GET /chat/history rehydrate) ----
  win.destroy()
  await delay(200)
  win = makeWindow(engineUrl)
  await waitFor('!!(window.openinfoPanel && document.querySelector(".in-text"))', 'reopened window boot')
  await waitFor(
    `(() => { const log = document.querySelector('.in-log'); return !!log && log.querySelectorAll('.in-turn').length === 4 && log.textContent.includes(${JSON.stringify(question)}) && log.textContent.includes('Hello world.') })()`,
    'the persisted thread rehydrating into the reopened window',
  )
  console.log('[e2e] reopened window rendered the persisted 4-turn thread from /chat/history')

  // ---- 4) EMPTY send with capture REFUSED ⇒ honest visible no-op, NO POST ----
  ipcMain.removeHandler('hud:capture-frame')
  ipcMain.handle('hud:capture-frame', () => ({ ok: false, reason: 'screen capture is off (e2e refusal)' }))
  const postsBefore = chatPosts.length
  await drive(`document.querySelector('[data-verb="input-submit"]').click()`)
  await waitFor(
    `(() => { const s = document.querySelector('.in-status'); return !!s && s.textContent.includes('Nothing to ask') && s.textContent.includes('screen capture is off (e2e refusal)') })()`,
    'the honest empty-send no-op text',
  )
  await delay(300)
  if (chatPosts.length !== postsBefore) return fail('an empty send with no frame still POSTed — it must be a visible no-op')
  console.log('[e2e] refused-capture empty send painted the honest no-op and posted nothing')

  console.log('\n[e2e] PASS — Ask face: screenshot-on-send, streamed reply, explain-my-screen, persisted thread across reopen, honest no-op')
  app.exit(0)
}

// Phase 3 destroys the only window to prove the reopen rehydrate — Electron's default would quit the
// app right there (a silent early exit-0 that LOOKS green). Stay alive until run() decides the verdict.
app.on('window-all-closed', () => {
  /* keep alive across the reopen phase */
})

app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const engineUrl = `http://127.0.0.1:${server.address().port}`

  // Mirror shell.ts's panel-size handler verbatim (the height authority under test elsewhere).
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
  // The DISCLOSED frame-source injection (see header): the harness serves the frame at the exact IPC seam
  // shell.ts registers captureAskFrame on — TCC cannot be granted to a throwaway harness process.
  ipcMain.handle('hud:capture-frame', () => ({ ok: true, frame: { contentType: 'image/jpeg', data: FAKE_FRAME_B64 } }))

  win = makeWindow(engineUrl)
  run(engineUrl).catch((err) => fail(String(err?.stack ?? err)))
})

setTimeout(() => fail('timed out after 60s'), 60_000)
