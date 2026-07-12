import type { PromptTemplate } from '@openinfo/contracts'
import type { WorkspaceRegistry } from '../store/index.js'
import { defaultPresets } from './defaults.js'

/** Presets are `preset`-kind PromptTemplate documents — they live in the SAME store kind as the
 * distill/extract/field templates so they enumerate and edit over the existing /templates routes. */
const TEMPLATE_KIND = 'prompt-template'

/**
 * Store-backed CONTEXT preset documents (pill P2), consistent with DistillDocuments / BundleDocuments:
 * versioned prompt-template records in _meta.db, seeded seed-if-absent so a user's edit is never clobbered.
 *
 * Presets are NOT a new doc kind — they are prompt-template documents discriminated by `kind: 'preset'`,
 * so GET /templates lists them and PUT /templates/:id edits them with no new route or editing UI ("defaults
 * are just documents we ship"). This class adds only the preset-shaped reads on top of that substrate:
 * `list`/`get` (filtered to kind 'preset'), the `isPreset` validity gate the PUT /active-preset route uses,
 * and — the centerpiece — `resolveActive`, the ONE "resolve the workspace's active preset if set" read that
 * both the distiller (injection) and the chat context-assembly path (P1) consume, so injection and chat
 * agree on exactly one source of truth. The selection itself is per-workspace store state
 * (WorkspaceRegistry.getActivePreset/setActivePreset); this class is the resolver over it.
 */
export class PresetDocuments {
  constructor(private readonly store: WorkspaceRegistry) {}

  /** Seed the five shipped presets when absent (never clobbers a user edit) — mirrors the sibling doc kinds. */
  ensureDefaults(): void {
    for (const preset of defaultPresets) {
      if (!this.store.layouts.getLatest<PromptTemplate>(TEMPLATE_KIND, preset.id)) {
        this.store.layouts.put(TEMPLATE_KIND, preset.id, preset)
      }
    }
  }

  /**
   * Every preset — the latest stored version of each `preset`-kind prompt-template document, with the five
   * shipped defaults filled in against an unseeded store (mirrors DistillDocuments.templates()). This is
   * what a preset picker reads; the client UI is a later slice, but the read is honest now.
   */
  list(): PromptTemplate[] {
    const stored = this.store.layouts
      .latestOfKind<PromptTemplate>(TEMPLATE_KIND)
      .map((doc) => doc.body)
      .filter((template) => template.kind === 'preset')
    for (const dflt of defaultPresets) if (!stored.some((t) => t.id === dflt.id)) stored.push(dflt)
    return stored
  }

  /**
   * A preset by id — store-first (so a user's PUT /templates/:id edit wins), code fallback for a shipped
   * preset id, else undefined. Guards on `kind: 'preset'`: an id that resolves to a NON-preset template
   * (e.g. tpl-distill-default) is not a preset, so this returns undefined — injection and the PUT gate
   * never treat an ordinary template as a context preset.
   */
  get(id: string): PromptTemplate | undefined {
    const stored = this.store.layouts.getLatest<PromptTemplate>(TEMPLATE_KIND, id)?.body
    if (stored) return stored.kind === 'preset' ? stored : undefined
    return defaultPresets.find((preset) => preset.id === id)
  }

  /** True when the id resolves to a live preset document — the PUT /active-preset validity gate (else 400). */
  isPreset(id: string): boolean {
    return this.get(id) !== undefined
  }

  /** The raw stored selection id (or undefined) — the low-level per-workspace seam GET /active-preset
   * echoes and P1 may read directly. `resolveActive` is the resolved-document counterpart. */
  activeId(workspaceId: string): string | undefined {
    return this.store.getActivePreset(workspaceId)
  }

  /**
   * Resolve the workspace's ACTIVE preset document if one is set, else undefined — the narrow read the
   * distiller prepends from and P1 gathers the `active-preset` chat source from. Degradable by design:
   * unset ⇒ undefined; a selection whose preset was since deleted ⇒ undefined (get returns undefined) ⇒
   * no injection, never an error.
   */
  resolveActive(workspaceId: string): PromptTemplate | undefined {
    const id = this.store.getActivePreset(workspaceId)
    return id !== undefined ? this.get(id) : undefined
  }

  /**
   * Persist the workspace's active-preset selection (undefined clears it). Existence is validated by the
   * caller (the PUT route → 400 via isPreset) — this just writes through to the store, mirroring how the
   * store persists an egress policy without re-deriving it.
   */
  setActive(workspaceId: string, presetId: string | undefined): void {
    this.store.setActivePreset(workspaceId, presetId)
  }
}
