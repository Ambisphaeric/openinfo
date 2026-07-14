/**
 * Owner-run real-frame OCR/VLM validation for issue #175.
 *
 * This is deliberately opt-in and isolated:
 * - Electron owns only the generated full-screen card + real desktop capture;
 * - a separately spawned, ABI-compatible Node process owns a temporary authenticated engine/store;
 * - the production FrameDeltaGate, CaptureController, EngineLink, capture route, queues, screen
 *   processor, persistence, query surface, and Ask path are exercised;
 * - raw pixels reach only the explicitly trusted LAN endpoint. The engine queue and offline-spool
 *   safety path can persist them transiently under a private mkdtemp tree, which is removed before PASS;
 * - the owner-only report contains derived synthetic text/provenance/timing/counters, never pixels.
 *
 * Build/run through the root `vision:live` script. See tools/vision-live/README.md.
 */

import { spawn, execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, desktopCapturer, screen } from 'electron'
import { classifyDestination, mayReceiveRawFrames } from '../../engine/dist/fabric/egress.js'
import { CaptureController } from '../dist/capture/capture-controller.js'
import { FrameDeltaGate, DELTA_PROBE_WIDTH, DELTA_THRESHOLD_DEFAULT } from '../dist/capture/frame-delta.js'
import { runScreenCaptureAttempt } from '../dist/capture/screen-observation.js'
import { EngineLink } from '../dist/engine-link/client.js'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..', '..')
const ENGINE_ENTRY = path.join(REPO, 'apps', 'engine', 'dist', 'main.js')
const BETTER_SQLITE = path.join(REPO, 'apps', 'engine', 'node_modules', 'better-sqlite3')
const argv = process.argv.slice(2)
const RUN_TIMEOUT_MS = 20 * 60 * 1000
const CONTROL_REQUEST_TIMEOUT_MS = 15_000
const ENGINE_START_TIMEOUT_MS = 30_000
const CADENCE_JITTER_MS = 250
const RAW_MARKERS = ['data:image/', '/9j/', 'iVBORw0KGgo', 'RAW_FRAME']
const VISION_KEY_REF = 'qa-vision-live-key'
const SAMPLE_CODES = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF', 'HOTEL', 'INDIA', 'JULIET']

const runAbort = new AbortController()
let emergencyCleanup = async () => undefined
const hardTimer = setTimeout(() => {
  runAbort.abort(new Error('hard timeout after 20 minutes'))
  // Abort normally unwinds fetch/capture work into main's finally. If an OS/Electron operation ignores
  // abort, invoke the same bounded cleanup directly and force the harness process down after its grace.
  void Promise.race([emergencyCleanup(), sleepUnabortable(20_000)]).finally(() => app.exit(1))
}, RUN_TIMEOUT_MS)
hardTimer.unref()

const value = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const next = argv[index + 1]
  if (next === undefined || next.startsWith('--')) throw new Error(`--${name} requires a value`)
  return next
}
const has = (name) => argv.includes(`--${name}`)
const required = (name, fallback) => {
  const found = value(name, fallback)
  if (typeof found !== 'string' || found.trim() === '') {
    throw new Error(`missing --${name} (or its documented environment fallback)`)
  }
  return found.trim()
}

const VISION_URL = required('vision-url', process.env.OPENINFO_VISION_URL)
const OCR_MODEL = required('ocr-model', process.env.OPENINFO_OCR_MODEL)
const VLM_MODEL = required('vlm-model', process.env.OPENINFO_VLM_MODEL)
const GEMMA_URL = required('gemma-url', process.env.OPENINFO_GEMMA_URL ?? VISION_URL)
const GEMMA_MODEL = required('gemma-model', process.env.OPENINFO_GEMMA_MODEL)
const ENGINE_NODE_HINT = value('engine-node', process.env.OPENINFO_ENGINE_NODE)
const VISION_KEY_ENV = value('vision-key-env', undefined)
const GEMMA_KEY_ENV = value('gemma-key-env', undefined)
const VISION_KEY = VISION_KEY_ENV ? process.env[VISION_KEY_ENV] : process.env.OPENINFO_VISION_KEY
const GEMMA_KEY = GEMMA_KEY_ENV
  ? process.env[GEMMA_KEY_ENV]
  : process.env.OPENINFO_GEMMA_KEY ?? VISION_KEY
const SAMPLE_COUNT = Number(value('samples', process.env.OPENINFO_VISION_SAMPLES ?? '2'))
const CADENCE_MS = Number(value('cadence-ms', process.env.OPENINFO_SCREEN_INTERVAL_MS ?? '5000'))
const TIMEOUT_MS = Number(value('timeout-ms', process.env.OPENINFO_VISION_TIMEOUT_MS ?? '120000'))
const OUTPUT = path.resolve(
  value(
    'output',
    path.join(REPO, 'tools', 'fixtures', 'private', `vision-live-${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
  ),
)

if (!has('trust-lan-raw-frames')) {
  throw new Error('refusing live capture without explicit --trust-lan-raw-frames')
}
if (VISION_KEY_ENV && !VISION_KEY) throw new Error(`--vision-key-env names an unset/empty environment variable: ${VISION_KEY_ENV}`)
if (GEMMA_KEY_ENV && !GEMMA_KEY) throw new Error(`--gemma-key-env names an unset/empty environment variable: ${GEMMA_KEY_ENV}`)
if (!Number.isInteger(SAMPLE_COUNT) || SAMPLE_COUNT < 1 || SAMPLE_COUNT > 10) {
  throw new Error('--samples must be an integer from 1 to 10')
}
if (!Number.isFinite(CADENCE_MS) || CADENCE_MS < 3000 || CADENCE_MS > 6000) {
  throw new Error('--cadence-ms must stay inside the product still-frame band (3000..6000)')
}
if (!Number.isFinite(TIMEOUT_MS) || TIMEOUT_MS < 1000 || TIMEOUT_MS > 300000) {
  throw new Error('--timeout-ms must be between 1000 and 300000')
}

const originOnly = (raw, label) => {
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`${label} must be an absolute http(s) URL`)
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${label} must contain only scheme, host, and optional port`)
  }
  return parsed.origin
}
const visionUrl = originOnly(VISION_URL, 'vision URL')
const gemmaUrl = originOnly(GEMMA_URL, 'Gemma URL')

const rawEndpoint = (name, url, model, withAuth = false) => ({
  kind: 'http',
  name,
  url,
  api: 'openai-compat',
  model,
  trustRawFrames: true,
  ...(withAuth && VISION_KEY ? { auth: { keyRef: VISION_KEY_REF } } : {}),
})
const visionDestination = classifyDestination(rawEndpoint('qa-ocr', visionUrl, OCR_MODEL))
if (!mayReceiveRawFrames(rawEndpoint('qa-ocr', visionUrl, OCR_MODEL)) || visionDestination !== 'lan-local') {
  throw new Error('refusing vision URL: the #175/#196 live proof requires a real private-LAN destination (never loopback, public, malformed, or wildcard)')
}
// The workload contains only synthetic text, but #175 measures the owner's LOCAL rig. A public Gemma
// endpoint would make the memory/latency result meaningless even though it would not leak screen content.
if (!mayReceiveRawFrames(rawEndpoint('qa-gemma-locality-check', gemmaUrl, GEMMA_MODEL))) {
  throw new Error('refusing Gemma URL: the #175 pressure workload must run on a loopback/LAN-local rig endpoint')
}
const policyTruth = {
  trustedLanAllowed: mayReceiveRawFrames(rawEndpoint('qa-ocr', visionUrl, OCR_MODEL)),
  trustedLanDestination: visionDestination,
  flaggedPublicAllowed: mayReceiveRawFrames(rawEndpoint('public-negative', 'https://example.test', OCR_MODEL)),
  flaggedWildcardAllowed: mayReceiveRawFrames(rawEndpoint('wildcard-negative', 'http://0.0.0.0:1234', OCR_MODEL)),
}
if (!policyTruth.trustedLanAllowed || policyTruth.flaggedPublicAllowed || policyTruth.flaggedWildcardAllowed) {
  throw new Error('raw-frame trust policy failed its LAN/public/wildcard truth table')
}

const abortReason = () =>
  runAbort.signal.reason instanceof Error ? runAbort.signal.reason : new Error('live validation aborted')
const ensureRunning = () => {
  if (runAbort.signal.aborted) throw abortReason()
}
const sleepUnabortable = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const delay = (ms) =>
  new Promise((resolve, reject) => {
    ensureRunning()
    const timer = setTimeout(done, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortReason())
    }
    function done() {
      runAbort.signal.removeEventListener('abort', onAbort)
      resolve()
    }
    runAbort.signal.addEventListener('abort', onAbort, { once: true })
  })

const fetchTimed = async (url, init = {}, timeoutMs = CONTROL_REQUEST_TIMEOUT_MS) => {
  ensureRunning()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs)
  const onAbort = () => controller.abort(abortReason())
  runAbort.signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
    runAbort.signal.removeEventListener('abort', onAbort)
  }
}

const percentile = (values, p) => {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))]
}
const summarize = (values) => ({
  count: values.length,
  ...(values.length > 0
    ? {
        min: Math.min(...values),
        median: percentile(values, 0.5),
        p95: percentile(values, 0.95),
        max: Math.max(...values),
      }
    : {}),
})
const modelHeaders = (key) => ({
  ...(key ? { authorization: `Bearer ${key}` } : {}),
  'content-type': 'application/json',
})
const safeModelState = (model) =>
  model
    ? {
        ...(Number.isFinite(model.size_bytes) && model.size_bytes >= 0 ? { sizeBytes: model.size_bytes } : {}),
        vision: model.capabilities?.vision === true,
        // Model inventory is server-controlled. Retain only numeric pressure inputs used by this report;
        // instance ids and arbitrary config can contain local paths, URLs, account names, or credentials.
        loadedInstances: Array.isArray(model.loaded_instances)
          ? model.loaded_instances.map((instance) => ({
              ...(Number.isFinite(instance.config?.context_length) && instance.config.context_length >= 0
                ? { contextLength: instance.config.context_length }
                : {}),
              ...(Number.isFinite(instance.config?.parallel) && instance.config.parallel >= 0
                ? { parallel: instance.config.parallel }
                : {}),
            }))
          : [],
      }
    : undefined

const listModels = async (baseUrl, key) => {
  const response = await fetchTimed(
    `${baseUrl}/api/v1/models`,
    { headers: key ? { authorization: `Bearer ${key}` } : {} },
    Math.min(TIMEOUT_MS, 120_000),
  )
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`model inventory failed with HTTP ${response.status}`)
  }
  const body = await response.json()
  return Array.isArray(body.models) ? body.models : []
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('could not allocate a loopback port'))
      const port = address.port
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })

const waitFor = async (read, accept, label, timeoutMs = TIMEOUT_MS) => {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    ensureRunning()
    last = await read()
    if (accept(last)) return last
    await delay(100)
  }
  throw new Error(`timed out waiting for ${label}`)
}

const startAskServer = async () => {
  const requests = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try {
        requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        requests.push({ invalid: true })
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'The synthetic vision card is present in ambient context.' } }] }))
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('could not start the loopback Ask endpoint')
  let closing
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => {
      closing ??= new Promise((resolve) => {
        server.closeIdleConnections?.()
        server.close(() => resolve())
      })
      return closing
    },
  }
}

const probeEngineNode = async (candidate) => {
  const source = [
    `const DB=require(${JSON.stringify(BETTER_SQLITE)})`,
    `const db=new DB(':memory:')`,
    `db.close()`,
    `process.stdout.write(JSON.stringify({version:process.version,abi:process.versions.modules}))`,
  ].join(';')
  try {
    const { stdout } = await execFileAsync(candidate, ['-e', source], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    })
    const runtime = JSON.parse(stdout.trim())
    return { command: candidate, version: runtime.version, abi: runtime.abi }
  } catch {
    return undefined
  }
}

const resolveEngineNode = async () => {
  const candidates = ENGINE_NODE_HINT
    ? [ENGINE_NODE_HINT]
    : [
        path.join(homedir(), '.local', 'share', 'mise', 'installs', 'node', 'latest', 'bin', 'node'),
        path.join(homedir(), '.local', 'share', 'mise', 'installs', 'node', '25.4.0', 'bin', 'node'),
        'node',
        '/opt/homebrew/bin/node',
        '/usr/local/bin/node',
      ]
  for (const candidate of [...new Set(candidates)]) {
    const compatible = await probeEngineNode(candidate)
    if (compatible) return compatible
  }
  throw new Error(
    'no Node runtime can load the installed better-sqlite3 binary; pass --engine-node PATH (or OPENINFO_ENGINE_NODE) for the ABI-compatible engine runtime',
  )
}

const collectLines = (stream, prefix, logs) => {
  let buffered = ''
  stream?.setEncoding('utf8')
  stream?.on('data', (chunk) => {
    buffered += chunk
    const lines = buffered.split(/\r?\n/)
    buffered = lines.pop() ?? ''
    for (const line of lines) {
      if (logs.length < 10_000) logs.push(`${prefix}${line}`)
    }
  })
  stream?.on('end', () => {
    if (buffered && logs.length < 10_000) logs.push(`${prefix}${buffered}`)
  })
}

const readJsonIfPresent = async (file) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

const startEngineChild = async ({ temp, port, nodeRuntime, logs }) => {
  const dataDir = path.join(temp, 'data')
  const runDir = path.join(temp, 'run')
  const secretsPath = path.join(dataDir, 'secrets', 'secrets.json')
  await mkdir(runDir, { recursive: true, mode: 0o700 })
  if (VISION_KEY) {
    await mkdir(path.dirname(secretsPath), { recursive: true, mode: 0o700 })
    await writeFile(secretsPath, `${JSON.stringify({ [VISION_KEY_REF]: VISION_KEY }, null, 2)}\n`, { mode: 0o600 })
    await chmod(secretsPath, 0o600)
  }

  // Deliberately minimal: no inherited OPENINFO_CONTROL_*, OPENINFO_DATA, or OPENINFO_SECRETS can point
  // this disposable engine at owner state. No NODE_OPTIONS is inherited either.
  const childEnv = {
    HOME: temp,
    TMPDIR: temp,
    PATH: process.env.PATH ?? '',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    OPENINFO_PORT: String(port),
    OPENINFO_BIND_HOST: '127.0.0.1',
    OPENINFO_CONTROL_MODE: 'local',
    OPENINFO_CONTROL_RUN_DIR: runDir,
    OPENINFO_DATA: dataDir,
    OPENINFO_SECRETS: secretsPath,
  }
  const child = spawn(nodeRuntime.command, [ENGINE_ENTRY], {
    cwd: REPO,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  collectLines(child.stdout, '[engine:stdout] ', logs)
  collectLines(child.stderr, '[engine:stderr] ', logs)
  let spawnError
  child.once('error', (error) => {
    spawnError = error
  })

  const terminateChild = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit').catch(() => undefined)
    child.kill('SIGTERM')
    await Promise.race([exited, sleepUnabortable(5000)])
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await Promise.race([exited, sleepUnabortable(2000)])
    }
  }

  const discoveryPath = path.join(runDir, `engine-${port}.json`)
  let discovery
  try {
    discovery = await waitFor(
      async () => {
        if (spawnError) throw new Error('temporary engine process could not start')
        if (child.exitCode !== null) throw new Error(`temporary engine exited before discovery (code ${child.exitCode})`)
        return readJsonIfPresent(discoveryPath)
      },
      (record) =>
        record?.pid === child.pid &&
        record?.baseUrl === `http://127.0.0.1:${port}` &&
        typeof record?.token === 'string' &&
        record.token.length > 0,
      'temporary engine discovery record',
      ENGINE_START_TIMEOUT_MS,
    )
  } catch (error) {
    await terminateChild()
    throw error
  }

  let closing
  const close = () => {
    closing ??= terminateChild()
    return closing
  }
  return {
    baseUrl: discovery.baseUrl,
    token: discovery.token,
    pid: child.pid,
    dataDir,
    textQueueDir: path.join(dataDir, 'queue-text'),
    node: { version: nodeRuntime.version, abi: nodeRuntime.abi },
    close,
  }
}

const cardHtml = ({ mode, sample, token }) => {
  const invert = sample % 2 === 0
  const bg = invert ? '#f6f0df' : '#101820'
  const fg = invert ? '#101820' : '#f6f0df'
  const accent = mode === 'OCR' ? '#ff5b35' : '#36c5f0'
  const shape = mode === 'OCR' ? 'OCR' : 'VLM'
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${bg};color:${fg};font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif}
    main{height:100%;display:grid;grid-template-columns:1.3fr .7fr;align-items:center;padding:8vw;gap:6vw}
    .eyebrow{font-size:2.2vw;letter-spacing:.22em;text-transform:uppercase;font-weight:700;color:${accent}}
    h1{font-size:8vw;line-height:.88;margin:2.4vw 0 3vw;letter-spacing:-.065em}p{font-size:3.2vw;line-height:1.2;margin:.8vw 0;font-weight:600}
    .token{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:3.2vw;border:4px solid ${accent};padding:1.2vw 1.6vw;display:inline-block;margin-top:2vw}
    .shape{width:26vw;height:26vw;border-radius:${mode === 'OCR' ? '50%' : '12%'};background:${accent};display:grid;place-items:center;color:#101820;font-weight:900;font-size:5vw;transform:rotate(${mode === 'OCR' ? '0' : '12deg'});box-shadow:1.5vw 1.5vw 0 ${fg}}
  </style></head><body><main><section><div class="eyebrow">Private real-frame validation</div><h1>OPENINFO<br>ISSUE 175</h1><p>${mode} lane · sample ${sample}</p><p>Capture → delta → queue → model → surface → Ask</p><div class="token">${token}</div></section><div class="shape">${shape}</div></main></body></html>`
}

const showCard = async (win, state, approvedDisplayId) => {
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(cardHtml(state))}`)
  if (!win.isVisible()) win.show()
  if (!win.isFullScreen()) {
    const entered = once(win, 'enter-full-screen')
    win.setFullScreen(true)
    await Promise.race([
      entered,
      delay(10_000).then(() => {
        throw new Error('test card did not enter full-screen within 10 seconds')
      }),
    ])
  }
  win.focus()
  await delay(750)
  if (!win.isFullScreen()) throw new Error('refusing capture because the synthetic card is not full-screen')
  const covering = screen.getDisplayMatching(win.getBounds())
  if (String(covering.id) !== approvedDisplayId) {
    throw new Error('refusing capture because the card is no longer on the approved primary display')
  }
}

const grabPrimary = async (approvedDisplayId) => {
  const primary = screen.getPrimaryDisplay()
  const primaryId = String(primary.id)
  if (primaryId !== approvedDisplayId) {
    throw new Error('primary display changed during the validation; refusing to capture an unapproved display')
  }
  const scale = primary.scaleFactor || 1
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(primary.size.width * scale),
      height: Math.round(primary.size.height * scale),
    },
  })
  const source = sources.find((candidate) => candidate.display_id === primaryId)
  if (!source) throw new Error('desktopCapturer did not return the exact approved primary display; refusing fallback capture')
  const image = source.thumbnail
  if (!image || image.isEmpty()) {
    throw new Error('desktopCapturer returned no frame; grant Screen Recording to Electron/openinfo, relaunch, and retry')
  }
  return { image, displayId: primaryId, scale }
}

const startGemmaWorkload = async () => {
  const startedAtMs = Date.now()
  try {
    const response = await fetchTimed(
      `${gemmaUrl}/v1/chat/completions`,
      {
        method: 'POST',
        headers: modelHeaders(GEMMA_KEY),
        body: JSON.stringify({
          model: GEMMA_MODEL,
          messages: [{
            role: 'user',
            content: 'Write a compact synthetic checklist numbered 1 through 20 for validating a local software pipeline. Do not mention real people, files, hosts, or accounts.',
          }],
          max_tokens: 384,
          temperature: 0,
        }),
      },
      Math.min(TIMEOUT_MS, 300_000),
    )
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return {
        ok: false,
        status: response.status,
        startedAt: new Date(startedAtMs).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        error: 'http-status',
      }
    }
    let body
    try {
      body = await response.json()
    } catch {
      body = undefined
    }
    const completion = body?.choices?.[0]?.message?.content
    const completedAtMs = Date.now()
    const valid = typeof completion === 'string' && completion.trim() !== ''
    return {
      ok: valid,
      status: response.status,
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs: completedAtMs - startedAtMs,
      completionChars: valid ? completion.length : 0,
      ...(valid ? {} : { error: 'missing-nonempty-completion' }),
    }
  } catch (error) {
    const completedAtMs = Date.now()
    return {
      ok: false,
      status: 0,
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs: completedAtMs - startedAtMs,
      error: error instanceof Error ? error.name : 'unknown',
    }
  }
}

const queueDirectoryStatus = async (dir) => {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return { pendingFiles: 0, pendingBytes: 0 }
  }
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
  const sizes = await Promise.all(
    files.map((entry) => stat(path.join(dir, entry.name)).then((info) => info.size).catch(() => 0)),
  )
  return { pendingFiles: files.length, pendingBytes: sizes.reduce((sum, size) => sum + size, 0) }
}

const processRssBytes = async (pid) => {
  if (!pid) return undefined
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-o', 'rss=', '-p', String(pid)], {
      timeout: 2000,
      maxBuffer: 4096,
    })
    const kib = Number(stdout.trim())
    return Number.isFinite(kib) && kib >= 0 ? kib * 1024 : undefined
  } catch {
    return undefined
  }
}

const containsRawMarker = (value) => {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  return RAW_MARKERS.some((marker) => serialized.includes(marker))
}
const assertNoRawMarker = (label, value) => {
  if (containsRawMarker(value)) throw new Error(`${label} contained a raw-frame marker`)
}
const assertSafeProvenance = (label, provenance) => {
  const serialized = JSON.stringify(provenance)
  assertNoRawMarker(label, serialized)
  if (/https?:\/\//i.test(serialized) || /authorization|bearer/i.test(serialized)) {
    throw new Error(`${label} contained a URL or credential-bearing field`)
  }
  if (VISION_KEY && serialized.includes(VISION_KEY)) throw new Error(`${label} contained the vision credential`)
}
const assertSafeReport = (serialized, secrets) => {
  assertNoRawMarker('private report', serialized)
  if (/https?:\/\//i.test(serialized)) throw new Error('private report contained an endpoint URL')
  if (/\bBearer\s+/i.test(serialized)) throw new Error('private report contained a bearer credential')
  if (/"(?:authorization|api[_-]?key|access[_-]?token|control[_-]?token)"\s*:/i.test(serialized)) {
    throw new Error('private report contained a credential-bearing field')
  }
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret !== '' && serialized.includes(secret)) {
      throw new Error('private report contained a known credential value')
    }
  }
  const ownerHome = homedir()
  if (ownerHome !== '' && serialized.includes(ownerHome)) throw new Error('private report contained the owner home path')
}
const normalizeToken = (text) => String(text).toUpperCase().replace(/[^A-Z0-9]/g, '')
const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const clippedInsight = (text) => {
  const trimmed = String(text).trim()
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed
}

const main = async () => {
  const runId = `oi175-${randomUUID().slice(0, 8)}`
  const temp = await mkdtemp(path.join(tmpdir(), 'openinfo-vision-live-'))
  let ask
  let running
  let win
  let controller
  let memoryTimer
  let memorySampling
  let cleanupPromise
  const logs = []
  const memory = []
  const queueSamples = []
  const observed = []
  const attemptStarts = []
  const report = {
    format: 'openinfo.vision-live-validation',
    version: 3,
    issue: 175,
    runId,
    createdAt: new Date().toISOString(),
    privacy: {
      screen: 'generated PII-free full-screen card on the approved primary display',
      rawFrameReportOrFixture: false,
      transientPrivateTempStorage: true,
      transientStorageReason: 'durable engine queue and offline-spool safety path',
      tempTreeRemovedBeforePass: false,
      endpointUrlRecorded: false,
      reportContainsDerivedSyntheticText: true,
    },
    config: {
      cadenceMs: CADENCE_MS,
      samplesPerMode: SAMPLE_COUNT,
      deltaThreshold: DELTA_THRESHOLD_DEFAULT,
      ocr: { endpoint: 'qa-ocr', model: OCR_MODEL },
      vlm: { endpoint: 'qa-vlm', model: VLM_MODEL },
      gemmaWorkload: { endpoint: 'qa-gemma', model: GEMMA_MODEL },
    },
    policy: policyTruth,
    modes: {},
  }

  const cleanup = async () => {
    cleanupPromise ??= (async () => {
      if (memoryTimer) clearInterval(memoryTimer)
      memoryTimer = undefined
      await Promise.race([memorySampling?.catch(() => undefined) ?? Promise.resolve(), sleepUnabortable(2_000)])
      try {
        controller?.shutdown()
        if (controller) {
          await Promise.race([controller.onCaptureStopped().catch(() => undefined), sleepUnabortable(5_000)])
        }
      } finally {
        try {
          if (win && !win.isDestroyed()) win.destroy()
        } finally {
          await Promise.race([running?.close().catch(() => undefined) ?? Promise.resolve(), sleepUnabortable(8_000)])
          await Promise.race([ask?.close().catch(() => undefined) ?? Promise.resolve(), sleepUnabortable(3_000)])
          await rm(temp, { recursive: true, force: true })
        }
      }
    })()
    return cleanupPromise
  }
  emergencyCleanup = cleanup

  try {
    const [nodeRuntime, modelsBefore] = await Promise.all([
      resolveEngineNode(),
      listModels(visionUrl, VISION_KEY),
    ])
    const gemmaModelsBefore = gemmaUrl === visionUrl
      ? modelsBefore
      : await listModels(gemmaUrl, GEMMA_KEY)
    const advertisedBefore = {
      ocr: modelsBefore.find((model) => model.key === OCR_MODEL),
      vlm: modelsBefore.find((model) => model.key === VLM_MODEL),
      gemma: gemmaModelsBefore.find((model) => model.key === GEMMA_MODEL),
    }
    const inventoryBefore = {
      ocr: safeModelState(advertisedBefore.ocr),
      vlm: safeModelState(advertisedBefore.vlm),
      gemma: safeModelState(advertisedBefore.gemma),
    }
    if (!inventoryBefore.ocr) throw new Error('the configured OCR model is not advertised by the vision server')
    if (!inventoryBefore.vlm) throw new Error('the configured VLM model is not advertised by the vision server')
    if (inventoryBefore.vlm.vision !== true) throw new Error('the configured VLM model is not advertised as vision-capable')
    if (!inventoryBefore.gemma) throw new Error('the configured Gemma workload model is not advertised by the workload server')
    const gemmaIdentity = `${advertisedBefore.gemma?.key ?? ''} ${advertisedBefore.gemma?.display_name ?? ''}`.toLowerCase()
    if (!gemmaIdentity.includes('gemma') || !gemmaIdentity.includes('12b')) {
      throw new Error('the concurrent workload model must be advertised as a Gemma 12B-class model')
    }
    report.modelStateBefore = inventoryBefore

    ask = await startAskServer()
    const port = await freePort()
    running = await startEngineChild({ temp, port, nodeRuntime, logs })
    report.engineRuntime = running.node
    const { baseUrl, token } = running
    const api = async (route, options = {}) => {
      const response = await fetchTimed(`${baseUrl}${route}`, {
        method: options.method ?? 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          ...((options.method ?? 'GET') === 'GET' ? {} : { 'content-type': 'application/json' }),
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(`engine ${options.method ?? 'GET'} ${route} failed with HTTP ${response.status}`)
      return body
    }

    await api('/fabric', {
      method: 'PUT',
      body: {
        slots: {
          stt: [],
          tts: [],
          llm: [{ kind: 'http', name: 'qa-ask-loopback', url: ask.url, api: 'openai-compat', model: 'qa-ask' }],
          vlm: [rawEndpoint('qa-vlm', visionUrl, VLM_MODEL, true)],
          ocr: [rawEndpoint('qa-ocr', visionUrl, OCR_MODEL, true)],
          embed: [],
        },
      },
    })
    const setFlag = (key, on) =>
      api(`/flags/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: { key, default: on, scope: 'engine', description: `#175 live validation: ${key}` },
      })
    await setFlag('screen.ocr', true)
    await setFlag('workflow.enabled', false)

    const session = await api('/sessions', {
      method: 'POST',
      body: { workspaceId: 'default', modeId: 'mode-meeting', title: 'Synthetic vision validation' },
    })

    const credentialSource = { credentialFor: async () => ({ token }) }
    const link = new EngineLink({
      baseUrl,
      spoolDir: path.join(temp, 'capture-spool'),
      credentials: credentialSource,
    })
    controller = new CaptureController({
      source: 'screen',
      enabled: true,
      capture: (chunk) => link.capture(chunk),
      control: { start: () => undefined, stop: () => undefined },
      requestPermission: async () => true,
      log: (line) => logs.push(String(line)),
    })
    const context = { sessionId: session.id, workspaceId: 'default' }
    await controller.onSessionStarted(context)

    const display = screen.getPrimaryDisplay()
    const approvedDisplayId = String(display.id)
    win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      show: false,
      backgroundColor: '#101820',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setMenuBarVisibility(false)

    const gate = new FrameDeltaGate()
    const attempt = async () => {
      let verdict
      const observation = await runScreenCaptureAttempt({
        context,
        capture: async ({ occurredAt }) => {
          const grabbed = await grabPrimary(approvedDisplayId)
          verdict = gate.assess(
            grabbed.displayId,
            new Uint8Array(grabbed.image.resize({ width: DELTA_PROBE_WIDTH }).toBitmap()),
          )
          if (!verdict.send) return { outcome: 'delta-skipped' }
          const size = grabbed.image.getSize()
          const jpeg = grabbed.image.toJPEG(70)
          const accepted = await controller.onSegment(
            {
              source: 'screen',
              bytes: new Uint8Array(jpeg).buffer,
              mimeType: 'image/jpeg',
              capturedAt: occurredAt,
              screenMeta: {
                displayId: grabbed.displayId,
                width: size.width,
                height: size.height,
                scale: grabbed.scale,
                deltaScore: verdict.deltaScore,
              },
            },
            context,
          )
          if (accepted) return { outcome: 'accepted', capture: accepted }
          gate.reset()
          return undefined
        },
        observe: async (row) => link.observeScreen(row),
        log: (line) => logs.push(String(line)),
      })
      observed.push(observation)
      return { observation, verdict }
    }

    let lastAttemptStartedAt = 0
    const pacedAttempt = async (mode, beforeAttempt) => {
      const wait = Math.max(0, CADENCE_MS - (Date.now() - lastAttemptStartedAt))
      if (lastAttemptStartedAt > 0) await delay(wait)
      beforeAttempt?.()
      lastAttemptStartedAt = Date.now()
      attemptStarts.push({ mode, startedAtMs: lastAttemptStartedAt })
      return { ...(await attempt()), startedAtMs: lastAttemptStartedAt }
    }

    const monitorQueues = (mode) => {
      let stopped = false
      let failure
      const done = (async () => {
        while (!stopped) {
          try {
            const [surface, workflow] = await Promise.all([
              api('/queue'),
              queueDirectoryStatus(running.textQueueDir),
            ])
            queueSamples.push({
              mode,
              at: new Date().toISOString(),
              surface: {
                pendingFiles: surface.pendingFiles,
                pendingBytes: surface.pendingBytes,
                screenChunks: surface.byKind?.screen?.pendingChunks ?? 0,
                lastFailureClass: surface.lastFailure?.class,
              },
              workflow: {
                pendingFiles: workflow.pendingFiles,
                pendingBytes: workflow.pendingBytes,
              },
            })
            await delay(100)
          } catch (error) {
            if (!stopped && !runAbort.signal.aborted) failure = error
            break
          }
        }
      })()
      return async () => {
        stopped = true
        await done.catch(() => undefined)
        if (failure) throw failure
      }
    }

    const sampleMemory = async () => {
      if (memorySampling) return memorySampling
      memorySampling = (async () => {
        const metrics = app.getAppMetrics()
        const electronWorkingSetBytes = metrics.reduce(
          (sum, metric) => sum + Math.max(0, metric.memory?.workingSetSize ?? 0) * 1024,
          0,
        )
        const engineRssBytes = await processRssBytes(running?.pid)
        memory.push({
          at: new Date().toISOString(),
          electronMainRssBytes: process.memoryUsage().rss,
          electronWorkingSetBytes,
          ...(engineRssBytes !== undefined ? { engineRssBytes } : {}),
        })
      })().finally(() => {
        memorySampling = undefined
      })
      return memorySampling
    }
    await sampleMemory()
    memoryTimer = setInterval(() => void sampleMemory(), 250)

    const waitForCaptureResults = async (captureIds, initialCount) => {
      const firstSeenAt = new Map()
      const deadline = Date.now() + TIMEOUT_MS * captureIds.length
      let results = []
      while (Date.now() < deadline) {
        ensureRunning()
        results = await api(`/screen/results?session=${encodeURIComponent(session.id)}`)
        const now = Date.now()
        for (const id of captureIds) {
          if (!firstSeenAt.has(id) && results.some((item) => item.sourceChunks?.includes(id))) {
            firstSeenAt.set(id, now)
          }
        }
        if (firstSeenAt.size === captureIds.length && results.length >= initialCount + captureIds.length) {
          return { results, firstSeenAt }
        }
        await delay(100)
      }
      throw new Error(`timed out waiting for ${captureIds.length} screen result(s)`)
    }

    const runMode = async (mode) => {
      const expected = mode === 'OCR'
        ? { owner: 'legacy-ingest', slot: 'ocr', endpoint: 'qa-ocr', model: OCR_MODEL }
        : { owner: 'workflow-drain', slot: 'vlm', endpoint: 'qa-vlm', model: VLM_MODEL }
      const before = await api(`/screen/results?session=${encodeURIComponent(session.id)}`)
      const statusBefore = await api('/screen/status')
      if (statusBefore.enabled !== true) throw new Error(`${mode} began while /screen/status said screen understanding was disabled`)
      const pending = []
      const attemptStartIndex = attemptStarts.length
      let workloadPromise
      const stopQueues = monitorQueues(mode)
      try {
        for (let index = 1; index <= SAMPLE_COUNT; index += 1) {
          const cardToken = `OPENINFO ${mode} ${SAMPLE_CODES[index - 1]}`
          await showCard(
            win,
            { mode, sample: index + (mode === 'VLM' ? 20 : 0), token: cardToken },
            approvedDisplayId,
          )
          const sent = await pacedAttempt(
            mode,
            index === 1
              ? () => {
                  workloadPromise = startGemmaWorkload()
                }
              : undefined,
          )
          if (sent.observation.outcome !== 'queued') {
            throw new Error(`${mode} changed card was not queued (outcome ${sent.observation.outcome})`)
          }
          pending.push({
            sample: index,
            token: cardToken,
            captureId: sent.observation.capture.id,
            capturedAt: sent.observation.capture.capturedAt,
            deltaScore: sent.verdict?.deltaScore,
          })

          if (index === 1) {
            const staticAttempt = await pacedAttempt(mode)
            if (staticAttempt.observation.outcome !== 'delta-skipped') {
              throw new Error(`${mode} unchanged card was not stopped by the delta gate`)
            }
          }
        }

        const captureIds = pending.map((row) => row.captureId)
        const modeAttemptStarts = attemptStarts
          .slice(attemptStartIndex)
          .filter((row) => row.mode === mode)
          .map((row) => row.startedAtMs)
        const attemptIntervalsMs = modeAttemptStarts.slice(1).map((startedAtMs, index) =>
          startedAtMs - modeAttemptStarts[index],
        )
        if (
          modeAttemptStarts.length !== SAMPLE_COUNT + 1 ||
          attemptIntervalsMs.some((interval) => interval < 3000 || interval > 6000 + CADENCE_JITTER_MS)
        ) {
          throw new Error(`${mode} capture attempts did not remain in the 3–6 second cadence band (250ms scheduler tolerance)`)
        }
        const waited = await waitForCaptureResults(captureIds, before.length)
        await delay(750)
        const finalResults = await api(`/screen/results?session=${encodeURIComponent(session.id)}`)
        if (finalResults.length !== before.length + SAMPLE_COUNT) {
          throw new Error(`${mode} produced ${finalResults.length - before.length} result(s), expected exactly ${SAMPLE_COUNT}`)
        }

        const rows = []
        for (const pendingRow of pending) {
          const matches = finalResults.filter((item) => item.sourceChunks?.includes(pendingRow.captureId))
          if (matches.length !== 1) {
            throw new Error(`${mode} ownership produced ${matches.length} OcrResults for capture ${pendingRow.sample}`)
          }
          const result = matches[0]
          const text = String(result.text ?? '')
          if (text.trim() === '') throw new Error(`${mode} returned a blank result for the high-contrast test card`)
          assertNoRawMarker(`${mode} model result`, text)
          if (!normalizeToken(text).includes(normalizeToken(pendingRow.token))) {
            throw new Error(`${mode} result did not recognize/describe the exact synthetic validation token for sample ${pendingRow.sample}`)
          }
          if (
            result.provenance?.slot !== expected.slot ||
            result.provenance?.endpoint !== expected.endpoint ||
            result.provenance?.model !== expected.model
          ) {
            throw new Error(`${mode} result used the wrong slot, endpoint, or model`)
          }
          if (!Number.isFinite(result.provenance?.usage?.durationMs)) {
            throw new Error(`${mode} result omitted finite invoke-duration provenance`)
          }
          const destination = result.provenance?.egress
          if (
            destination?.reach !== 'local' ||
            destination?.destination !== 'lan-local' ||
            destination?.rawFrameTrust !== 'explicit' ||
            destination?.allowed !== false ||
            destination?.decidedBy !== 'content-class' ||
            !String(destination?.reason ?? '').includes('crossed the device boundary to an explicitly trusted LAN destination')
          ) {
            throw new Error(`${mode} result did not prove explicit trusted-LAN raw-frame boundary crossing with hosted/public denial`)
          }
          assertSafeProvenance(`${mode} OcrResult provenance`, result.provenance)
          if (!sameJson(result.sourceChunks, [pendingRow.captureId])) {
            throw new Error(`${mode} result carried unexpected source-chunk ownership`)
          }
          rows.push({
            sample: pendingRow.sample,
            captureId: pendingRow.captureId,
            capturedAt: result.capturedAt,
            createdAt: result.createdAt,
            endToEndMs: Math.max(0, Date.parse(result.createdAt) - Date.parse(result.capturedAt)),
            wallMs: Math.max(0, (waited.firstSeenAt.get(pendingRow.captureId) ?? Date.now()) - Date.parse(result.capturedAt)),
            deltaScore: pendingRow.deltaScore,
            text,
            provenance: result.provenance,
          })
        }

        const expectedStatus = {
          processed: statusBefore.processed + SAMPLE_COUNT,
          skipped: statusBefore.skipped + SAMPLE_COUNT,
          blank: statusBefore.blank,
          failed: statusBefore.failed,
        }
        const status = await waitFor(
          () => api('/screen/status'),
          (current) => current.processed >= expectedStatus.processed && current.skipped >= expectedStatus.skipped,
          `${mode} /screen/status counters`,
        )
        if (
          status.enabled !== true ||
          status.processed !== expectedStatus.processed ||
          status.skipped !== expectedStatus.skipped ||
          status.blank !== expectedStatus.blank ||
          status.failed !== expectedStatus.failed
        ) {
          throw new Error(`${mode} /screen/status did not advance by exactly processed=${SAMPLE_COUNT}, skipped=${SAMPLE_COUNT}`)
        }

        const surface = await api('/query', {
          method: 'POST',
          body: { source: 'distillates', params: { session: session.id }, top: 50 },
        })
        const modeCaptureIds = new Set(rows.map((row) => row.captureId))
        const mirrorRows = surface.items.filter((item) => item.sourceChunks?.some((id) => modeCaptureIds.has(id)))
        if (mirrorRows.length !== rows.length) {
          throw new Error(`${mode} surface query did not return one mirror Distillate per result`)
        }
        for (const row of rows) {
          const mirrors = mirrorRows.filter((item) => item.sourceChunks?.includes(row.captureId))
          if (mirrors.length !== 1) throw new Error(`${mode} ownership produced ${mirrors.length} mirror Distillates for one frame`)
          const mirror = mirrors[0]
          if (
            mirror.text !== row.text.trim() ||
            mirror.windowStart !== row.capturedAt ||
            mirror.windowEnd !== row.capturedAt ||
            mirror.createdAt !== row.createdAt ||
            !sameJson(mirror.sourceChunks, [row.captureId]) ||
            !sameJson(mirror.provenance, row.provenance)
          ) {
            throw new Error(`${mode} mirror Distillate did not exactly match its OcrResult`)
          }
          assertSafeProvenance(`${mode} mirror Distillate provenance`, mirror.provenance)
        }

        const live = await waitFor(
          () => api(`/senses/live?workspace=default&session=${encodeURIComponent(session.id)}`),
          (snapshot) => {
            const lane = snapshot.lanes?.find((item) => item.source === 'screen')
            return lane?.latestProcessing?.captureId === rows.at(-1)?.captureId
          },
          `${mode} live screen lane processing evidence`,
        )
        const screenLane = live.lanes.find((lane) => lane.source === 'screen')
        if (!screenLane || screenLane.latestProcessing?.outcome !== 'processed') {
          throw new Error(`${mode} live screen lane did not retain processed evidence for the latest changed frame`)
        }

        const workload = await workloadPromise
        if (!workload?.ok || workload.status !== 200 || !Number.isFinite(workload.completionChars) || workload.completionChars < 1) {
          throw new Error(`${mode} Gemma-12B pressure workload did not return a successful nonempty completion`)
        }
        const firstCaptureMs = Date.parse(rows[0].capturedAt)
        if (
          !Number.isFinite(firstCaptureMs) ||
          Date.parse(workload.startedAt) > firstCaptureMs ||
          Date.parse(workload.completedAt) < firstCaptureMs
        ) {
          throw new Error(`${mode} Gemma-12B workload did not overlap the first real-frame capture`)
        }

        return {
          owner: expected.owner,
          samples: rows,
          invokeDurationMs: summarize(rows.map((row) => row.provenance.usage.durationMs)),
          endToEndMs: summarize(rows.map((row) => row.endToEndMs)),
          wallMs: summarize(rows.map((row) => row.wallMs)),
          captureAttemptIntervalMs: {
            target: CADENCE_MS,
            schedulerToleranceMs: CADENCE_JITTER_MS,
            ...summarize(attemptIntervalsMs),
          },
          status: {
            enabled: status.enabled,
            processed: status.processed,
            blank: status.blank,
            skipped: status.skipped,
            failed: status.failed,
            failureClasses: status.lastFailures.map((failure) => failure.class),
          },
          surface: { mirrorDistillates: mirrorRows.length },
          liveLane: {
            disposition: screenLane.disposition,
            health: screenLane.health,
            reason: screenLane.reason,
            latestProcessingCaptureId: screenLane.latestProcessing.captureId,
          },
          workload,
        }
      } finally {
        await stopQueues()
      }
    }

    report.modes.ocr = await runMode('OCR')

    const workflow = await api('/workflows/workflow-default')
    const vlmStep = {
      id: 'screen-vlm-live-validation',
      kind: 'vlm',
      slot: 'vlm',
      trigger: 'drain',
      when: { flag: 'screen.ocr' },
      params: {
        prompt: 'Describe this synthetic validation card. Include the visible OPENINFO issue number, lane label, major colored shape, and the full validation token exactly as shown.',
      },
    }
    await api('/workflows/workflow-default', {
      method: 'PUT',
      body: {
        ...workflow,
        steps: [vlmStep, ...workflow.steps.filter((step) => step.kind !== 'ocr' && step.kind !== 'vlm')],
      },
    })
    await setFlag('workflow.enabled', true)
    report.modes.vlm = await runMode('VLM')

    // Ask must see AMBIENT persisted text through `insights`. No screenshot is attached, so per-send OCR
    // cannot mask a broken capture→persist→Ask chain.
    const askBefore = ask.requests.length
    const reply = await api('/chat', {
      method: 'POST',
      body: {
        message: 'What did the ambient screen pipeline just observe?',
        workspace: 'default',
        turnId: `turn-${runId}`,
      },
    })
    const askRequest = ask.requests.at(-1)
    if (ask.requests.length !== askBefore + 1 || !askRequest) {
      throw new Error('Ask did not invoke the loopback model endpoint exactly once')
    }
    const messages = Array.isArray(askRequest.messages) ? askRequest.messages : []
    const systemText = messages
      .filter((message) => message?.role === 'system' && typeof message.content === 'string')
      .map((message) => message.content)
      .join('\n')
    const latestText = report.modes.vlm.samples.at(-1).text
    const expectedInsight = clippedInsight(latestText)
    if (!systemText.includes(expectedInsight)) {
      throw new Error('Ask system prompt did not include the correctly clipped latest ambient Distillate')
    }
    assertNoRawMarker('Ask model request', askRequest)
    report.ask = {
      answer: reply.answer,
      ambientDistillateIncluded: true,
      screenshotAttached: false,
      modelEndpoint: 'qa-ask-loopback',
    }

    const modelsAfter = await listModels(visionUrl, VISION_KEY)
    const gemmaModelsAfter = gemmaUrl === visionUrl
      ? modelsAfter
      : await listModels(gemmaUrl, GEMMA_KEY)
    report.modelStateAfter = {
      ocr: safeModelState(modelsAfter.find((model) => model.key === OCR_MODEL)),
      vlm: safeModelState(modelsAfter.find((model) => model.key === VLM_MODEL)),
      gemma: safeModelState(gemmaModelsAfter.find((model) => model.key === GEMMA_MODEL)),
      metricBasis: 'server-advertised model weight size plus loaded-instance configuration; neither is remote host RSS',
    }

    if (memoryTimer) clearInterval(memoryTimer)
    memoryTimer = undefined
    await memorySampling?.catch(() => undefined)
    await sampleMemory()
    report.memory = {
      localProcess: {
        electronMainRssBytes: summarize(memory.map((row) => row.electronMainRssBytes)),
        electronWorkingSetBytes: summarize(memory.map((row) => row.electronWorkingSetBytes)),
        engineRssBytes: summarize(memory.map((row) => row.engineRssBytes).filter(Number.isFinite)),
        samples: memory.length,
      },
      remoteModelPressure: {
        basis: 'advertised model weight size + loaded-instance count/configuration, not residency or remote host RSS',
        ocrModelSizeBytes: report.modelStateAfter.ocr?.sizeBytes,
        vlmModelSizeBytes: report.modelStateAfter.vlm?.sizeBytes,
        gemmaModelSizeBytes: report.modelStateAfter.gemma?.sizeBytes,
        loadedInstanceCount: {
          ocr: report.modelStateAfter.ocr?.loadedInstances.length ?? 0,
          vlm: report.modelStateAfter.vlm?.loadedInstances.length ?? 0,
          gemma: report.modelStateAfter.gemma?.loadedInstances.length ?? 0,
        },
      },
    }
    report.queue = {
      samples: queueSamples.length,
      sampling: 'GET /queue for the primary queue + metadata-only stat of the isolated queue-text directory',
      peakSurfacePendingFiles: Math.max(0, ...queueSamples.map((sample) => sample.surface.pendingFiles)),
      peakSurfacePendingBytes: Math.max(0, ...queueSamples.map((sample) => sample.surface.pendingBytes)),
      peakSurfaceScreenChunks: Math.max(0, ...queueSamples.map((sample) => sample.surface.screenChunks)),
      peakWorkflowPendingFiles: Math.max(0, ...queueSamples.map((sample) => sample.workflow.pendingFiles)),
      peakWorkflowPendingBytes: Math.max(0, ...queueSamples.map((sample) => sample.workflow.pendingBytes)),
      failureClasses: [...new Set(queueSamples.map((sample) => sample.surface.lastFailureClass).filter(Boolean))],
    }
    if (report.queue.failureClasses.length > 0) {
      throw new Error(`queue monitoring observed failure classes during a purported pass: ${report.queue.failureClasses.join(', ')}`)
    }
    report.observations = {
      queued: observed.filter((row) => row.outcome === 'queued').length,
      deltaSkipped: observed.filter((row) => row.outcome === 'delta-skipped').length,
      grabFailed: observed.filter((row) => row.outcome === 'grab-failed').length,
    }
    if (
      report.observations.queued !== SAMPLE_COUNT * 2 ||
      report.observations.deltaSkipped !== 2 ||
      report.observations.grabFailed !== 0
    ) {
      throw new Error('capture observations did not match the exact dual-mode changed/static attempt plan')
    }

    await api(`/sessions/${encodeURIComponent(session.id)}/end`, { method: 'POST', body: {} })
    await cleanup()
    ensureRunning()
    assertNoRawMarker('captured engine/client logs', logs.join('\n'))
    report.privacyChecks = {
      rawMarkersInHarnessCollectedLogs: false,
      rawMarkersInModelResults: false,
      rawMarkersInAskRequest: false,
      urlsOrCredentialsInPersistedProvenance: false,
      genericWebSocketBoundary: 'covered by deterministic api/http-security.test.ts and api/ws.test.ts',
    }
    report.privacy.tempTreeRemovedBeforePass = true
    report.completedAt = new Date().toISOString()
    report.passed = true

    const serializedReport = `${JSON.stringify(report, null, 2)}\n`
    assertSafeReport(serializedReport, [VISION_KEY, GEMMA_KEY, token])
    await mkdir(path.dirname(OUTPUT), { recursive: true })
    await writeFile(OUTPUT, serializedReport, { mode: 0o600 })
    await chmod(OUTPUT, 0o600)
    console.log(`[vision-live] PASS — private derived-only evidence written to ${path.relative(REPO, OUTPUT)}`)
  } finally {
    await cleanup()
  }
}

app.on('window-all-closed', () => {})
app.whenReady().then(() =>
  main()
    .then(() => {
      clearTimeout(hardTimer)
      app.exit(0)
    })
    .catch((error) => {
      clearTimeout(hardTimer)
      console.error(`[vision-live] FAIL — ${error instanceof Error ? error.message : String(error)}`)
      app.exit(1)
    }),
)
