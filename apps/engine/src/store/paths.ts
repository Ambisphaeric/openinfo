import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const defaultDataDir = (): string => join(homedir(), '.openinfo', 'data')

export const resolveDataDir = (override?: string): string =>
  resolve(override ?? process.env['OPENINFO_DATA'] ?? defaultDataDir())
