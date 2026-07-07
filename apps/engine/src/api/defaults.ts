import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Flag } from '@openinfo/contracts'
import type { WorkspaceRegistry } from '../store/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const examplesDir = join(here, '..', '..', '..', '..', 'shared', 'contracts', 'examples')

export const loadDefaultFlags = (): Flag[] =>
  JSON.parse(readFileSync(join(examplesDir, 'flag.examples.json'), 'utf8')) as Flag[]

export const ensureDefaultFlags = (store: WorkspaceRegistry): Flag[] => {
  const flags = loadDefaultFlags()
  for (const flag of flags) {
    if (!store.layouts.getLatest<Flag>('flag', flag.key)) store.layouts.put('flag', flag.key, flag)
  }
  return flags
}
