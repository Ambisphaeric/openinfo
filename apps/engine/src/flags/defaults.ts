import type { Flag } from '@openinfo/contracts'

export const defaultFlags: readonly Flag[] = [
  {
    key: 'capture.sim',
    default: false,
    scope: 'engine',
    description: 'headless capture simulator for proving the client/engine seam',
    minTier: 'T0',
  },
  {
    key: 'fabric.http',
    default: false,
    scope: 'engine',
    description: 'HTTP fabric endpoint health and benchmark checks',
    minTier: 'T0',
  },
]
