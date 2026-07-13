import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Value } from '@sinclair/typebox/value'
import {
  FIXTURE_FORMAT,
  FIXTURE_FORMAT_VERSION,
  FixtureEnvelopeSchema,
} from './schema.mjs'

const PRIVATE_NOTICE = 'May contain personal screen/audio data. Keep owner-only, local, and out of git.'
const SYNTHETIC_NOTICE = 'Synthetic test data only; no real person, account, screen, or recording is represented.'
const SANITIZED_NOTICE = 'Sanitized fixture: review every text field before sharing or committing.'

export class FixtureError extends Error {
  constructor(message) {
    super(message)
    this.name = 'FixtureError'
  }
}

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

const compareCodePoints = (left, right) => (left < right ? -1 : left > right ? 1 : 0)

/** RFC-8785-style needs for this format: sorted object keys, preserved array order, finite JSON values. */
export function canonicalize(value, path = '$', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new FixtureError(`${path}: non-finite numbers are not fixture data`)
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new FixtureError(`${path}: cyclic fixture data`)
    seen.add(value)
    const result = value.map((item, index) => canonicalize(item, `${path}[${index}]`, seen))
    seen.delete(value)
    return result
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) throw new FixtureError(`${path}: cyclic fixture data`)
    seen.add(value)
    const result = {}
    for (const key of Object.keys(value).sort(compareCodePoints)) {
      const item = value[key]
      if (item === undefined) throw new FixtureError(`${path}.${key}: undefined is not fixture data`)
      result[key] = canonicalize(item, `${path}.${key}`, seen)
    }
    seen.delete(value)
    return result
  }
  throw new FixtureError(`${path}: ${typeof value} is not fixture data`)
}

/** No trailing newline: this exact byte sequence is also the digest input. */
export const canonicalJson = (value) => JSON.stringify(canonicalize(value))

/** File representation: canonical JSON plus exactly one trailing newline. */
export const canonicalStringify = (value) => `${canonicalJson(value)}\n`

const sha256 = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex')

const digestContent = (fixture) => {
  const { digest: _digest, fixtureId: _fixtureId, ...content } = fixture
  return content
}

export const computeFixtureDigest = (fixture) => `sha256:${sha256(digestContent(fixture))}`
export const fixtureIdForDigest = (digest) => `fixture-${digest.slice('sha256:'.length, 'sha256:'.length + 20)}`

const assertIso = (value, path) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new FixtureError(`${path}: expected canonical UTC ISO timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)`)
  }
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new FixtureError(`${path}: invalid calendar timestamp`)
  }
}

const laneForSource = (source) => (source === 'mic' || source === 'system-audio' || source === 'screen' ? source : undefined)
const isMediaContentType = (chunk) => /^(audio|image)\//i.test(chunk.contentType)
const isMediaChunk = (chunk) => chunk.encoding === 'base64' && isMediaContentType(chunk)
const hasInlineMedia = (entry) => entry.kind === 'capture' && isMediaContentType(entry.value) && entry.value.data.length > 0
const isCanonicalBase64 = (value) => {
  if (value === '') return true
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false
  return Buffer.from(value, 'base64').toString('base64') === value
}

/** Validate the complete envelope before a caller can observe even one replay entry. */
export function validateFixture(value, source = '<fixture>') {
  if (!isPlainObject(value)) throw new FixtureError(`${source}: fixture root must be an object`)
  if (value.format !== FIXTURE_FORMAT) throw new FixtureError(`${source}: unsupported fixture format ${JSON.stringify(value.format)}`)
  if (value.formatVersion !== FIXTURE_FORMAT_VERSION) {
    throw new FixtureError(`${source}: unsupported formatVersion ${JSON.stringify(value.formatVersion)}; supported: ${FIXTURE_FORMAT_VERSION}`)
  }
  if (!Value.Check(FixtureEnvelopeSchema, value)) {
    const first = Value.Errors(FixtureEnvelopeSchema, value).First()
    const location = first?.path || '$'
    throw new FixtureError(`${source}${location}: ${first?.message ?? 'fixture does not match schema'}`)
  }

  assertIso(value.recordedAt, `${source}.recordedAt`)
  assertIso(value.replay.at, `${source}.replay.at`)
  const entryIds = new Set()
  const captures = new Map()
  const stageInputs = new Set()
  for (let index = 0; index < value.entries.length; index++) {
    const entry = value.entries[index]
    const path = `${source}.entries[${index}]`
    if (entry.ordinal !== index) throw new FixtureError(`${path}.ordinal: expected contiguous ordinal ${index}, got ${entry.ordinal}`)
    if (entryIds.has(entry.id)) throw new FixtureError(`${path}.id: duplicate entry id ${JSON.stringify(entry.id)}`)
    entryIds.add(entry.id)
    assertIso(entry.at, `${path}.at`)

    if (entry.kind === 'capture') {
      assertIso(entry.value.capturedAt, `${path}.value.capturedAt`)
      const sourceLane = laneForSource(entry.value.source)
      if (sourceLane === undefined || sourceLane !== entry.lane) {
        throw new FixtureError(`${path}.lane: ${entry.lane} disagrees with capture source ${entry.value.source}`)
      }
      if (captures.has(entry.value.id)) throw new FixtureError(`${path}.value.id: duplicate capture id ${JSON.stringify(entry.value.id)}`)
      if (isMediaContentType(entry.value) && entry.value.encoding !== 'base64') {
        throw new FixtureError(`${path}.value.encoding: audio/image captures must use base64`)
      }
      if (entry.value.encoding === 'base64' && !isCanonicalBase64(entry.value.data)) {
        throw new FixtureError(`${path}.value.data: invalid or non-canonical base64 payload`)
      }
      if (entry.media === 'redacted' && isMediaChunk(entry.value) && entry.value.data !== '') {
        throw new FixtureError(`${path}.value.data: redacted media must contain no original bytes (use an empty payload)`)
      }
      if (entry.media === 'text' && isMediaChunk(entry.value)) {
        throw new FixtureError(`${path}.media: audio/image base64 must be synthetic, redacted, or raw`)
      }
      captures.set(entry.value.id, { lane: entry.lane, ordinal: entry.ordinal, entry })
      continue
    }

    if ((entry.kind === 'ocr' || entry.kind === 'vlm') && entry.lane !== 'screen') {
      throw new FixtureError(`${path}.lane: ${entry.kind} results must remain on the screen lane`)
    }
    if (entry.kind === 'stt' && entry.lane !== 'mic' && entry.lane !== 'system-audio') {
      throw new FixtureError(`${path}.lane: stt results must remain on mic or system-audio`)
    }
    if (entry.output.slot !== entry.kind) {
      throw new FixtureError(`${path}.output.slot: ${entry.output.slot} disagrees with stage kind ${entry.kind}`)
    }
    const uniqueInputs = new Set()
    for (let inputIndex = 0; inputIndex < entry.inputIds.length; inputIndex++) {
      const inputId = entry.inputIds[inputIndex]
      if (uniqueInputs.has(inputId)) throw new FixtureError(`${path}.inputIds[${inputIndex}]: duplicate input id ${JSON.stringify(inputId)}`)
      uniqueInputs.add(inputId)
      const capture = captures.get(inputId)
      if (!capture) throw new FixtureError(`${path}.inputIds[${inputIndex}]: capture ${JSON.stringify(inputId)} is missing or not earlier`)
      if (capture.ordinal >= entry.ordinal) throw new FixtureError(`${path}.inputIds[${inputIndex}]: capture must precede its result`)
      if (capture.lane !== entry.lane) {
        throw new FixtureError(`${path}.lane: ${entry.lane} disagrees with input capture ${inputId} lane ${capture.lane}`)
      }
      const stageInput = `${entry.kind}\u0000${inputId}`
      if (stageInputs.has(stageInput)) {
        throw new FixtureError(`${path}.inputIds[${inputIndex}]: duplicate ${entry.kind} output for capture ${inputId}`)
      }
      stageInputs.add(stageInput)
    }
  }

  const inlineMedia = value.entries.some(hasInlineMedia)
  if (value.privacy.rawMedia !== inlineMedia) {
    throw new FixtureError(`${source}.privacy.rawMedia: must equal presence of inline audio/image payload bytes (${inlineMedia})`)
  }
  const rawEntries = value.entries.filter((entry) => entry.kind === 'capture' && entry.media === 'raw')
  if (rawEntries.length > 0 && value.privacy.classification !== 'sensitive') {
    throw new FixtureError(`${source}.privacy.classification: media:'raw' requires sensitive classification`)
  }

  const expectedDigest = computeFixtureDigest(value)
  if (value.digest !== expectedDigest) throw new FixtureError(`${source}.digest: integrity mismatch; expected ${expectedDigest}`)
  const expectedId = fixtureIdForDigest(expectedDigest)
  if (value.fixtureId !== expectedId) throw new FixtureError(`${source}.fixtureId: expected derived id ${expectedId}`)
  return value
}

export function parseFixture(text, source = '<fixture>') {
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new FixtureError(`${source}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return validateFixture(value, source)
}

export const loadFixtureSync = (path) => parseFixture(readFileSync(path, 'utf8'), path)

const normalizeInputOrder = (entries) => {
  const hasOrdinals = entries.map((entry) => Number.isInteger(entry?.ordinal))
  if (hasOrdinals.some(Boolean) && !hasOrdinals.every(Boolean)) throw new FixtureError('record input: either every entry has ordinal or none do')
  if (!hasOrdinals.every(Boolean)) return [...entries]
  const ordinals = new Set()
  for (const [index, entry] of entries.entries()) {
    if (ordinals.has(entry.ordinal)) throw new FixtureError(`record input[${index}].ordinal: duplicate ordinal ${entry.ordinal}`)
    ordinals.add(entry.ordinal)
  }
  return [...entries].sort((left, right) => left.ordinal - right.ordinal)
}

const entryId = (entry, ordinal) => {
  const { id: _id, ordinal: _ordinal, ...content } = entry
  return `entry-${String(ordinal).padStart(4, '0')}-${sha256(content).slice(0, 12)}`
}

const noticeFor = (classification) =>
  classification === 'sensitive' ? PRIVATE_NOTICE : classification === 'synthetic' ? SYNTHETIC_NOTICE : SANITIZED_NOTICE

/** Build a canonical envelope from ordered normalized capture/stage events. No clock or random id is consulted. */
export function recordFixture(inputEntries, options) {
  if (!Array.isArray(inputEntries) || inputEntries.length === 0) throw new FixtureError('record input: expected at least one entry')
  const classification = options?.classification
  if (!['synthetic', 'sanitized', 'sensitive'].includes(classification)) {
    throw new FixtureError('record: explicit classification required (synthetic | sanitized | sensitive)')
  }
  const ordered = normalizeInputOrder(inputEntries)
  const entries = ordered.map((input, ordinal) => {
    if (!isPlainObject(input)) throw new FixtureError(`record input[${ordinal}]: entry must be an object`)
    const cloned = structuredClone(input)
    delete cloned.ordinal
    delete cloned.id
    if (cloned.kind === 'capture') {
      if (!isPlainObject(cloned.value)) throw new FixtureError(`record input[${ordinal}].value: capture value required`)
      cloned.at ??= cloned.value.capturedAt
      cloned.lane ??= laneForSource(cloned.value.source)
      if (cloned.media === undefined) {
        if (isMediaChunk(cloned.value)) {
          throw new FixtureError(`record input[${ordinal}].media: classify inline audio/image as synthetic, redacted, or raw`)
        }
        cloned.media = 'text'
      }
    }
    const normalized = { ordinal, id: '', ...cloned }
    normalized.id = entryId(normalized, ordinal)
    return normalized
  })
  for (const [index, entry] of entries.entries()) assertIso(entry.at, `record input[${index}].at`)
  const inlineMedia = entries.some(hasInlineMedia)
  if (inlineMedia && options?.allowRawMedia !== true) {
    throw new FixtureError('record: inline audio/image bytes require explicit allowRawMedia=true (CLI: --allow-raw-media)')
  }
  if (entries.some((entry) => entry.kind === 'capture' && entry.media === 'raw') && classification !== 'sensitive') {
    throw new FixtureError("record: media:'raw' requires --privacy sensitive")
  }
  const containsPersonalData = options?.containsPersonalData === true || classification === 'sensitive'
  const timestamps = entries.map((entry) => entry.at)
  const recordedAt = options?.recordedAt ?? [...timestamps].sort(compareCodePoints)[0]
  const replayAt = options?.replayAt ?? [...timestamps].sort(compareCodePoints).at(-1)
  assertIso(recordedAt, 'recordedAt')
  assertIso(replayAt, 'replay.at')
  const core = {
    format: FIXTURE_FORMAT,
    formatVersion: FIXTURE_FORMAT_VERSION,
    fixtureId: '',
    recordedAt,
    privacy: {
      classification,
      rawMedia: inlineMedia,
      containsPersonalData,
      notice: noticeFor(classification),
    },
    replay: { at: replayAt },
    entries,
    digest: '',
  }
  core.digest = computeFixtureDigest(core)
  core.fixtureId = fixtureIdForDigest(core.digest)
  return validateFixture(core, '<recorded fixture>')
}

const stageKey = (kind, contentType, data) => `${kind}\u0000${contentType}\u0000${data}`

/** Pure replay boundary: recorded results replace STT/OCR/VLM invocations; this module never calls fetch. */
export function createFixtureReplay(value) {
  const fixture = validateFixture(structuredClone(value))
  const captures = new Map(
    fixture.entries.filter((entry) => entry.kind === 'capture').map((entry) => [entry.value.id, entry]),
  )
  const queues = new Map()
  const byCapture = new Map()
  const ambiguous = new Set()
  for (const entry of fixture.entries) {
    if (entry.kind === 'capture') continue
    const inputId = entry.inputIds[0]
    const capture = captures.get(inputId)
    const key = stageKey(entry.kind, capture.value.contentType, capture.value.data)
    const queue = queues.get(key) ?? []
    if (queue.some((queued) => canonicalJson(queued.output) !== canonicalJson(entry.output))) ambiguous.add(key)
    queue.push(entry)
    queues.set(key, queue)
    byCapture.set(`${entry.kind}\u0000${inputId}`, entry)
  }
  const cursors = new Map()
  let idCursor = 0
  const take = (kind, contentType, data) => {
    const key = stageKey(kind, contentType, data)
    if (ambiguous.has(key)) {
      throw new FixtureError(`replay: ambiguous ${kind} payload appears in multiple lanes/captures; use the capture-scoped invoker`)
    }
    const queue = queues.get(key) ?? []
    const cursor = cursors.get(key) ?? 0
    const entry = queue[cursor]
    if (!entry) throw new FixtureError(`replay: no recorded ${kind} output matches ${contentType}`)
    cursors.set(key, cursor + 1)
    return structuredClone(entry.output)
  }
  const takeFor = (kind, captureId, contentType, data) => {
    const capture = captures.get(captureId)
    if (!capture) throw new FixtureError(`replay: unknown capture ${JSON.stringify(captureId)}`)
    if (capture.value.contentType !== contentType || capture.value.data !== data) {
      throw new FixtureError(`replay: ${kind} request bytes do not match capture ${captureId}`)
    }
    const entry = byCapture.get(`${kind}\u0000${captureId}`)
    if (!entry) throw new FixtureError(`replay: capture ${captureId} has no recorded ${kind} output`)
    return structuredClone(entry.output)
  }
  return {
    fixtureId: fixture.fixtureId,
    entries: () => structuredClone(fixture.entries),
    captures: (lane) => fixture.entries
      .filter((entry) => entry.kind === 'capture' && (lane === undefined || entry.lane === lane))
      .map((entry) => structuredClone(entry.value)),
    invokeStt: async (audio) => take('stt', audio.contentType, audio.base64),
    invokeSttFor: async (captureId, audio) => takeFor('stt', captureId, audio.contentType, audio.base64),
    invokeOcr: async (params) => take('ocr', params.contentType, params.image),
    invokeOcrFor: async (captureId, params) => takeFor('ocr', captureId, params.contentType, params.image),
    invokeVlm: async (params) => take('vlm', params.contentType, params.image),
    invokeVlmFor: async (captureId, params) => takeFor('vlm', captureId, params.contentType, params.image),
    now: () => new Date(fixture.replay.at),
    newId: () => `${fixture.fixtureId}-record-${String(++idCursor).padStart(4, '0')}`,
    reset: () => {
      cursors.clear()
      idCursor = 0
    },
  }
}

/** Prevalidation is deliberately completed before the first callback. */
export function replayFixture(value, onEntry) {
  const fixture = validateFixture(structuredClone(value))
  for (const entry of fixture.entries) onEntry(structuredClone(entry))
}

export function fixtureSummary(value) {
  const fixture = validateFixture(value)
  const byKind = { capture: 0, stt: 0, ocr: 0, vlm: 0 }
  const byLane = { mic: 0, 'system-audio': 0, screen: 0 }
  for (const entry of fixture.entries) {
    byKind[entry.kind]++
    byLane[entry.lane]++
  }
  return {
    ok: true,
    fixtureId: fixture.fixtureId,
    formatVersion: fixture.formatVersion,
    digest: fixture.digest,
    privacy: fixture.privacy,
    entries: fixture.entries.length,
    byKind,
    byLane,
  }
}
