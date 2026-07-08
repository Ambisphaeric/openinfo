/**
 * Finding the system-audio input among the machine's audio devices — the pure matcher, so the
 * name-pattern rules are asserted headless (no electron, no navigator). The renderer enumerates
 * `navigator.mediaDevices.enumerateDevices()` (after mic permission, so labels are populated) and hands
 * the audio inputs here; the main process then opens a second MediaRecorder on the matched deviceId. The
 * user NEVER types a device name (detection-over-configuration, ARCHITECTURE §8 onboarding note): we
 * recognize the device by its label.
 *
 * Why an in-code constant, not a seeded document: this is a tiny, client-local, single-purpose list
 * (recognize a virtual-audio driver by name) that never crosses the seam and is not user-editable — the
 * same call `discover.ts::modelSizeRank` made (an in-code heuristic is the honest v0). GRADUATION PATH:
 * if this grows to several drivers users want to add (Loopback, Soundflower revivals, VB-Cable on
 * Windows) it earns a seeded, versioned document like the capability map — one match rule per driver.
 */

/** The structural subset of MediaDeviceInfo the matcher needs — keeps this file node-typed (no lib.dom). */
export interface AudioDevice {
  kind: string
  label: string
  deviceId: string
}

/**
 * Ordered, lowercased substring patterns that name a system-audio virtual INPUT, best-known first.
 * BlackHole is the v0 target (already common among meeting-recorders, installed on the dev machine).
 * The others are near-neighbours we recognize opportunistically if present — never installed by us.
 */
export const SYSTEM_AUDIO_PATTERNS: readonly string[] = ['blackhole', 'existential audio', 'loopback audio', 'soundflower']

/**
 * Pick the system-audio input device from an enumerated device list, or `undefined` if none is present.
 * Considers only `audioinput` devices with a real deviceId (a labelled device before permission has no
 * usable id). Ordered by pattern preference, then by device order within a matched pattern — so the
 * result is deterministic when several candidates exist. A device whose label is empty (permission not
 * yet granted) can never match, which is correct: we only claim presence once we can actually open it.
 */
export const matchSystemAudioDevice = (devices: readonly AudioDevice[]): AudioDevice | undefined => {
  const inputs = devices.filter((d) => d.kind === 'audioinput' && d.deviceId.length > 0)
  for (const pattern of SYSTEM_AUDIO_PATTERNS) {
    const hit = inputs.find((d) => d.label.toLowerCase().includes(pattern))
    if (hit) return hit
  }
  return undefined
}
