import type { PromptTemplate } from '@openinfo/contracts'
import type { WorkspaceRegistry } from '../store/index.js'
import { defaultFollowUpTemplate } from './defaults.js'

const TEMPLATE_KIND = 'prompt-template'

/**
 * Store-backed act config docs (the follow-up prompt template), consistent with DistillDocuments/
 * VoiceDocuments: versioned config records in _meta.db under the shared `prompt-template` kind
 * (templates are distinguished by id, not by a separate store kind). Seeds the shipped default only
 * when absent, so a user's edits are never clobbered. Exposes the template WITH its stored version
 * so the composed Draft's provenance can record which template version ran.
 */
export class ActDocuments {
  constructor(private readonly store: WorkspaceRegistry) {}

  ensureDefaults(): void {
    if (!this.store.layouts.getLatest<PromptTemplate>(TEMPLATE_KIND, defaultFollowUpTemplate.id)) {
      this.store.layouts.put(TEMPLATE_KIND, defaultFollowUpTemplate.id, defaultFollowUpTemplate)
    }
  }

  followUpTemplate(id: string = defaultFollowUpTemplate.id): { template: PromptTemplate; version?: number } {
    const stored = this.store.layouts.getLatest<PromptTemplate>(TEMPLATE_KIND, id)
    return stored ? { template: stored.body, version: stored.version } : { template: defaultFollowUpTemplate }
  }
}
