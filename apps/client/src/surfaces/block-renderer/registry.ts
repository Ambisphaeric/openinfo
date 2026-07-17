import type { Block, BlockTypeName, QueryResult, Surface } from '@openinfo/contracts'
import { h, type VElement, type VNode } from './vnode.js'

/**
 * The live-session context the `now` block renders (design/renderings/hud-v2.html: the one place the
 * context is named, plus the heartbeat dot). Derived by the HUD controller from the live session; the
 * renderer never fetches it.
 */
export interface NowContext {
  workspace?: string
  title?: string
  topic?: string
  elapsed?: string
  live: boolean
}

/**
 * The #75 clarify session context — which ambiguous-entity asks the user has already settled/dismissed
 * this session (no ≟), and which single ask is currently expanded. Session-ephemeral, owned by the Hud
 * (mirrors the #96 system-mute bit); a block renderer that surfaces entities (relevant-now) consults it so
 * an answered/dismissed row goes quiet. Optional so a query-less/entity-less block ignores it.
 */
export interface ClarifyRenderContext {
  suppressed: ReadonlySet<string>
  expanded?: string
}

/**
 * The #136 session-control readiness — the honest can-this-act signal the shell feeds down from the SAME
 * engine/capture state the tray reads. Threaded to every block renderer (the `session-control` block + the
 * note-taker's canvas-header control consult it). Optional so a surface without a session control ignores it;
 * absent ⇒ no shell bridge (browser dev / served frame), which the control renders as a disabled, disclosed
 * state. Shape mirrored in blocks/session-control.ts (SessionReadiness) — the pure renderer that consumes it.
 */
export interface SessionReadiness {
  /** Can a start/stop dispatch actually succeed right now? false ⇒ the control renders disabled with `reason`. */
  ready: boolean
  /** When !ready, the true human reason (hud-voice) — the disabled title AND the inline note. */
  reason?: string
  /** An honest capture sub-state shown WHILE live only (never disables — the session/text path still works). */
  capture?: { tone: 'rec' | 'warn'; note: string }
}

export interface BlockRenderArgs {
  block: Block
  result?: QueryResult
  now: NowContext
  clarify?: ClarifyRenderContext
  /** #136: the session-control readiness, threaded from the surface render input (see SurfaceRenderInput). */
  session?: SessionReadiness
}

/** A block renderer: pure `(config + hydrated data) → VNode(s)`. Returns null to render nothing. */
export type BlockRenderer = (args: BlockRenderArgs) => VNode | VNode[] | null

/** Registry keyed by BlockTypeName so Phase-6 custom blocks slot in without touching the renderer. */
export type BlockRegistry = Partial<Record<BlockTypeName, BlockRenderer>>

export interface SurfaceRenderInput {
  surface: Surface
  now: NowContext
  /** hydrated query results, parallel to surface.stack (undefined for query-less blocks like `now`) */
  results: readonly (QueryResult | undefined)[]
  /** #75 clarify session context, threaded to every block renderer (entity blocks consult it). */
  clarify?: ClarifyRenderContext
  /** #136 session-control readiness, threaded to the session-control block + the note-taker canvas control. */
  session?: SessionReadiness
}

/**
 * Render a surface DOCUMENT into the HUD panel — the whole point of the slice: the HUD is
 * `render(surfaceDocument)`, with NO hardcoded layout. This function knows nothing about "the HUD"
 * specifically; it walks the document's stack, applies each block's `show`/`collapsed`, dispatches to
 * the registered renderer by `block.block` (unknown types fall to the `custom` renderer), and stacks
 * the results. Two different documents therefore produce two different layouts with zero branching
 * here. `top` is applied per-block inside each list renderer (HUD shows top-K; workbench holds rest).
 */
export const renderSurface = (input: SurfaceRenderInput, registry: BlockRegistry): VElement => {
  const children: VNode[] = []
  input.surface.stack.forEach((block: Block, index: number) => {
    const show = block.show ?? 'always'
    const result = input.results[index]
    if (show === 'manual') return // no manual-toggle affordance in this slice (documented)
    if (show === 'on-match' && (!result || result.items.length === 0)) return
    const renderer = registry[block.block] ?? registry.custom
    if (!renderer) return
    const node = renderer({ block, now: input.now, ...(result !== undefined ? { result } : {}), ...(input.clarify !== undefined ? { clarify: input.clarify } : {}), ...(input.session !== undefined ? { session: input.session } : {}) })
    if (Array.isArray(node)) children.push(...node)
    else if (node) children.push(node)
  })
  return h('div', { class: 'hud' }, ...children)
}
