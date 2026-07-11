import type { BlockRegistry } from '../block-renderer/registry.js'
import { renderNow } from './now.js'
import { renderRelevantNow } from './relevant-now.js'
import { renderMoments } from './moments.js'
import { renderLedger } from './ledger.js'
import { renderHint } from './hint.js'
import { renderPinnedDoc } from './pinned-doc.js'
import { renderAsk } from './ask.js'
import { renderTodos } from './todos.js'
import { renderDrafts } from './drafts.js'
import { renderTeach } from './teach.js'
import { renderDistillates } from './distillates.js'
import { renderFields } from './fields.js'
import { renderQueue } from './queue.js'
import { renderTranscriptInspector } from './transcript-inspector.js'
import { renderSenseGates } from './sense-gates.js'
import { renderInput } from './input.js'
import { renderCustom } from './custom.js'

export { momentGlyph, entityGlyph } from './glyphs.js'
export { actionButtons, glyphStrip, rowAffordances, GLYPH_VERBS, type ActionPayload } from './actions.js'

/**
 * The built-in block registry — one renderer per BlockTypeName (append-only). `custom` doubles as the
 * fallback for any block type a given client build lacks a renderer for (renderSurface routes unknown
 * types to it), so a forward document never breaks the render. A user could swap or extend this map
 * without touching renderSurface — the Phase-6 custom-block seam.
 */
export const defaultBlockRegistry: BlockRegistry = {
  now: renderNow,
  'relevant-now': renderRelevantNow,
  moments: renderMoments,
  ledger: renderLedger,
  hint: renderHint,
  'pinned-doc': renderPinnedDoc,
  ask: renderAsk,
  todos: renderTodos,
  drafts: renderDrafts,
  teach: renderTeach,
  distillates: renderDistillates,
  fields: renderFields,
  queue: renderQueue,
  'transcript-inspector': renderTranscriptInspector,
  'sense-gates': renderSenseGates,
  input: renderInput,
  custom: renderCustom,
}
