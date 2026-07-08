import { randomUUID } from 'node:crypto'
import type { Distillate, Draft, Dials, Mode, Moment, PromptTemplate, Session, VoiceBinding } from '@openinfo/contracts'
import { DRAFT_SCHEMA_VERSION } from '@openinfo/contracts'
import { FabricDocuments, invokeLlm, type SecretResolver } from '../fabric/index.js'
import type { WorkspaceRegistry } from '../store/index.js'
import { VoiceDocuments, compileVoiceVars, interpolateTemplate, resolveVoice, type VoiceScope } from '../voice/index.js'
import type { LlmInvoke } from '../distill/index.js'
import { ActDocuments } from './documents.js'

/** Glyphs mirror the HUD moment stream (● commitment ◆ question ▲ decision ✱ artifact). */
const MOMENT_GLYPH: Record<string, string> = {
  commitment: '●',
  question: '◆',
  decision: '▲',
  artifact: '✱',
  mention: '·',
  note: '·',
}

const renderMoments = (moments: readonly Moment[]): string =>
  moments.length === 0
    ? '(no typed moments captured)'
    : moments.map((m) => `${MOMENT_GLYPH[m.kind] ?? '·'} ${m.text}`).join('\n')

export interface ComposeInput {
  sessionId: string
  workspaceId: string
  /** the session's accumulated summaries — the draft is composed from these, not raw transcript */
  distillates: readonly Distillate[]
  moments: readonly Moment[]
  /** resolved voice vector: dials interpolate into the prompt; scope/registerId stamp the Draft */
  dials: Dials
  scope: VoiceScope
  registerId?: string
  templateId: string
  templateVersion?: number
}

export interface ComposeDeps {
  invoke: LlmInvoke
  template: PromptTemplate
  now?: () => Date
  newId?: () => string
  maxTokens?: number
  /** bounded in-call re-sample when the model returns an empty draft (default 2). */
  maxAttempts?: number
  log?: (message: string) => void
}

export interface ComposeResult {
  /** undefined when the session had nothing to draft, or the model returned only blank text. */
  draft?: Draft
  attempts: number
}

/**
 * Compose one follow-up draft from a session's accumulated distillates + moments — the Act v0 pass.
 * Pure and store-free/bus-free (like the distill extractors) so it unit-tests against a canned llm:
 * the Actor persists + publishes. PROSE output (not JSON), so only light cleanup — trim, and a
 * bounded re-sample if the model returns blank. A session with NO distillates AND no moments yields
 * no draft (a normal outcome, not an error). Transport failures from `invoke` propagate so the
 * caller can retry.
 */
export const composeFollowUpDraft = async (input: ComposeInput, deps: ComposeDeps): Promise<ComposeResult> => {
  const now = deps.now ?? (() => new Date())
  const newId = deps.newId ?? (() => randomUUID())
  const log = deps.log ?? (() => undefined)
  const maxAttempts = Math.max(1, deps.maxAttempts ?? 2)

  if (input.distillates.length === 0 && input.moments.length === 0) {
    return { attempts: 0 }
  }

  const prompt = interpolateTemplate(deps.template.body, {
    ...compileVoiceVars(input.dials),
    summaries: input.distillates.map((d) => `- ${d.text}`).join('\n'),
    moments: renderMoments(input.moments),
  })

  let attempts = 0
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt
    const result = await deps.invoke([{ role: 'user', content: prompt }], { maxTokens: deps.maxTokens ?? 700 })
    const body = result.text.trim()
    if (body.length === 0) {
      if (attempt < maxAttempts) {
        log(`follow-up draft: empty completion on attempt ${attempt}, re-sampling`)
        continue
      }
      log(`follow-up draft: empty after ${maxAttempts} attempts, no draft for session ${input.sessionId}`)
      return { attempts }
    }
    const draft: Draft = {
      id: newId(),
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      actKind: 'follow-up-draft',
      body,
      status: 'prepared',
      voice: {
        scope: input.scope,
        dials: input.dials,
        ...(input.registerId !== undefined ? { registerId: input.registerId } : {}),
      },
      provenance: {
        templateId: input.templateId,
        ...(input.templateVersion !== undefined ? { templateVersion: input.templateVersion } : {}),
        slot: result.slot,
        endpoint: result.endpoint,
        ...(result.model !== undefined ? { model: result.model } : {}),
        sourceDistillates: input.distillates.map((d) => d.id),
        sourceMoments: input.moments.map((m) => m.id),
      },
      schemaVersion: DRAFT_SCHEMA_VERSION,
      createdAt: now().toISOString(),
    }
    return { draft, attempts }
  }
  return { attempts }
}

export interface ActorDeps {
  store: WorkspaceRegistry
  voice: VoiceDocuments
  fabric: FabricDocuments
  docs: ActDocuments
  /** resolve the session's mode document (DistillDocuments owns modes); injectable for tests. */
  mode: (id: string) => Mode
  /** publish draft.created so it reaches WS clients; optional (tests may omit). */
  publish?: (draft: Draft) => void | Promise<void>
  invoke?: LlmInvoke
  /** resolve an endpoint's auth.keyRef at invoke time (bearer token injection); optional. */
  resolveKey?: SecretResolver
  now?: () => Date
  newId?: () => string
  log?: (message: string) => void
}

/**
 * The Act primitive's orchestrator (Act v0: the follow-up draft — the first Act node). Runs on
 * session end (see PHASE2-NOTES for the trigger + DAG decision): resolves the session's voice
 * (session register wins over the mode default, exactly like the distiller), reads the session's
 * stored distillates + moments via store/, composes ONE voice-interpolated draft, persists it, and
 * publishes draft.created. Only runs when the session's mode declares a follow-up-draft act.
 */
export class Actor {
  private readonly store: WorkspaceRegistry
  private readonly voice: VoiceDocuments
  private readonly fabric: FabricDocuments
  private readonly docs: ActDocuments
  private readonly mode: (id: string) => Mode
  private readonly publish: ((d: Draft) => void | Promise<void>) | undefined
  private readonly invoke: LlmInvoke
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly log: (message: string) => void

  constructor(deps: ActorDeps) {
    this.store = deps.store
    this.voice = deps.voice
    this.fabric = deps.fabric
    this.docs = deps.docs
    this.mode = deps.mode
    this.publish = deps.publish
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => randomUUID())
    this.log = deps.log ?? (() => undefined)
    const resolveKey = deps.resolveKey
    this.invoke =
      deps.invoke ?? ((messages, opts) => invokeLlm(this.fabric.load(), messages, resolveKey ? { ...opts, resolveKey } : opts))
  }

  async runFollowUpDraft(session: Session): Promise<Draft | undefined> {
    const mode = this.mode(session.modeId)
    if (!mode.acts.some((act) => act.kind === 'follow-up-draft')) {
      this.log(`follow-up draft: mode ${mode.id} declares no follow-up-draft act — skipping session ${session.id}`)
      return undefined
    }

    // Voice resolution mirrors the distiller: a session register is a session-scope binding that
    // wins over the mode-default (mode.registerId). Stored bindings come first, so an explicit
    // stored binding still out-ranks both synthesized ones. This is what makes the same meeting
    // read differently under boardroom vs sales-floor (the Phase-2 exit criterion).
    const registers = this.voice.registers()
    const storedBindings = this.voice.bindings()
    const modeDefault: VoiceBinding[] =
      mode.registerId !== undefined ? [{ scope: 'mode', targetId: mode.id, registerId: mode.registerId }] : []
    const sessionBinding: VoiceBinding[] =
      session.registerId !== undefined ? [{ scope: 'session', targetId: session.id, registerId: session.registerId }] : []
    const bindings = [...storedBindings, ...sessionBinding, ...modeDefault]
    const resolved = resolveVoice(registers, bindings, {
      sessionId: session.id,
      workspaceId: session.workspaceId,
      modeId: mode.id,
    })

    const distillates = this.store.listDistillates(session.workspaceId, session.id)
    const moments = this.store.listMoments(session.workspaceId, session.id)
    const { template, version } = this.docs.followUpTemplate()

    const { draft } = await composeFollowUpDraft(
      {
        sessionId: session.id,
        workspaceId: session.workspaceId,
        distillates,
        moments,
        dials: resolved.dials,
        scope: resolved.scope,
        ...(resolved.registerId !== undefined ? { registerId: resolved.registerId } : {}),
        templateId: template.id,
        ...(version !== undefined ? { templateVersion: version } : {}),
      },
      { invoke: this.invoke, template, now: this.now, newId: this.newId, maxTokens: mode.distill.tokenBudget, log: this.log },
    )

    if (!draft) {
      this.log(`follow-up draft: session ${session.id} produced no draft (no source distillates/moments)`)
      return undefined
    }
    this.store.saveDraft(draft)
    await this.publish?.(draft)
    this.log(
      `prepared follow-up draft ${draft.id} for session ${session.id} (${distillates.length} summaries, ${moments.length} moments) via ${draft.provenance.endpoint}`,
    )
    return draft
  }
}
