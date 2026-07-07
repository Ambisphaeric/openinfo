import type { CaptureChunk, Distillate, Flag, Moment, QueueStatus } from '@openinfo/contracts'

export interface EngineEvents {
  'capture.received': CaptureChunk
  'flag.changed': Flag
  'queue.updated': QueueStatus
  'distillate.updated': Distillate
  'moment.created': Moment
}
