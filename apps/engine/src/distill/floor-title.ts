import { randomUUID } from 'node:crypto'
import type { CaptureChunk, Entity, Session, SessionTitling } from '@openinfo/contracts'
import { SESSION_TITLING_SCHEMA_VERSION } from '@openinfo/contracts'
import { rankEntities } from '../index/rank.js'
import type { WorkspaceRegistry } from '../store/index.js'

/** A floor title never runs long — a glanceable name, not a sentence. Bounded, word-safe (mirrors #211). */
const MAX_TITLE_CHARS = 80

/** The deterministic producer this floor rung names in provenance — never a model, never the judge (#226). */
const FLOOR_PRODUCER = 'session-entities'

/** How many top-ranked subjects a floor name may lead with — more than two stops being glanceable. */
const MAX_SUBJECTS = 2

/** Join up to two subjects the human way — "A" or "A and B" (mirrors #211's episode-title transform). */
const humanSubjects = (subjects: readonly string[]): string => {
  const top = subjects.slice(0, MAX_SUBJECTS)
  return top.length === 2 ? `${top[0]} and ${top[1]}` : (top[0] ?? '')
}

/** Trim to the length cap on a word boundary so a floor title never ends mid-word or mid-space (mirrors #211). */
const clamp = (s: string): string => {
  const collapsed = s.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= MAX_TITLE_CHARS) return collapsed
  const cut = collapsed.slice(0, MAX_TITLE_CHARS)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim()
}

/**
 * Derive a deterministic, MODEL-FREE floor title from subjects that already exist for the session (#226).
 * PURE: the subjects are ranked signals the store already holds (session entities) — no model is invoked,
 * nothing is fabricated. The name leads with the top subject(s) in the calm human voice the HUD speaks
 * ("Working on kubefast" beats "session live"). Honest degradation: with NO usable subject this returns
 * `undefined` so the caller keeps the honest start-time fallback rather than minting a hollow name.
 */
export const deriveFloorTitle = (subjects: readonly string[]): string | undefined => {
  const clean = subjects.map((s) => s.trim()).filter((s) => s.length > 0)
  if (clean.length === 0) return undefined
  return clamp(`Working on ${humanSubjects(clean)}`)
}

export interface FloorTitleSchedulerDeps {
  store: WorkspaceRegistry
  /** publish the session with its materialised floor title (session.titled) when one lands (#211/#226); optional in tests. */
  publishTitled?: (session: Session) => void | Promise<void>
  now?: () => Date
  /** id minter for the append-only titling id; injected only for deterministic tests. */
  newId?: () => string
  log?: (message: string) => void
}

/**
 * The zero-model title FLOOR (#226) — the sane-defaults safety net that gives a session an honest name from
 * signals it ALREADY has, BEFORE (or instead of) any judge-derived title. It runs every distill batch and
 * is cheap and deterministic (a store read + a pure transform — no invoke), so it is never flag-gated: on a
 * rig with no judge derivation it is the only name a session gets; on a rig with one, the judge derivation
 * supersedes it (resolveTitle precedence). It never runs once a session carries a USER or DERIVED title
 * (`hasAuthoredTitle`), and it dedupes on `latestFloorTitle`, so it can neither clobber a stronger rung nor
 * spam identical rows. Self-gating: with no session entities the floor finds no subject and is a no-op.
 */
export class FloorTitleScheduler {
  private readonly store: WorkspaceRegistry
  private readonly publishTitled: ((s: Session) => void | Promise<void>) | undefined
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly log: (message: string) => void

  constructor(deps: FloorTitleSchedulerDeps) {
    this.store = deps.store
    this.publishTitled = deps.publishTitled
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => randomUUID())
    this.log = deps.log ?? (() => undefined)
  }

  /**
   * Attempt a floor title for every session with material in this batch. Returns the titlings appended
   * (persisted + published). Explainable-empty — [] — when every touched session already has a stronger
   * title, has no nameable signal yet, or the floor name is unchanged; never an error.
   */
  async run(chunks: readonly CaptureChunk[]): Promise<SessionTitling[]> {
    const appended: SessionTitling[] = []
    for (const [key, sessionId] of this.sessions(chunks)) {
      const workspaceId = key
      // A user or judge-derived title outranks the floor — never append (nor override) once one exists.
      if (this.store.hasAuthoredTitle(workspaceId, sessionId)) continue
      const subjects = this.topSubjects(workspaceId, sessionId)
      const title = deriveFloorTitle(subjects)
      if (title === undefined) continue
      // Dedupe on the latest floor title so a re-run with the same top subjects appends nothing (mirrors #211).
      if (this.store.latestFloorTitle(workspaceId, sessionId) === title) continue
      const titling: SessionTitling = {
        id: `ft:${workspaceId}:${sessionId}:${this.newId()}`,
        workspaceId,
        sessionId,
        title,
        source: 'floor',
        provenance: { producer: FLOOR_PRODUCER, subjects, derivedAt: this.now().toISOString() },
        createdAt: this.now().toISOString(),
        schemaVersion: SESSION_TITLING_SCHEMA_VERSION,
      }
      const updated = this.store.recordSessionTitling(titling)
      this.log(`floor: session ${sessionId} titled "${title}" (deterministic, ${FLOOR_PRODUCER})`)
      appended.push(titling)
      if (updated !== undefined) await this.publishTitled?.(updated)
    }
    return appended
  }

  /** The (workspaceId → sessionId) pairs present in this batch — one attempt per touched session. */
  private sessions(chunks: readonly CaptureChunk[]): Map<string, string> {
    const pairs = new Map<string, string>()
    for (const chunk of chunks) pairs.set(chunk.workspaceId, chunk.sessionId)
    return pairs
  }

  /**
   * The top-ranked SUBJECTS for a session's floor name (#226): the entities sighted in THIS session, ranked
   * by the existing recency×frequency scorer, most salient first. Session scoping is the append-only
   * evidence trail — an entity belongs to the session when any of its provenance/sighting windows names a
   * distillate of this session. Model-free: it reads records the pipeline already produced, never invokes.
   */
  private topSubjects(workspaceId: string, sessionId: string): string[] {
    const distillateIds = new Set(this.store.listDistillates(workspaceId, sessionId).map((d) => d.id))
    if (distillateIds.size === 0) return []
    const inSession = (entity: Entity): boolean =>
      (entity.provenance ?? []).some((p) => p.distillateId !== undefined && distillateIds.has(p.distillateId)) ||
      (entity.sightings ?? []).some((s) => s.distillateId !== undefined && distillateIds.has(s.distillateId))
    const entities = this.store.listEntities(workspaceId).filter(inSession)
    if (entities.length === 0) return []
    return rankEntities(entities, this.now())
      .slice(0, MAX_SUBJECTS)
      .map((ranked) => ranked.entity.name)
  }
}
