/**
 * GUI-only #175 proof. This launches a REAL BrowserWindow against a REAL built/authenticated engine and
 * the shipped hud.html → preload.cjs → dev-entry.js renderer chain. A loopback OCR fake recognizes one
 * valid synthetic JPEG; the test waits for the engine's one persisted screen mirror and then proves the
 * seeded surf-openinfo-fields window contains that sentinel exactly once as laid-out, visible DOM. Finally
 * BrowserWindow.capturePage proves Chromium painted a nonempty, nontransparent image of the sentinel row.
 *
 * This is deliberately outside the normal Node test suite: it requires a macOS GUI session.
 * Run: pnpm --filter @openinfo/client test:e2e:screen-surface
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, BrowserWindow, ipcMain, screen, session as electronSession } from 'electron'
import { EngineAuthDiscovery, fetchEngineControl } from '../dist/main/engine-auth.js'
import { RendererEngineAuth, pinTrustedSurface } from '../dist/main/renderer-engine-auth.js'
import { HUD_MIN_HEIGHT, surfaceWindowSpec, windowTitleFor } from '../dist/main/window-options.js'
import { resolveHudHeight } from '../dist/main/hud-height.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_DIR = path.join(__dirname, '..')
const REPO = path.join(CLIENT_DIR, '..', '..')
const HUD_HTML = path.join(CLIENT_DIR, 'hud.html')
const PRELOAD_JS = path.join(CLIENT_DIR, 'dist', 'main', 'preload.cjs')
const ENGINE_MAIN = path.join(REPO, 'apps', 'engine', 'dist', 'main.js')
const NODE_EXECUTABLE = process.env.OPENINFO_E2E_NODE ?? process.env.npm_node_execpath ?? 'node'

const SURFACE_ID = 'surf-openinfo-fields'
const WORKSPACE_ID = 'default'
const OCR_SENTINEL = 'OPENINFO 175 GUI SURFACE MIRROR — painted synthetic screen text'
const JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMQD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABLAAEBAAAAAAAAAAAAAAAAAAAABwEBAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIAAgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AL+AD//Z'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const withTimeout = async (promise, timeoutMs, description) => {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${description}`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

const eventually = async (probe, description, timeoutMs = 12_000) => {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      return await probe()
    } catch (error) {
      lastError = error
      await delay(50)
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`timed out waiting for ${description}: ${detail}`)
}

const closeServer = async (server) => {
  if (!server?.listening) return
  server.closeAllConnections?.()
  await withTimeout(
    new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    2_000,
    'loopback server close',
  )
}

const listen = async (server) => {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}

const startFakeOcr = async () => {
  const calls = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      calls.push({ method: req.method, path: req.url, body })
      if (req.method !== 'POST' || req.url !== '/predict/ocr_system') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unexpected OCR route' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        status: '0',
        results: [[{
          text: OCR_SENTINEL,
          confidence: 0.99,
          text_region: [[0, 0], [2, 0], [2, 2], [0, 2]],
        }]],
      }))
    })
  })
  return { server, calls, url: await listen(server) }
}

/** Reserve-and-release is inherently advisory, so startup retries the only realistic race: EADDRINUSE. */
const availablePort = async () => {
  const reservation = http.createServer()
  const url = await listen(reservation)
  await closeServer(reservation)
  return Number(new URL(url).port)
}

const stopEngineChild = async (child) => {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit').catch(() => undefined)
  child.kill('SIGTERM')
  await Promise.race([exited, delay(3_000)])
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await Promise.race([exited, delay(2_000)])
  }
}

const startEngine = async (dataDir, runDir) => {
  const {
    OPENINFO_CONTROL_TOKEN: _controlToken,
    OPENINFO_CONTROL_TOKEN_FILE: _controlTokenFile,
    OPENINFO_PUBLIC_ORIGIN: _publicOrigin,
    ...baseEnv
  } = process.env

  let lastError
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const port = await availablePort()
    const baseUrl = `http://127.0.0.1:${port}`
    let output = ''
    let launchError
    const appendOutput = (chunk) => {
      output = `${output}${String(chunk)}`.slice(-24_000)
    }
    const child = spawn(NODE_EXECUTABLE, [ENGINE_MAIN], {
      cwd: REPO,
      env: {
        ...baseEnv,
        OPENINFO_BIND_HOST: '127.0.0.1',
        OPENINFO_CONTROL_MODE: 'local',
        OPENINFO_CONTROL_RUN_DIR: runDir,
        OPENINFO_DATA: dataDir,
        OPENINFO_PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', appendOutput)
    child.stderr?.on('data', appendOutput)
    child.once('error', (error) => {
      launchError = error
      appendOutput(error.message)
    })

    try {
      await eventually(async () => {
        if (launchError) throw launchError
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`engine exited before health (${child.exitCode ?? child.signalCode})`)
        }
        const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(750) })
        assert.equal(response.status, 200)
      }, `built engine health on attempt ${attempt}`, 15_000)

      const credentials = new EngineAuthDiscovery({ runDir })
      await eventually(async () => {
        assert.ok(await credentials.credentialFor(baseUrl, { refresh: true }))
      }, 'authenticated engine discovery record', 5_000)
      return { baseUrl, child, credentials, output: () => output }
    } catch (error) {
      lastError = error
      await stopEngineChild(child)
      if (attempt < 4 && /EADDRINUSE|address already in use/i.test(output)) continue
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`built engine failed to start: ${detail}${output ? `\n${output}` : ''}`)
    }
  }
  throw lastError ?? new Error('built engine failed to start')
}

const engineJson = async (engine, method, requestPath, body) => {
  const response = await fetchEngineControl({
    baseUrl: engine.baseUrl,
    path: requestPath,
    credentials: engine.credentials,
    fetchImpl: globalThis.fetch,
    init: {
      method,
      signal: AbortSignal.timeout(5_000),
      ...(['POST', 'PUT', 'DELETE'].includes(method) ? { headers: { 'content-type': 'application/json' } } : {}),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  })
  const raw = await response.text()
  if (!response.ok) throw new Error(`${method} ${requestPath} failed (HTTP ${response.status}): ${raw.slice(0, 500)}`)
  return raw === '' ? undefined : JSON.parse(raw)
}

const configureEngine = async (engine, ocrUrl) => {
  await engineJson(engine, 'PUT', '/fabric', {
    slots: {
      stt: [],
      tts: [],
      llm: [],
      vlm: [],
      ocr: [{
        kind: 'http',
        name: 'fake-loopback-ocr-175-gui',
        url: ocrUrl,
        api: 'paddle-serving',
        model: 'pp-ocrv4',
      }],
      embed: [],
    },
  })
  await engineJson(engine, 'PUT', '/flags/workflow.enabled', {
    key: 'workflow.enabled',
    default: false,
    scope: 'engine',
    description: '#175 GUI proof keeps legacy ingest ownership explicit',
  })
  await engineJson(engine, 'PUT', '/flags/screen.ocr', {
    key: 'screen.ocr',
    default: true,
    scope: 'engine',
    description: '#175 GUI Surface paint proof',
  })
  return engineJson(engine, 'POST', '/sessions', {
    workspaceId: WORKSPACE_ID,
    modeId: 'mode-meeting',
    title: '#175 GUI Surface proof',
  })
}

const waitForInitialSurface = async (win) => eventually(async () => {
  const state = await win.webContents.executeJavaScript(`(() => ({
    surfaceId: new URLSearchParams(location.search).get('surface'),
    title: document.title,
    labels: Array.from(document.querySelectorAll('.glbl'), (node) => node.textContent || ''),
    text: document.body.textContent || '',
    boot: document.querySelector('.hud-boot-status')?.textContent || ''
  }))()`)
  assert.equal(state.surfaceId, SURFACE_ID)
  assert.equal(state.title, 'Fields')
  assert.ok(state.labels.includes('Transcript · distillate stream'))
  assert.match(state.text, /No distilled windows yet/)
  assert.equal(state.boot, '')
  return state
}, 'the seeded Fields Surface initial DOM')

const waitForPaintableSentinel = async (win) => eventually(async () => {
  const literal = JSON.stringify(OCR_SENTINEL)
  const proof = await win.webContents.executeJavaScript(`(() => {
    const sentinel = ${literal};
    const exact = Array.from(document.querySelectorAll('.ttl')).filter(
      (node) => (node.textContent || '').trim() === sentinel
    );
    let textOccurrences = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      textOccurrences += (node.nodeValue || '').split(sentinel).length - 1;
    }
    const target = exact[0];
    if (!target) return { exactRows: exact.length, textOccurrences };
    const rect = target.getBoundingClientRect();
    const style = getComputedStyle(target);
    const x = Math.max(0, Math.floor(rect.left));
    const y = Math.max(0, Math.floor(rect.top));
    const right = Math.min(window.innerWidth, Math.ceil(rect.right));
    const bottom = Math.min(window.innerHeight, Math.ceil(rect.bottom));
    return {
      surfaceId: new URLSearchParams(location.search).get('surface'),
      title: document.title,
      exactRows: exact.length,
      textOccurrences,
      display: style.display,
      visibility: style.visibility,
      opacity: Number(style.opacity),
      clientRects: target.getClientRects().length,
      connected: target.isConnected,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      fullyInViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
      captureRect: { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) },
      emptyRowStillPresent: (document.body.textContent || '').includes('No distilled windows yet'),
      boot: document.querySelector('.hud-boot-status')?.textContent || ''
    };
  })()`)
  assert.equal(proof.surfaceId, SURFACE_ID)
  assert.equal(proof.title, 'Fields')
  assert.equal(proof.exactRows, 1, 'one .ttl row owns the OCR sentinel')
  assert.equal(proof.textOccurrences, 1, 'the rendered DOM text contains the OCR sentinel exactly once')
  assert.equal(proof.display === 'none', false)
  assert.equal(['hidden', 'collapse'].includes(proof.visibility), false)
  assert.ok(proof.opacity > 0)
  assert.ok(proof.clientRects > 0)
  assert.equal(proof.connected, true)
  assert.ok(proof.rect.width > 0 && proof.rect.height > 0)
  assert.equal(proof.fullyInViewport, true)
  assert.equal(proof.emptyRowStillPresent, false)
  assert.equal(proof.boot, '')
  return proof
}, 'one visibly laid-out OCR sentinel in the seeded Surface DOM', 15_000)

const paintedPixelCount = (bitmap) => {
  let count = 0
  // NativeImage.toBitmap() is BGRA. Count pixels carrying both opacity and actual color information.
  for (let offset = 0; offset + 3 < bitmap.length; offset += 4) {
    if (bitmap[offset + 3] > 0 && (bitmap[offset] > 0 || bitmap[offset + 1] > 0 || bitmap[offset + 2] > 0)) count += 1
  }
  return count
}

const run = async () => {
  const jpeg = Buffer.from(JPEG_BASE64, 'base64')
  assert.deepEqual([...jpeg.subarray(0, 2)], [0xff, 0xd8])
  assert.equal(jpeg.subarray(6, 10).toString('ascii'), 'JFIF')
  assert.deepEqual([...jpeg.subarray(-2)], [0xff, 0xd9])

  const tempDirs = []
  let fakeOcr
  let engine
  let win
  let resizeHandler
  try {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'openinfo-175-gui-engine-'))
    const runDir = await mkdtemp(path.join(tmpdir(), 'openinfo-175-gui-run-'))
    tempDirs.push(dataDir, runDir)

    fakeOcr = await startFakeOcr()
    engine = await startEngine(dataDir, runDir)
    const liveSession = await configureEngine(engine, fakeOcr.url)
    assert.equal(liveSession.workspaceId, WORKSPACE_ID)

    const rendererAuth = new RendererEngineAuth(engine.baseUrl, engine.credentials)
    rendererAuth.install(electronSession.defaultSession.webRequest)

    const spec = surfaceWindowSpec(SURFACE_ID, { startVisible: false })
    win = new BrowserWindow({
      ...spec.browserWindow,
      title: windowTitleFor(SURFACE_ID),
      webPreferences: { ...spec.browserWindow.webPreferences, preload: PRELOAD_JS },
    })
    pinTrustedSurface(rendererAuth, win.webContents, pathToFileURL(HUD_HTML).toString())

    const rendererErrors = []
    win.webContents.on('did-fail-load', (_event, code, description) => rendererErrors.push(`load ${code}: ${description}`))
    win.webContents.on('render-process-gone', (_event, details) => rendererErrors.push(`renderer ${details.reason}`))
    win.webContents.on('console-message', (details) => {
      if (details.level === 'error') rendererErrors.push(`console: ${details.message}`)
    })

    resizeHandler = (event, measured) => {
      const source = BrowserWindow.fromWebContents(event.sender)
      if (source !== win || win.isDestroyed()) return
      const maximum = screen.getDisplayMatching(win.getBounds()).workArea.height
      const [width, currentHeight] = win.getContentSize()
      const height = resolveHudHeight(measured, { min: HUD_MIN_HEIGHT, max: maximum })
      if (height !== currentHeight) win.setContentSize(width, height)
    }
    ipcMain.on('hud:resize', resizeHandler)

    const readyToShow = once(win, 'ready-to-show')
    await withTimeout(
      win.loadFile(HUD_HTML, {
        search: new URLSearchParams({
          engine: engine.baseUrl,
          surface: SURFACE_ID,
          workspace: WORKSPACE_ID,
        }).toString(),
      }),
      10_000,
      'shipped hud.html load',
    )
    await withTimeout(readyToShow, 5_000, 'BrowserWindow ready-to-show paint')
    win.showInactive()
    await waitForInitialSurface(win)

    const captureId = 'capture-175-gui-surface-image'
    const capturedAt = new Date().toISOString()
    const ack = await engineJson(engine, 'POST', '/capture/screen', {
      id: captureId,
      sessionId: liveSession.id,
      workspaceId: WORKSPACE_ID,
      source: 'screen',
      sequence: 1,
      capturedAt,
      contentType: 'image/jpeg',
      encoding: 'base64',
      data: JPEG_BASE64,
    })
    assert.equal(ack.ok, true)
    assert.equal(ack.chunkId, captureId)

    await eventually(async () => {
      const result = await engineJson(engine, 'POST', '/query', {
        source: 'distillates',
        params: { workspace: WORKSPACE_ID, session: liveSession.id },
        top: 10,
      })
      const mirrors = result.items.filter((row) => row.sourceChunks?.length === 1 && row.sourceChunks[0] === captureId)
      assert.equal(mirrors.length, 1)
      assert.equal(mirrors[0].text, OCR_SENTINEL)
      assert.equal(['ocr', 'vlm'].includes(mirrors[0].provenance?.slot), true)
    }, 'one persisted OCR mirror', 15_000)

    const proof = await waitForPaintableSentinel(win)
    assert.equal(win.isVisible(), true)
    await win.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const image = await win.capturePage(proof.captureRect)
    const png = image.toPNG()
    const bitmap = image.toBitmap()
    const imageSize = image.getSize()
    assert.equal(image.isEmpty(), false)
    assert.ok(imageSize.width > 0 && imageSize.height > 0)
    assert.ok(png.byteLength > 0)
    assert.ok(bitmap.byteLength > 0)
    assert.ok(paintedPixelCount(bitmap) > 0, 'capturePage contains painted, nontransparent pixels')

    assert.equal(fakeOcr.calls.length, 1, 'the valid JPEG is recognized exactly once')
    assert.equal(fakeOcr.calls[0].method, 'POST')
    assert.equal(fakeOcr.calls[0].path, '/predict/ocr_system')
    assert.deepEqual(JSON.parse(fakeOcr.calls[0].body).images, [JPEG_BASE64])
    assert.deepEqual(rendererErrors, [])

    console.log(
      `[e2e] PASS — ${SURFACE_ID} painted one OCR sentinel ` +
      `(${proof.rect.width.toFixed(1)}×${proof.rect.height.toFixed(1)} CSS px; capture ${imageSize.width}×${imageSize.height})`,
    )
  } finally {
    if (resizeHandler) ipcMain.off('hud:resize', resizeHandler)
    if (win && !win.isDestroyed()) win.destroy()
    await electronSession.defaultSession.closeAllConnections().catch(() => undefined)
    await stopEngineChild(engine?.child)
    await closeServer(fakeOcr?.server)
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  }
}

app.whenReady().then(async () => {
  let exitCode = 1
  try {
    if (process.platform !== 'darwin') throw new Error('screen-surface e2e requires a macOS GUI host')
    await run()
    exitCode = 0
  } catch (error) {
    console.error(`[e2e] FAIL — ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  } finally {
    app.exit(exitCode)
  }
})
