export type Range = '15m' | '1h' | '24h' | '7d' | 'all'

export const RANGES: { value: Range; label: string }[] = [
  { value: '15m', label: '15m' },
  { value: '1h', label: '1h' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: 'all', label: 'All' },
]

const RANGE_MS: Record<Exclude<Range, 'all'>, number> = {
  '15m': 15 * 60_000,
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
}

/** ISO lower bound for a range, or undefined for "all". Computed per request so live mode slides forward. */
export function sinceFor(range: Range, now: number = Date.now()): string | undefined {
  return range === 'all' ? undefined : new Date(now - RANGE_MS[range]).toISOString()
}

/** "just now", "12s ago", "5m ago", "3h ago", "2d ago", then a short date. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000)
  if (Number.isNaN(seconds)) return iso
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d ago`
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/** Full local timestamp with milliseconds and zone, for tooltips and the detail drawer. */
export function fullTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, timeZoneName: 'short',
  })
}
