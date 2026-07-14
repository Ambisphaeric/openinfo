import type { ShellCommand } from './shortcuts.js'
import type { SystemAudioMethod } from '../capture/protocol.js'

/**
 * The capture-permission readout — a pure mapping from raw OS state (macOS TCC media-access statuses +
 * whether a system-audio loopback device is present) to an honest, debuggable per-sense status the tray
 * renders. The user asked to be able to "debug here": for each sense (mic / screen / system-audio) it says
 * plainly what the OS state is, what to do about it, and — where the OS won't pop a prompt — links the exact
 * System Settings pane with honest relaunch copy.
 *
 * Pure and electron-free: the shell (shell.ts) reads systemPreferences.getMediaAccessStatus + the capture
 * controllers' device state and feeds those primitives here, so the whole mapping is asserted headless (the
 * tray itself renders in the main process, so no renderer IPC bridge is needed — the status is assembled
 * from state the main process already holds).
 *
 * macOS TCC reality drives the copy (see the slice brief): mic HAS an app-triggerable popup; screen
 * recording does NOT (a System-Settings flip + a relaunch), and system-audio is not a TCC gate at all but a
 * device-presence question (a BlackHole-class loopback input rides the one Microphone grant when present).
 */

/** Electron's systemPreferences.getMediaAccessStatus return set (plus 'unknown' for the non-mac/no-answer case). */
export type MediaAccessStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'

/** System-audio is device presence, not a permission: present ⇒ a loopback input exists; missing-device ⇒ none. */
export type SysAudioPresence = 'present' | 'missing-device' | 'unknown'

/** The three senses the readout covers, in display order. */
export type Sense = 'mic' | 'screen' | 'sys-audio'

/** A normalized per-sense state used for the dot + colour (independent of the sense's specific copy). */
export type SenseLevel = 'granted' | 'denied' | 'not-determined' | 'missing-device' | 'unsupported'

export interface SenseStatus {
  sense: Sense
  /** Human sense name for the readout line ("Microphone", "Screen recording", "System audio"). */
  label: string
  /** The normalized state (drives the dot). */
  level: SenseLevel
  /** A short state word shown after the label ("granted", "denied", "not yet asked", "no device"). */
  state: string
  /** Honest one-line "what this means / what to do", including relaunch-after-grant cases. */
  detail: string
  /** When actionable, the command the tray fires to open the right System Settings pane. */
  fixCommand?: ShellCommand
  /**
   * The FIRST closed gate blocking this sense end-to-end (issue #7) — the single named reason a sense is
   * silently producing nothing, across the whole mic → capture → STT/OCR chain (sense toggled off, OS
   * permission, engine unreachable, no live session, then the engine-side processing gates). Undefined
   * when nothing is blocking. This is what keeps a sense from ever reading as a bare "off" with no reason.
   */
  blocking?: SenseBlock
}

/** A named blocking gate + its one-step fix — the short-form "why this sense is dead" the tray shows. */
export interface SenseBlock {
  /** stable gate id ('sense-off' | 'os-permission' | 'engine-unreachable' | 'no-session' | an engine gate id) */
  gate: string
  /** short human line naming the blocker */
  reason: string
  /** the single "what to do" step, when there is one */
  fix?: string
  /** a Settings-pane command when the fix is a one-click OS flip (the OS-permission gate). */
  fixCommand?: ShellCommand
}

/**
 * The engine-side verdict for ONE sense, as GET /senses reports it (issue #7). The client cannot see the
 * engine's flags/slots/endpoint-health, so the shell fetches this and threads it in; the composer chains
 * it AFTER the client-side gates. Only the fields the readout needs are modelled (no engine import).
 */
export interface EngineSenseVerdict {
  sense: Sense
  blocking?: { id: string; label: string; fix?: string }
}

/** Engine events that can change the derived GET /senses gate chain and therefore invalidate the tray cache. */
export const invalidatesEngineSenseGates = (eventName: string): boolean =>
  eventName === 'flag.changed' || eventName === 'fabric.changed' || eventName === 'workflow.updated'

/**
 * Small latest-request-wins cache for GET /senses. Invalidating clears the old verdict immediately;
 * an older, slower request can never overwrite a newer result after back-to-back WS edits.
 */
export class EngineSenseGateCache {
  private revision = 0
  private gates: EngineSenseVerdict[] | undefined

  current(): EngineSenseVerdict[] | undefined {
    return this.gates
  }

  begin(): number {
    this.gates = undefined
    return ++this.revision
  }

  succeed(revision: number, gates: EngineSenseVerdict[]): boolean {
    if (revision !== this.revision) return false
    this.gates = gates
    return true
  }

  fail(revision: number): boolean {
    if (revision !== this.revision) return false
    this.gates = undefined
    return true
  }
}

export interface CaptureStatusInput {
  /** process.platform — only 'darwin' has the TCC gates this readout describes. */
  platform: string
  /** systemPreferences.getMediaAccessStatus('microphone'); undefined off macOS. */
  micAccess?: MediaAccessStatus
  /** systemPreferences.getMediaAccessStatus('screen'); undefined off macOS. */
  screenAccess?: MediaAccessStatus
  /** Whether a system-audio loopback device is present (the capture renderer reports 'no-device'). */
  sysAudio: SysAudioPresence
  /** Whether screen capture is enabled at all (cfg.screenEnabled — opt-in, default OFF). */
  screenEnabled: boolean
  /** Whether the mic sense is enabled in client config (cfg.micEnabled). Undefined ⇒ treated as on. */
  micEnabled?: boolean
  /** Whether the system-audio sense is enabled in client config (cfg.systemAudioEnabled). Undefined ⇒ on. */
  systemAudioEnabled?: boolean
  /**
   * HOW system audio is opened (#142): `loopback` (Chromium CoreAudio-Tap — no routing, rides the Screen-&-
   * System-Audio-Recording grant) or `device` (a BlackHole-class virtual input). Drives which fix the
   * readout names. Undefined ⇒ treated as `device` (the historical BlackHole copy).
   */
  systemAudioMethod?: SystemAudioMethod
  /** Whether the engine is currently reachable (shell `connected`). Undefined ⇒ unknown (not asserted). */
  engineReachable?: boolean
  /** Whether a session is live (nothing captures without one). Undefined ⇒ unknown (not asserted). */
  sessionLive?: boolean
  /** The engine-side per-sense verdicts (GET /senses) — chained after the client gates. Undefined when unreachable/unfetched. */
  engineGates?: EngineSenseVerdict[]
}

/** Map a raw media-access status to the normalized level (restricted reads as denied — both block, both need a flip). */
const levelOf = (status: MediaAccessStatus | undefined): SenseLevel => {
  switch (status) {
    case 'granted':
      return 'granted'
    case 'denied':
    case 'restricted':
      return 'denied'
    case 'not-determined':
      return 'not-determined'
    default:
      return 'unsupported' // 'unknown' or absent (non-macOS)
  }
}

const micStatus = (input: CaptureStatusInput): SenseStatus => {
  const level = levelOf(input.micAccess)
  if (level === 'granted') return { sense: 'mic', label: 'Microphone', level, state: 'granted', detail: 'openinfo can record the mic.' }
  if (level === 'denied')
    return {
      sense: 'mic',
      label: 'Microphone',
      level,
      state: 'denied',
      detail: 'Access was refused — a session runs without mic audio until you re-grant it. Open System Settings › Privacy › Microphone.',
      fixCommand: 'open-mic-settings',
    }
  if (level === 'not-determined')
    return { sense: 'mic', label: 'Microphone', level, state: 'not yet asked', detail: 'macOS will show the mic popup at first launch (or when a session starts). Allow it to record.' }
  return { sense: 'mic', label: 'Microphone', level, state: 'n/a', detail: 'Governed by the browser permission handler on this platform.' }
}

const screenStatus = (input: CaptureStatusInput): SenseStatus => {
  const level = levelOf(input.screenAccess)
  // Screen is opt-in (default off); the enable note rides every non-granted line so the readout shows the enable path.
  const optIn = input.screenEnabled ? '' : ' Screen capture is off by default — enable it in client config (screenEnabled), too.'
  if (level === 'granted')
    return {
      sense: 'screen',
      label: 'Screen recording',
      level,
      state: input.screenEnabled ? 'granted' : 'granted · capture off',
      detail: input.screenEnabled ? 'openinfo can read the screen.' : 'Permission is granted, but screen capture is off by default — enable it in client config (screenEnabled).',
    }
  if (level === 'denied')
    return {
      sense: 'screen',
      label: 'Screen recording',
      level,
      state: 'denied',
      detail: 'macOS has no in-app popup for this — flip it in System Settings › Privacy › Screen Recording, then RELAUNCH openinfo.' + optIn,
      fixCommand: 'open-screen-settings',
    }
  if (level === 'not-determined')
    return {
      sense: 'screen',
      label: 'Screen recording',
      level,
      state: 'not granted',
      detail: 'There is no in-app prompt for screen recording — enable openinfo in System Settings › Privacy › Screen Recording, then RELAUNCH.' + optIn,
      fixCommand: 'open-screen-settings',
    }
  return { sense: 'screen', label: 'Screen recording', level, state: 'n/a', detail: 'Governed by the OS on this platform.' }
}

/**
 * System-audio readout (#142) — the copy depends on the OPEN METHOD. `loopback` is the no-routing macOS
 * default (Chromium CoreAudio-Tap): present ⇒ it is capturing with no device to install; "missing" ⇒ the
 * tap yielded nothing (recording grant / plist absent, or unsupported) → grant Screen & System Audio
 * Recording and relaunch (one-click), or fall back to a virtual device. `device` keeps the BlackHole
 * detect-and-guide copy. Either way the honesty floor is the silence probe: a present-but-silent stream is
 * surfaced elsewhere, never faked.
 */
const sysAudioStatus = (input: CaptureStatusInput): SenseStatus => {
  const loopback = input.systemAudioMethod === 'loopback'
  if (input.sysAudio === 'present')
    return {
      sense: 'sys-audio',
      label: 'System audio',
      level: 'granted',
      state: loopback ? 'capturing (loopback)' : 'device present',
      detail: loopback
        ? 'openinfo is capturing system audio directly (no virtual device, no routing) — the far side of calls and media is recorded.'
        : 'A loopback device is present — route your call/app output through it to capture the far side. It rides the Microphone grant.',
    }
  if (input.sysAudio === 'missing-device')
    return loopback
      ? {
          sense: 'sys-audio',
          label: 'System audio',
          level: 'missing-device',
          state: 'not available',
          detail: 'System-audio recording is not available — grant openinfo Screen & System Audio Recording in System Settings, then RELAUNCH. (Or set systemAudioMethod=device to use a BlackHole-class virtual input instead.)',
          fixCommand: 'open-screen-settings',
        }
      : { sense: 'sys-audio', label: 'System audio', level: 'missing-device', state: 'no device', detail: 'No loopback input found — install a BlackHole-class virtual device and route output through it to capture system audio.' }
  return { sense: 'sys-audio', label: 'System audio', level: 'not-determined', state: 'unknown', detail: 'System-audio state is reported once capture starts (start a session).' }
}

/** Whether this sense is toggled OFF in client config (undefined config reads as ON — the defaults). */
const senseDisabled = (sense: Sense, input: CaptureStatusInput): boolean =>
  sense === 'mic' ? input.micEnabled === false
    : sense === 'sys-audio' ? input.systemAudioEnabled === false
    : input.screenEnabled === false

/** The client-config enable path for a disabled sense (mirrors the config env keys / client.json fields). */
const enableFix = (sense: Sense): string =>
  sense === 'mic' ? 'Enable microphone capture in client config (mic / OPENINFO_MIC).'
    : sense === 'sys-audio' ? 'Enable system-audio capture in client config (systemAudio / OPENINFO_SYSTEM_AUDIO).'
    : 'Enable screen capture in client config (screen / OPENINFO_SCREEN).'

/**
 * Is the OS-permission gate closed for this sense? Reuses the already-computed SenseStatus.level so the
 * OS layer is never re-derived: mic/screen are blocked while denied or not-yet-granted; system-audio is
 * blocked only when its loopback device is missing ('unknown' is not-yet-known, not a block). 'unsupported'
 * (off-macOS) is never a block — that platform has no TCC gate here.
 */
const osBlocked = (status: SenseStatus): boolean =>
  status.sense === 'sys-audio' ? status.level === 'missing-device' : status.level === 'denied' || status.level === 'not-determined'

/**
 * Compose the single blocking gate for a sense across the WHOLE chain (issue #7), in precedence order:
 * sense toggled off → OS permission → engine unreachable → no live session → the engine-side gate
 * (processing flag off / missing stt-ocr endpoint / unhealthy endpoint, from GET /senses). The FIRST
 * closed gate wins, so the tray names exactly what to fix and no sense reads as a bare "off". Pure.
 */
const blockingFor = (status: SenseStatus, input: CaptureStatusInput): SenseBlock | undefined => {
  const sense = status.sense
  if (senseDisabled(sense, input)) return { gate: 'sense-off', reason: `${status.label} is turned off`, fix: enableFix(sense) }
  if (osBlocked(status)) return { gate: 'os-permission', reason: `${status.label} — ${status.state}`, ...(status.fixCommand ? { fixCommand: status.fixCommand } : {}), fix: status.detail }
  if (input.engineReachable === false) return { gate: 'engine-unreachable', reason: 'engine unreachable', fix: 'Start the engine (or check the engine URL).' }
  if (input.sessionLive === false) return { gate: 'no-session', reason: 'no live session', fix: 'Start a session to capture.' }
  const verdict = input.engineGates?.find((v) => v.sense === sense)
  if (verdict?.blocking) return { gate: verdict.blocking.id, reason: verdict.blocking.label, ...(verdict.blocking.fix ? { fix: verdict.blocking.fix } : {}) }
  return undefined
}

/** Attach the composed blocking gate to a base OS-permission status (pure). */
const withBlocking = (status: SenseStatus, input: CaptureStatusInput): SenseStatus => {
  const blocking = blockingFor(status, input)
  return blocking ? { ...status, blocking } : status
}

/**
 * Assemble the per-sense capture-status readout. Pure — mic, screen, then system-audio, in display order.
 * Each sense carries its OS-permission line AND (issue #7) the first gate blocking it end-to-end.
 */
export const captureStatuses = (input: CaptureStatusInput): SenseStatus[] =>
  [micStatus(input), screenStatus(input), sysAudioStatus(input)].map((s) => withBlocking(s, input))
