/**
 * Format an ISO timestamp as the HUD's compact clock (design/renderings/hud-v2.html: "2:44p").
 * Uses UTC so the rendered output is deterministic regardless of the host timezone — the live HUD
 * shell can localize later; the renderer stays pure and testable.
 */
export const clockLabel = (iso: string): string => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  let hour = d.getUTCHours()
  const minute = d.getUTCMinutes()
  const meridiem = hour >= 12 ? 'p' : 'a'
  hour %= 12
  if (hour === 0) hour = 12
  return `${hour}:${String(minute).padStart(2, '0')}${meridiem}`
}

/** Whole-minute elapsed label between two ISO instants, e.g. "31m" / "1h 4m". */
export const elapsedLabel = (startIso: string, now: Date): string => {
  const start = new Date(startIso).getTime()
  if (Number.isNaN(start)) return ''
  const mins = Math.max(0, Math.floor((now.getTime() - start) / 60_000))
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}
