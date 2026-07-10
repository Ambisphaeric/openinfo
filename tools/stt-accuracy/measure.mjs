#!/usr/bin/env node
// @ts-check
/**
 * STT accuracy harness (issue #97; seeds the #95 chunking-architecture fix).
 *
 * Renders known utterances with `say` (SYNTHESIZED voice, rendered to file — never played aloud),
 * then runs each one (a) whole-file and (b) through each candidate CHUNKING strategy at 1s/2s/5s
 * cadences against a local STT endpoint, and prints a word-accuracy (WER) table against the reference
 * text. Silence and pink-noise probes confirm the model is not hallucinating (they must transcribe
 * empty / near-empty).
 *
 * This is the regression metric for the fixed-1s-slicing corruption: the whole-vs-chunked WER delta.
 *
 * NO endpoints are hardcoded to any one machine — pass them as flags/env, localhost defaults. Requires
 * `say` (macOS) and `ffmpeg` on PATH. Read-only against the endpoint (POST transcriptions only).
 *
 * Usage:
 *   node tools/stt-accuracy/measure.mjs \
 *     --endpoint http://localhost:8002/v1/audio/transcriptions \
 *     --model mlx-community/parakeet-tdt_ctc-110m \
 *     [--api-key-env OPENINFO_STT_KEY] [--strategies whole,fixed,overlap,vad] \
 *     [--cadences 1,2,5] [--rate 175] [--keep] [--json]
 *
 * Env fallbacks: STT_ENDPOINT, STT_MODEL, STT_API_KEY (or the name given via --api-key-env).
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

// ---- args -------------------------------------------------------------------------------------
const argv = process.argv.slice(2)
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return def
  const v = argv[i + 1]
  return v === undefined || v.startsWith('--') ? true : v
}
const has = (name) => argv.includes(`--${name}`)

const ENDPOINT = flag('endpoint', process.env.STT_ENDPOINT ?? 'http://localhost:8002/v1/audio/transcriptions')
const MODEL = flag('model', process.env.STT_MODEL ?? 'mlx-community/parakeet-tdt_ctc-110m')
const API_KEY_ENV = flag('api-key-env', undefined)
const API_KEY = API_KEY_ENV ? process.env[API_KEY_ENV] : process.env.STT_API_KEY
const STRATEGIES = String(flag('strategies', 'whole,fixed,overlap,vad')).split(',')
const CADENCES = String(flag('cadences', '1,2,5')).split(',').map(Number)
const RATE = Number(flag('rate', '175')) // say words-per-minute; ~175 is a natural speaking pace
const KEEP = has('keep')
const AS_JSON = has('json')
const OVERLAP_WINDOW = Number(flag('overlap-window', '5')) // rolling-window length (s) for the overlap strategy
const OVERLAP_HOP = Number(flag('overlap-hop', '2')) // hop between window starts (s)

// ---- fixtures ---------------------------------------------------------------------------------
/** @type {{name:string, ref:string, kind?:'silence'|'noise'}[]} */
const UTTERANCES = [
  { name: 'testing-x3', ref: 'testing testing testing' },
  { name: 'can-you-hear-me', ref: 'can you hear me' },
  {
    name: 'meeting-line',
    ref: "let's align on the parakeet chunking strategy before the release next week",
  },
  {
    name: 'longer',
    ref: 'the quick brown fox jumps over the lazy dog while the engine transcribes every spoken word',
  },
  {
    // ~20s continuous monologue with few pauses — long enough to have MULTIPLE segment boundaries even
    // at the 5s cadence, so fixed-5s can no longer hide the boundary corruption behind a single chunk.
    // This is the fixture that separates "just use longer segments" from overlap/VAD.
    name: 'monologue',
    ref: 'so the main thing i want to walk through today is how we handle transcription because right now the audio gets sliced into fixed one second pieces and every piece is sent to the model completely on its own with no idea what came before or after which means whenever a word happens to straddle a boundary it gets mangled into something that was never actually said',
  },
  { name: 'silence', ref: '', kind: 'silence' },
  { name: 'noise', ref: '', kind: 'noise' },
]

// ---- audio rendering (never plays; renders to file) -------------------------------------------
const ffmpeg = (args) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args])

/** Render one utterance to a 16kHz mono PCM wav (what the mlx STT servers expect). */
async function renderWav(dir, u) {
  const wav = join(dir, `${u.name}.wav`)
  if (u.kind === 'silence') {
    await ffmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '3', '-c:a', 'pcm_s16le', wav])
    return wav
  }
  if (u.kind === 'noise') {
    // pink-ish noise via a lightly filtered white source; -30dB so it is plausibly room noise, not a tone
    await ffmpeg(['-f', 'lavfi', '-i', 'anoisesrc=r=16000:a=0.06:c=pink', '-t', '3', '-ac', '1', '-c:a', 'pcm_s16le', wav])
    return wav
  }
  const aiff = join(dir, `${u.name}.aiff`)
  await run('say', ['-r', String(RATE), '-o', aiff, u.ref]) // renders to file only — no audio device touched
  await ffmpeg(['-i', aiff, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav])
  return wav
}

async function durationSec(wav) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', wav,
  ])
  return Number(stdout.trim())
}

// ---- transcription ----------------------------------------------------------------------------
/** POST one wav to the endpoint, return {text, ms}. Throws on transport / non-2xx. */
async function transcribe(wav) {
  const buf = await readFile(wav)
  const form = new FormData()
  form.set('file', new Blob([buf], { type: 'audio/wav' }), wav.split('/').pop())
  form.set('model', MODEL)
  const headers = API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}
  const t0 = performance.now()
  const res = await fetch(ENDPOINT, { method: 'POST', headers, body: form })
  const ms = performance.now() - t0
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = await res.json()
  return { text: typeof body.text === 'string' ? body.text : '', ms }
}

// ---- chunking strategies ----------------------------------------------------------------------
/** Non-overlapping fixed segments of `cadence` seconds (reproduces the shipped 0.0.8 slicing). */
async function sliceFixed(dir, wav, cadence) {
  const out = join(dir, `seg-${cadence}s`) // unique per cadence so leftover slices never contaminate
  await run('mkdir', ['-p', out])
  await ffmpeg(['-i', wav, '-f', 'segment', '-segment_time', String(cadence), '-c:a', 'pcm_s16le', join(out, 'c_%03d.wav')])
  const files = (await readdir(out)).filter((f) => f.endsWith('.wav')).sort()
  return files.map((f) => join(out, f))
}

/** Rolling windows of `win` seconds every `hop` seconds — the overlap strategy's audio segmentation. */
async function sliceOverlap(dir, wav, win, hop) {
  const total = await durationSec(wav)
  const out = join(dir, 'ov')
  await run('mkdir', ['-p', out])
  const files = []
  let idx = 0
  for (let start = 0; start < total; start += hop) {
    const f = join(out, `w_${String(idx).padStart(3, '0')}.wav`)
    await ffmpeg(['-ss', String(start), '-t', String(win), '-i', wav, '-c:a', 'pcm_s16le', f])
    files.push(f)
    idx++
    if (start + win >= total) break
  }
  return files
}

/** VAD: cut at ffmpeg-detected silences (>=0.25s below -35dB), so no cut lands mid-word. */
async function sliceVad(dir, wav) {
  const { stderr } = await run('ffmpeg', [
    '-hide_banner', '-i', wav, '-af', 'silencedetect=noise=-35dB:d=0.25', '-f', 'null', '-',
  ]).catch((e) => ({ stderr: String(e.stderr ?? '') }))
  const total = await durationSec(wav)
  // silence_end N marks a boundary where speech resumes; cut points = those ends (plus 0 and total).
  const ends = [...String(stderr).matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => Number(m[1]))
  const cuts = [0, ...ends.filter((t) => t > 0.1 && t < total - 0.1), total]
  const out = join(dir, 'vad')
  await run('mkdir', ['-p', out])
  const files = []
  for (let i = 0; i < cuts.length - 1; i++) {
    const start = cuts[i]
    const len = cuts[i + 1] - start
    if (len < 0.15) continue
    const f = join(out, `v_${String(i).padStart(3, '0')}.wav`)
    await ffmpeg(['-ss', String(start), '-t', String(len), '-i', wav, '-c:a', 'pcm_s16le', f])
    files.push(f)
  }
  return files.length ? files : [wav]
}

// ---- text + WER -------------------------------------------------------------------------------
const normalize = (s) =>
  s.toLowerCase().replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim()
const words = (s) => (normalize(s) ? normalize(s).split(' ') : [])

/** Word-level Levenshtein → WER = (S+D+I)/N (N = reference word count). */
function wer(ref, hyp) {
  const r = words(ref)
  const h = words(hyp)
  if (r.length === 0) return h.length === 0 ? 0 : 1 // empty ref: 0 if hyp also empty, else full error
  const d = Array.from({ length: r.length + 1 }, () => new Array(h.length + 1).fill(0))
  for (let i = 0; i <= r.length; i++) d[i][0] = i
  for (let j = 0; j <= h.length; j++) d[0][j] = j
  for (let i = 1; i <= r.length; i++)
    for (let j = 1; j <= h.length; j++)
      d[i][j] = r[i - 1] === h[j - 1] ? d[i - 1][j - 1] : 1 + Math.min(d[i - 1][j], d[i][j - 1], d[i - 1][j - 1])
  return d[r.length][h.length] / r.length
}

/**
 * The overlap MERGE step (mirrors the engine-side reconciliation the fix ships): join a sequence of
 * window transcripts, dropping the longest word-level overlap between the running tail and each new
 * window's head. This is the same algorithm the transcript path uses so the live strip never shows
 * duplicated overlap text.
 */
export function mergeOverlap(texts) {
  /** @type {string[]} */
  let acc = []
  for (const t of texts) {
    const w = words(t)
    if (w.length === 0) continue
    if (acc.length === 0) {
      acc = w
      continue
    }
    const max = Math.min(acc.length, w.length)
    let overlap = 0
    for (let k = max; k >= 1; k--) {
      if (acc.slice(acc.length - k).join(' ') === w.slice(0, k).join(' ')) {
        overlap = k
        break
      }
    }
    acc = acc.concat(w.slice(overlap))
  }
  return acc.join(' ')
}

// ---- driver -----------------------------------------------------------------------------------
async function measureOne(dir, u, wav) {
  /** @type {Record<string, {text:string, wer:number, ms:number, chunks:number}>} */
  const results = {}
  const record = async (label, files, merge) => {
    const parts = []
    let ms = 0
    for (const f of files) {
      const r = await transcribe(f)
      parts.push(r.text)
      ms += r.ms
    }
    const text = merge ? merge(parts) : parts.join(' ')
    results[label] = { text, wer: wer(u.ref, text), ms, chunks: files.length }
  }

  if (STRATEGIES.includes('whole')) await record('whole', [wav])
  if (STRATEGIES.includes('fixed'))
    for (const c of CADENCES) await record(`fixed-${c}s`, await sliceFixed(dir, wav, c))
  if (STRATEGIES.includes('overlap'))
    await record(`overlap-${OVERLAP_WINDOW}s/${OVERLAP_HOP}s`, await sliceOverlap(dir, wav, OVERLAP_WINDOW, OVERLAP_HOP), mergeOverlap)
  if (STRATEGIES.includes('vad')) await record('vad', await sliceVad(dir, wav))
  return results
}

async function main() {
  // sanity: tools present
  for (const t of ['say', 'ffmpeg', 'ffprobe']) {
    try {
      await run('which', [t])
    } catch {
      console.error(`missing required tool: ${t}`)
      process.exit(2)
    }
  }
  console.error(`# endpoint: ${ENDPOINT}\n# model:    ${MODEL}\n# say rate: ${RATE} wpm  auth: ${API_KEY ? 'yes' : 'none'}\n`)

  const dir = await mkdtemp(join(tmpdir(), 'stt-accuracy-'))
  /** @type {Record<string, Record<string, any>>} */
  const all = {}
  try {
    for (const u of UTTERANCES) {
      const wav = await renderWav(dir, u)
      const sub = await mkdtemp(join(dir, `${u.name}-`))
      all[u.name] = { ref: u.ref, kind: u.kind ?? 'speech', results: await measureOne(sub, u, wav) }
    }
  } finally {
    if (!KEEP) await rm(dir, { recursive: true, force: true })
  }

  if (AS_JSON) {
    console.log(JSON.stringify(all, null, 2))
    return
  }
  printTable(all)
}

function printTable(all) {
  const labels = new Set()
  for (const u of Object.values(all)) for (const k of Object.keys(u.results)) labels.add(k)
  const cols = [...labels]
  const pad = (s, n) => String(s).padEnd(n)
  const w0 = Math.max(18, ...Object.keys(all).map((k) => k.length))
  console.log('WER by strategy (lower is better; silence/noise want empty→0.00)\n')
  console.log(pad('utterance', w0), cols.map((c) => pad(c, 16)).join(''))
  console.log('-'.repeat(w0 + cols.length * 16))
  for (const [name, u] of Object.entries(all)) {
    const row = cols.map((c) => {
      const r = u.results[c]
      return pad(r ? r.wer.toFixed(2) : '-', 16)
    })
    console.log(pad(name, w0), row.join(''))
  }
  // speech-only mean (exclude silence/noise probes)
  console.log('-'.repeat(w0 + cols.length * 16))
  const meanRow = cols.map((c) => {
    const vals = Object.values(all).filter((u) => u.kind === 'speech' && u.results[c]).map((u) => u.results[c].wer)
    const m = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN
    return pad(Number.isNaN(m) ? '-' : m.toFixed(2), 16)
  })
  console.log(pad('MEAN(speech)', w0), meanRow.join(''))
  const latRow = cols.map((c) => {
    const vals = Object.values(all).filter((u) => u.results[c]).map((u) => u.results[c].ms)
    const m = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN
    return pad(Number.isNaN(m) ? '-' : `${Math.round(m)}ms`, 16)
  })
  console.log(pad('mean req time', w0), latRow.join(''))
  console.log('\ntranscripts:')
  for (const [name, u] of Object.entries(all)) {
    console.log(`\n[${name}] ref: "${u.ref}"`)
    for (const [c, r] of Object.entries(u.results)) console.log(`  ${pad(c, 16)} "${r.text}"`)
  }
}

// run as script; export mergeOverlap/wer for the engine merge test to import
const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) main().catch((e) => {
  console.error(e)
  process.exit(1)
})
export { wer, words }
