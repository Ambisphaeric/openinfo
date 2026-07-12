/**
 * Driven REAL-Electron e2e for the file-attach fix (basics wave B / S2).
 *
 * Green unit tests are not proof that the SERVED attach path behaves — the whole failure class lived in an
 * Electron edge: `File.path` was removed in Electron 32 (this repo ships 38), so a picked file no longer
 * carried its local path and the input block's attach went SILENTLY inert. A structural-DOM unit test can
 * inject `.path`, but it cannot prove that a REAL picked file, in a REAL renderer behind context isolation,
 * has its path resolved by the REAL preload bridge (webUtils.getPathForFile). So this launches REAL Electron
 * with the REAL compiled preload.cjs + the REAL compiled input-submit.js against the input-block fixture and
 * drives a genuine file selection over the Chrome DevTools Protocol (DOM.setFileInputFiles, the same
 * mechanism Puppeteer uses), then reads back what landed:
 *
 *   PHASE 1 — a real file on disk is picked:
 *     • the renderer's change handler runs, resolveUploadFile calls window.openinfoFiles.getPathForFile,
 *       and the upload dep receives the EXACT local filesystem path (not null / not '') → the fix works
 *     • the attachment is painted into `.in-context` → the affordance has a live handler, end to end
 *
 *   PHASE 2 — a real file is picked but ingest rejects (the honest-failure path):
 *     • the reason is painted into `.in-status` as visible text, nothing is attached → a failed attach is
 *       never a silent no-op (the basics-wave QA doctrine)
 *
 * It is a "probe main" (the capture-lifecycle-e2e precedent): a minimal BrowserWindow with the real preload,
 * no tray/engine — the test is about the attach edge and nothing else.
 *
 * Run: pnpm --filter @openinfo/client test:e2e:attach  (builds first). Needs a GUI (darwin) — deliberately
 * NOT wired into the headless default `test`, exactly like test:e2e:capture.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_DIR = path.join(__dirname, '..')
const FIXTURE_HTML = path.join(__dirname, 'e2e-attach.html')
const PRELOAD_JS = path.join(CLIENT_DIR, 'dist', 'main', 'preload.cjs')

const fail = (msg) => {
  console.error(`\n[e2e] FAIL: ${msg}`)
  app.exit(1)
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/** Poll until `predicate()` (may be async) is truthy or `ms` elapses. */
const waitFor = async (predicate, ms, label) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(50)
  }
  throw new Error(`timed out waiting for: ${label}`)
}

/** Write a real temp file so there is a genuine backing file on disk for webUtils to resolve a path from. */
const writeTemp = (name, body) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openinfo-attach-e2e-'))
  const p = path.join(dir, name)
  fs.writeFileSync(p, body)
  return p
}

/** Drive a genuine file pick on the `.in-file` input via CDP — this fires the real `change` event. */
const pickFile = async (win, filePath) => {
  const dbg = win.webContents.debugger
  await dbg.sendCommand('DOM.enable')
  const { root } = await dbg.sendCommand('DOM.getDocument', { depth: -1 })
  const { nodeId } = await dbg.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '.in-file' })
  if (!nodeId) throw new Error('could not find the .in-file input in the fixture')
  await dbg.sendCommand('DOM.setFileInputFiles', { files: [filePath], nodeId })
}

const readE2e = (win) => win.webContents.executeJavaScript('JSON.parse(JSON.stringify(window.__e2e))')
const readStatus = (win) => win.webContents.executeJavaScript("document.querySelector('.in-status').innerHTML")
const readContext = (win) => win.webContents.executeJavaScript("document.querySelector('.in-context').innerHTML")

const run = async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: PRELOAD_JS, contextIsolation: true, nodeIntegration: false },
  })
  win.webContents.on('console-message', (d) => {
    if (d.level === 'error') console.error(`[fixture] ${d.message}`)
  })
  win.webContents.debugger.attach('1.3')
  await win.loadFile(FIXTURE_HTML)
  await waitFor(async () => (await readE2e(win)).ready, 8000, 'the fixture to install the InputSession')

  // Sanity: the preload bridge must actually be exposed on the isolated page world.
  const hasBridge = await win.webContents.executeJavaScript("typeof window.openinfoFiles?.getPathForFile === 'function'")
  if (!hasBridge) return fail('window.openinfoFiles.getPathForFile is not exposed — preload bridge missing')
  console.log('[e2e] preload bridge present: window.openinfoFiles.getPathForFile')

  // --- PHASE 1: a real file is picked; the real OS path must reach the upload dep -----------------------
  const realFile = writeTemp('report.txt', 'openinfo attach e2e — real file on disk\n')
  await pickFile(win, realFile)
  await waitFor(async () => (await readE2e(win)).uploads.length === 1, 5000, 'the attach to reach the upload dep')
  const afterPick = await readE2e(win)
  const landed = afterPick.uploads[0]
  if (landed.path !== realFile) return fail(`resolved path mismatch — got ${JSON.stringify(landed.path)}, expected ${JSON.stringify(realFile)}`)
  console.log(`[e2e] PHASE 1 — webUtils resolved the real path end to end: ${landed.path}`)
  await waitFor(async () => /report\.txt/.test(await readContext(win)), 3000, 'the attachment to paint into .in-context')
  console.log('[e2e] PHASE 1 — attachment painted into .in-context (live handler, no silent no-op)')

  // --- PHASE 2: a real file is picked but ingest rejects; the reason must be VISIBLE --------------------
  await win.webContents.executeJavaScript('window.__e2e.failNext = true')
  const secondFile = writeTemp('broken.txt', 'this attach will be rejected by the stub\n')
  await pickFile(win, secondFile)
  await waitFor(async () => (await readE2e(win)).uploads.length === 2, 5000, 'the second attach to reach the upload dep')
  await waitFor(async () => /in-note error/.test(await readStatus(win)), 3000, 'the failed attach to paint an error into .in-status')
  const status = await readStatus(win)
  if (!/could not be ingested/.test(status)) return fail(`failed attach did not surface its reason as text — .in-status was: ${status}`)
  const ctx = await readContext(win)
  if (ctx.trim() !== '') return fail(`a failed attach still showed an attachment — .in-context was: ${ctx}`)
  console.log('[e2e] PHASE 2 — failed attach surfaced its reason as visible text; nothing attached')

  win.webContents.debugger.detach()
  win.destroy()
}

app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  try {
    await run()
    console.log('\n[e2e] PASS — a real picked file resolves its path via webUtils end to end, and a failed attach fails visibly')
    app.exit(0)
  } catch (err) {
    fail(String(err?.stack ?? err))
  }
})

setTimeout(() => fail('timed out after 45s'), 45_000)
