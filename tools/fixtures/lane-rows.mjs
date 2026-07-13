import { validateFixture } from './model.mjs'

/**
 * Project a loaded pipeline fixture into the three canonical live-sense lane rows — the fixture's own
 * ground truth expressed in the exact closed metadata shape that `GET /senses/live` and the `live-senses`
 * `POST /query` source serve.
 *
 * This is deliberately shared across the package boundary so both halves of the #174 "distinguishable end
 * to end" proof agree on the SAME rows, extracted from the fixture rather than hand-authored:
 *   - the engine replay test (apps/engine/src/senses/live-replay.test.ts) drives replayed capture/STT/OCR
 *     through the REAL transcribe + ScreenOcrProcessor stages into the REAL SenseLaneTracker and asserts
 *     its snapshotSet — the exact projection both read paths return — deep-equals these rows;
 *   - the client surface test (apps/client/src/surfaces/blocks/sense-lanes-replay.test.ts) renders these
 *     same rows through the REAL sanitizeSenseLaneSnapshot + renderSenseLanes.
 * The client never imports engine code (it depends only on @openinfo/contracts); this fixture-derived
 * projection is the shared, proven-canonical bridge between the two.
 *
 * The completion clock matches the replay clock on purpose: every real consumer stamps its
 * processing-completion time with the injected deterministic `now` (= fixture.replay.at), so completedAt is
 * replay.at and lag is replay.at − capturedAt per lane. Fixture v1 models exactly one terminal result per
 * lane (mic→STT, system-audio→STT, screen→OCR), so each lane resolves to a `processed` disposition.
 */

const AUDIO = /^audio\//i
const IMAGE = /^image\//i

const lagMs = (capturedAt, completedAt) => Math.max(0, Date.parse(completedAt) - Date.parse(capturedAt))

const processedLane = (source, capture, completedAt) => ({
  workspaceId: capture.workspaceId,
  sessionId: capture.sessionId,
  source,
  disposition: 'processed',
  health: 'healthy',
  reason: 'processed',
  updatedAt: completedAt,
  latestCapture: { id: capture.id, capturedAt: capture.capturedAt },
  latestProcessing: {
    captureId: capture.id,
    capturedAt: capture.capturedAt,
    completedAt,
    outcome: 'processed',
    lagMs: lagMs(capture.capturedAt, completedAt),
    basis: 'capture-to-processing-completion',
  },
})

/** Canonical mic → system-audio → screen rows for the tri-lane fixture. Throws if any lane is incomplete. */
export function senseLaneRowsFromFixture(fixture) {
  const valid = validateFixture(fixture)
  const completedAt = valid.replay.at
  const captures = valid.entries.filter((entry) => entry.kind === 'capture')
  const audioCapture = (lane) => {
    const found = captures.find((entry) => entry.lane === lane && AUDIO.test(entry.value.contentType))
    if (!found) throw new Error(`fixture has no ${lane} audio capture`)
    return found.value
  }
  const screenEntry = captures.find((entry) => entry.lane === 'screen' && IMAGE.test(entry.value.contentType))
  if (!screenEntry) throw new Error('fixture has no screen image capture')
  const requireResult = (kind, captureId) => {
    if (!valid.entries.some((entry) => entry.kind === kind && entry.inputIds?.includes(captureId))) {
      throw new Error(`fixture capture ${captureId} has no terminal ${kind} result`)
    }
  }
  const mic = audioCapture('mic')
  const system = audioCapture('system-audio')
  const screen = screenEntry.value
  requireResult('stt', mic.id)
  requireResult('stt', system.id)
  requireResult('ocr', screen.id)
  return [
    processedLane('mic', mic, completedAt),
    processedLane('system-audio', system, completedAt),
    processedLane('screen', screen, completedAt),
  ]
}
