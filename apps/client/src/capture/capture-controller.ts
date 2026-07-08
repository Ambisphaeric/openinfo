import type { CaptureChunk } from '@openinfo/contracts'
import { segmentToChunk, frameMetaToChunk, type CaptureContext } from './chunk.js'
import type { CaptureSourceKind, CaptureStatus, RawSegment } from './protocol.js'

/**
 * The per-source capture lifecycle brain — pure and electron-free so the whole state machine (session
 * started → permission → capturing → session ended → flush the final segment → idle, plus the denial
 * and no-device paths) is asserted headless. The shell (shell.ts) owns the electron edges (the ONE
 * hidden capture window, systemPreferences, EngineLink) and feeds each controller the events; nothing
 * here imports electron, so CI never loads a display.
 *
 * ONE instance per source. `mic` ("me") and `system-audio` ("them") each get their own controller wired
 * to the same hidden renderer over source-tagged IPC (protocol.ts). The mic path is unchanged from the
 * mic-only slice; system-audio RHYMES with it (same lifecycle, same chunk shape, same EngineLink) and
 * differs only in two source-scoped behaviours below (`unavailable` + silence), both no-ops for mic.
 *
 * Privacy default: capture strictly follows the session lifecycle the tray already controls. No session
 * live ⇒ nothing is captured. The session IS the consent gesture (see config.ts).
 *
 * Recording-indicator honesty (see PHASE2-NOTES): granting permission + telling the renderer to start
 * does NOT mean audio is flowing yet. So the machine distinguishes `starting` (told to start, no segment
 * yet) from `capturing` (the first real segment arrived). The tray's `● rec` reflects `capturing` ONLY.
 *
 * System-audio honesty (design note): a BlackHole-like input with no output routed through it emits pure
 * DIGITAL SILENCE (the common not-yet-set-up state). The renderer flags such segments (`silent`) and the
 * controller surfaces it via `onSilence` so the tray/log can say "present but silent" instead of pretending
 * to record the room. The absence of the device entirely is the `unavailable` state (a benign not-error).
 */

export type CaptureState =
  | 'idle' // no session / not capturing
  | 'requesting' // asking the OS for audio permission
  | 'starting' // permission granted, renderer told to start — waiting for the first real segment
  | 'capturing' // the first segment arrived: audio is genuinely flowing (drives ● rec)
  | 'unavailable' // this source has no capturable input on this machine (system-audio: no BlackHole) — benign
  | 'denied' // the OS (or the user) refused audio access — capture disabled, session unaffected
  | 'error' // the renderer reported a capture error — capture stopped, session unaffected

export interface CaptureControllerDeps {
  /** Which stream this controller drives — tags every chunk and every control/IPC message. */
  source: CaptureSourceKind
  /** Send a chunk to the engine — EngineLink.capture, which POSTs `/capture/<source>` or spools offline (never throws fatally). */
  capture: (chunk: CaptureChunk) => Promise<unknown>
  /** Drive the hidden capture renderer for THIS source: start begins the getUserMedia loop, stop flushes + ends it. */
  control: { start(): void; stop(): void }
  /** Ask the OS for audio access before the first capture (systemPreferences.askForMediaAccess). */
  requestPermission: () => Promise<boolean>
  /** Whether this source's capture is enabled at all (client-local config; default ON — see config.ts). */
  enabled: boolean
  /** Notified on every state transition so the shell can repaint the tray (● rec / blocked / mic+system). */
  onStateChange?: (state: CaptureState) => void
  /**
   * Notified when the silence signal flips (system-audio only): `true` on the first silent segment while
   * capturing (device present but nothing routed), `false` the first time real audio is heard. Fires at
   * most once per direction per run, so the shell can log/tooltip once without spamming.
   */
  onSilence?: (silent: boolean) => void
  log?: (message: string) => void
}

export class CaptureController {
  private state: CaptureState = 'idle'
  private context: CaptureContext | undefined
  private sequence = 0
  /** True between session-end and the renderer confirming it stopped — we still accept the final segment. */
  private stopping = false
  /** A start that arrived while a previous run was still flushing (auto-end → immediate restart). */
  private pendingStart: CaptureContext | undefined
  /** Silence tracking (system-audio only): the last emitted silence signal (undefined = not yet decided). */
  private silentSignal: boolean | undefined
  /** Once real audio is heard in a run, we never revert to "silent" for that run. */
  private heardAudio = false

  constructor(private readonly deps: CaptureControllerDeps) {}

  get currentState(): CaptureState {
    return this.state
  }

  /** A session went live — begin capturing under its ids (unless disabled or a run is still flushing). */
  async onSessionStarted(context: CaptureContext): Promise<void> {
    if (!this.deps.enabled) {
      this.deps.log?.(`[${this.deps.source}] capture disabled by config — not starting`)
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
    // Both `starting` and `capturing` mean the renderer was told to start (it holds an open stream),
    // so either way we must stop it — even if the first segment never arrived (a very short session).
    if ((this.state === 'capturing' || this.state === 'starting') && this.context) {
      this.stopping = true
      this.deps.control.stop() // renderer emits its last segment, then `stopped` → onCaptureStopped
      return
    }
    // Not capturing (idle / unavailable / denied / error): a session end just clears any such state.
    this.reset()
  }

  /** A finished segment arrived from the renderer — wrap and send it while a run owns a context. */
  async onSegment(segment: RawSegment): Promise<void> {
    if (!this.context) return // no active run (stray segment after stop, or capture never started)
    // The FIRST real segment is when recording is genuinely happening — flip `starting → capturing`
    // so `● rec` lights up on real audio, not on the start intent. (No-op once already capturing.)
    if (this.state === 'starting') this.setState('capturing')
    this.updateSilence(segment) // system-audio honesty: present-but-silent vs genuinely flowing
    this.sequence += 1
    await this.sendChunk(segmentToChunk(segment, this.context, this.sequence))
    // Screen frames carry a companion typed descriptor (which display, pixel size, scale). Emit it as its
    // OWN adjacent `source:'screen'` utf8/json chunk (records/screen.ts) at the NEXT sequence, so the
    // image and its ScreenFrameMeta correlate by capture order. `screenMeta` is undefined for audio, so
    // this is a strict no-op on the mic/system-audio paths. Re-check context: an await above could have
    // let a stop/reset land in between (context cleared) — then there is nothing left to tag.
    if (segment.screenMeta && this.context) {
      this.sequence += 1
      await this.sendChunk(frameMetaToChunk(segment, this.context, this.sequence))
    }
  }

  /** Send one chunk to the engine — EngineLink spools on POST failure, so this never throws fatally. */
  private async sendChunk(chunk: CaptureChunk): Promise<void> {
    try {
      await this.deps.capture(chunk)
    } catch (err) {
      this.deps.log?.(`[${this.deps.source}] capture send failed (will spool): ${String(err)}`)
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

  /** A lifecycle/permission/device signal from the renderer (getUserMedia failed, no device, etc.). */
  onStatus(status: CaptureStatus): void {
    if (status.state === 'permission-denied') {
      this.context = undefined
      this.stopping = false
      this.setState('denied')
      this.deps.log?.(`[${this.deps.source}] renderer reported permission denied — capture disabled (session unaffected)`)
    } else if (status.state === 'no-device') {
      // Benign absence, NOT an error: the machine has no capturable input for this source (system-audio
      // with no BlackHole-like device). Capture just doesn't happen; the session/text path is untouched.
      this.context = undefined
      this.stopping = false
      this.setState('unavailable')
      this.deps.log?.(`[${this.deps.source}] no capturable device — capturing without it (install + route a virtual audio device to add it)`)
    } else if (status.state === 'error') {
      this.context = undefined
      this.stopping = false
      this.setState('error')
      this.deps.log?.(`[${this.deps.source}] renderer capture error: ${status.detail}`)
    }
    // 'ready' is informational — capture is already driven by the session lifecycle.
  }

  /** App is quitting mid-capture — tell the renderer to stop cleanly (best-effort, no await). */
  shutdown(): void {
    this.pendingStart = undefined
    if (this.state === 'capturing' || this.state === 'starting') this.deps.control.stop()
    this.reset()
  }

  private async beginRun(context: CaptureContext): Promise<void> {
    this.setState('requesting')
    let granted: boolean
    try {
      granted = await this.deps.requestPermission()
    } catch (err) {
      this.deps.log?.(`[${this.deps.source}] permission request threw: ${String(err)}`)
      granted = false
    }
    if (!granted) {
      this.setState('denied')
      this.deps.log?.(`[${this.deps.source}] audio access denied — capture disabled, session continues (text path unaffected)`)
      return
    }
    this.context = context
    this.sequence = 0
    this.stopping = false
    this.silentSignal = undefined
    this.heardAudio = false
    // `starting`, NOT `capturing`: the renderer is told to start, but no audio has flowed yet. The
    // first segment (onSegment) promotes us to `capturing` — that is when ● rec honestly lights up.
    this.setState('starting')
    this.deps.control.start()
  }

  /**
   * System-audio honesty. When the renderer flags a segment's silence, surface the FIRST silent segment
   * (device present, nothing routed) and the FIRST time real audio is heard — at most once each per run,
   * so the shell logs/tooltips once. Mic segments carry no `silent` flag, so this is a strict no-op for
   * the mic path (behaviour byte-identical to the mic-only slice).
   */
  private updateSilence(segment: RawSegment): void {
    if (segment.silent === undefined || this.heardAudio) return
    if (segment.silent) {
      if (this.silentSignal !== true) {
        this.silentSignal = true
        this.deps.onSilence?.(true)
        this.deps.log?.(`[${this.deps.source}] device present but only silence so far — route your call/app output through it (or wear headphones)`)
      }
    } else {
      this.heardAudio = true
      this.silentSignal = false
      this.deps.onSilence?.(false)
      this.deps.log?.(`[${this.deps.source}] audio is now flowing`)
    }
  }

  private reset(): void {
    this.context = undefined
    this.sequence = 0
    this.stopping = false
    this.silentSignal = undefined
    this.heardAudio = false
    if (this.state !== 'idle') this.setState('idle')
  }

  private setState(next: CaptureState): void {
    if (next === this.state) return
    this.state = next
    this.deps.onStateChange?.(next)
  }
}
