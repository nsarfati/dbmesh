import { ListFilter } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { RowEvent } from '@/api/types'
import { ChangesDiff } from '@/components/ChangesDiff'
import { CopyButton } from '@/components/CopyButton'
import { JsonView } from '@/components/JsonView'
import { OperationBadge } from '@/components/OperationBadge'
import { Button } from '@/components/ui/button'
import { Sheet } from '@/components/ui/sheet'
import { fullTime, relativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'

function Meta({ label, copy, children }: { label: string; copy?: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="flex h-5 items-center gap-1 text-xs font-medium text-muted-foreground">
        {label}
        {copy && <CopyButton value={copy} label={label.toLowerCase()} className="size-5" />}
      </dt>
      <dd className="mt-0.5 min-w-0 text-sm">{children}</dd>
    </div>
  )
}

const Mono = ({ children }: { children: ReactNode }) => <span className="min-w-0 font-mono text-[13px] [overflow-wrap:anywhere]">{children}</span>
const Empty = () => <span className="text-muted-foreground">—</span>

type Tab = 'before' | 'after'

function RawTabs({ event }: { event: RowEvent }) {
  const [tab, setTab] = useState<Tab>(event.operation === 'DELETE' ? 'before' : 'after')
  const tabs: { id: Tab; label: string; value: unknown }[] = [
    { id: 'before', label: 'Before', value: event.previous },
    { id: 'after', label: 'After', value: event.new },
  ]
  const current = tabs.find((t) => t.id === tab)!
  return (
    <div>
      <div role="tablist" aria-label="Row image" className="mb-2 inline-flex rounded-md border border-input bg-muted p-0.5">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn('h-7 rounded-[5px] px-3 text-xs font-medium transition-colors', tab === t.id ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground')}
          >
            {t.label}
          </button>
        ))}
      </div>
      {current.value ? (
        <JsonView value={current.value} label={`Row ${current.id} the change`} />
      ) : (
        <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
          {event.operation === 'INSERT' ? 'A new row has no previous image.' : 'A deleted row has no new image.'}
        </p>
      )}
    </div>
  )
}

interface Props {
  event: RowEvent | null
  loading: boolean
  notFound: boolean
  now: number
  onClose: () => void
  onFilterRequest: (requestId: string) => void
}

export function EventSheet({ event, loading, notFound, now, onClose, onFilterRequest }: Props) {
  const open = event !== null || loading || notFound
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={
        event ? (
          <span className="flex flex-wrap items-center gap-2">
            <OperationBadge operation={event.operation} />
            <span className="font-mono text-[15px]">{event.schema}.{event.table}</span>
          </span>
        ) : (
          'Event'
        )
      }
      description={
        event ? (
          <time dateTime={event.created_at} className="flex flex-wrap gap-x-2">
            <span>{relativeTime(event.created_at, now)}</span>
            <span aria-hidden className="hidden sm:inline">·</span>
            <span className="whitespace-nowrap">{fullTime(event.created_at)}</span>
          </time>
        ) : undefined
      }
    >
      {event ? (
        <div className="space-y-6 px-5 py-5">
          <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            <Meta label="Event ID" copy={event.event_id}><Mono>{event.event_id}</Mono></Meta>
            <Meta label="Request ID" copy={event.request_id ?? undefined}>{event.request_id ? <Mono>{event.request_id}</Mono> : <Empty />}</Meta>
            <Meta label="User">{event.user_id ? <Mono>{event.user_id}</Mono> : <Empty />}</Meta>
            <Meta label="Service">{event.service ? <span>{event.service}</span> : <Empty />}</Meta>
            <Meta label="Database"><Mono>{event.db}</Mono></Meta>
          </dl>

          {event.request_id && (
            <Button size="sm" onClick={() => onFilterRequest(event.request_id!)}>
              <ListFilter aria-hidden className="size-3.5" />
              Show every event of this request
            </Button>
          )}

          <section aria-labelledby="changes-heading">
            <h3 id="changes-heading" className="mb-2 text-sm font-semibold">
              {event.operation === 'UPDATE' ? 'Changed fields' : event.operation === 'INSERT' ? 'Inserted values' : 'Deleted values'}
            </h3>
            <div className="overflow-hidden rounded-lg border"><ChangesDiff event={event} /></div>
          </section>

          <section aria-labelledby="raw-heading">
            <h3 id="raw-heading" className="mb-2 text-sm font-semibold">Full row</h3>
            <RawTabs key={event.event_id} event={event} />
          </section>
        </div>
      ) : notFound ? (
        <p className="px-5 py-10 text-center text-sm text-muted-foreground">This event no longer exists, or the link is wrong.</p>
      ) : (
        <p className="px-5 py-10 text-center text-sm text-muted-foreground" role="status">Loading event…</p>
      )}
    </Sheet>
  )
}
