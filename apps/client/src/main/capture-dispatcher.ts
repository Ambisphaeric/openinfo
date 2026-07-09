import type { CaptureSourceKind } from '../capture/protocol.js'

/**
 * The renderer readiness + start-ack handshake (issue #41), pure and electron-free so the whole
 * dropped-start failure class is asserted headless (shell.ts owns the real webContents.send / IPC edges).
 *
 * THE BUG this closes: `control.start` was a bare `captureWindow?.webContents.send(...)`. Fired during
 * boot it raced the hidden capture window's ESM load; if the renderer had not yet registered its
 * `ipcRenderer.on('capture:start')` listener the send was silently dropped — no queue, no ack, no retry.
 * The controller then sat in `starting` forever and the whole capture path wedged, invisibly.
 *
 * THE FIX, as a small state machine per audio source:
 *   1. The renderer pings `loaded` on module load (BEFORE getUserMedia). Until we've heard it, a start
 *      is QUEUED, never sent — so a start can never race the renderer's listener registration.
 *   2. Once loaded, a start is SENT and we await a `start-ack` the renderer emits on receiving it.
 *   3. No ack within `ackTimeoutMs` ⇒ RESEND (up to `maxRetries`); still no ack ⇒ a VISIBLE fault
 *      (`onFault`) the shell surfaces on the tray, instead of a silent forever-`starting`.
 *   4. A renderer that dies / fails to load (`markUnloaded`) re-queues any in-flight start so it fires
 *      when the renderer comes back, and does not leave a timer dangling.
 *
 * Screen capture does NOT ride the hidden renderer (it is grabbed in the main process), so only the two
 * audio sources ever flow through here — the shell wires mic/system-audio `control` through the
 * dispatcher and leaves the screen controller on its own main-process loop.
 */

export type DispatchChannel = 'start' | 'stop'

/** An opaque timer handle — real setTimeout in the shell, a controllable fake in tests. */
export type TimerHandle = unknown

export interface CaptureDispatcherDeps {
  /** Send a control message to the renderer for one source (the real webContents.send in the shell). */
  send: (channel: DispatchChannel, source: CaptureSourceKind) => void
  /** A start could not be acknowledged after every retry — surface a VISIBLE error (tray) for this source. */
  onFault: (source: CaptureSourceKind, reason: string) => void
  /** Lifecycle log (→ the client log file). */
  log?: (message: string) => void
  /** How long to wait for a start-ack before resending. Default 1500ms. */
  ackTimeoutMs?: number
  /** How many resends before giving up into a fault. Default 3. */
  maxRetries?: number
  /** Timer seam (defaults to setTimeout/clearTimeout with unref) so timeouts are driven in tests. */
  setTimer?: (fn: () => void, ms: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
}

/** Per-source dispatch phase. `queued` = waiting for the renderer to load; `awaiting-ack` = sent, unacked. */
type Phase = 'idle' | 'queued' | 'awaiting-ack'

interface SourceState {
  phase: Phase
  attempts: number
  timer: TimerHandle | undefined
}

const defaultSetTimer = (fn: () => void, ms: number): TimerHandle => {
  const t = setTimeout(fn, ms)
  ;(t as { unref?: () => void }).unref?.() // never keep the event loop alive for a capture timer
  return t
}

export class CaptureDispatcher {
  private loaded = false
  private readonly ackTimeoutMs: number
  private readonly maxRetries: number
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle
  private readonly clearTimer: (handle: TimerHandle) => void
  private readonly sources = new Map<CaptureSourceKind, SourceState>()

  constructor(private readonly deps: CaptureDispatcherDeps) {
    this.ackTimeoutMs = deps.ackTimeoutMs ?? 1500
    this.maxRetries = deps.maxRetries ?? 3
    this.setTimer = deps.setTimer ?? defaultSetTimer
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  /** Whether the capture renderer has reported it loaded its module + registered its listeners. */
  get rendererLoaded(): boolean {
    return this.loaded
  }

  private stateFor(source: CaptureSourceKind): SourceState {
    let s = this.sources.get(source)
    if (!s) {
      s = { phase: 'idle', attempts: 0, timer: undefined }
      this.sources.set(source, s)
    }
    return s
  }

  private clear(state: SourceState): void {
    if (state.timer !== undefined) {
      this.clearTimer(state.timer)
      state.timer = undefined
    }
  }

  /** The renderer pinged that it loaded and registered its listeners — flush any queued starts. */
  markLoaded(): void {
    if (!this.loaded) this.deps.log?.('[capture] renderer loaded — start commands will be delivered')
    this.loaded = true
    for (const [source, state] of this.sources) {
      if (state.phase === 'queued') this.dispatchStart(source, state)
    }
  }

  /** The renderer died or failed to load — re-queue any in-flight start and drop timers (no silent drop). */
  markUnloaded(reason: string): void {
    this.loaded = false
    this.deps.log?.(`[capture] renderer unavailable (${reason}) — queued starts will re-fire when it reloads`)
    for (const state of this.sources.values()) {
      this.clear(state)
      // Anything we were driving becomes queued again so it is honoured once the renderer returns.
      if (state.phase === 'awaiting-ack') {
        state.phase = 'queued'
        state.attempts = 0
      }
    }
  }

  /** Request that the renderer start a source. Queued until loaded, then sent + ack-tracked. */
  requestStart(source: CaptureSourceKind): void {
    const state = this.stateFor(source)
    this.clear(state)
    state.attempts = 0
    if (!this.loaded) {
      state.phase = 'queued'
      this.deps.log?.(`[capture] ${source} start queued — renderer not ready yet`)
      return
    }
    this.dispatchStart(source, state)
  }

  /** Request that the renderer stop a source. Cancels any pending start; the stop itself needs no ack here */
  /** (the controller's onCaptureStopped/stop-timeout owns that side). */
  requestStop(source: CaptureSourceKind): void {
    const state = this.stateFor(source)
    this.clear(state)
    state.phase = 'idle'
    state.attempts = 0
    this.deps.send('stop', source)
  }

  /** The renderer acknowledged it received the start command — the send was NOT dropped. */
  ackStart(source: CaptureSourceKind): void {
    const state = this.stateFor(source)
    if (state.phase !== 'awaiting-ack') return // a late/duplicate ack after stop — ignore
    this.clear(state)
    state.phase = 'idle'
    this.deps.log?.(`[capture] ${source} start acknowledged by the renderer`)
  }

  private dispatchStart(source: CaptureSourceKind, state: SourceState): void {
    state.attempts += 1
    state.phase = 'awaiting-ack'
    this.deps.send('start', source)
    if (state.attempts > 1) this.deps.log?.(`[capture] ${source} start resend #${state.attempts - 1}`)
    state.timer = this.setTimer(() => this.onAckTimeout(source, state), this.ackTimeoutMs)
  }

  private onAckTimeout(source: CaptureSourceKind, state: SourceState): void {
    state.timer = undefined
    if (state.phase !== 'awaiting-ack') return
    if (state.attempts <= this.maxRetries) {
      this.deps.log?.(`[capture] ${source} start not acknowledged in ${this.ackTimeoutMs}ms — resending`)
      this.dispatchStart(source, state)
      return
    }
    state.phase = 'idle'
    const reason = `capture renderer did not acknowledge start after ${state.attempts} attempts`
    this.deps.log?.(`[capture] ${source} ${reason} — surfacing a visible fault`)
    this.deps.onFault(source, reason)
  }
}
