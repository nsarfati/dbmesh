import { Inbox, Loader2, RefreshCw, SearchX } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ApiError } from '@/api/client'
import { PAGE_SIZE, useEvent, useEvents, useFacets } from '@/api/hooks'
import type { RowEvent } from '@/api/types'
import { EmptyState, ErrorBanner } from '@/components/Feedback'
import { Button } from '@/components/ui/button'
import { EventSheet } from '@/features/audit/EventSheet'
import { EventsTable, EventsTableSkeleton } from '@/features/audit/EventsTable'
import { FilterBar } from '@/features/audit/FilterBar'
import { activeFilterCount, DEFAULT_FILTERS, parseFilters, toSearchParams, type Filters } from '@/lib/filters'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'

const SNIPPET = `import dbmesh

dsn = "postgresql://dbmesh@localhost:6432/demo?audit=public.users"
with dbmesh.connect(dsn) as conn:
    with conn.request(user_id="812", request_id="req-1", service="billing"):
        conn.execute("UPDATE users SET plan = 'pro' WHERE id = 1")`

export function AuditLog() {
  const [params, setParams] = useSearchParams()
  const filters = useMemo(() => parseFilters(params), [params])
  const selectedId = params.get('event')
  const [live, setLive] = useState(false)
  const now = useNow()

  const events = useEvents(filters, live)
  const facets = useFacets()
  const rows = useMemo(() => events.data?.pages.flatMap((page) => page.events) ?? [], [events.data])

  // A link can open an event that is not on a loaded page; fetch it directly.
  const loaded = rows.find((event) => event.event_id === selectedId) ?? null
  const single = useEvent(selectedId, selectedId !== null && loaded === null)
  const selected: RowEvent | null = loaded ?? single.data ?? null
  const notFound = selectedId !== null && loaded === null && single.error instanceof ApiError && single.error.status === 404

  const setFilters = useCallback(
    (next: Filters) => {
      setParams(
        (previous) => {
          const merged = toSearchParams(next)
          const event = previous.get('event')
          if (event) merged.set('event', event)
          return merged
        },
        { replace: true },
      )
    },
    [setParams],
  )
  const select = (event: RowEvent | null) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous)
        if (event) next.set('event', event.event_id)
        else next.delete('event')
        return next
      },
      { replace: true },
    )

  const filtered = activeFilterCount(filters) > 0
  const failed = events.isError && rows.length === 0
  const firstLoad = events.isPending

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Audit log</h1>
          <p className="mt-1 text-sm text-muted-foreground">Row changes captured by DBMesh, newest first.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" aria-pressed={live} onClick={() => setLive((v) => !v)} className={cn(live && 'border-insert/50 text-insert')}>
            <span aria-hidden className={cn('size-2 rounded-full', live ? 'live-dot bg-insert' : 'bg-muted-foreground/50')} />
            Live
          </Button>
          <Button variant="outline" size="sm" onClick={() => events.refetch()} disabled={events.isFetching} aria-label="Refresh events">
            <RefreshCw aria-hidden className={cn('size-3.5', events.isFetching && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      <FilterBar filters={filters} facets={facets.data} onChange={setFilters} />

      {events.isError && rows.length > 0 && (
        <ErrorBanner message={`Could not refresh: ${events.error.message}`} onRetry={() => events.refetch()} retrying={events.isFetching} />
      )}

      <section aria-label="Events" aria-busy={events.isFetching} className="overflow-hidden rounded-lg border bg-card">
        {firstLoad ? (
          <EventsTableSkeleton />
        ) : failed ? (
          <div className="p-4"><ErrorBanner message={events.error.message} onRetry={() => events.refetch()} retrying={events.isFetching} /></div>
        ) : rows.length === 0 ? (
          filtered ? (
            <EmptyState icon={<SearchX className="size-5" />} title="No events match these filters">
              <p>Try a wider time range or remove a filter.</p>
              <Button size="sm" className="mt-4" onClick={() => setFilters(DEFAULT_FILTERS)}>Clear filters</Button>
            </EmptyState>
          ) : (
            <EmptyState icon={<Inbox className="size-5" />} title="No audited changes yet">
              <p>Connect with the Python client and select the tables to audit. Each INSERT, UPDATE or DELETE shows up here.</p>
              <pre className="mt-4 overflow-x-auto rounded-md border bg-muted/60 p-3 text-left font-mono text-xs leading-relaxed">{SNIPPET}</pre>
            </EmptyState>
          )
        ) : (
          <>
            <EventsTable events={rows} selectedId={selectedId} onSelect={select} now={now} />
            <div className="flex items-center justify-between gap-3 border-t px-4 py-3 text-sm text-muted-foreground">
              <span aria-live="polite">
                {rows.length} {rows.length === 1 ? 'event' : 'events'}
                {events.hasNextPage ? ' loaded' : ''}
              </span>
              {events.hasNextPage && (
                <Button size="sm" onClick={() => events.fetchNextPage()} disabled={events.isFetchingNextPage}>
                  {events.isFetchingNextPage && <Loader2 aria-hidden className="size-3.5 animate-spin" />}
                  Load {PAGE_SIZE} more
                </Button>
              )}
            </div>
          </>
        )}
      </section>

      <EventSheet
        event={selected}
        loading={selectedId !== null && selected === null && single.isPending && !notFound}
        notFound={notFound}
        now={now}
        onClose={() => select(null)}
        onFilterRequest={(requestId) => setFilters({ ...filters, request_id: requestId })}
      />
    </div>
  )
}
