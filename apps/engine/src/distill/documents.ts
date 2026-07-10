import type { Mode, PromptTemplate } from '@openinfo/contracts'
import { Mode as ModeSchema, PromptTemplate as PromptTemplateSchema } from '@openinfo/contracts'
import { Value } from '@sinclair/typebox/value'
import type { WorkspaceRegistry } from '../store/index.js'
import { defaultDistillTemplate, defaultEntitiesTemplate, defaultExtractTemplate, defaultMeetingMode } from './defaults.js'

const TEMPLATE_KIND = 'prompt-template'
const MODE_KIND = 'mode'

/** The shipped prompt templates, by seed order — the code fallback GET /templates/:id resolves against an
 * unseeded store, mirroring WorkflowDocuments' loadDefaultWorkflow fallback for `workflow-default`. */
const DEFAULT_TEMPLATES: readonly PromptTemplate[] = [defaultDistillTemplate, defaultExtractTemplate, defaultEntitiesTemplate]

/**
 * Store-backed distill config docs (prompt templates + modes), consistent with FabricDocuments
 * and VoiceDocuments: versioned config records in _meta.db. Seeds shipped defaults only when
 * absent, so a user's edits are never clobbered.
 */
export class DistillDocuments {
  constructor(private readonly store: WorkspaceRegistry) {}

  ensureDefaults(): void {
    if (!this.store.layouts.getLatest<PromptTemplate>(TEMPLATE_KIND, defaultDistillTemplate.id)) {
      this.store.layouts.put(TEMPLATE_KIND, defaultDistillTemplate.id, defaultDistillTemplate)
    }
    if (!this.store.layouts.getLatest<PromptTemplate>(TEMPLATE_KIND, defaultExtractTemplate.id)) {
      this.store.layouts.put(TEMPLATE_KIND, defaultExtractTemplate.id, defaultExtractTemplate)
    }
    if (!this.store.layouts.getLatest<PromptTemplate>(TEMPLATE_KIND, defaultEntitiesTemplate.id)) {
      this.store.layouts.put(TEMPLATE_KIND, defaultEntitiesTemplate.id, defaultEntitiesTemplate)
    }
    if (!this.store.layouts.getLatest<Mode>(MODE_KIND, defaultMeetingMode.id)) {
      this.store.layouts.put(MODE_KIND, defaultMeetingMode.id, defaultMeetingMode)
    }
  }

  template(id: string = defaultDistillTemplate.id): PromptTemplate {
    return this.store.layouts.getLatest<PromptTemplate>(TEMPLATE_KIND, id)?.body ?? defaultDistillTemplate
  }

  extractTemplate(id: string = defaultExtractTemplate.id): PromptTemplate {
    return this.store.layouts.getLatest<PromptTemplate>(TEMPLATE_KIND, id)?.body ?? defaultExtractTemplate
  }

  entitiesTemplate(id: string = defaultEntitiesTemplate.id): PromptTemplate {
    return this.store.layouts.getLatest<PromptTemplate>(TEMPLATE_KIND, id)?.body ?? defaultEntitiesTemplate
  }

  mode(id: string = defaultMeetingMode.id): Mode {
    return this.store.layouts.getLatest<Mode>(MODE_KIND, id)?.body ?? defaultMeetingMode
  }

  /**
   * Every mode document (latest version of each). Backs GET /modes, mirroring how VoiceDocuments.registers()
   * backs GET /registers — a cheap read over the seeded config docs. The default meeting mode is always
   * seeded (ensureDefaults); the defensive unshift keeps it listed against an unseeded store.
   */
  modes(): Mode[] {
    const stored = this.store.layouts.latestOfKind<Mode>(MODE_KIND).map((doc) => doc.body)
    if (!stored.some((m) => m.id === defaultMeetingMode.id)) stored.unshift(defaultMeetingMode)
    return stored
  }

  /**
   * Every prompt-template document (latest version of each) — the GET /templates enumeration read,
   * mirroring modes() and WorkflowDocuments.list(). The three shipped defaults are seeded on
   * ensureDefaults(), so the list always carries them; the defensive fill keeps them listed even against
   * an unseeded store (as modes() does for the meeting mode).
   */
  templates(): PromptTemplate[] {
    const stored = this.store.layouts.latestOfKind<PromptTemplate>(TEMPLATE_KIND).map((doc) => doc.body)
    for (const dflt of DEFAULT_TEMPLATES) if (!stored.some((t) => t.id === dflt.id)) stored.push(dflt)
    return stored
  }

  /**
   * The stored prompt template for an id, falling back to the shipped default of that id, else undefined.
   * Backs GET /templates/:id: an unknown id ⇒ undefined ⇒ 404, exactly as WorkflowDocuments.get resolves
   * only `workflow-default` from code. NB: the pipeline readers use template()/extractTemplate()/
   * entitiesTemplate() which fall back to a default body; this by-id read does NOT, so the route can 404.
   */
  templateById(id: string): PromptTemplate | undefined {
    return this.store.layouts.getLatest<PromptTemplate>(TEMPLATE_KIND, id)?.body ?? DEFAULT_TEMPLATES.find((t) => t.id === id)
  }

  /**
   * Persist an edited prompt template. Contract-validated against PromptTemplate BEFORE write (the belt-
   * and-suspenders Tier-A gate WorkflowDocuments.save established — the PUT route validates too), so a
   * malformed body never lands. LayoutStore keeps every prior version (editable history). The pipeline
   * reads templates fresh per pass, so a saved edit takes effect with no restart (the read-fresh seam).
   */
  saveTemplate(template: PromptTemplate): PromptTemplate {
    const id = template.id
    if (!Value.Check(PromptTemplateSchema, template)) throw new Error(`prompt template failed contract validation: ${id}`)
    this.store.layouts.put(TEMPLATE_KIND, id, template)
    return template
  }

  /**
   * The stored mode for an id, falling back to the shipped meeting mode for its own id, else undefined —
   * the GET /modes/:id read (unknown ⇒ 404), symmetric with templateById and WorkflowDocuments.get.
   */
  modeById(id: string): Mode | undefined {
    return this.store.layouts.getLatest<Mode>(MODE_KIND, id)?.body ?? (id === defaultMeetingMode.id ? defaultMeetingMode : undefined)
  }

  /**
   * Persist an edited mode document — the write half GET/PUT /modes bind to (#23), fixing the read-only
   * drift (the route table already declared PUT /modes/:id). Contract-validated before write, versioned by
   * LayoutStore, read fresh by the pipeline. Mirrors saveTemplate / WorkflowDocuments.save.
   */
  saveMode(mode: Mode): Mode {
    const id = mode.id
    if (!Value.Check(ModeSchema, mode)) throw new Error(`mode failed contract validation: ${id}`)
    this.store.layouts.put(MODE_KIND, id, mode)
    return mode
  }
}
