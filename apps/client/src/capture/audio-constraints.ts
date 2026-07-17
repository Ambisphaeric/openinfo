/**
 * The MIC getUserMedia audio constraints — pure, so the CHOICE is unit-tested without a Chromium renderer
 * (the capture-renderer itself is not in the CI unit set; see its header). Mic capture is `me`, and with the
 * system-audio tap live (#142) a loud speaker plays the far side into the room, where the physical mic picks
 * it up as bleed — the phantom `mic · me` twins the engine echo-dedupe then has to clean up. These
 * constraints are the CAPTURE-SIDE half of that fix (the honest one-liners), each justified against that
 * diagnosis:
 *
 *   - echoCancellation: true  — KEEP. Chromium AEC subtracts the KNOWN far-end (the system playback) from the
 *     mic signal; it is the first line of defence against speaker bleed and stays on. (PHASE2 assumed AEC
 *     alone was "enough"; it was never hardware-validated, hence the two changes below.)
 *   - autoGainControl: false  — was UNSET on the mic path, so Chromium's default (AGC ON) applied and
 *     AMPLIFIED quiet room bleed UP toward speech level, defeating both AEC and the engine dedupe. Pinned OFF
 *     so bleed stays quiet instead of being boosted into a transcribable phantom line.
 *   - voiceIsolation: true    — request the platform voice-isolation filter, which attenuates non-voice and
 *     far-field (speaker) energy beyond what AEC removes. NON-BASELINE: only requested where the runtime
 *     advertises it (getSupportedConstraints), and even then it is ADVISORY — it takes effect only on
 *     platforms with low-level support and is a no-op elsewhere. Never over-constrain (no `{exact}`), so an
 *     older Chromium/Electron or an unsupported OS degrades to plain capture rather than a failed getUserMedia.
 *
 * noiseSuppression stays on (unchanged) and mono channelCount is unchanged. System-audio constraints are
 * deliberately NOT built here: that stream must faithfully carry the far end (EC/NS/AGC all OFF, no voice
 * isolation) and keeps its own inline constraints in the renderer.
 */

/**
 * The subset of MediaTrackSupportedConstraints this module feature-detects against — the shape returned by
 * `navigator.mediaDevices.getSupportedConstraints()`. Only the keys we might gate on are modelled; a missing
 * key (or an undefined dictionary, on a runtime without the API) reads as "not supported".
 */
export interface SupportedAudioConstraints {
  autoGainControl?: boolean
  echoCancellation?: boolean
  noiseSuppression?: boolean
  voiceIsolation?: boolean
}

/** The mic constraint set. `voiceIsolation` is present only when the runtime advertises support for it. */
export interface MicAudioConstraints {
  echoCancellation: true
  noiseSuppression: true
  autoGainControl: false
  channelCount: 1
  voiceIsolation?: true
}

/**
 * Build the mic getUserMedia audio constraints, feature-detecting the non-baseline `voiceIsolation` against
 * the runtime's supported-constraints dictionary. `echoCancellation`/`noiseSuppression`/`autoGainControl`
 * are baseline and always set; `voiceIsolation` is added only when advertised so capture never breaks on a
 * runtime that lacks it. Pass the result as `{ audio: micAudioConstraints(...) }`.
 */
export const micAudioConstraints = (supported?: SupportedAudioConstraints): MicAudioConstraints => {
  const constraints: MicAudioConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false,
    channelCount: 1,
  }
  if (supported?.voiceIsolation) constraints.voiceIsolation = true
  return constraints
}
