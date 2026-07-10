import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToHtml } from '../block-renderer/index.js'
import { renderLiveTranscript, streamLabel, type TranscriptLine } from './live-transcript.js'

/**
 * Stream attribution + the system-stream mute (#96). The owner's audio-pipeline decision is that the mic
 * and system-audio streams stay SEPARATE at this strip — every fragment carries its source-stream label
 * (never an undifferentiated interleave) and the system stream can be hidden without disabling capture.
 * These cover the pure render: labels, filtering, the hidden-count disclosure, and the empty states.
 */

const line = (seq: number, source: TranscriptLine['source'], text: string, at = 1_000): TranscriptLine => ({ seq, source, text, at })
const html = (lines: TranscriptLine[], over: { live?: boolean; nowMs?: number; systemMuted?: boolean } = {}): string => {
  const node = renderLiveTranscript(lines, { live: over.live ?? true, nowMs: over.nowMs ?? 1_000, systemMuted: over.systemMuted ?? false })
  return node ? renderToHtml(node) : ''
}

test('streamLabel reuses the transcript-inspector idiom — mic·me / sys·them, raw for other sources', () => {
  assert.equal(streamLabel('mic'), 'mic · me')
  assert.equal(streamLabel('system-audio'), 'sys · them')
  assert.equal(streamLabel('screen'), 'screen') // not a speech stream — labeled by raw source
})

test('every fragment is attributed to its source stream — mic and system render as distinct labelled lanes', () => {
  const out = html([line(1, 'mic', 'we should ship Thursday'), line(2, 'system-audio', 'breaking news tonight')])
  // both streams present, each carrying its own source-stream label — never a single undifferentiated line
  assert.match(out, /class="lt-line me"/)
  assert.match(out, /class="lt-line them"/)
  assert.match(out, /mic · me/)
  assert.match(out, /sys · them/)
  assert.match(out, /we should ship Thursday/)
  assert.match(out, /breaking news tonight/)
})

test('muting the system stream hides system-audio lines from the strip but keeps mic — the blend is gone', () => {
  const lines = [line(1, 'mic', 'we should ship Thursday'), line(2, 'system-audio', 'breaking news tonight'), line(3, 'mic', 'agreed')]
  const out = html(lines, { systemMuted: true })
  assert.match(out, /we should ship Thursday/) // mic stays
  assert.match(out, /agreed/)
  assert.doesNotMatch(out, /breaking news tonight/) // ambient media hidden — not interleaved into the strip
  assert.doesNotMatch(out, /class="lt-line them"/)
  // honest disclosure: how many are hidden, and that capture continues
  assert.match(out, /system audio hidden · 1 line not shown \(still captured\)/)
})

test('the mute toggle is present and reflects state — capture is never disabled, only the strip filters', () => {
  const shown = html([line(1, 'mic', 'hi')])
  assert.match(shown, /data-verb="mute-system-stream"/)
  assert.match(shown, />hide system audio</) // action offered
  const muted = html([line(1, 'mic', 'hi')], { systemMuted: true })
  assert.match(muted, /class="lt-mute on"/)
  assert.match(muted, />show system audio</) // state reflected on the button — the un-mute action
})

test('muted with ONLY system audio explains itself rather than looking empty/broken', () => {
  const out = html([line(1, 'system-audio', 'a podcast playing')], { systemMuted: true })
  assert.doesNotMatch(out, /a podcast playing/)
  assert.match(out, /only system audio right now — hidden by the mute toggle \(still captured\)/)
})

test('idle with no lines renders nothing (no dead chrome); live-but-silent explains itself', () => {
  assert.equal(html([], { live: false }), '')
  assert.match(html([], { live: true }), /listening/)
})
