import { randomUUID } from 'node:crypto'
import type { Session } from '@openinfo/contracts'
import type { WorkspaceRegistry } from '../store/index.js'
import { DEFAULT_DETECTOR_CONFIG, detectSwitch, type DetectionResult, type DetectorConfig, type TimedSignal } from './detector.js'
import type { HintsDocuments } from './hints.js'

export type AttributionEvent = 'session.started' | 'session.ended' | 'session.switched'

export interface AttributorDeps {
  store: WorkspaceRegistry
  hints: HintsDocuments
  /** emit a session lifecycle event on the bus (WS-broadcast happens downstream). */
  publish: (event: AttributionEvent, session: Session) => void | Promise<void>
  /** the mode an auto-started session runs (v0: the default meeting mode). */
  modeId?: () => string
  config?: DetectorConfig
  now?: () => Date
  newId?: () => string
  log?: (message: string) => void
}

/**
 * The stateful router half (route/attribute.ts): session → workspace, with attribution evidence
 * recorded on the session. It holds the rolling in-memory buffer of recent FocusSignals (the machine's
 * global foreground context — signals are machine-wide, sessions are per-workspace), feeds it to the
 * pure detector against ALL workspaces' hints, and ACTS on a sustained switch:
 *
 *  - No live session anywhere + a sustained match → AUTO-START a session in the matched workspace
 *    (session.started), its attribution = the detector's window/repo evidence at confidence < 1.
 *  - A live session in W1 + a sustained match for W2 → auto-END W1's session (session.ended), START in
 *    W2 (session.started), and emit session.switched (the started session) — the router's ACTION event,
 *    distinct from session.rerouted (the user's retroactive correction; see PHASE3-NOTES). The reroute
 *    correction loop is the teaching signal that says "this auto-attribution was wrong".
 *
 * Every auto-started session carries ONLY the detector's evidence trail (no manual evidence) at a
 * sub-1.0 confidence, so the risk-register invariant holds: attribution evidence on every session, and
 * a detected attribution never outranks a manual one. Kept framework-free (store + publish injected) so
 * the switch policy is unit-tested through the real store without a server.
 */
export class Attributor {
  private readonly store: WorkspaceRegistry
  private readonly hints: HintsDocuments
  private readonly publish: (event: AttributionEvent, session: Session) => void | Promise<void>
  private readonly modeId: () => string
  private readonly config: DetectorConfig
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly log: (message: string) => void
  /** recent signals, kept to 2× the sustain window so the detector always has a full window to judge. */
  private buffer: TimedSignal[] = []

  constructor(deps: AttributorDeps) {
    this.store = deps.store
    this.hints = deps.hints
    this.publish = deps.publish
    this.modeId = deps.modeId ?? (() => 'mode-meeting')
    this.config = deps.config ?? DEFAULT_DETECTOR_CONFIG
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => randomUUID())
    this.log = deps.log ?? (() => undefined)
  }

  /**
   * Observe a batch of routing signals — focus signals extracted from one drained spool file, OR calendar
   * signals from the engine-side collector — update the rolling buffer, run detection, and act on a switch.
   * Both feed the SAME buffer so calendar meeting-presence and focus window/repo participate in one
   * sustain-window contest. Returns the DetectionResult (for tests/logging).
   */
  async observe(signals: readonly TimedSignal[]): Promise<DetectionResult> {
    for (const s of signals) this.buffer.push(s)
    this.buffer.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    if (this.buffer.length > 0) {
      const newest = Date.parse(this.buffer[this.buffer.length - 1]!.at)
      const keepFrom = newest - this.config.sustainMs * 2
      this.buffer = this.buffer.filter((s) => Date.parse(s.at) >= keepFrom)
    }

    const live = this.mostRecentLiveSession()
    const result = detectSwitch(this.buffer, this.hints.all(), live?.workspaceId, this.config)
    if (result.decision !== 'switch' || result.toWorkspaceId === undefined) return result

    const to = result.toWorkspaceId
    const nowIso = this.now().toISOString()

    // Defensive one-live-per-workspace: end any live session already in the destination.
    const destLive = this.store.liveSession(to)
    if (destLive && destLive.id !== live?.id) {
      const ended: Session = { ...destLive, endedAt: nowIso }
      this.store.saveSession(ended)
      await this.publish('session.ended', ended)
    }

    // End the session we are switching AWAY from (the live case); auto-start has none to end.
    const switched = live !== undefined && live.workspaceId !== to
    if (switched && live) {
      const ended: Session = { ...live, endedAt: nowIso }
      this.store.saveSession(ended)
      await this.publish('session.ended', ended)
    }

    const session: Session = {
      id: this.newId(),
      workspaceId: to,
      modeId: this.modeId(),
      startedAt: nowIso,
      attribution: { evidence: result.evidence, confidence: result.confidence },
    }
    this.store.saveSession(session)
    await this.publish('session.started', session)
    if (switched) await this.publish('session.switched', session)
    this.log(
      `${switched ? 'switched' : 'auto-started'} session ${session.id} → workspace ${to} ` +
        `(confidence ${result.confidence.toFixed(2)}, ${result.evidence.length} evidence)`,
    )
    return result
  }

  /** The most recently started live (unended) session across all workspaces — the current attribution. */
  private mostRecentLiveSession(): Session | undefined {
    let current: Session | undefined
    for (const workspace of this.store.all()) {
      const live = this.store.liveSession(workspace.id)
      if (live && (current === undefined || live.startedAt > current.startedAt)) current = live
    }
    return current
  }
}
