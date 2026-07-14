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
  /**
   * #192: notified with the refused run's exact session context whenever permission denial stops this
   * source — the OS/user refusing the pre-start request, or the renderer reporting a mid-run denial. The
   * shell uses it to file the metadata-only permission-denied observation so the lane reads blocked with
   * its true reason instead of idle. Fires only when a session context exists (no session ⇒ no lane).
   */
  onDenied?: (context: CaptureContext) => void
  log?: (message: string) => void
  /**
   * Un-wedge guard (issue #41): how long to wait for the renderer's `stopped` ack after a stop before
   * force-clearing `stopping` ourselves. Without this a renderer that never received the stop (it was
   * not listening / had died) leaves `stopping` true forever, and every later start is swallowed into
   * `pendingStart` — a permanent wedge. Default 8000ms; tests drive it via the timer seam below.
   */
  stopAckTimeoutMs?: number
  /** Timer seam so the stop-ack timeout is asserted headless. Defaults to setTimeout/clearTimeout (unref'd). */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
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
  /** The armed stop-ack timeout while `stopping` (undefined otherwise) — the un-wedge guard's handle. */
  private stopTimer: unknown
  private readonly stopAckTimeoutMs: number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly deps: CaptureControllerDeps) {
    this.stopAckTimeoutMs = deps.stopAckTimeoutMs ?? 8000
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms)
        ;(t as { unref?: () => void }).unref?.() // never keep the process alive for a capture timer
        return t
      })
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  get currentState(): CaptureState {
    return this.state
  }

  /** The run that would own a segment arriving now (copy prevents callers mutating controller state). */
  get currentContext(): CaptureContext | undefined {
    return this.context ? { ...this.context } : undefined
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
      // Arm the un-wedge guard: if `stopped` never comes back (the renderer was never listening / died),
      // force-clear `stopping` and drain any queued start rather than wedging on a lost ack (issue #41).
      this.armStopTimeout()
      return
    }
    // Not capturing (idle / unavailable / denied / error): a session end just clears any such state.
    this.reset()
  }

  /**
   * A finished segment arrived from the renderer — wrap and send it while a run owns a context.
   * Returns the exact PRIMARY chunk only when `capture` resolved (direct ack or durable spool acceptance).
   * Existing audio callers ignore the additive receipt; screen uses it to avoid claiming `queued` before
   * pixels are durable. Screen also supplies `expectedContext`, atomically rejecting a frame whose async
   * grab crossed a session switch. A companion ScreenFrameMeta failure never revokes an accepted image.
   */
  async onSegment(segment: RawSegment, expectedContext?: CaptureContext): Promise<CaptureChunk | undefined> {
    if (!this.context) return undefined // no active run (stray segment after stop, or capture never started)
    // A desktop grab is async. If run A ended and run B began while pixels were pending, those old pixels
    // must be dropped — never re-tagged as B merely because B is current when the promise resumes.
    if (expectedContext && (
      this.context.sessionId !== expectedContext.sessionId ||
      this.context.workspaceId !== expectedContext.workspaceId
    )) return undefined
    // The FIRST real segment is when recording is genuinely happening — flip `starting → capturing`
    // so `● rec` lights up on real audio, not on the start intent. (No-op once already capturing.)
    if (this.state === 'starting') this.setState('capturing')
    this.updateSilence(segment) // system-audio honesty: present-but-silent vs genuinely flowing
    const runContext = this.context
    this.sequence += 1
    const primary = segmentToChunk(segment, runContext, this.sequence)
    // Reserve/build the adjacent metadata id BEFORE the network await so correlation stays explicit even
    // if another producer calls in. (The shell additionally serializes its screen ticks.) A failed image
    // may leave a harmless sequence gap; it must never emit orphan metadata.
    const companion = segment.screenMeta
      ? frameMetaToChunk(segment, runContext, ++this.sequence)
      : undefined
    const primaryAccepted = await this.sendChunk(primary)
    // Screen frames carry a companion typed descriptor (which display, pixel size, scale). Emit it as its
    // OWN adjacent `source:'screen'` utf8/json chunk (records/screen.ts) at the NEXT sequence, so the
    // image and its ScreenFrameMeta correlate by capture order. `screenMeta` is undefined for audio, so
    // this is a strict no-op on the mic/system-audio paths. Re-check context: an await above could have
    // let a stop/reset land in between (context cleared) — then there is nothing left to tag.
    if (primaryAccepted && companion && this.context === runContext) {
      await this.sendChunk(companion)
    }
    return primaryAccepted ? primary : undefined
  }

  /** Send one chunk to the engine; true means direct ack OR durable spool acceptance. */
  private async sendChunk(chunk: CaptureChunk): Promise<boolean> {
    try {
      await this.deps.capture(chunk)
      return true
    } catch (err) {
      this.deps.log?.(`[${this.deps.source}] capture was not durably accepted (direct send/spool failed): ${String(err)}`)
      return false
    }
  }

  /** The renderer confirmed capture fully stopped — clear the run and honor any queued start. */
  async onCaptureStopped(): Promise<void> {
    await this.concludeStop()
  }

  /**
   * A start could NOT be delivered to the renderer (the dispatcher exhausted its retries — issue #41).
   * Rather than sit in `starting`/`requesting` forever, drop back to idle so the tray stops claiming a
   * warming-up capture; the shell surfaces the visible fault. The session/text path is untouched.
   */
  onStartFailed(reason: string): void {
    this.deps.log?.(`[${this.deps.source}] capture start failed: ${reason} — resetting to idle`)
    this.pendingStart = undefined
    this.reset()
  }

  /**
   * Finish a stop: clear the un-wedge timer, reset the run, and drain any start queued while stopping.
   * Shared by the renderer's `stopped` ack (onCaptureStopped) and the timeout un-wedge, so both paths
   * converge identically — a queued start ALWAYS eventually runs, and `stopping` ALWAYS clears.
   */
  private async concludeStop(): Promise<void> {
    this.reset() // clears context/stopping/state and the stop timer
    if (this.pendingStart) {
      const next = this.pendingStart
      this.pendingStart = undefined
      await this.beginRun(next)
    }
  }

  private armStopTimeout(): void {
    this.clearStopTimer()
    this.stopTimer = this.setTimer(() => {
      this.stopTimer = undefined
      if (!this.stopping) return // the real ack already concluded the stop
      this.deps.log?.(
        `[${this.deps.source}] renderer never acknowledged stop in ${this.stopAckTimeoutMs}ms — force-clearing (un-wedge)`,
      )
      void this.concludeStop()
    }, this.stopAckTimeoutMs)
  }

  private clearStopTimer(): void {
    if (this.stopTimer !== undefined) {
      this.clearTimer(this.stopTimer)
      this.stopTimer = undefined
    }
  }

  /** A lifecycle/permission/device signal from the renderer (getUserMedia failed, no device, etc.). */
  onStatus(status: CaptureStatus): void {
    // Any terminal-ish renderer signal ends the run, so the un-wedge timer (if a stop was in flight) is
    // no longer needed — clear it rather than let it fire concludeStop on an already-reset controller.
    if (status.state === 'permission-denied' || status.state === 'no-device' || status.state === 'error') {
      this.clearStopTimer()
    }
    if (status.state === 'permission-denied') {
      const denied = this.context
      this.context = undefined
      this.stopping = false
      this.setState('denied')
      this.deps.log?.(`[${this.deps.source}] renderer reported permission denied — capture disabled (session unaffected)`)
      if (denied) this.deps.onDenied?.({ ...denied })
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
      this.deps.log?.(`[${this.deps.source}] capture access denied — capture disabled, session continues (text path unaffected)`)
      this.deps.onDenied?.({ ...context })
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
    this.clearStopTimer()
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
