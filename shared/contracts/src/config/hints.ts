import { Type, type Static } from '@sinclair/typebox'
import { Id, Confidence } from '../common.js'

/**
 * One signal→workspace match rule. A pattern names a FocusSignal `field` and a matcher — `contains`
 * (substring) and/or `prefix` — tested case-insensitively against that field's value. When both are
 * given, both must match; at least one must be present (a matcher-less pattern matches nothing). The
 * `weight` is this rule's contribution to the workspace's attribution evidence (a Confidence, 0..1),
 * and rides straight onto the AttributionEvidence entry the detector stamps on an auto-started session
 * (field→kind: repoPath→'repo', windowTitle/app→'window').
 */
export const AttributionPattern = Type.Object(
  {
    field: Type.Union(['repoPath', 'windowTitle', 'app'].map((f) => Type.Literal(f))),
    contains: Type.Optional(Type.String({ minLength: 1, description: 'case-insensitive substring match against the field' })),
    prefix: Type.Optional(Type.String({ minLength: 1, description: 'case-insensitive prefix match against the field' })),
    weight: Confidence,
  },
  { $id: 'AttributionPattern', additionalProperties: false },
)
export type AttributionPattern = Static<typeof AttributionPattern>

/**
 * The per-workspace attribution-hints document (Phase 3 context-switch detection). A versioned config
 * document (store kind `workspace-hints`, keyed by workspaceId) mapping foreground-focus signal
 * patterns → this workspace. The detector (route/detector.ts) scores each incoming FocusSignal against
 * every workspace's hints; a workspace that sustains dominance over the window wins the switch. Editable
 * via the normal document store — the same versioned records as modes/registers/flags. v0 seeds only an
 * EMPTY hints doc for the default workspace (patterns: []), which matches nothing: unmatched signals
 * take NO action (no permissive catch-all — a fallback that captured everything would defeat detection).
 */
export const WorkspaceHints = Type.Object(
  {
    workspaceId: Id,
    patterns: Type.Array(AttributionPattern),
  },
  { $id: 'WorkspaceHints', additionalProperties: false, description: 'signal-pattern → workspace attribution hints (P3 context-switch detection)' },
)
export type WorkspaceHints = Static<typeof WorkspaceHints>
