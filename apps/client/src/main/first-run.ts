/**
 * First-run assembly logic — decide whether to open the engine's `/setup` page in the browser ONCE on
 * launch. Pure (no electron, no fs) so the once-only rule is asserted headless; the shell (shell.ts) owns
 * the browser open and persists the timestamp via first-run-store.ts.
 *
 * THE RULE: on launch, if the engine is reachable AND its live fabric's llm slot is empty (the
 * established `needsModelSetup` signal — nothing can distill without a model), open `/setup` in the
 * default browser so a brand-new user lands on onboarding without hunting the tray. Do it AT MOST ONCE
 * per fresh state: a `firstRunShownAt` timestamp is persisted client-local, and once set we never
 * auto-open again (the ⚠ tray prominence stays as the always-available nudge). If the engine is NOT
 * reachable at launch we open nothing (there is no /setup to show) — the tray leads with the honest
 * "engine unreachable" state instead.
 */
export interface FirstRunState {
  /** ISO timestamp of when /setup was first auto-opened. Absent ⇒ never auto-opened. */
  firstRunShownAt?: string
  /**
   * ISO timestamp of when we FIRST proactively asked the OS for microphone access (the once-only
   * first-launch TCC prompt — a capture app asks for the mic at first open, not only when a session
   * starts). Absent ⇒ never proactively asked, so the next launch fires the prompt once. Independent of
   * firstRunShownAt: the mic ask fires at first launch regardless of engine/model state (see shell.ts).
   */
  micPromptedAt?: string
}

/**
 * Should the shell auto-open `/setup` right now? True iff the engine is reachable, its llm slot is empty
 * (needsModelSetup === true), and we have not already auto-opened. `needsModelSetup` may be undefined
 * (fabric not yet fetched) — that is NOT a yes (we don't nag before we know).
 */
export const shouldOpenSetup = (opts: {
  engineReachable: boolean
  needsModelSetup: boolean | undefined
  alreadyShown: boolean
}): boolean => opts.engineReachable && opts.needsModelSetup === true && !opts.alreadyShown

/**
 * Should the shell PROACTIVELY ask for microphone access on this launch? True iff we have never asked
 * before (once-only). Unlike shouldOpenSetup this does NOT depend on the engine or the model state — the
 * mic popup should appear at first open like any capture app; a denial degrades harmlessly (the capture
 * paths already handle it). The shell guards the platform (only macOS has a triggerable TCC prompt).
 */
export const shouldPromptMic = (opts: { alreadyPrompted: boolean }): boolean => !opts.alreadyPrompted

/** Parse persisted first-run state — junk/missing ⇒ empty. Pure, for a headless round-trip. */
export const parseFirstRunState = (raw: unknown): FirstRunState => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const obj = raw as Record<string, unknown>
  const state: FirstRunState = {}
  if (typeof obj['firstRunShownAt'] === 'string') state.firstRunShownAt = obj['firstRunShownAt']
  if (typeof obj['micPromptedAt'] === 'string') state.micPromptedAt = obj['micPromptedAt']
  return state
}

/** Serialize first-run state to the on-disk JSON shape. */
export const serializeFirstRunState = (state: FirstRunState): string => JSON.stringify(state)
