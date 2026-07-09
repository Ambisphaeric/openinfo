import type { ShellCommand } from './shortcuts.js'

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

const sysAudioStatus = (input: CaptureStatusInput): SenseStatus => {
  if (input.sysAudio === 'present')
    return { sense: 'sys-audio', label: 'System audio', level: 'granted', state: 'device present', detail: 'A loopback device is present — route your call/app output through it to capture the far side. It rides the Microphone grant.' }
  if (input.sysAudio === 'missing-device')
    return { sense: 'sys-audio', label: 'System audio', level: 'missing-device', state: 'no device', detail: 'No loopback input found — install a BlackHole-class virtual device and route output through it to capture system audio.' }
  return { sense: 'sys-audio', label: 'System audio', level: 'not-determined', state: 'unknown', detail: 'Device presence is reported once capture starts (start a session).' }
}

/** Assemble the per-sense capture-status readout. Pure — mic, screen, then system-audio, in display order. */
export const captureStatuses = (input: CaptureStatusInput): SenseStatus[] => [micStatus(input), screenStatus(input), sysAudioStatus(input)]
