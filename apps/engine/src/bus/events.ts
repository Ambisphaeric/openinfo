import type { CaptureChunk, Distillate, Draft, Entity, Fabric, Flag, Moment, QueueStatus, Session } from '@openinfo/contracts'

export interface EngineEvents {
  'capture.received': CaptureChunk
  'flag.changed': Flag
  'queue.updated': QueueStatus
  'distillate.updated': Distillate
  'moment.created': Moment
  'entity.updated': Entity
  'session.started': Session
  'session.ended': Session
  'session.switched': Session
  'session.rerouted': Session
  'draft.created': Draft
  'fabric.changed': Fabric
}
