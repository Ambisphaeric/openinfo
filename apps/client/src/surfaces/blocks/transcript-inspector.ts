import type { CaptureSource, SttSlotEndpoint, TranscriptInspector, TranscriptUpdate } from '@openinfo/contracts'
import { h, type VNode } from '../block-renderer/vnode.js'
import type { BlockRenderer } from '../block-renderer/registry.js'
import { clockLabel } from '../block-renderer/format.js'

const LABEL = 'Transcription · inspector'

/**
 * The `transcript-inspector` block — the diagnostics app's headline (#101). The transcript-garbage QA round
 * was diagnosable only over ssh; this puts the exact probes on a surface. It reads the hydrated `transcript`
 * query (`source: 'transcript'`, ONE row: the TranscriptInspector snapshot the engine injects — recent
 * ephemeral chunks from an in-memory ring + the CURRENT stt slot config) and renders, newest-first, one row
 * per transcript chunk: clock · physical stream · duration · raw text. A physical input is never
 * presented as a speaker identity because one microphone or system stream can contain several people.
 *
 * HONESTY (the whole point): per-chunk stt provenance is NOT recorded anywhere — STT invokes persist no
 * provenance row, unlike DISTILLATE records (the disclosed #65 gap). So the block does NOT stamp a per-chunk
 * endpoint/model it cannot know. Instead it renders the current stt slot as a SEPARATE labelled line
 * ("stt slot · <endpoint> · <model>") and a disclosure line naming the gap and the ring's retention (last N,
 * session-lived, not persisted). Empty is EXPLAINABLE, never silent: no chunks yet ⇒ a "start a session"
 * line; a missing snapshot (the source unwired — only in a unit caller) ⇒ an explainable "unavailable" line.
 */
const streamLabel = (source: CaptureSource): string =>
  source === 'mic' ? 'Microphone' : source === 'system-audio' ? 'System audio' : source

/** The captured-audio span of the chunks aggregated into this update, humanised. Malformed range ⇒ ''. */
const durationLabel = (range: TranscriptUpdate['capturedAtRange']): string => {
  const start = Date.parse(range.start)
  const end = Date.parse(range.end)
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return ''
  const ms = end - start
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

const chunkRow = (chunk: TranscriptUpdate): VNode => {
  const dur = durationLabel(chunk.capturedAtRange)
  const meta = [streamLabel(chunk.source), ...(dur !== '' ? [dur] : [])].join(' · ')
  return h(
    'div',
    { class: 'rel' },
    h('span', { class: 'mk t' }, clockLabel(chunk.capturedAtRange.end)),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, chunk.text),
      h('span', { class: 'why' }, meta),
    ),
  )
}

/** The stt slot line — the CURRENT config, explicitly NOT a per-chunk claim (the #65 disclosure follows). */
const slotRow = (sttSlot: SttSlotEndpoint[]): VNode => {
  const desc =
    sttSlot.length === 0
      ? 'none configured'
      : sttSlot.map((e) => (e.model !== undefined && e.model !== '' ? `${e.endpoint} · ${e.model}` : e.endpoint)).join(' , ')
  return h(
    'div',
    { class: 'rel slot' },
    h('span', { class: 'mk q' }, '⚙'),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, `stt slot · ${desc}`),
      h('span', { class: 'why' }, 'the current stt slot — NOT which endpoint served each chunk (per-chunk stt provenance is not recorded, #65)'),
    ),
  )
}

/** The retention disclosure: the ring is a recent-feed glance, not a log — last N, ephemeral, not persisted. */
const retentionRow = (ringLimit: number): VNode =>
  h(
    'div',
    { class: 'rel note' },
    h('span', { class: 'mk q' }, 'ⓘ'),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, `live feed · last ${ringLimit}, this session, not persisted`),
      h('span', { class: 'why' }, 'transcript chunks are the ephemeral fast-path (#58); the durable stream is the distillate block'),
    ),
  )

const emptyRow = (): VNode =>
  h(
    'div',
    { class: 'rel' },
    h('span', { class: 'mk t' }, '—'),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, 'no transcript chunks yet — start a session'),
      h('span', { class: 'why' }, 'chunks appear here the instant audio is transcribed (mic/system-audio)'),
    ),
  )

const unavailableRow = (): VNode =>
  h(
    'div',
    { class: 'rel' },
    h('span', { class: 'mk t' }, '—'),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, 'Transcription inspector unavailable'),
      h('span', { class: 'why' }, 'the engine is not reporting the transcript ring right now'),
    ),
  )

export const renderTranscriptInspector: BlockRenderer = ({ block, result }) => {
  if (block.collapsed) return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, LABEL))
  const snapshot = (result?.items ?? [])[0] as TranscriptInspector | undefined
  if (snapshot === undefined) return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, LABEL), unavailableRow())
  const all = snapshot.chunks
  const chunks = block.top !== undefined ? all.slice(0, block.top) : all
  const chunkRows: VNode[] = chunks.length > 0 ? chunks.map((c) => chunkRow(c)) : [emptyRow()]
  return h(
    'div',
    { class: 'hgroup' },
    h('div', { class: 'glbl' }, LABEL),
    slotRow(snapshot.sttSlot),
    retentionRow(snapshot.ringLimit),
    ...chunkRows,
  )
}
