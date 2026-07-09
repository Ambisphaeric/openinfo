/**
 * Format an ISO timestamp as the HUD's compact clock (design/renderings/hud-v2.html: "2:44p").
 * Renders in the viewer's local timezone so a human reads wall-clock time, not UTC. `timeZone` is an
 * explicit override: production callers omit it (viewer-local); tests pass a fixed zone for deterministic
 * assertions without process.env.TZ games; a future Settings timezone control has a ready seam here.
 */
export const clockLabel = (iso: string, timeZone?: string): string => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
  }).formatToParts(d)
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? ''
  const meridiem = part('dayPeriod').toLowerCase().startsWith('p') ? 'p' : 'a'
  return `${part('hour')}:${part('minute')}${meridiem}`
}

/** Whole-minute elapsed label between two ISO instants, e.g. "31m" / "1h 4m". */
export const elapsedLabel = (startIso: string, now: Date): string => {
  const start = new Date(startIso).getTime()
  if (Number.isNaN(start)) return ''
  const mins = Math.max(0, Math.floor((now.getTime() - start) / 60_000))
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}
