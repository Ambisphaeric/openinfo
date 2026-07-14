import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type {
  CaptureChunk,
  ChatReply,
  Distillate,
  Fabric,
  Flag,
  OcrResult,
  QueryResult,
  ScreenStatus,
  WorkflowSpec,
} from '@openinfo/contracts'
import {
  createSecureTestEngineApp,
  secureTestFetch,
} from '../api/test-control-plane.js'
import { wireScreenOcr } from './index.js'

/**
 * #175's deterministic valid-frame transport boundary. The repository has no committed image fixture
 * (its fixture corpus is JSON/JSONL), so this is a complete 2x2 JFIF JPEG generated once and committed inline. Tests
 * assert its SOI/JFIF/EOI markers and that both fake model transports receive these exact bytes. Keeping
 * the tiny synthetic frame in-process avoids a person's screenshot, a rig dependency, and any network
 * egress while still exercising the production base64 image transport end to end.
 */
const JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMQD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABLAAEBAAAAAAAAAAAAAAAAAAAABwEBAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIAAgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AL+AD//Z'

const OCR_TEXT = 'OPENINFO 175 OCR — deterministic frame'
const VLM_TEXT = 'OPENINFO 175 VLM — a tiny white acceptance frame'
const VLM_PROMPT = 'Describe this acceptance frame without inventing content.'

interface FakeModelServer {
  server: Server
  url: string
  paths: string[]
  bodies: string[]
}

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}

const startFakePaddle = async (): Promise<FakeModelServer> => {
  const paths: string[] = []
  const bodies: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      paths.push(req.url ?? '')
      bodies.push(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        status: '0',
        results: [[{
          text: OCR_TEXT,
          confidence: 0.99,
          text_region: [[0, 0], [2, 0], [2, 2], [0, 2]],
        }]],
      }))
    })
  })
  return { server, url: await listen(server), paths, bodies }
}

const startFakeOpenAi = async (
  answer: string,
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
): Promise<FakeModelServer> => {
  const paths: string[] = []
  const bodies: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      paths.push(req.url ?? '')
      bodies.push(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: answer } }], usage }))
    })
  })
  return { server, url: await listen(server), paths, bodies }
}

const stop = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))

const poll = async <T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  description: string,
  tries = 120,
): Promise<T> => {
  let last = await read()
  for (let attempt = 0; attempt < tries && !ready(last); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    last = await read()
  }
  assert.ok(ready(last), `timed out waiting for ${description}`)
  return last
}

const putFlag = async (base: string, key: string, enabled: boolean): Promise<void> => {
  const flag: Flag = { key, default: enabled, scope: 'engine', description: `#175 acceptance: ${key}` }
  const response = await secureTestFetch(`${base}/flags/${key}`, {
    method: 'PUT',
    body: JSON.stringify(flag),
  })
  assert.equal(response.status, 200)
}

const framePair = (
  sessionId: string,
  idPrefix: string,
  capturedAt: string,
): readonly [CaptureChunk, CaptureChunk] => [
  {
    id: `${idPrefix}-image`,
    sessionId,
    workspaceId: 'default',
    source: 'screen',
    sequence: 1,
    capturedAt,
    contentType: 'image/jpeg',
    encoding: 'base64',
    data: JPEG_BASE64,
  },
  {
    id: `${idPrefix}-meta`,
    sessionId,
    workspaceId: 'default',
    source: 'screen',
    sequence: 2,
    capturedAt,
    contentType: 'application/json',
    encoding: 'utf8',
    data: JSON.stringify({ displayId: 'synthetic-2x2', width: 2, height: 2 }),
  },
]

const postCapture = async (base: string, chunks: readonly CaptureChunk[]): Promise<void> => {
  for (const chunk of chunks) {
    const response = await secureTestFetch(`${base}/capture/screen`, {
      method: 'POST',
      body: JSON.stringify(chunk),
    })
    assert.equal(response.status, 200)
  }
}

const readResults = async (base: string, sessionId: string): Promise<OcrResult[]> =>
  (await (await secureTestFetch(`${base}/screen/results?workspace=default&session=${sessionId}`)).json()) as OcrResult[]

const readDistillates = async (base: string, sessionId?: string): Promise<QueryResult> => {
  const response = await secureTestFetch(`${base}/query`, {
    method: 'POST',
    body: JSON.stringify({
      source: 'distillates',
      params: { workspace: 'default', ...(sessionId !== undefined ? { session: sessionId } : {}) },
      top: 50,
    }),
  })
  assert.equal(response.status, 200)
  return (await response.json()) as QueryResult
}

const assertMirror = (
  result: OcrResult,
  mirror: Distillate,
  expected: {
    sourceChunk: string
    capturedAt: string
    text: string
    slot: 'ocr' | 'vlm'
    endpoint: string
    model: string
  },
): void => {
  assert.notEqual(result.id, mirror.id, 'the OcrResult and surface mirror are distinct records')
  assert.deepEqual(result.sourceChunks, [expected.sourceChunk])
  assert.deepEqual(mirror.sourceChunks, [expected.sourceChunk])
  assert.equal(result.text, expected.text)
  assert.equal(mirror.text, expected.text)
  assert.equal(result.capturedAt, expected.capturedAt)
  assert.equal(mirror.windowStart, expected.capturedAt)
  assert.equal(mirror.windowEnd, expected.capturedAt)
  assert.equal(result.createdAt, mirror.createdAt, 'one recognition stamps both owned records together')
  assert.ok(Number.isFinite(Date.parse(result.createdAt)), 'createdAt is an ISO timestamp')
  assert.equal(result.provenance.slot, expected.slot)
  assert.equal(result.provenance.endpoint, expected.endpoint)
  assert.equal(result.provenance.model, expected.model)
  assert.deepEqual(mirror.provenance, result.provenance)
  assert.equal(result.provenance.egress?.reach, 'local')
  assert.equal(result.provenance.egress?.allowed, false)
  assert.equal(result.provenance.egress?.decidedBy, 'content-class')
  assert.ok(result.provenance.usage, 'screen invokes carry auditable usage')
}

test('#175 acceptance: authenticated valid-frame OCR/VLM transport surfaces once and feeds ambient Ask context', async () => {
  const jpeg = Buffer.from(JPEG_BASE64, 'base64')
  assert.deepEqual([...jpeg.subarray(0, 2)], [0xff, 0xd8], 'fixture starts with JPEG SOI')
  assert.equal(jpeg.subarray(6, 10).toString('ascii'), 'JFIF', 'fixture carries a JFIF header')
  assert.deepEqual([...jpeg.subarray(-2)], [0xff, 0xd9], 'fixture ends with JPEG EOI')

  const dir = await mkdtemp(join(tmpdir(), 'openinfo-175-acceptance-'))
  const servers: Server[] = []
  let app: ReturnType<typeof createSecureTestEngineApp> | undefined
  try {
    const paddle = await startFakePaddle()
    servers.push(paddle.server)
    const vlm = await startFakeOpenAi(VLM_TEXT, { prompt_tokens: 13, completion_tokens: 11, total_tokens: 24 })
    servers.push(vlm.server)
    const llm = await startFakeOpenAi('The ambient screen context came from the persisted distillates.', {
      prompt_tokens: 41,
      completion_tokens: 12,
      total_tokens: 53,
    })
    servers.push(llm.server)
    app = createSecureTestEngineApp({ dataRoot: dir, log: () => undefined })
    const ocrEvents: OcrResult[] = []
    const distillateEvents: Distillate[] = []
    app.bus.subscribe('ocr.completed', (result) => void ocrEvents.push(result))
    app.bus.subscribe('distillate.updated', (distillate) => void distillateEvents.push(distillate))
    wireScreenOcr(app)

    await new Promise<void>((resolve) => app!.server.listen(0, '127.0.0.1', resolve))
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    const flags = (await (await secureTestFetch(`${base}/flags`)).json()) as Flag[]
    assert.equal(flags.find((flag) => flag.key === 'workflow.enabled')?.default, false, 'legacy owner starts selected')

    const initialFabric: Fabric = {
      slots: {
        stt: [],
        tts: [],
        llm: [{ kind: 'http', name: 'fake-loopback-llm', url: llm.url, api: 'openai-compat', model: 'fake-chat-175' }],
        vlm: [],
        ocr: [{ kind: 'http', name: 'fake-paddle-175', url: paddle.url, api: 'paddle-serving', model: 'pp-ocrv4' }],
        embed: [],
      },
    }
    const fabricResponse = await secureTestFetch(`${base}/fabric`, {
      method: 'PUT',
      body: JSON.stringify(initialFabric),
    })
    assert.equal(fabricResponse.status, 200)
    await putFlag(base, 'screen.ocr', true)

    const legacySession = 'session-175-legacy'
    const legacyCapturedAt = '2026-07-13T14:00:00.000Z'
    const legacyFrame = framePair(legacySession, 'capture-175-legacy', legacyCapturedAt)

    // The same product route rejects an otherwise-valid frame without control-plane authentication.
    const unauthorized = await globalThis.fetch(`${base}/capture/screen`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(legacyFrame[0]),
    })
    assert.equal(unauthorized.status, 401)
    await postCapture(base, legacyFrame)

    await poll(
      () => readResults(base, legacySession),
      (rows) => rows.length >= 1,
      'legacy OCR result',
    )
    await new Promise((resolve) => setTimeout(resolve, 150))
    const legacyResults = await readResults(base, legacySession)
    assert.equal(legacyResults.length, 1, 'legacy ingest owns the frame exactly once')

    const legacyQuery = await readDistillates(base, legacySession)
    assert.equal(legacyQuery.source, 'distillates')
    const legacyMirrors = legacyQuery.items as Distillate[]
    assert.equal(legacyMirrors.length, 1, 'one OcrResult has one standard-surface mirror')
    assertMirror(legacyResults[0]!, legacyMirrors[0]!, {
      sourceChunk: legacyFrame[0].id,
      capturedAt: legacyCapturedAt,
      text: OCR_TEXT,
      slot: 'ocr',
      endpoint: 'fake-paddle-175',
      model: 'pp-ocrv4',
    })
    assert.equal(legacyResults[0]!.blocks?.length, 1)
    assert.equal(legacyResults[0]!.provenance.usage?.estimated, true, 'Paddle usage is explicitly estimated')

    const legacyStatus = await poll(
      async () => (await (await secureTestFetch(`${base}/screen/status`)).json()) as ScreenStatus,
      (status) => status.processed === 1 && status.skipped === 1,
      'legacy /screen/status counters',
    )
    assert.deepEqual(
      { processed: legacyStatus.processed, skipped: legacyStatus.skipped, blank: legacyStatus.blank, failed: legacyStatus.failed },
      { processed: 1, skipped: 1, blank: 0, failed: 0 },
    )
    assert.equal(legacyStatus.enabled, true, 'legacy status reflects screen.ocr ownership')
    assert.equal(paddle.paths.length, 1)
    assert.equal(paddle.paths[0], '/predict/ocr_system')
    assert.deepEqual((JSON.parse(paddle.bodies[0]!) as { images: string[] }).images, [JPEG_BASE64])
    assert.equal(ocrEvents.filter((row) => row.sourceChunks[0] === legacyFrame[0].id).length, 1)
    assert.equal(distillateEvents.filter((row) => row.sourceChunks[0] === legacyFrame[0].id).length, 1)

    // Edit the live fabric and active workflow before handing ownership to the workflow executor. The
    // explicit trustRawFrames bit mirrors the rig/LAN configuration #175 needs; this acceptance endpoint
    // remains loopback so the deterministic proof itself never widens the raw-frame trust boundary.
    const withVlm: Fabric = {
      ...initialFabric,
      slots: {
        ...initialFabric.slots,
        vlm: [{
          kind: 'http',
          name: 'fake-loopback-vlm-175',
          url: vlm.url,
          api: 'openai-compat',
          model: 'fake-vision-175',
          trustRawFrames: true,
        }],
      },
    }
    assert.equal((await secureTestFetch(`${base}/fabric`, { method: 'PUT', body: JSON.stringify(withVlm) })).status, 200)
    const liveFabric = (await (await secureTestFetch(`${base}/fabric`)).json()) as Fabric
    const liveVlm = liveFabric.slots.vlm[0]
    assert.ok(liveVlm?.kind === 'http')
    assert.equal(liveVlm.trustRawFrames, true)

    const active = (await (await secureTestFetch(`${base}/workflows/workflow-default`)).json()) as WorkflowSpec
    const vlmWorkflow: WorkflowSpec = {
      ...active,
      name: '#175 deterministic VLM acceptance',
      description: 'One gated VLM drain step; no distill step or second screen owner.',
      steps: [{
        id: 'screen-vlm-175',
        kind: 'vlm',
        slot: 'vlm',
        trigger: 'drain',
        when: { flag: 'screen.vlm' },
        params: { prompt: VLM_PROMPT },
      }],
    }
    const workflowResponse = await secureTestFetch(`${base}/workflows/workflow-default`, {
      method: 'PUT',
      body: JSON.stringify(vlmWorkflow),
    })
    assert.equal(workflowResponse.status, 200)
    const savedWorkflow = (await workflowResponse.json()) as WorkflowSpec
    assert.equal(savedWorkflow.version, active.version + 1)
    assert.deepEqual(savedWorkflow.steps.map(({ kind, slot }) => [kind, slot]), [['vlm', 'vlm']])
    await putFlag(base, 'screen.ocr', false)
    await putFlag(base, 'screen.vlm', true)
    await putFlag(base, 'workflow.enabled', true)

    const vlmSession = 'session-175-workflow-vlm'
    const vlmCapturedAt = '2026-07-13T14:01:00.000Z'
    const vlmFrame = framePair(vlmSession, 'capture-175-workflow-vlm', vlmCapturedAt)
    await postCapture(base, vlmFrame)

    await poll(
      () => readResults(base, vlmSession),
      (rows) => rows.length >= 1,
      'workflow VLM result',
    )
    await new Promise((resolve) => setTimeout(resolve, 150))
    const vlmResults = await readResults(base, vlmSession)
    assert.equal(vlmResults.length, 1, 'workflow drain owns the frame exactly once; ingest deferred')
    const vlmQuery = await readDistillates(base, vlmSession)
    const vlmMirrors = vlmQuery.items as Distillate[]
    assert.equal(vlmQuery.source, 'distillates')
    assert.equal(vlmMirrors.length, 1)
    assertMirror(vlmResults[0]!, vlmMirrors[0]!, {
      sourceChunk: vlmFrame[0].id,
      capturedAt: vlmCapturedAt,
      text: VLM_TEXT,
      slot: 'vlm',
      endpoint: 'fake-loopback-vlm-175',
      model: 'fake-vision-175',
    })
    assert.equal(vlmResults[0]!.blocks, undefined, 'VLM prose has no fabricated OCR regions')
    assert.deepEqual(vlmResults[0]!.provenance.usage, {
      promptTokens: 13,
      completionTokens: 11,
      totalTokens: 24,
      estimated: false,
      durationMs: vlmResults[0]!.provenance.usage?.durationMs,
    })

    const visionPayload = JSON.parse(vlm.bodies[0]!) as {
      model: string
      stream: boolean
      messages: { role: string; content: ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[] }[]
    }
    assert.equal(vlm.paths.length, 1)
    assert.equal(vlm.paths[0], '/v1/chat/completions')
    assert.equal(visionPayload.model, 'fake-vision-175')
    assert.equal(visionPayload.stream, false)
    assert.deepEqual(visionPayload.messages[0]?.content[0], { type: 'text', text: VLM_PROMPT })
    assert.deepEqual(visionPayload.messages[0]?.content[1], {
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${JPEG_BASE64}` },
    })
    assert.equal(paddle.paths.length, 1, 'workflow VLM did not leak back to the legacy OCR owner')
    assert.equal(ocrEvents.filter((row) => row.sourceChunks[0] === vlmFrame[0].id).length, 1)
    assert.equal(distillateEvents.filter((row) => row.sourceChunks[0] === vlmFrame[0].id).length, 1)

    const finalStatus = await poll(
      async () => (await (await secureTestFetch(`${base}/screen/status`)).json()) as ScreenStatus,
      (status) => status.processed === 2 && status.skipped === 2,
      'combined /screen/status counters',
    )
    assert.deepEqual(
      { processed: finalStatus.processed, skipped: finalStatus.skipped, blank: finalStatus.blank, failed: finalStatus.failed },
      { processed: 2, skipped: 2, blank: 0, failed: 0 },
    )
    assert.equal(
      finalStatus.enabled,
      true,
      'workflow status follows the enabled VLM step even though the legacy screen.ocr flag is off',
    )

    // Ask sends NO per-turn screenshot. Its declared `screen` source is therefore honestly empty, while
    // the already-persisted screen distillates enter through the ambient `insights` source as derived text.
    assert.equal(llm.bodies.length, 0, 'screen passes did not invoke the chat model')
    const askRequest = { message: 'What did the ambient screen context show?', workspace: 'default' }
    assert.equal('screenshot' in askRequest, false)
    const chatResponse = await secureTestFetch(`${base}/chat`, {
      method: 'POST',
      body: JSON.stringify(askRequest),
    })
    assert.equal(chatResponse.status, 200)
    const reply = (await chatResponse.json()) as ChatReply
    assert.equal(reply.endpoint, 'fake-loopback-llm')
    assert.match(reply.answer, /ambient screen context/i)
    assert.match(reply.budget.note, /insights\(2\)/)
    assert.match(reply.budget.note, /screen \(empty\)/)

    assert.equal(llm.paths.length, 1)
    assert.equal(llm.paths[0], '/v1/chat/completions')
    const chatRaw = llm.bodies[0]!
    const chatPayload = JSON.parse(chatRaw) as { messages: { role: string; content: string }[] }
    const system = chatPayload.messages.find((message) => message.role === 'system')?.content ?? ''
    assert.match(system, /Session insights:/)
    assert.ok(system.includes(OCR_TEXT), 'legacy ambient OCR distillate entered Ask context')
    assert.ok(system.includes(VLM_TEXT), 'workflow ambient VLM distillate entered Ask context')
    assert.equal(chatRaw.includes(JPEG_BASE64), false, 'Ask received derived text, never persisted raw pixels')
    assert.equal(chatRaw.includes('data:image/'), false)
    assert.equal(chatRaw.includes('image_url'), false)

    const allResults = await readResults(base, legacySession)
    const allDistillates = await readDistillates(base)
    assert.equal(allResults.length, 1, 'legacy session remains single-owned after the workflow handoff')
    assert.deepEqual(
      (allDistillates.items as Distillate[]).map((row) => row.sourceChunks[0]),
      [vlmFrame[0].id, legacyFrame[0].id],
      'the standard feed has exactly one mirror per source frame, newest first',
    )
    assert.equal(ocrEvents.length, 2)
    assert.equal(distillateEvents.length, 2)
  } finally {
    if (app !== undefined) await app.close()
    await Promise.all(servers.map(stop))
    await rm(dir, { recursive: true, force: true })
  }
})
