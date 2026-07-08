import type { CaptureChunk } from '@openinfo/contracts'
import { segmentToChunk, type CaptureContext } from './chunk.js'
import type { MicStatus, RawSegment } from './protocol.js'

/**
 * The mic-capture lifecycle brain — pure and electron-free so the whole state machine (session
 * started → permission → capturing → session ended → flush the final segment → idle, plus the
 * denial path) is asserted headless. The shell (shell.ts) owns the electron edges (the hidden
 * capture window, systemPreferences, EngineLink) and feeds this controller the events; nothing here
 * imports electron, so CI never loads a display.
 *
 * Privacy default: capture strictly follows the session lifecycle the tray already controls. No
 * session live ⇒ nothing is captured. The session IS the consent gesture (see config.ts), so on a
 * session start we start the mic; on end we stop it and flush whatever segment was in flight.
 */

export type MicState =
  | 'idle' // no session / not capturing
  | 'requesting' // asking the OS for mic permission
  | 'capturing' // a session is live and segments are flowing
  | 'denied' // the OS (or the user) refused mic access — capture disabled, session unaffected
  | 'error' // the renderer reported a capture error — capture stopped, session unaffected

export interface MicControllerDeps {
  /** Send a chunk to the engine — EngineLink.capture, which POSTs or spools offline (never throws fatally). */
  capture: (chunk: CaptureChunk) => Promise<unknown>
  /** Drive the hidden capture renderer: start begins the getUserMedia loop, stop flushes + ends it. */
  control: { start(): void; stop(): void }
  /** Ask the OS for mic access before the first capture (systemPreferences.askForMediaAccess). */
  requestPermission: () => Promise<boolean>
  /** Whether mic capture is enabled at all (client-local config; default ON — see config.ts). */
  enabled: boolean
  /** Notified on every state transition so the shell can repaint the tray (● rec / mic blocked). */
  onStateChange?: (state: MicState) => void
  log?: (message: string) => void
}

export class MicCaptureController {
  private state: MicState = 'idle'
  private context: CaptureContext | undefined
  private sequence = 0
  /** True between session-end and the renderer confirming it stopped — we still accept the final segment. */
  private stopping = false
  /** A start that arrived while a previous run was still flushing (auto-end → immediate restart). */
  private pendingStart: CaptureContext | undefined

  constructor(private readonly deps: MicControllerDeps) {}

  get currentState(): MicState {
    return this.state
  }

  /** A session went live — begin capturing under its ids (unless disabled or a run is still flushing). */
  async onSessionStarted(context: CaptureContext): Promise<void> {
    if (!this.deps.enabled) {
      this.deps.log?.('[mic] capture disabled by config — not starting')
      return
    }
    // A previous run is still flushing its final segment; queue this start until it confirms stopped,
    // so the old session's last segment is never mis-tagged with the new session's ids.
    if (this.stopping) {
      this.pendingStart = context
      return
    }
    await this.beginRun(context)
  }

  /** The session ended — stop the renderer; the final in-flight segment still flows in under the old ids. */
  onSessionEnded(): void {
    this.pendingStart = undefined
    if (this.state === 'capturing' && this.context) {
      this.stopping = true
      this.deps.control.stop() // renderer emits its last segment, then `stopped` → onCaptureStopped
      return
    }
    // Not capturing (idle / denied / error): a session end just clears any non-capturing state.
    this.reset()
  }

  /** A finished segment arrived from the renderer — wrap and send it while a run owns a context. */
  async onSegment(segment: RawSegment): Promise<void> {
    if (!this.context) return // no active run (stray segment after stop, or capture never started)
    this.sequence += 1
    const chunk = segmentToChunk(segment, this.context, this.sequence)
    try {
      await this.deps.capture(chunk) // EngineLink spools on POST failure — this never throws fatally
    } catch (err) {
      this.deps.log?.(`[mic] capture send failed (will spool): ${String(err)}`)
    }
  }

  /** The renderer confirmed capture fully stopped — clear the run and honor any queued start. */
  async onCaptureStopped(): Promise<void> {
    this.reset()
    if (this.pendingStart) {
      const next = this.pendingStart
      this.pendingStart = undefined
      await this.beginRun(next)
    }
  }

  /** A lifecycle/permission signal from the renderer (getUserMedia failed, etc.). */
  onStatus(status: MicStatus): void {
    if (status.state === 'permission-denied') {
      this.context = undefined
      this.stopping = false
      this.setState('denied')
      this.deps.log?.('[mic] renderer reported permission denied — capture disabled (session unaffected)')
    } else if (status.state === 'error') {
      this.context = undefined
      this.stopping = false
      this.setState('error')
      this.deps.log?.(`[mic] renderer capture error: ${status.detail}`)
    }
    // 'ready' is informational — capture is already driven by the session lifecycle.
  }

  /** App is quitting mid-capture — tell the renderer to stop cleanly (best-effort, no await). */
  shutdown(): void {
    this.pendingStart = undefined
    if (this.state === 'capturing') this.deps.control.stop()
    this.reset()
  }

  private async beginRun(context: CaptureContext): Promise<void> {
    this.setState('requesting')
    let granted: boolean
    try {
      granted = await this.deps.requestPermission()
    } catch (err) {
      this.deps.log?.(`[mic] permission request threw: ${String(err)}`)
      granted = false
    }
    if (!granted) {
      this.setState('denied')
      this.deps.log?.('[mic] microphone access denied — capture disabled, session continues (text path unaffected)')
      return
    }
    this.context = context
    this.sequence = 0
    this.stopping = false
    this.setState('capturing')
    this.deps.control.start()
  }

  private reset(): void {
    this.context = undefined
    this.sequence = 0
    this.stopping = false
    if (this.state !== 'idle') this.setState('idle')
  }

  private setState(next: MicState): void {
    if (next === this.state) return
    this.state = next
    this.deps.onStateChange?.(next)
  }
}
