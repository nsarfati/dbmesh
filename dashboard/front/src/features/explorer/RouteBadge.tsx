import { TriangleAlert } from 'lucide-react'
import type { RouteOut } from '@/api/types'
import { formatBytes, formatMicros } from '@/lib/explorer'
import { cn } from '@/lib/utils'

/** Where DBMesh ran a statement, with the reader's monitored lag and how long it took. */
export function RouteBadge({ route, className }: { route: RouteOut | null | undefined; className?: string }) {
  if (!route) return <span className={cn('text-xs text-muted-foreground', className)}>route unknown</span>
  const replica = route.target === 'replica'
  return (
    <span
      title={route.reason}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        replica ? 'bg-teal-500/12 text-teal-700 ring-teal-500/25 dark:text-teal-300' : 'bg-primary/10 text-primary ring-primary/25',
        className,
      )}
    >
      <span aria-hidden className={cn('size-1.5 rounded-full', replica ? 'bg-teal-500' : 'bg-primary')} />
      {replica ? `replica ${route.reader}` : 'primary'}
      {replica && route.lag_bytes !== null && route.lag_bytes !== undefined && (
        <span className="font-normal opacity-80">· {formatBytes(route.lag_bytes)} behind</span>
      )}
      {route.fallback && (
        <span className="inline-flex items-center gap-0.5 font-normal text-update" title="No reader was eligible, so the primary served this read">
          <TriangleAlert aria-hidden className="size-3" />
          fallback
        </span>
      )}
      <span className="font-normal opacity-70">· {formatMicros(route.duration_us)}</span>
    </span>
  )
}
