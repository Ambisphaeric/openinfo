import { Type, type Static } from '@sinclair/typebox'

/**
 * Layered egress-consent policy (#64). "Egress" is the single question: may this content leave the
 * machine? It is resolved across FOUR layers, ANY of which can DENY — and a fresh install has NO
 * egress-capable endpoint configured, so nothing can leave because no path out exists. Egress is a
 * primitive the user deliberately ADDS, never a setting to turn off.
 *
 * The four layers, and how each denies:
 *  1. ENDPOINT      — an endpoint is `local` or `egress` BY ITS NATURE (loopback/LAN vs a hosted host),
 *                     with the finer destination stamped as device-local / LAN-local / hosted-public;
 *                     both are derived purely from the endpoint document, never from payload data.
 *  2. PROMPT/FIELD  — a prompt document may declare it never uses egress-capable endpoints (`neverEgress`).
 *  3. MODE/WORKSPACE— a mode or a workspace may deny egress wholesale (`egress.deny`).
 *  4. CONTENT-CLASS — content carries its origin; screen-derived content never reaches hosted/public
 *                     destinations, while an explicitly trusted private-LAN raw-frame hop is separate.
 *
 * Resolution follows the voice-binding precedent (global → mode → workspace → session, with a
 * which-scope-won audit field): MOST-SPECIFIC DENIAL WINS, and every decision records WHICH layer decided.
 * The specificity order (most specific → least), used to attribute a denial, is:
 *   content-class (this datum) → prompt (this template) → mode → workspace (the broadest container).
 * The `endpoint` layer is the orthogonal destination axis (layer 1) — it is what the resolved consent is
 * ENFORCED against when invokes choose endpoints, not a content-side consent knob.
 */

/** Layer 1: an endpoint's reach — `local` (loopback/LAN, or an engine-spawned runtime) vs `egress`
 * (a hosted host, or a cloud provider). Derived purely from the endpoint (kind + URL), never configured. */
export const EgressReach = Type.Union([Type.Literal('local'), Type.Literal('egress')], {
  $id: 'EgressReach',
  description:
    'layer 1 compatibility bucket: local-network (device loopback/managed or private LAN) vs hosted/public egress; use EgressDecision.destination for physical boundary truth',
})
export type EgressReach = Static<typeof EgressReach>

/**
 * The physical destination class for a completed invoke. `EgressReach` intentionally preserves the
 * original policy grouping (`local` includes both loopback and the private LAN); this additive detail is
 * the audit answer to whether bytes stayed on the device, crossed to the LAN, or reached a hosted/public
 * service. It contains no host, URL, credential, payload, or model output.
 */
export const EgressDestination = Type.Union(
  [Type.Literal('device-local'), Type.Literal('lan-local'), Type.Literal('hosted-public')],
  {
    $id: 'EgressDestination',
    description:
      'physical destination of a completed invoke: device-local (managed/loopback), lan-local (device boundary crossed within the private network), or hosted-public',
  },
)
export type EgressDestination = Static<typeof EgressDestination>

/**
 * Which layer decided an egress outcome — the which-layer-won provenance (the voice `scope` analogue).
 * A DENIAL is attributed to the most-specific denying layer; `default` means no layer denied (allowed by
 * the absence of any denial); `endpoint` means the destination classification itself was decisive (e.g.
 * an egress endpoint was skipped, or no egress path exists at all — the factory posture).
 */
export const EgressLayer = Type.Union(
  ['endpoint', 'prompt', 'mode', 'workspace', 'content-class', 'default'].map((l) => Type.Literal(l)),
  { $id: 'EgressLayer', description: 'which of the four layers decided (or `default` = no denial, `endpoint` = destination-classification decided)' },
)
export type EgressLayer = Static<typeof EgressLayer>

/**
 * Layer 4: the origin class of a piece of content, derived from what the pipeline already knows (no new
 * upstream tagging). `screen` (OCR/VLM-derived) NEVER reaches hosted/public destinations; an explicit
 * trusted-LAN raw-frame opt-in is enforced separately. `transcript` (mic/system audio) and `typed` MAY;
 * `unknown` is treated as allowed-unless-denied-elsewhere (never a silent deny).
 */
export const ContentClass = Type.Union(
  ['screen', 'transcript', 'typed', 'unknown'].map((c) => Type.Literal(c)),
  { $id: 'ContentClass', description: 'layer 4: content origin — screen denies hosted/public egress; transcript/typed may allow it' },
)
export type ContentClass = Static<typeof ContentClass>

/**
 * The content-side egress knob a mode or a workspace carries (layers 2/3). Append-only and OPTIONAL:
 * absent ⇒ that layer does not deny (it defers to the others). `deny:true` denies egress wholesale for
 * everything that layer scopes. There is deliberately no "allow" — egress is enabled by ADDING an egress
 * endpoint, not by a boolean, so the only thing a mode/workspace can express here is a wholesale DENIAL.
 */
export const EgressPolicy = Type.Object(
  { deny: Type.Boolean({ description: 'true ⇒ this mode/workspace denies egress wholesale' }) },
  { $id: 'EgressPolicy', additionalProperties: false },
)
export type EgressPolicy = Static<typeof EgressPolicy>

/**
 * The resolved egress decision, stamped onto a record's provenance so the audit ledger (#65) can render
 * "what data went where and what filtered it." It fuses the layer-1 classification of the endpoint that
 * ANSWERED (`reach`) with the content-side consent verdict (`allowed` + `decidedBy` + `reason`). Because a
 * denied-egress invoke is FILTERED before it runs, a persisted record with `reach:'egress'` always has
 * `allowed:true`; a `reach:'local'` record may carry `allowed:false` because hosted/public egress was
 * denied even though an explicitly trusted LAN raw-frame hop was allowed. `destination` removes that
 * deliberate compatibility ambiguity for newly stamped records; `rawFrameTrust:'explicit'` records the
 * narrow opt-in required for a successful LAN OCR/VLM call. Both fields are additive/optional so existing
 * persisted records remain valid, while new code always stamps `destination`.
 */
export const EgressDecision = Type.Object(
  {
    reach: EgressReach,
    allowed: Type.Boolean({ description: 'did the layered content-side policy permit hosted/public egress for this content?' }),
    decidedBy: EgressLayer,
    reason: Type.String({ minLength: 1, description: 'one-line, human-readable why — safe to surface (no url/secret)' }),
    destination: Type.Optional(EgressDestination),
    rawFrameTrust: Type.Optional(
      Type.Literal('explicit', {
        description:
          'present only when raw screen bytes crossed to a LAN-local HTTP endpoint under that endpoint’s explicit trustRawFrames opt-in',
      }),
    ),
  },
  { $id: 'EgressDecision', additionalProperties: false },
)
export type EgressDecision = Static<typeof EgressDecision>
