import type { Mode, PromptTemplate } from '@openinfo/contracts'
import type { WorkspaceRegistry } from '../store/index.js'
import { defaultDistillTemplate, defaultEntitiesTemplate, defaultExtractTemplate, defaultMeetingMode } from './defaults.js'

const TEMPLATE_KIND = 'prompt-template'
const MODE_KIND = 'mode'

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
}
