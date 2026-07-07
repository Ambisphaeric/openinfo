import type { CaptureChunk, Distillate, Flag, QueueStatus } from '@openinfo/contracts'

export interface EngineEvents {
  'capture.received': CaptureChunk
  'flag.changed': Flag
  'queue.updated': QueueStatus
  'distillate.updated': Distillate
}
