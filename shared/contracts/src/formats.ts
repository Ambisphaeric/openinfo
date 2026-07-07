import { FormatRegistry } from '@sinclair/typebox'

// Registered at import time so Value.Check works identically in every consumer.
const ISO_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

if (!FormatRegistry.Has('date-time')) {
  FormatRegistry.Set('date-time', (v) => ISO_DATE_TIME.test(v))
}
