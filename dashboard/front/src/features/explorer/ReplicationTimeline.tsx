import type { ReplicationOut } from '@/api/types'
import { formatBytes, formatMillis } from '@/lib/explorer'
import { cn } from '@/lib/utils'

/** How long each replica took to show the change, read back through DBMesh like any client would. */
export function ReplicationTimeline({ replication }: { replication: ReplicationOut }) {
  const { readers, fallback_reads: fallbacks, note } = replication
  const slowest = Math.max(1, ...readers.map((r) => r.visible_after_ms ?? 0))

  return (
    <section aria-label="Replication" className="min-w-0">
      <h3 className="text-sm font-semibold">Replication</h3>
      <p className="mt-0.5 mb-3 text-xs text-muted-foreground">Time until each replica returns the change when read through DBMesh.</p>
      {readers.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">{note ?? 'Not measured.'}</p>
      ) : (
        <ul className="space-y-3">
          {readers.map((reader) => {
            const visible = reader.visible_after_ms !== null && reader.visible_after_ms !== undefined
            const width = visible ? Math.max(4, Math.round((reader.visible_after_ms! / slowest) * 100)) : 100
            return (
              <li key={reader.reader}>
                <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
                  <span className="font-medium">Replica {reader.reader}</span>
                  <span className={cn('font-mono', visible ? 'text-insert' : 'text-delete')}>
                    {visible ? `visible after ${formatMillis(reader.visible_after_ms!)}` : 'not visible yet'}
                  </span>
                </div>
                <div
                  role="img"
                  aria-label={visible ? `Replica ${reader.reader} showed the change after ${reader.visible_after_ms} milliseconds` : `Replica ${reader.reader} did not show the change`}
                  className="h-2 overflow-hidden rounded-full bg-muted"
                >
                  <div style={{ width: `${width}%` }} className={cn('h-full rounded-full', visible ? 'bg-insert' : 'bg-delete/45')} />
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {reader.stale_reads} stale {reader.stale_reads === 1 ? 'read' : 'reads'} before it caught up · {formatBytes(reader.lag_bytes)} behind when sampled
                </p>
              </li>
            )
          })}
        </ul>
      )}
      {readers.length > 0 && note && <p className="mt-3 text-xs text-update">{note}</p>}
      {fallbacks > 0 && readers.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">{fallbacks} {fallbacks === 1 ? 'read' : 'reads'} fell back to the primary while measuring.</p>
      )}
    </section>
  )
}
