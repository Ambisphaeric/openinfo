/**
 * Driven served e2e for the note-taker SESSION-HISTORY DRILL-DOWN (#247). Green unit/controller tests are not
 * proof the SERVED window behaves: this launches REAL Electron with the REAL hud.html + REAL compiled preload
 * against a minimal fake engine, opens surf-openinfo-notetaker through the PRODUCTION window constructor, and
 * proves the drill-down end-to-end in the served DOM:
 *
 *   1) the pad boots as the three-zone note-taker and self-identifies; the left rail shows the session-history
 *      list with clickable rows (the wired `session-open` verb) and NO dead feature-nav tabs.
 *   2) the CENTER opens on the live current-session pad.
 *   3) clicking a PAST session row shows THAT session's read-only record in the center — its session summary
 *      and its moments, NOT the live session's — under a "Past session" header with a Back-to-live control,
 *      and NO Record affordance (read-only; the consent boundary — a history click starts/stops nothing).
 *   4) clicking Back-to-live returns the center to the live current-session view.
 *   5) a past session whose detail query comes back empty surfaces honest text ("Nothing was captured…"),
 *      never a blank center.
 *
 * THE PRODUCTION WINDOW PATH (#194, as pill-e2e): the window is built by `constructSurfaceWindow` — the EXACT
 * function the shell's factory runs — so the contract assertion, spec resolution, title stamp, preload, and
 * hud.html load are the production body. The fake engine bearer is injected at the defaultSession webRequest
 * seam (production pins per-webContents), mirroring pill-e2e; the renderer path is the REAL shipped code.
 *
 * Run: pnpm --filter @openinfo/client test:e2e:notetaker-history  (builds first). Needs a GUI (darwin).
 */
import http from 'node:http'
import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, session as electronSession } from 'electron'
import { configForSurface } from '../dist/main/window-options.js'
import { constructSurfaceWindow } from '../dist/main/surface-window.js'

const NOTETAKER_ID = 'surf-openinfo-notetaker'
const ENGINE_TOKEN = 'notetaker-history-e2e-bearer-000000000000000000001'
const LIVE_ID = 'ses-live'
const PAST_ID = 'ses-past'
const LIVE_MOMENT = 'Live: shipping the beta today'
const PAST_MOMENT = 'Past: agreed to renew for a year'
const PAST_SUMMARY = 'they agreed the one-year renewal'
const PAST_TITLE = 'Q3 renewal — security review'

const LIVE_SESSION = { id: LIVE_ID, workspaceId: 'default', modeId: 'mode-meeting', startedAt: '2026-07-16T14:00:00.000Z', title: 'Live standup', attribution: { evidence: [], confidence: 1 } }
const PAST_SESSION = { id: PAST_ID, workspaceId: 'default', modeId: 'mode-meeting', startedAt: '2026-07-10T09:00:00.000Z', endedAt: '2026-07-10T09:31:00.000Z', title: PAST_TITLE, attribution: { evidence: [], confidence: 1 } }
const moment = (id, sessionId, text, at) => ({ id, sessionId, workspaceId: 'default', at, kind: 'decision', text, refs: [], source: 'mic', confidence: 0.9 })
const summary = (id, sessionId, level, text) => ({ id, workspaceId: 'default', sessionId, level, windowStart: '2026-07-10T09:00:00Z', windowEnd: '2026-07-10T09:05:00Z', text, proposal: true, children: [], provenance: { slot: 'llm', endpoint: 'this-mac', model: 'qwen2.5-7b' }, schemaVersion: 1, createdAt: '2026-07-10T09:05:01Z' })

// A past session that captured nothing — flip via ?empty on the query (scene 5 opens its own window).
let pastEmpty = false

const loadSurface = async () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const raw = await readFile(join(here, '..', '..', '..', 'templates', 'openinfo-notetaker', 'surface.json'), 'utf8')
  return JSON.parse(raw)
}
let NOTETAKER_SURFACE

const sockets = new Set()
const authenticated = []
const unauthorized = []
const authorize = (req, res) => {
  if (req.headers.authorization === `Bearer ${ENGINE_TOKEN}`) { authenticated.push(`${req.method} ${req.url}`); return true }
  unauthorized.push(`${req.method} ${req.url}`)
  res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'authentication required' })); return false
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const json = (body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (url.pathname === '/health') return json({ status: 'ok', version: 'e2e' })
  if (!authorize(req, res)) return
  if (url.pathname.startsWith('/layouts/surfaces/')) return json(NOTETAKER_SURFACE)
  if (url.pathname === '/sessions') return json([LIVE_SESSION])
  if (url.pathname === '/query' && req.method === 'POST') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      let query = { source: 'moments', params: {} }
      try { query = JSON.parse(raw) } catch { /* default */ }
      const sess = query.params?.session
      if (query.source === 'sessions') return json({ source: 'sessions', items: [LIVE_SESSION, PAST_SESSION], truncated: false })
      if (query.source === 'moments') {
        if (sess === 'current') return json({ source: 'moments', items: [moment('m-live', LIVE_ID, LIVE_MOMENT, '2026-07-16T14:02:00Z')], truncated: false })
        if (sess === PAST_ID) return json({ source: 'moments', items: pastEmpty ? [] : [moment('m-past', PAST_ID, PAST_MOMENT, '2026-07-10T09:03:00Z')], truncated: false })
        return json({ source: 'moments', items: [], truncated: false })
      }
      if (query.source === 'summaries') {
        const level = query.params?.level
        if (sess === PAST_ID && !pastEmpty) return json({ source: 'summaries', items: [summary(`s-${level}`, PAST_ID, level ?? 'session', PAST_SUMMARY)], truncated: false })
        return json({ source: 'summaries', items: [], truncated: false })
      }
      return json({ source: query.source ?? 'moments', items: [], truncated: false })
    })
    return
  }
  res.writeHead(404); res.end()
})

server.on('upgrade', (req, socket) => {
  if (req.headers.authorization !== `Bearer ${ENGINE_TOKEN}`) {
    unauthorized.push(`UPGRADE ${req.url}`); socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return
  }
  authenticated.push(`UPGRADE ${req.url}`)
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`)
  sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => sockets.delete(socket))
})

const fail = (msg) => { console.error(`\n[e2e] FAIL: ${msg}`); app.exit(1) }
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const makeWindow = (engineUrl) => {
  const w = constructSurfaceWindow(NOTETAKER_ID, { chrome: configForSurface(NOTETAKER_ID).chrome, isDefaultHud: false, startVisible: true }, { engineUrl })
  w.showInactive()
  return w
}

const run = async (win) => {
  const drive = (expr) => win.webContents.executeJavaScript(expr)
  const waitFor = async (expr, what, tries = 100) => {
    for (let i = 0; i < tries; i += 1) { if (await drive(expr).catch(() => false)) return; await delay(100) }
    throw new Error(`${what} never became true`)
  }
  const centerText = () => drive(`document.querySelector('.nt-center')?.textContent ?? ''`)

  // 1) the pad boots as the three-zone note-taker with a clickable history list and NO dead nav tabs.
  await waitFor(`!!document.querySelector('.nt-app') && document.querySelectorAll('.sess-nav').length >= 2`, 'the note-taker + its clickable history rows')
  if (await drive(`!!document.querySelector('.nt-navitem')`)) return fail('the dead feature-nav tabs are still rendered')
  if (await drive(`document.querySelectorAll('button.nt-home').length > 0`)) return fail('the Home brand mark is still a (dead) button')
  if (await drive(`document.body.textContent.includes('Enrichments')`)) return fail('the machine-word "Enrichments" header is still rendered')
  console.log('[e2e] note-taker booted: clickable history, no dead nav, no machine header')

  // 2) the center opens on the live current-session pad.
  await waitFor(`(document.querySelector('.nt-center')?.textContent ?? '').includes(${JSON.stringify(LIVE_MOMENT)})`, 'the live moment in the center')
  if (await drive(`!!document.querySelector('.nt-past-head')`)) return fail('a past-session header is showing before any row was clicked')

  // 3) click the PAST session row → the center shows THAT session, not the live one.
  await drive(`document.querySelector('.sess-nav[data-session="${PAST_ID}"]').click()`)
  await waitFor(`!!document.querySelector('.nt-past-head')`, 'the past-session header after the click')
  const past = await centerText()
  if (!past.includes(PAST_TITLE)) return fail(`the past header did not name the session: ${JSON.stringify(past.slice(0, 120))}`)
  if (!past.includes(PAST_MOMENT)) return fail('the past session moment is not in the center')
  if (!past.includes(PAST_SUMMARY)) return fail('the past session summary is not in the center')
  if (past.includes(LIVE_MOMENT)) return fail('the LIVE moment is still showing in the center of a past-session view')
  if (await drive(`!!document.querySelector('.nt-center .session-record')`)) return fail('a Record control is showing in the read-only past view (consent boundary)')
  if (!(await drive(`!!document.querySelector('.nt-center [data-verb="session-back"]')`))) return fail('the Back-to-live control is missing')
  console.log('[e2e] past-session drill-down: center shows the past record, read-only, with Back-to-live')

  // 4) Back-to-live → the live current-session view returns.
  await drive(`document.querySelector('[data-verb="session-back"]').click()`)
  await waitFor(`!document.querySelector('.nt-past-head')`, 'the past header clearing on Back-to-live')
  const back = await centerText()
  if (!back.includes(LIVE_MOMENT)) return fail('the live view did not return after Back-to-live')
  console.log('[e2e] Back-to-live returned the center to the live current-session view')

  if (unauthorized.length !== 0) return fail(`fake engine saw unauthenticated renderer traffic: ${unauthorized.join(', ')}`)
  if (authenticated.length === 0) return fail('fake engine did not observe authenticated renderer traffic')
  console.log('\n[e2e] PASS — note-taker history drill-down: clickable rows, past record in center, Back-to-live, no dead chrome')
}

const runEmptyScene = async (engineUrl) => {
  // 5) a past session whose detail query returns nothing surfaces honest text, never a blank center.
  pastEmpty = true
  const win = makeWindow(engineUrl)
  const drive = (expr) => win.webContents.executeJavaScript(expr)
  const waitFor = async (expr, what, tries = 100) => {
    for (let i = 0; i < tries; i += 1) { if (await drive(expr).catch(() => false)) return; await delay(100) }
    throw new Error(`${what} never became true`)
  }
  await waitFor(`document.querySelectorAll('.sess-nav').length >= 2`, 'the empty-scene history rows')
  await drive(`document.querySelector('.sess-nav[data-session="${PAST_ID}"]').click()`)
  await waitFor(`!!document.querySelector('.nt-past-head')`, 'the empty-scene past header')
  await waitFor(`(document.querySelector('.nt-center')?.textContent ?? '').includes('Nothing was captured in this session')`, 'the honest empty note')
  if (await drive(`(document.querySelector('.nt-center')?.textContent ?? '').includes('turn on')`)) return fail('a live fresh-install prompt is showing over a finished session')
  if (!(await drive(`!!document.querySelector('.nt-center [data-verb="session-back"]')`))) return fail('Back-to-live is unreachable in the empty past view')
  console.log('[e2e] empty past session: honest "Nothing was captured" text, Back-to-live still reachable, never a blank')
  win.destroy()
}

app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  NOTETAKER_SURFACE = await loadSurface()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const engineUrl = `http://127.0.0.1:${server.address().port}`
  const eventUrl = engineUrl.replace(/^http/, 'ws')
  electronSession.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const isEngine = details.url.startsWith(engineUrl) || details.url.startsWith(eventUrl)
    callback({ requestHeaders: isEngine ? { ...details.requestHeaders, Authorization: `Bearer ${ENGINE_TOKEN}` } : details.requestHeaders })
  })
  run(makeWindow(engineUrl))
    .then(() => runEmptyScene(engineUrl))
    .then(() => app.exit(0))
    .catch((err) => fail(String(err?.stack ?? err)))
})
setTimeout(() => fail('timed out after 60s'), 60_000)
