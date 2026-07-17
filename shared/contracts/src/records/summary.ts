import { Type, type Static } from '@sinclair/typebox'
import { Id, IsoTime, Confidence, InvokeUsage, SlotName } from '../common.js'
import { EgressDecision } from '../config/egress.js'
import { GuardVerdict } from '../config/guard.js'

/** Schema version of the Summary record shape — bumped when the persisted shape changes. */
export const SUMMARY_SCHEMA_VERSION = 1

/**
 * The multi-timescale summary hierarchy levels (#177). The enum is COMPLETE now — all five levels are
 * typed — even though slice 1 only PRODUCES rolling/five-minute/session. The finer→coarser order is:
 *   - `rolling`     one short window over the existing distillates (+ ContextPackets as evidence);
 *   - `episode`     a coherent stretch of activity (slice-2 production);
 *   - `five-minute` the concise five-minute view the human UI leads with, over rolling summaries;
 *   - `session`     the durable end-of-session result, over five-minute summaries;
 *   - `project`     durable cross-session continuity (slice-2 production; spans sessions, so it carries
 *                   no single sessionId).
 * A coarser level consumes the level below it — never unbounded raw history (see `SummaryInputBound`).
 */
export const SummaryLevel = Type.Union(
  ['rolling', 'episode', 'five-minute', 'session', 'project'].map((l) => Type.Literal(l)),
  { $id: 'SummaryLevel', description: 'the summary timescale, finest (rolling) to coarsest (project)' },
)
export type SummaryLevel = Static<typeof SummaryLevel>

/**
 * One reference a summary makes to a lower-level input (#177). A summary NEVER copies content — it points
 * at the immutable record by id, so every assertion stays traceable to its source and ultimately to source
 * evidence (a summary→summary→…→packet/distillate→observation chain). `at` is the child's window-start /
 * observation instant, carried so a reader can see WHY the ref landed in this window without loading it.
 * `level` is present ONLY when `record` is `summary`, naming which lower level the child summary is.
 */
export const SummaryChild = Type.Object(
  {
    record: Type.Union(
      ['summary', 'context-packet', 'distillate', 'moment', 'stt-segment', 'ocr-result'].map((r) => Type.Literal(r)),
      { description: 'which record table the id names — the closed set of summarizable inputs and evidence' },
    ),
    id: Id,
    at: IsoTime,
    role: Type.Union(['child', 'evidence'].map((r) => Type.Literal(r)), {
      description: "`child` = a bounded lower-level input this summary is derived FROM; `evidence` = selectively-retrieved corroborating source",
    }),
    level: Type.Optional(SummaryLevel),
  },
  { $id: 'SummaryChild', additionalProperties: false },
)
export type SummaryChild = Static<typeof SummaryChild>

/**
 * The EXPLICIT bound on a summary's inputs (#177) — the acceptance criterion made inspectable. A longer
 * summary consumes BOUNDED lower-level inputs plus a bounded selection of evidence, never unbounded raw
 * history: `*Consumed` is always `<= max` from the level's config document, and `available > consumed`
 * means the input was TRUNCATED to the cap (the newest were kept). A reader (and a test) can see the bound
 * held from the record alone, so an over-long history can never silently balloon a summary's inputs.
 */
export const SummaryInputBound = Type.Object(
  {
    childrenAvailable: Type.Integer({ minimum: 0, description: 'lower-level inputs that existed in the window' }),
    childrenConsumed: Type.Integer({ minimum: 0, description: 'lower-level inputs actually fed to the summarizer (<= maxChildren)' }),
    evidenceAvailable: Type.Integer({ minimum: 0, description: 'candidate evidence records in the window' }),
    evidenceConsumed: Type.Integer({ minimum: 0, description: 'evidence records actually fed (<= maxEvidence)' }),
  },
  { $id: 'SummaryInputBound', additionalProperties: false },
)
export type SummaryInputBound = Static<typeof SummaryInputBound>

/**
 * How a summary was built (#177). `builder` keeps the deterministic assembler inspectable: the child
 * selection, window, bound, and confidence are a PURE function of the stored inputs — only the prose came
 * from a model. The model-invoke half (`slot`…`guard`) is present ONLY when prose was produced; a DEGRADED
 * summary (model unavailable) carries none of it, so a reader can never mistake a placeholder for a real
 * invocation. `templateId` names the summary prompt DOCUMENT that shaped the prose (config, not hardcode).
 */
export const SummaryProvenance = Type.Object(
  {
    builder: Type.Literal('bounded-hierarchical-summary'),
    windowMs: Type.Integer({ minimum: 0, description: 'the interval bucket size this level assembled with (0 for whole-session bucketing)' }),
    childLevel: Type.Optional(SummaryLevel),
    templateId: Id,
    slot: Type.Optional(SlotName),
    endpoint: Type.Optional(Type.String({ minLength: 1, description: 'fabric endpoint name that produced the prose' })),
    model: Type.Optional(Type.String()),
    usage: Type.Optional(InvokeUsage),
    egress: Type.Optional(EgressDecision),
    guard: Type.Optional(GuardVerdict),
  },
  { $id: 'SummaryProvenance', additionalProperties: false },
)
export type SummaryProvenance = Static<typeof SummaryProvenance>

/**
 * A multi-timescale summary (#177) — one interval's view at one `level`, built ONLY from references to
 * lower-level summaries, distillates, packets, and source evidence (never copied content). The prose is a
 * MODEL PROPOSAL (`proposal: true`, the #189 invariant): it is never canonical truth, and a human
 * correction would supersede it. The deterministic skeleton (window, children, bound, confidence) is a
 * pure function of the stored inputs — so replaying the same inputs yields the same skeleton and the same
 * `id`, which is content-derived over that skeleton (prose EXCLUDED, so a re-roll of prose over the SAME
 * children does not churn a new revision).
 *
 * HONEST DEGRADATION: when the summarizing model is unavailable, `text` is ABSENT and `degraded` names the
 * machine-visible reason — no fabricated prose. The children/derivation path is still intact (it is
 * deterministic), so the summary remains a real, traceable structural record that a later pass upgrades in
 * place when the model returns.
 *
 * SUPERSESSION is append-only: when the child SET changes (new material arrived in an active interval), a
 * NEW summary supersedes the prior (revision + 1, `supersedes` naming it) — the prior is never mutated.
 * `sessionId` is absent only for a cross-session `project` summary (slice-2 production).
 */
export const Summary = Type.Object(
  {
    id: Id,
    workspaceId: Id,
    sessionId: Type.Optional(Id),
    level: SummaryLevel,
    windowStart: IsoTime,
    windowEnd: IsoTime,
    children: Type.Array(SummaryChild, { description: 'refs to bounded lower-level inputs + selective evidence — never copied content' }),
    bound: SummaryInputBound,
    text: Type.Optional(Type.String({ description: 'the MODEL-PROPOSED summary prose; ABSENT ⇒ degraded (see `degraded`)' })),
    proposal: Type.Literal(true, { description: '#189: summary prose is a model PROPOSAL, never canonical truth' }),
    degraded: Type.Optional(
      Type.Object(
        { reason: Type.String({ minLength: 1, description: 'why no prose was produced — e.g. no summarizer endpoint, invoke failed' }) },
        { additionalProperties: false, description: 'present ⇒ no prose (honest unavailable state); absent ⇒ `text` is present' },
      ),
    ),
    confidence: Confidence,
    provenance: SummaryProvenance,
    revision: Type.Integer({ minimum: 1, description: 'position in this interval’s append-only supersession chain' }),
    supersedes: Type.Optional(Id),
    schemaVersion: Type.Integer({ minimum: 1 }),
    createdAt: IsoTime,
  },
  { $id: 'Summary', additionalProperties: false },
)
export type Summary = Static<typeof Summary>
