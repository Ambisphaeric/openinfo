import { Type, type Static } from '@sinclair/typebox'
import { Id, IsoTime } from '../common.js'

/**
 * The egress GUARD (#63) — a content/PII filter on every hop MARKED egress (content leaving the machine,
 * e.g. a hosted API via an aggregator key). The guard is the privacy filter between local capture and any
 * external intelligence: sensitive spans (a payment card number in a screenshot's OCR, a secret in a
 * transcript) must never reach an external API un-redacted by default. Local-only hops never invoke the
 * guard (no egress ⇒ no filter needed — enforced upstream by the #64 egress gate; the guard runs ONLY at
 * a `{allow:true, reach:'egress'}` hop).
 *
 * Two verdict behaviors, document-driven (GuardPolicy), never hardcoded:
 *  - redact-and-continue (DEFAULT): flagged spans are masked (`[redacted:<kind>]`); the hop proceeds with
 *    the redacted content.
 *  - hold-and-surface (STRICT): the hop is SUSPENDED; a GuardHold record surfaces with a release/deny
 *    affordance and NOTHING leaves until the user acts.
 *
 * Fail-closed edges (owner-confirmed canon):
 *  - empty guard slot + strict mode ⇒ egress HOLDS (fail closed).
 *  - empty guard slot + default mode ⇒ egress proceeds ONLY under explicit acknowledgment that no guard is
 *    active (`GuardPolicy.acknowledgeUnguardedEgress`); otherwise it HOLDS — never silently unguarded.
 *
 * Guard verdicts are ALWAYS written to the audit trail, INCLUDING when content is held/blocked, with
 * span-level detail — positions/kinds/lengths, NEVER the raw flagged value.
 */

/** A verdict behavior — the two policy modes. `redact-and-continue` is the default; `hold-and-surface` is strict. */
export const GuardBehavior = Type.Union(
  [Type.Literal('redact-and-continue'), Type.Literal('hold-and-surface')],
  { $id: 'GuardBehavior', description: 'redact-and-continue (default, mask spans + proceed) | hold-and-surface (strict, suspend the hop)' },
)
export type GuardBehavior = Static<typeof GuardBehavior>

/**
 * One flagged span the guard classifier reported — a DESCRIPTOR of what was masked, NEVER the raw value.
 * `start`/`length` are character offsets into the outbound text (so a consumer can see WHAT extent was
 * masked without the content); `kind` is the classifier's label (e.g. `card-number`, `email`, `secret`).
 */
export const GuardSpan = Type.Object(
  {
    kind: Type.String({ minLength: 1, description: 'the classifier label for this span (e.g. card-number) — a category, never the value' }),
    start: Type.Integer({ minimum: 0, description: 'character offset of the span in the outbound text' }),
    length: Type.Integer({ minimum: 1, description: 'character length of the masked span (extent only — never the value)' }),
  },
  { $id: 'GuardSpan', additionalProperties: false },
)
export type GuardSpan = Static<typeof GuardSpan>

/**
 * The guard's resolved verdict, stamped onto a record's provenance (and onto a GuardHold when held) so the
 * audit ledger (#65) can render "what filtered it." `outcome` is the decision the policy reached; `spans`
 * carry span-level detail (kinds/positions/lengths) — NEVER a raw flagged value. `guarded` says whether a
 * guard endpoint actually classified the content (false for the unguarded-acknowledged / fail-closed-empty
 * edges). Append-only/optional on provenance: records predating #63 omit it and still validate.
 */
export const GuardVerdict = Type.Object(
  {
    outcome: Type.Union(
      ['clean', 'redacted', 'held', 'unguarded'].map((o) => Type.Literal(o)),
      {
        description:
          'clean = guard ran, nothing flagged; redacted = flagged spans masked, hop proceeded; held = hop suspended (strict, or fail-closed empty slot); unguarded = no guard active, proceeded under explicit acknowledgment',
      },
    ),
    behavior: GuardBehavior,
    guarded: Type.Boolean({ description: 'true ⇒ a guard endpoint classified the content; false ⇒ no guard ran (acknowledged-unguarded or fail-closed-empty)' }),
    maskedSpanCount: Type.Integer({ minimum: 0, description: 'how many spans were masked (0 for clean/held/unguarded)' }),
    spans: Type.Optional(Type.Array(GuardSpan, { description: 'span descriptors (kind/start/length) — never the raw value; present when spans were flagged' })),
    guardEndpoint: Type.Optional(Type.String({ description: 'the guard endpoint NAME that classified — never a url/secret; absent when no guard ran' })),
    reason: Type.String({ minLength: 1, description: 'one-line, human-readable why — safe to surface (no raw value)' }),
  },
  { $id: 'GuardVerdict', additionalProperties: false },
)
export type GuardVerdict = Static<typeof GuardVerdict>

/**
 * The verdict→behavior POLICY document (contract-validated config, versioned in _meta.db — the fabric/flag
 * document pattern, NOT hardcoded). `behavior` picks redact-vs-hold; `acknowledgeUnguardedEgress` is the
 * explicit acknowledgment that lets default-mode egress proceed when the guard slot is empty (never silent).
 * Seeded default: redact-and-continue, not acknowledged (so an empty slot in default mode HOLDS until the
 * user either adds a guard endpoint or acknowledges).
 */
export const GuardPolicy = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    version: Type.Integer({ minimum: 1, description: 'store-stamped, monotonic; every prior version is kept' }),
    behavior: GuardBehavior,
    acknowledgeUnguardedEgress: Type.Boolean({
      description: 'default mode + empty guard slot: true ⇒ egress proceeds UNGUARDED (recorded as such); false ⇒ it HOLDS (never silently unguarded)',
    }),
    description: Type.Optional(Type.String()),
  },
  { $id: 'GuardPolicy', additionalProperties: false },
)
export type GuardPolicy = Static<typeof GuardPolicy>

/** A held hop's lifecycle: `held` until the user resolves it; `released` (let it proceed) or `denied` (dropped). */
export const GuardHoldStatus = Type.Union(
  ['held', 'released', 'denied'].map((s) => Type.Literal(s)),
  { $id: 'GuardHoldStatus', description: 'held | released (proceed) | denied (dropped)' },
)
export type GuardHoldStatus = Static<typeof GuardHoldStatus>

/**
 * A SUSPENDED egress hop (hold-and-surface, or a fail-closed empty slot) — the durable audit record of a
 * block, carrying the verdict (with span-level detail, never the raw value) so a held verdict IS in the
 * audit trail. Surfaces in the ledger with a release/deny affordance; the release/deny HTTP action flips
 * `status`. v0 records the hold + surfaces it + resolves status; automatically re-driving the exact held
 * pass on release is deferred (see PHASE4-NOTES) — the raw content is NOT retained (fail-closed: nothing
 * leaked), only the verdict descriptor.
 */
export const GuardHold = Type.Object(
  {
    id: Id,
    workspaceId: Id,
    sessionId: Type.Optional(Id),
    stage: Type.String({ minLength: 1, description: "the pipeline stage that was held (e.g. 'distill')" }),
    // #116: the correlation id of the pipeline pass that was suspended — a held window produced no
    // distillate, so this (plus sourceChunks below) is how the audit trail reaches the hold from its
    // input. Append-only/optional: holds predating #116 omit both.
    spanId: Type.Optional(Id),
    sourceChunks: Type.Optional(Type.Array(Id, { description: 'capture chunk ids of the held window — the parent link a trace walks; ids only, never content' })),
    verdict: GuardVerdict,
    status: GuardHoldStatus,
    createdAt: IsoTime,
    resolvedAt: Type.Optional(IsoTime),
  },
  { $id: 'GuardHold', additionalProperties: false },
)
export type GuardHold = Static<typeof GuardHold>
