import type { Mode, PromptTemplate, SummaryLevel, SummaryScope } from '@openinfo/contracts'
import { Mode as ModeSchema, PromptTemplate as PromptTemplateSchema } from '@openinfo/contracts'
import { Value } from '@sinclair/typebox/value'
import type { WorkspaceRegistry } from '../store/index.js'
import { PREVIOUS_BUILTIN_BODIES, defaultAskTemplate, defaultDistillTemplate, defaultEntitiesTemplate, defaultExtractTemplate, defaultFieldTemplates, defaultJudgeTemplate, defaultMeetingMode, defaultOrientationTemplate, defaultSummaryTemplates } from './defaults.js'

const TEMPLATE_KIND = 'prompt-template'
const MODE_KIND = 'mode'

/** The context a summary template is resolved against (#177 slice 2) — the active workflow / app instance. */
export interface SummaryScopeContext {
  workflowId?: string
  appId?: string
}

/** Resolution precedence for a per-scope summary binding, most specific first (the voice-binding precedent). */
const SUMMARY_SCOPE_PRECEDENCE: readonly SummaryScope[] = ['app', 'workflow', 'workspace']

/** The context target a given binding scope matches against; workspace-global matches unconditionally. */
const summaryTargetFor = (scope: SummaryScope, ctx: SummaryScopeContext): string | undefined =>
  scope === 'app' ? ctx.appId : scope === 'workflow' ? ctx.workflowId : undefined

/** True ⇒ this binding is in force for the context (its declared scope's target matches, or it is workspace-global). */
const summaryBindingMatches = (template: PromptTemplate, scope: SummaryScope, ctx: SummaryScopeContext): boolean => {
  const declared = template.summary!.scope ?? 'workspace'
  if (declared !== scope) return false
  if (scope === 'workspace') return true
  const target = summaryTargetFor(scope, ctx)
  return target !== undefined && template.summary!.targetId === target
}

/**
 * Pick the summary template that governs a level in a context: the most-specific matching scope wins
 * (app > workflow > workspace). Pure — the caller supplies the candidate templates (all summary-binding
 * documents) and the context. Absent context ⇒ only the workspace-global binding matches, so a plain
 * install resolves exactly as before. Returns undefined when no binding produces the level at all.
 */
export const resolveSummaryTemplate = (
  templates: readonly PromptTemplate[],
  level: SummaryLevel,
  ctx: SummaryScopeContext = {},
): PromptTemplate | undefined => {
  const forLevel = templates.filter((t) => t.summary?.level === level)
  for (const scope of SUMMARY_SCOPE_PRECEDENCE) {
    const match = forLevel.find((t) => summaryBindingMatches(t, scope, ctx))
    if (match !== undefined) return match
  }
  return undefined
}

/** The shipped prompt templates, by seed order — the code fallback GET /templates/:id resolves against an
 * unseeded store, mirroring WorkflowDocuments' loadDefaultWorkflow fallback for `workflow-default`. The
 * three fast-field prompt documents (#61) are seeded alongside the distill/extract trio — they are the
 * SAME `prompt-template` kind, discriminated by `kind: 'field'` + a `field` binding. The summary prompt
 * documents (#177) join the same list — `kind: 'summary'` + a `summary` binding. */
const DEFAULT_TEMPLATES: readonly PromptTemplate[] = [defaultDistillTemplate, defaultExtractTemplate, defaultEntitiesTemplate, ...defaultFieldTemplates, defaultJudgeTemplate, defaultOrientationTemplate, defaultAskTemplate, ...defaultSummaryTemplates]

/**
 * Store-backed distill config docs (prompt templates + modes), consistent with FabricDocuments
 * and VoiceDocuments: versioned config records in _meta.db. Seeds shipped defaults only when
 * absent, so a user's edits are never clobbered.
 */
export class DistillDocuments {
  constructor(private readonly store: WorkspaceRegistry) {}

  ensureDefaults(): void {
    // The three window templates (#130): seed-if-absent, then a one-time neutral-body refresh for an
    // UNEDITED builtin left on an existing install. seedOrRefreshBuiltin never clobbers a user edit.
    this.seedOrRefreshBuiltin(defaultDistillTemplate)
    this.seedOrRefreshBuiltin(defaultExtractTemplate)
    this.seedOrRefreshBuiltin(defaultEntitiesTemplate)
    // Fast-field prompt documents (#61) — seeded like the distill trio; a user's edit is never clobbered.
    for (const field of defaultFieldTemplates) {
      if (!this.store.layouts.getLatest<PromptTemplate>(TEMPLATE_KIND, field.id)) {
        this.store.layouts.put(TEMPLATE_KIND, field.id, field)
      }
    }
    // The judge prompt document (#62) — the same seed-if-absent as the fast documents; it edits over the
    // same GET/PUT /templates routes. Present in the store need not mean it ever RUNS: the judge stage is
    // tier-gated on a judge-capable endpoint (see distill/judge.ts).
    if (!this.store.layouts.getLatest<PromptTemplate>(TEMPLATE_KIND, defaultJudgeTemplate.id)) {
      this.store.layouts.put(TEMPLATE_KIND, defaultJudgeTemplate.id, defaultJudgeTemplate)
    }
    // The orientation judge document (#131) — the same seed-if-absent as the verdict judge; it too is
    // tier-gated on a judge-capable endpoint and edits over the same GET/PUT /templates routes. judgeTemplates()
    // returns it (tier: 'judge'); the scheduler routes it by `produces: 'orientation'`.
    if (!this.store.layouts.getLatest<PromptTemplate>(TEMPLATE_KIND, defaultOrientationTemplate.id)) {
      this.store.layouts.put(TEMPLATE_KIND, defaultOrientationTemplate.id, defaultOrientationTemplate)
    }
    // The Ask face default-question document (empty send = "explain my screen") — seed-if-absent like the
    // fast/judge documents; the client reads its body over GET /templates/tpl-ask-default, a user edit
    // over PUT /templates/:id is never clobbered, and the read is fresh per send (no restart).
    if (!this.store.layouts.getLatest<PromptTemplate>(TEMPLATE_KIND, defaultAskTemplate.id)) {
      this.store.layouts.put(TEMPLATE_KIND, defaultAskTemplate.id, defaultAskTemplate)
    }
    // The hierarchical-summary prompt documents (#177) — one per live-loop level. Seed-if-absent, then the
    // same one-time unedited-builtin refresh the window templates use (#245): the summary bodies moved to the
    // human note-taking register, so an UNEDITED summary builtin left at its #177 body auto-upgrades while a
    // user edit is never clobbered. Each edits over the same GET/PUT /templates routes and is read fresh per
    // pass, so a user's edit to a level's cadence/bound/body still takes effect with no restart.
    for (const summaryTemplate of defaultSummaryTemplates) {
      this.seedOrRefreshBuiltin(summaryTemplate)
    }
    if (!this.store.layouts.getLatest<Mode>(MODE_KIND, defaultMeetingMode.id)) {
      this.store.layouts.put(MODE_KIND, defaultMeetingMode.id, defaultMeetingMode)
    }
  }

  /**
   * Seed a shipped window template if absent; else, on an existing install, refresh it to the new
   * shipped body ONLY when it is an UNEDITED builtin (#130). Seeds are seed-if-absent, so without this
   * an upgrader would keep the old voice-baked body forever. "Unedited" is detected CONSERVATIVELY:
   * the stored doc must still be at version 1 (any user PUT bumps the version off 1) AND its body must
   * be byte-for-byte the previous shipped body for this id (PREVIOUS_BUILTIN_BODIES). Either signal
   * failing ⇒ a user has taken ownership ⇒ leave it untouched. A refresh is itself a put(), bumping to
   * version 2, so it runs at most once (v2's body no longer matches the previous body, and v2 ≠ v1).
   */
  private seedOrRefreshBuiltin(template: PromptTemplate): void {
    const existing = this.store.layouts.getLatest<PromptTemplate>(TEMPLATE_KIND, template.id)
    if (!existing) {
      this.store.layouts.put(TEMPLATE_KIND, template.id, template)
      return
    }
    const previousBody = PREVIOUS_BUILTIN_BODIES[template.id]
    if (previousBody !== undefined && existing.version === 1 && existing.body.body === previousBody) {
      this.store.layouts.put(TEMPLATE_KIND, template.id, template)
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
   * Every fast-field prompt document (#61): the templates carrying a `field` binding — the fan-out
   * scheduler's work list. Derived from templates() (the SAME store list the GET /templates route reads),
   * so a user who authors or edits a `field`-kind template over PUT /templates/:id joins the fan-out with
   * no restart (the read-fresh seam). Not tier-filtered here: the scheduler runs `fast` and skips `judge`
   * (which has no confirm pass yet), so the whole binding set is returned and the scheduler decides.
   */
  fieldTemplates(): PromptTemplate[] {
    return this.templates().filter((t) => t.field !== undefined)
  }

  /**
   * Every judge prompt document (#62): the templates carrying a `judge`-tier `field` binding — the judge
   * scheduler's work list, the counterpart to fieldTemplates()'s fast set. Derived from templates() (the
   * SAME store list GET /templates reads), so a user who authors or edits a judge document over PUT
   * /templates/:id joins the review pass with no restart (the read-fresh seam). The fast fan-out already
   * skips these (it filters `tier !== 'fast'`), so a document is either a fast field or a judge, never both.
   */
  judgeTemplates(): PromptTemplate[] {
    return this.templates().filter((t) => t.field?.tier === 'judge')
  }

  /**
   * Every hierarchical-summary prompt document (#177): the templates carrying a `summary` binding — the
   * summary producer's per-level config + prompt. Derived from templates() (the SAME store list GET
   * /templates reads), so a user who authors or edits a summary document over PUT /templates/:id changes
   * that level's cadence/bound/prose with no restart (the read-fresh seam). Empty ⇒ no summary levels run.
   */
  summaryTemplates(): PromptTemplate[] {
    return this.templates().filter((t) => t.summary !== undefined)
  }

  /**
   * The summary prompt document for one level, RESOLVED for a scope context (#177 slice 2). Cadence/template
   * are configurable per workflow/app, not only workspace-global: a binding scoped `workflow`/`app` whose
   * `targetId` matches the context WINS over the workspace-global one for that level (precedence app >
   * workflow > workspace — the voice-binding precedent). Absent context ⇒ only the workspace-global binding
   * resolves, so the default install is unchanged. The winning template's `summary.scope` is the which-scope-won
   * audit the producer stamps onto every summary's provenance (`templateScope`).
   */
  summaryTemplate(level: SummaryLevel, ctx: SummaryScopeContext = {}): PromptTemplate | undefined {
    return resolveSummaryTemplate(this.summaryTemplates(), level, ctx)
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
