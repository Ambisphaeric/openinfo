import { Type, type Static } from '@sinclair/typebox'
import { Id } from '../common.js'

/**
 * The FACE vocabulary — the noun set a Standard App presents (owner canon 2026-07-11: "IA = Apps >
 * Standard App > HUD/Chat/Support faces"). Append-only closed union, mirroring `WorkflowStepKind`: a
 * face KIND names a role the shell understands, and an unknown kind has no home to open, so it is
 * rejected at document-write time (the Tier-A JSON-Schema gate) rather than silently dropped. This is a
 * seed of the block/face vocabulary the later Surface DSL compiles onto — grow it by appending here.
 *
 *   hud     — the always-on glance face (the pill).
 *   chat    — the app-scoped conversation face (the below-HUD chat shell).
 *   support — a working companion face (fields / diagnostics / system…); a bundle may declare SEVERAL.
 */
export const BundleFaceKind = Type.Union(
  ['hud', 'chat', 'support'].map((k) => Type.Literal(k)),
  { $id: 'BundleFaceKind', description: 'append-only closed union of app-face roles (hud | chat | support)' },
)
export type BundleFaceKind = Static<typeof BundleFaceKind>

/**
 * One face of an app bundle — a typed slot that maps a face role to an EXISTING surface document. It is a
 * REFERENCE, not an inlined surface (defaults are documents we ship; the surface stays its own versioned,
 * editable document). The shell opens the referenced surface through the ONE window factory, so a face's
 * window title comes free from the surface's own `name` — `title` is an OPTIONAL display override only.
 * Array order is presentation order (hud first by convention). Same declarative-list idiom as
 * `Surface.stack` / `WorkflowSpec.steps`, so the later Surface DSL compiles a face list onto this shape.
 */
export const BundleFace = Type.Object(
  {
    kind: BundleFaceKind,
    surfaceRef: Id,
    title: Type.Optional(
      Type.String({ minLength: 1, description: 'display override; absent ⇒ the mapped surface’s own name (the window factory titles it)' }),
    ),
  },
  { $id: 'BundleFace', additionalProperties: false },
)
export type BundleFace = Static<typeof BundleFace>

/**
 * The kinds of context a chat turn may assemble — the NINE declared sources (owner canon 2026-07-11:
 * "CONTEXT ASSEMBLY … must be DECLARED in the bundle config — data, not code — so a future DSL compiles
 * onto it"). Append-only closed union: a source an assembler has no path to gather is rejected at write
 * time rather than silently omitted. Each maps to an assembly stage the chat route already has (or will):
 *
 *   bundle-prompt      — the app bundle's own system/priming prompt.
 *   active-preset      — the active voice/register preset overlay.
 *   transcript-window  — the rolling live-transcript window.
 *   insights           — session insights (distillates / moments / fields).
 *   relevant-entities  — the recency×frequency relevant-now join.
 *   attached-docs      — cited chunks from a doc attached to the turn (the pins/ingest path).
 *   recent-turns       — the prior turns of this app-scoped thread.
 *   screen             — the one frame the turn shipped (Ask face screenshot-on-send), read through the
 *                        screen-understanding path (ocr slot, VLM fallback) and entered as TEXT under this
 *                        source's cap; the frame itself never leaves the machine (content-class `screen`).
 *   packets            — the CURRENT session's converged ContextPackets (#176/#180): recency-bounded
 *                        correlation windows rendered as one block per window, the three sense lanes kept
 *                        SEPARATE with their attribution, refs resolved to their source records at read
 *                        time (refs-not-content — the packet's converged window is the value). Screen-derived
 *                        text inside a window carries content-class `screen`, so it can never leave the machine.
 */
export const ChatContextSourceKind = Type.Union(
  ['bundle-prompt', 'active-preset', 'transcript-window', 'insights', 'relevant-entities', 'attached-docs', 'recent-turns', 'screen', 'packets'].map((k) => Type.Literal(k)),
  { $id: 'ChatContextSourceKind', description: 'append-only closed union of the nine chat context sources' },
)
export type ChatContextSourceKind = Static<typeof ChatContextSourceKind>

/**
 * One declared chat context source with its HONEST budget. A source names WHAT enters the context and the
 * CAP it enters under, so assembly is data (auditable, DSL-targetable) not code. Budgets are declared, not
 * inferred, so the route can disclose truncation instead of silently dropping (owner canon: "honest
 * budgets, never silent truncation" — the #134 ChatBudget already surfaces this to the user). All caps are
 * OPTIONAL: an absent cap means "engine default for this source" — additive, so a minimal source that
 * names only its `kind` still validates. `limit` bounds item/turn COUNT; `windowChars` bounds a rolling
 * CHARACTER window; `tokenBudget` bounds the estimated TOKENS this source may occupy (chars/4, the #134
 * estimator's unit). A source declares whichever caps are meaningful for its kind.
 */
export const ChatContextSource = Type.Object(
  {
    kind: ChatContextSourceKind,
    limit: Type.Optional(Type.Integer({ minimum: 0, description: 'max items/turns this source contributes; absent ⇒ engine default' })),
    windowChars: Type.Optional(Type.Integer({ minimum: 0, description: 'rolling character window for this source; absent ⇒ engine default' })),
    tokenBudget: Type.Optional(Type.Integer({ minimum: 0, description: 'estimated-token budget (chars/4) this source may occupy; absent ⇒ engine default' })),
  },
  { $id: 'ChatContextSource', additionalProperties: false },
)
export type ChatContextSource = Static<typeof ChatContextSource>

/**
 * The declarative chat CONTEXT-ASSEMBLY plan for an app bundle (owner canon 2026-07-11). It is the ordered
 * list of sources a chat turn assembles, each with its honest budget — the "data, not code" description the
 * future Surface DSL compiles onto and the chat route reads to build (and disclose) each turn's context.
 * Array order IS assembly order. This slice DECLARES the plan on the bundle; wiring the route to READ it
 * (preset injection, the rolling window) is explicitly a later slice — the substrate lands first.
 */
export const ChatContextAssembly = Type.Object(
  {
    sources: Type.Array(ChatContextSource, { minItems: 1, description: 'ordered chat context sources with honest budgets — assembly is data, not code' }),
  },
  { $id: 'ChatContextAssembly', additionalProperties: false },
)
export type ChatContextAssembly = Static<typeof ChatContextAssembly>

/**
 * An APP BUNDLE document — the bundle-as-runtime-object substrate (owner canon 2026-07-11: "Defaults are
 * just documents we ship"). A bundle is a DOCUMENT bundling references to the organs of ONE app: its FACES
 * (surface doc refs), the workflow DAG it runs (`workflowRef`), the prompt/template documents it uses
 * (`templateRefs`), a flag-config overlay (`flags`), and the declarative chat context-assembly plan
 * (`chat`). Shipping a different app later is shipping a different bundle document — NOT new code (the
 * ~10 mini smart apps are ~10 bundle docs). Everything a bundle names is a REFERENCE to an existing
 * versioned document, so a bundle never duplicates surface/workflow/prompt canon; it composes it.
 *
 * Envelope follows the house convention (id · name · version · description?), like `WorkflowSpec` /
 * `Surface`. The store stamps `version` monotonically (every prior version kept — editable history). Every
 * field beyond the envelope + `faces` is OPTIONAL, so a bundle grows additively and a minimal bundle that
 * names only its faces still validates. Contract-validated at write time (the PUT /bundles/:id Tier-A gate).
 *
 *   faces        — the app's faces (surface refs); ≥1. hud first by convention; support may repeat.
 *   workflowRef  — the WorkflowSpec document this app's pipeline runs (a ref, not the spec).
 *   templateRefs — the PromptTemplate documents this app uses (distill/extract/act/field); refs, not bodies.
 *   flags        — a flag-config OVERLAY: flag key → desired enabled state for this app. A declared overlay
 *                  (NOT applied by this slice — preset/flag injection wiring is out of scope); it records the
 *                  app's intended posture as data the later injection slice reads.
 *   chat         — the declarative chat context-assembly plan (the eight sources + honest budgets).
 */
export const Bundle = Type.Object(
  {
    id: Id,
    name: Type.String({ minLength: 1 }),
    version: Type.Integer({ minimum: 1, description: 'store-stamped, monotonic; every prior version is kept' }),
    description: Type.Optional(Type.String()),
    faces: Type.Array(BundleFace, { minItems: 1, description: 'the app’s faces (surface refs); hud first by convention, support may repeat' }),
    workflowRef: Type.Optional(Id),
    templateRefs: Type.Optional(Type.Array(Id, { description: 'PromptTemplate document ids this app uses — references, never inlined bodies' })),
    flags: Type.Optional(
      Type.Record(Type.String(), Type.Boolean(), {
        description: 'flag-config OVERLAY: flag key → desired enabled state; a declared posture (injection is a later slice), never applied here',
      }),
    ),
    chat: Type.Optional(ChatContextAssembly),
  },
  { $id: 'Bundle', additionalProperties: false, description: 'an app bundle — references to the organs of one app (faces, workflow, templates, flags, chat assembly), all versioned documents' },
)
export type Bundle = Static<typeof Bundle>
