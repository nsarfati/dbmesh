import { ArrowRight } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import type { RowEvent } from '@/api/types'
import { CopyButton } from '@/components/CopyButton'
import { OperationBadge } from '@/components/OperationBadge'
import { ValueText } from '@/components/ValueText'
import { summarize } from '@/lib/changes'
import { fullTime, relativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'

function Summary({ event }: { event: RowEvent }) {
  const { row, shown, hidden, fields } = summarize(event)
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs">
      {row && <span className="text-muted-foreground">{row}</span>}
      {event.operation === 'UPDATE' ? (
        <>
          {shown.map((change) => (
            <span key={change.field} className="inline-flex min-w-0 items-center gap-1.5">
              <span className="text-muted-foreground">{change.field}</span>
              <span className="rounded bg-delete/10 px-1 text-delete line-through decoration-delete/50"><ValueText value={change.before} className="text-delete!" /></span>
              <ArrowRight aria-hidden className="size-3 shrink-0 text-muted-foreground" />
              <span className="rounded bg-insert/10 px-1"><ValueText value={change.after} className="text-insert!" /></span>
            </span>
          ))}
          {hidden > 0 && <span className="text-muted-foreground">+{hidden} more</span>}
        </>
      ) : (
        <span className="text-muted-foreground">
          {event.operation === 'INSERT' ? 'new row' : 'row removed'} · {fields} {fields === 1 ? 'field' : 'fields'}
        </span>
      )}
    </div>
  )
}

interface Props {
  events: RowEvent[]
  selectedId: string | null
  onSelect: (event: RowEvent) => void
  now: number
}

export function EventsTable({ events, selectedId, onSelect, now }: Props) {
  const open = (event: RowEvent) => onSelect(event)
  const onKey = (event: RowEvent) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      open(event)
    }
  }

  return (
    <>
      <ul aria-label="Events" className="divide-y md:hidden">
        {events.map((event) => (
          <li key={event.event_id}>
            <button
              type="button"
              onClick={() => open(event)}
              aria-label={`${event.operation} ${event.schema}.${event.table}, ${relativeTime(event.created_at, now)}. Open details`}
              className={cn('block w-full px-4 py-3 text-left transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-offset-[-2px]', event.event_id === selectedId && 'bg-primary/8')}
            >
              <span className="flex items-center gap-2">
                <OperationBadge operation={event.operation} />
                <span className="min-w-0 truncate font-mono text-[13px]"><span className="text-muted-foreground">{event.schema}.</span>{event.table}</span>
                <time dateTime={event.created_at} className="ml-auto shrink-0 text-xs text-muted-foreground">{relativeTime(event.created_at, now)}</time>
              </span>
              <span className="mt-2 block"><Summary event={event} /></span>
              {(event.user_id || event.service) && (
                <span className="mt-1.5 block truncate text-xs text-muted-foreground">
                  {[event.user_id && `user ${event.user_id}`, event.service].filter(Boolean).join(' · ')}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    <div className="hidden overflow-x-auto md:block">
      <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b text-xs font-medium text-muted-foreground">
            <th scope="col" className="w-28 px-4 py-2.5 font-medium">Time</th>
            <th scope="col" className="w-24 px-2 py-2.5 font-medium">Operation</th>
            <th scope="col" className="px-2 py-2.5 font-medium">Table</th>
            <th scope="col" className="px-2 py-2.5 font-medium">Changes</th>
            <th scope="col" className="hidden px-2 py-2.5 font-medium lg:table-cell">User</th>
            <th scope="col" className="hidden px-2 py-2.5 font-medium md:table-cell">Request</th>
            <th scope="col" className="hidden px-4 py-2.5 font-medium xl:table-cell">Service</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr
              key={event.event_id}
              tabIndex={0}
              aria-label={`${event.operation} ${event.schema}.${event.table}, ${relativeTime(event.created_at, now)}. Open details`}
              aria-selected={event.event_id === selectedId}
              onClick={() => open(event)}
              onKeyDown={onKey(event)}
              className={cn(
                'cursor-pointer border-b last:border-b-0 transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-offset-[-2px]',
                event.event_id === selectedId && 'bg-primary/8',
              )}
            >
              <td className="px-4 py-3 align-top whitespace-nowrap text-muted-foreground" title={fullTime(event.created_at)}>
                <time dateTime={event.created_at}>{relativeTime(event.created_at, now)}</time>
              </td>
              <td className="px-2 py-3 align-top"><OperationBadge operation={event.operation} /></td>
              <td className="px-2 py-3 align-top font-mono text-[13px] whitespace-nowrap">
                <span className="text-muted-foreground">{event.schema}.</span>{event.table}
              </td>
              <td className="px-2 py-3 align-top"><Summary event={event} /></td>
              <td className="hidden px-2 py-3 align-top font-mono text-[13px] whitespace-nowrap lg:table-cell">
                {event.user_id ?? <span className="text-muted-foreground">—</span>}
              </td>
              <td className="hidden px-2 py-3 align-top md:table-cell">
                {event.request_id ? (
                  <span className="inline-flex items-center gap-1 font-mono text-[13px]">
                    <span className="max-w-40 truncate" title={event.request_id}>{event.request_id}</span>
                    <CopyButton value={event.request_id} label="request ID" />
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
              <td className="hidden px-4 py-3 align-top text-[13px] whitespace-nowrap xl:table-cell">
                {event.service ?? <span className="text-muted-foreground">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </>
  )
}

export function EventsTableSkeleton() {
  return (
    <div aria-hidden className="divide-y">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-4">
          <div className="h-3 w-16 animate-pulse rounded bg-muted" />
          <div className="h-5 w-16 animate-pulse rounded-full bg-muted" />
          <div className="h-3 w-32 animate-pulse rounded bg-muted" />
          <div className="h-3 flex-1 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  )
}
