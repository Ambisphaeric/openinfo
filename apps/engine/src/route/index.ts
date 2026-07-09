export { rerouteSession, type RerouteResult } from './reroute.js'
export {
  detectSwitch,
  DEFAULT_DETECTOR_CONFIG,
  type DetectorConfig,
  type DetectionResult,
  type Signal,
  type TimedFocusSignal,
  type TimedCalendarSignal,
  type TimedSignal,
} from './detector.js'
export { Attributor, type AttributorDeps, type AttributionEvent } from './attribute.js'
export { HintsDocuments } from './hints.js'
export { extractFocusSignals, isFocusChunk } from './focus.js'
export { decodeCalendarSample } from './calendar.js'
export {
  CalendarPoller,
  startCalendarCollector,
  sampleCalendarViaOsascript,
  CALENDAR_POLL_INTERVAL_MS,
  CALENDAR_SAMPLE_TIMEOUT_MS,
  type CalendarPollerDeps,
  type CalendarWiringApp,
  type CalendarWiringOptions,
} from './calendar-collector.js'
