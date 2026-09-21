import { useState } from 'react'
import { fullDiff } from '@/lib/changes'
import type { RowEvent } from '@/api/types'
import { cn } from '@/lib/utils'
import { ValueText } from './ValueText'

function Line({ sign, value }: { sign: '+' | '−'; value: unknown }) {
  const add = sign === '+'
  return (
    <div className={cn('flex gap-2 rounded px-2 py-1', add ? 'bg-insert/10' : 'bg-delete/10')}>
      <span aria-hidden className={cn('w-3 shrink-0 select-none', add ? 'text-insert' : 'text-delete')}>{sign}</span>
      <span className="sr-only">{add ? 'after' : 'before'}</span>
      <ValueText value={value} className="min-w-0" />
    </div>
  )
}

/** Field-level before/after for one event. */
export function ChangesDiff({ event }: { event: Pick<RowEvent, 'operation' | 'previous' | 'new'> }) {
  const [showUnchanged, setShowUnchanged] = useState(false)
  const rows = fullDiff(event)
  const unchanged = rows.filter((row) => row.unchanged)
  const visible = rows.filter((row) => showUnchanged || !row.unchanged)

  if (rows.length === 0) return <p className="px-4 py-3 text-sm text-muted-foreground">This event recorded no field values.</p>

  return (
    <div>
      <ul className="divide-y">
        {visible.map((row) => (
          <li key={row.field} className="grid gap-1 px-4 py-2.5 sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)] sm:gap-3">
            <span className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere] sm:pt-1">{row.field}</span>
            {row.unchanged ? (
              <div className="px-2 py-1 font-mono text-[13px] text-muted-foreground"><ValueText value={row.after} /></div>
            ) : (
              <div className="space-y-1 font-mono text-[13px]">
                {event.operation !== 'INSERT' && <Line sign="−" value={row.before} />}
                {event.operation !== 'DELETE' && <Line sign="+" value={row.after} />}
              </div>
            )}
          </li>
        ))}
      </ul>
      {unchanged.length > 0 && (
        <button
          type="button"
          onClick={() => setShowUnchanged((v) => !v)}
          aria-expanded={showUnchanged}
          className="w-full border-t px-4 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
        >
          {showUnchanged ? 'Hide' : 'Show'} {unchanged.length} unchanged {unchanged.length === 1 ? 'field' : 'fields'}
        </button>
      )}
    </div>
  )
}
