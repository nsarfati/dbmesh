import { useState } from 'react'
import { Activity, RefreshCw } from 'lucide-react'
import { useMetrics, useStatus } from '@/api/hooks'
import { EmptyState, ErrorBanner } from '@/components/Feedback'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

const number = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 })
const WINDOWS = [['5m', 'Last 5 minutes'], ['15m', 'Last 15 minutes'], ['1h', 'Last hour'], ['6h', 'Last 6 hours'], ['24h', 'Last 24 hours']]

export function Metrics() {
  // Named to avoid shadowing the global `window` object.
  const [timeWindow, setTimeWindow] = useState('15m')
  const [database, setDatabase] = useState('')
  const [hovered, setHovered] = useState<{ operation: string; target: 'primary' | 'replica' } | null>(null)
  const status = useStatus()
  const metrics = useMetrics(timeWindow, database)
  const data = metrics.data
  const rows = data?.rows ?? []
  const total = rows.reduce((n, row) => n + row.count, 0)
  const primary = rows.filter((row) => row.target === 'primary').reduce((n, row) => n + row.count, 0)
  const perSecond = rows.reduce((n, row) => n + row.per_second, 0)
  const failed = rows.filter((row) => row.outcome === 'error').reduce((n, row) => n + row.count, 0)
  const unknown = rows.filter((row) => row.outcome === 'unknown').reduce((n, row) => n + row.count, 0)
  const operations = [...new Set(['select', 'insert', 'update', 'delete', ...rows.filter((r) => r.count > 0).map((r) => r.operation)])]
  const destinations = new Map<string, { label: string; count: number; errors: number; unknown: number }>()
  for (const row of rows) {
    const key = `${row.database}/${row.target}/${row.reader}`
    const entry = destinations.get(key) ?? { label: `${row.database} / ${row.target === 'primary' ? 'Writer' : `Reader ${row.reader}`}`, count: 0, errors: 0, unknown: 0 }
    entry.count += row.count
    if (row.outcome === 'error') entry.errors += row.count
    if (row.outcome === 'unknown') entry.unknown += row.count
    destinations.set(key, entry)
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Query metrics</h1>
          <p className="mt-1 text-sm text-muted-foreground">Traffic through DBMesh, measured at the proxy. Refreshes every 15 seconds.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => metrics.refetch()} disabled={metrics.isFetching}>
          <RefreshCw aria-hidden className="size-4" /> Refresh metrics
        </Button>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-xs text-muted-foreground">Database
          <Select value={database} onChange={(e) => setDatabase(e.target.value)} aria-label="Metrics database">
            <option value="">All databases</option>
            {status.data?.databases.map((db) => <option key={db} value={db}>{db}</option>)}
          </Select>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">Period
          <Select value={timeWindow} onChange={(e) => setTimeWindow(e.target.value)} aria-label="Metrics period">
            {WINDOWS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select>
        </label>
        {data && <p className="pb-2 text-xs text-muted-foreground">Updated {new Date(data.sampled_at * 1000).toLocaleTimeString()} · {data.targets_up}/{data.targets_total} proxy targets reachable</p>}
      </div>
      {metrics.isError && <ErrorBanner message={`${metrics.error.message}. Check Prometheus and the proxy metrics listener.${data ? ' Showing the last successful sample.' : ''}`} onRetry={() => metrics.refetch()} retrying={metrics.isFetching} />}
      {metrics.isPending && <p role="status" className="text-sm text-muted-foreground">Loading metrics…</p>}
      {data && (data.targets_total === 0 || data.targets_up < data.targets_total) && (
        <ErrorBanner message="Proxy metrics unavailable or incomplete. Historical data may still appear; this does not mean there is no traffic." />
      )}
      {data && rows.length === 0 && <EmptyState icon={<Activity className="size-5" />} title="Waiting for metric samples">
        Prometheus needs at least two scrapes. Check the dbmesh target and allow about 30 seconds after starting it.
      </EmptyState>}
      {data && rows.length > 0 && <>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            ['Messages · estimated', number(total)],
            ['Messages / second', perSecond.toFixed(2)],
            ['Writer / readers', `${number(primary)} / ${number(total - primary)}`],
            ['Upstream latency · p95', data.p95_seconds == null ? 'No observations' : `${number(data.p95_seconds * 1000)} ms`],
          ].map(([label, value]) => <div key={label} className="rounded-lg border bg-card p-5">
            <p className="text-xs text-muted-foreground">{label}</p><p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
          </div>)}
        </div>
        <div className="grid gap-6 xl:grid-cols-2">
          <section className="rounded-lg border bg-card p-5">
            <h2 className="font-semibold">By operation</h2>
            <div className="mt-5 space-y-4">
              {operations.map((operation) => {
                const matching = rows.filter((r) => r.operation === operation)
                const writer = matching.filter((r) => r.target === 'primary').reduce((n, r) => n + r.count, 0)
                const readers = matching.filter((r) => r.target === 'replica').reduce((n, r) => n + r.count, 0)
                const active = hovered?.operation === operation ? hovered.target : null
                return <div key={operation}>
                  <div className="mb-1 flex justify-between gap-3 text-sm">
                    <span className={cn('font-mono uppercase transition-colors', active === 'primary' && 'text-primary', active === 'replica' && 'text-insert')}>{operation}</span>
                    <span className="tabular-nums">Writer {number(writer)} · Readers {number(readers)}</span>
                  </div>
                  <div className="relative h-2">
                    <div className="absolute inset-0 flex overflow-hidden rounded-full bg-muted">
                      <div className={cn('bg-primary transition-[filter]', active === 'primary' && 'brightness-125')} style={{ width: `${total ? writer / total * 100 : 0}%` }} />
                      <div className={cn('bg-insert transition-[filter]', active === 'replica' && 'brightness-125')} style={{ width: `${total ? readers / total * 100 : 0}%` }} />
                    </div>
                    <div className="absolute inset-0 flex">
                      <Tooltip
                        content={`Writer: ${number(writer)} messages`}
                        className="h-full"
                        style={{ width: `${total ? writer / total * 100 : 0}%` }}
                        onMouseEnter={() => setHovered({ operation, target: 'primary' })}
                        onMouseLeave={() => setHovered(null)}
                      />
                      <Tooltip
                        content={`Readers: ${number(readers)} messages`}
                        className="h-full"
                        style={{ width: `${total ? readers / total * 100 : 0}%` }}
                        onMouseEnter={() => setHovered({ operation, target: 'replica' })}
                        onMouseLeave={() => setHovered(null)}
                      />
                    </div>
                  </div>
                </div>
              })}
            </div>
          </section>
          <section className="min-w-0 rounded-lg border bg-card p-5">
            <h2 className="font-semibold">By destination</h2>
            <p className="mt-1 text-xs text-muted-foreground">SQL errors: {number(failed)} · Unknown outcomes: {number(unknown)}</p>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-muted-foreground"><tr><th className="py-2 font-medium">Destination</th><th className="text-right font-medium">Messages</th><th className="text-right font-medium">Errors</th><th className="text-right font-medium">Unknown</th></tr></thead>
                <tbody>{[...destinations.entries()].map(([key, entry]) => <tr key={key} className="border-t">
                  <td className="py-3 pr-3">{entry.label}</td><td className="text-right tabular-nums">{number(entry.count)}</td><td className="text-right tabular-nums">{number(entry.errors)}</td><td className="text-right tabular-nums">{number(entry.unknown)}</td>
                </tr>)}</tbody>
              </table>
            </div>
          </section>
        </div>
      </>}
      <p className="max-w-4xl text-xs leading-relaxed text-muted-foreground">
        One message can contain several SQL statements; those messages are counted once as MULTI, even if an error stops execution midway.
        Single statements use their outer SQL operation, including statements with CTEs. Counts include completed attempts, not affected rows or committed changes.
        Period totals are Prometheus estimates and may be fractional; restarts and scrape gaps affect precision. Internal monitoring and audit queries are excluded.
      </p>
    </div>
  )
}
