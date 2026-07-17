import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk, ChatReply, ContextPacket, Fabric, Mode, Session } from '@openinfo/contracts'
import { createSecureTestEngineApp as createEngineApp, secureTestFetch as fetch } from './test-control-plane.js'
import { wireScreenOcr } from '../screen/index.js'

/**
 * The #180 slice-1 DRIVEN e2e: Ask grounded in the CURRENT session's ContextPackets, proven end to end
 * through PRODUCTION code with NO faked seam past the capture route (the QA doctrine — the shipped v0.0.20
 * rig finding that "screen isn't reaching chat" had no un-faked test to catch it).
 *
 * The pipeline under test, all real:
 *   fake loopback paddle OCR (the deterministic stand-in for a live PaddleOCR runtime) → real POST
 *   /capture/screen → the real ScreenOcrProcessor (wireScreenOcr, NO injected invoke) → a persisted
 *   OcrResult → the real deterministic packet builder (materialized at chat gather time) → the real POST
 *   /chat context assembler consuming the declared `packets` source.
 *
 * ARM 1 (consumed + device-local): a loopback llm answers; the assembled system prompt carries the packet's
 * CORRELATED WINDOW — the screen-derived recognized text under a `screen:` lane label, both audio lanes
 * named and kept separate (their honest gap reasons), and the note discloses the packet contribution. The
 * screen text reaching a LOOPBACK model never left the machine.
 *
 * ARM 2 (egress mediation — the summaries-egress-seam sentinel, for chat): the ONLY llm endpoint is
 * egress-classified and the session's mode DENIES egress. The screen-derived turn must never reach it: the
 * egress endpoint receives ZERO bytes, and the turn degrades to an HONEST visible failure naming the skip —
 * never a silent no-op, never a screen byte off the machine.
 */

const RECOGNIZED_TEXT = 'Sprint planning board — Q3 roadmap review'
const FRAME_CAPTURED_AT = '2026-07-16T09:00:00.000Z'

/** A fake paddle-serving OCR endpoint (the screen-trace-e2e stand-in): one recognized region per frame. */
const startFakePaddle = async (): Promise<{ server: Server; url: string }> => {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          status: '0',
          results: [[{ text: RECOGNIZED_TEXT, confidence: 0.96, text_region: [[10, 10], [420, 10], [420, 40], [10, 40]] }]],
        }),
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}` }
}

/** A counting fake completions server — records every hit + the last prompt it received. */
interface FakeChat { server: Server; port: number; hits: () => number; lastPrompt: () => string }
const startChat = async (answer: string): Promise<FakeChat> => {
  let hits = 0
  let lastPrompt = ''
  const server = createServer((req, res) => {
    const bufs: Buffer[] = []
    req.on('data', (c: Buffer) => bufs.push(c))
    req.on('end', () => {
      hits++
      try {
        const body = JSON.parse(Buffer.concat(bufs).toString('utf8')) as { messages: { content: string }[] }
        lastPrompt = body.messages.map((m) => m.content).join('\n')
      } catch { /* a malformed body is still a hit */ }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer } }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, port: address.port, hits: () => hits, lastPrompt: () => lastPrompt }
}
const stop = (chat: { server: Server }): Promise<void> => new Promise((resolve) => chat.server.close(() => resolve()))

/** Steer ONLY `*.egress.test` hosts to loopback so an egress-classified endpoint is reachable at a fake server. */
const installEgressRewrite = (): (() => void) => {
  const real = globalThis.fetch
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    if (typeof raw === 'string') {
      const url = new URL(raw)
      if (url.hostname.endsWith('.egress.test')) {
        url.hostname = '127.0.0.1'
        return real(url.href, init)
      }
    }
    return real(input, init)
  }) as typeof fetch
  return () => { globalThis.fetch = real }
}

const enableFlag = async (base: string, key: string): Promise<void> => {
  await fetch(`${base}/flags/${key}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, default: true, scope: 'engine', description: key }),
  })
}
const putLlm = async (base: string, endpoint: Fabric['slots']['llm'][number]): Promise<void> => {
  const fabric = (await (await fetch(`${base}/fabric`)).json()) as Fabric
  await fetch(`${base}/fabric`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slots: { ...fabric.slots, llm: [endpoint] } }),
  })
}
const eventually = async (assertion: () => Promise<void>, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try { await assertion(); return } catch (error) { lastError = error; await new Promise((r) => setTimeout(r, 50)) }
  }
  throw lastError instanceof Error ? lastError : new Error('condition not met')
}

test('e2e (#180): a real screen frame → OcrResult → ContextPacket grounds Ask, and the egress gate keeps screen bytes home', async () => {
  const paddle = await startFakePaddle()
  const localLlm = await startChat('You are reviewing the Q3 roadmap on your planning board.')
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-ask-packets-e2e-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  wireScreenOcr(app) // the same wiring main.ts does — NO injected invoke, so the REAL processor runs
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // Point the live fabric ocr slot at the fake paddle; enable screen understanding.
    const fabric0 = (await (await fetch(`${base}/fabric`)).json()) as Fabric
    await fetch(`${base}/fabric`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slots: { ...fabric0.slots, ocr: [{ kind: 'http', name: 'paddle', url: paddle.url, api: 'paddle-serving', model: 'pp-ocrv4' }] } }),
    })
    await enableFlag(base, 'screen.ocr')

    // A live session — session.started sets the RUNTIME-current session the `packets` source scopes to (#210).
    const started = (await (await fetch(`${base}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'default', modeId: 'mode-meeting', title: 'ask packets e2e' }),
    })).json()) as Session

    // Ship a real screen frame (+ its companion meta) through the PRODUCTION capture route.
    const frame: CaptureChunk = {
      id: 'scr-recognized-1', sessionId: started.id, workspaceId: 'default', source: 'screen', sequence: 1,
      capturedAt: FRAME_CAPTURED_AT, contentType: 'image/jpeg', encoding: 'base64', data: Buffer.from('SCREEN-FRAME-RECOGNIZED').toString('base64'),
    }
    const meta: CaptureChunk = {
      id: 'scr-meta-1', sessionId: started.id, workspaceId: 'default', source: 'screen', sequence: 2,
      capturedAt: FRAME_CAPTURED_AT, contentType: 'application/json', encoding: 'utf8', data: JSON.stringify({ displayId: '1', width: 1280, height: 800 }),
    }
    for (const chunk of [frame, meta]) {
      const res = await fetch(`${base}/capture/screen`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chunk) })
      assert.equal(res.status, 200)
    }

    // The REAL processor recognized the frame — proven by its own health, not assumed.
    await eventually(async () => {
      const status = (await (await fetch(`${base}/screen/status`)).json()) as { processed: number; failed: number }
      assert.equal(status.processed, 1, 'the real screen processor recognized exactly one frame')
      assert.equal(status.failed, 0, 'no failures on the driven capture path')
    })

    // ---- ARM 1: a loopback llm answers; the packet's converged window is CONSUMED into the prompt ----
    await putLlm(base, { kind: 'http', name: 'llm.local', url: `http://127.0.0.1:${localLlm.port}`, api: 'openai-compat' })
    const reply1 = (await (await fetch(`${base}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: 'default', message: 'what is happening on my screen right now?' }),
    })).json()) as ChatReply

    const prompt = localLlm.lastPrompt()
    assert.match(prompt, /Converged activity in the CURRENT session/, 'the packet block header entered the prompt')
    assert.match(prompt, new RegExp(`screen: ${RECOGNIZED_TEXT.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}`), 'the screen-DERIVED recognized text entered under its screen lane label (attribution intact)')
    assert.match(prompt, /microphone: no-observations-this-session/, 'the silent mic lane keeps its honest machine gap reason, kept separate — never guessed')
    assert.match(prompt, /system audio: no-observations-this-session/, 'the system-audio lane stays a SEPARATE labeled lane')
    assert.match(reply1.budget.note, /packets\(1\)/, 'the honest budget note discloses the consumed packet window')
    assert.equal(reply1.contentClass, 'screen', 'screen-derived packet content keeps the whole composite turn screen-classed')

    // Real materialization is durable, not a chat-only artifact: the session now has a packet naming the OcrResult.
    const packets = (await (await fetch(`${base}/context/packets?session=${encodeURIComponent(started.id)}`)).json()) as ContextPacket[]
    assert.equal(packets.length, 1, 'exactly one converged window materialized for the session')
    assert.equal(packets[0]!.screen.length, 1, 'the packet references its screen observation (a ref, never copied content)')
    assert.equal(packets[0]!.screen[0]!.record, 'ocr-result')
    assert.deepEqual(packets[0]!.gaps.map((g) => g.lane).sort(), ['mic', 'system-audio'], 'both audio lanes are honestly absent this session')

    // ---- ARM 2: mode denies egress + the ONLY llm endpoint is egress-classified ⇒ zero screen bytes leave ----
    const restore = installEgressRewrite()
    const egressLlm = await startChat('this must never be reached')
    try {
      const mode = (await (await fetch(`${base}/modes`)).json() as Mode[]).find((m) => m.id === 'mode-meeting')!
      await fetch(`${base}/modes/mode-meeting`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...mode, egress: { deny: true } }),
      })
      await putLlm(base, { kind: 'http', name: 'llm.hosted', url: `http://llm.egress.test:${egressLlm.port}`, api: 'openai-compat' })

      const denied = await fetch(`${base}/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: 'default', message: 'summarize my screen to the cloud model' }),
      })
      assert.equal(egressLlm.hits(), 0, 'the egress-classified endpoint received ZERO bytes — no screen content left the machine')
      assert.equal(denied.status, 502, 'the screen-derived turn had nowhere honest to go — it degrades to a visible failure, never a silent no-op')
      const error = ((await denied.json()) as { error: string }).error
      assert.match(error, /no llm endpoint answered/, 'the failure names the honest reason')
      assert.match(error, /egress|skipped/i, 'the disclosure names the egress skip, not a vague error')
    } finally {
      await stop(egressLlm)
      restore()
    }
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
    await stop(paddle)
    await stop(localLlm)
  }
})
