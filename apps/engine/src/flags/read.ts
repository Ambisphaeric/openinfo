import type { Flag } from '@openinfo/contracts'
import type { WorkspaceRegistry } from '../store/index.js'

/**
 * Read a flag's effective value from the store. v0 reads the flag document's `default`; per-user
 * and per-context overrides layer on later (flags are documents, settable per context — P0 rule 3).
 * Unknown flags read false, so a feature behind a missing flag stays OFF.
 */
export const isFlagEnabled = (store: WorkspaceRegistry, key: string): boolean =>
  store.layouts.getLatest<Flag>('flag', key)?.body.default ?? false
