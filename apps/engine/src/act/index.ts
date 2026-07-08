export { Actor, composeFollowUpDraft, type ActorDeps, type ComposeInput, type ComposeDeps, type ComposeResult } from './draft.js'
export { ActDocuments } from './documents.js'
export { defaultFollowUpTemplate, defaultTaskExtractTemplate } from './defaults.js'
export {
  TodoDocuments,
  TaskExtractor,
  composeTaskExtract,
  mergeTodoItems,
  renderTodo,
  type TaskExtractInput,
  type TaskExtractDeps,
  type TaskExtractResult,
  type TaskExtractorDeps,
} from './todo.js'
