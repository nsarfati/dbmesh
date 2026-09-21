import { ChevronLeft, ChevronRight, Database, KeyRound, RefreshCw, Table2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ROWS_PER_PAGE, useRows, useStatus, useTable, useTables } from '@/api/hooks'
import type { ChangeOut, Row, TableOut } from '@/api/types'
import { EmptyState, ErrorBanner } from '@/components/Feedback'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'
import { Select } from '@/components/ui/select'
import { Builder } from '@/features/explorer/Builder'
import { DataGrid } from '@/features/explorer/DataGrid'
import { ResultPanel } from '@/features/explorer/ResultPanel'
import { RouteBadge } from '@/features/explorer/RouteBadge'
import { TableList } from '@/features/explorer/TableList'
import { rowKey, type Operation } from '@/lib/explorer'
import { cn } from '@/lib/utils'

type Source = 'replica' | 'primary'

const SOURCES = [
  { value: 'replica', label: 'Replica', title: 'Normal DBMesh routing: a replica serves the read, so it can lag the primary' },
  { value: 'primary', label: 'Primary', title: 'Pin the read to the primary for the latest data' },
] as const

const split = (name: string | null) => {
  if (!name) return null
  const dot = name.indexOf('.')
  return dot > 0 ? { schema: name.slice(0, dot), table: name.slice(dot + 1) } : null
}

export function Explorer() {
  const status = useStatus()
  const [params, setParams] = useSearchParams()
  const databases = status.data?.databases ?? []
  const requested = params.get('db')
  const database = requested && databases.includes(requested) ? requested : (databases[0] ?? null)
  const tables = useTables(database)
  const tableName = params.get('table')
  const known = tables.data?.tables.some((t) => `${t.schema}.${t.table}` === tableName) ?? false
  const ref = known ? split(tableName) : null
  const info = useTable(database, ref)
  const source: Source = params.get('source') === 'primary' ? 'primary' : 'replica'

  const set = (patch: Record<string, string | null>) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous)
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) next.delete(key)
          else next.set(key, value)
        }
        return next
      },
      { replace: true },
    )

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Explorer</h1>
          <p className="mt-1 text-sm text-muted-foreground">Browse tables and run changes through DBMesh, with the audit trail and replication delay.</p>
        </div>
        {databases.length > 0 && (
          <div className="w-full sm:w-56">
            <label htmlFor="database" className="mb-1 block text-xs font-medium text-muted-foreground">Database</label>
            <Select id="database" value={database ?? ''} onChange={(e) => set({ db: e.target.value, table: null })}>
              {databases.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </Select>
          </div>
        )}
      </div>

      {status.isError ? (
        <ErrorBanner message={status.error.message} onRetry={() => status.refetch()} retrying={status.isFetching} />
      ) : database === null ? (
        !status.isPending && <EmptyState icon={<Database className="size-5" />} title="No databases configured">Add one under <code className="font-mono">databases</code> in config.yaml.</EmptyState>
      ) : tables.isError ? (
        <ErrorBanner message={tables.error.message} onRetry={() => tables.refetch()} retrying={tables.isFetching} />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[14rem_minmax(0,1fr)]">
          <aside>
            {tables.isPending ? (
              <p className="text-sm text-muted-foreground" role="status">Loading tables…</p>
            ) : tables.data.tables.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tables in this database.</p>
            ) : (
              <TableList tables={tables.data.tables} selected={known ? tableName : null} onSelect={(name) => set({ table: name })} />
            )}
          </aside>
          <div className="min-w-0 space-y-5">
            {ref === null ? (
              !tables.isPending && (
                <div className="rounded-lg border bg-card">
                  <EmptyState icon={<Table2 className="size-5" />} title="Pick a table">Choose a table to see its rows and build a change.</EmptyState>
                </div>
              )
            ) : info.isError ? (
              <ErrorBanner message={info.error.message} onRetry={() => info.refetch()} retrying={info.isFetching} />
            ) : info.data ? (
              <TableView
                key={`${database}|${tableName}|${source}`}
                database={database}
                info={info.data}
                source={source}
                onSource={(value) => set({ source: value === 'replica' ? null : value })}
              />
            ) : (
              <p className="text-sm text-muted-foreground" role="status">Loading table…</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

interface ViewProps {
  database: string
  info: TableOut
  source: Source
  onSource: (source: Source) => void
}

/** One table: its rows, the builder and the last result. Remounted per table so their state resets. */
function TableView({ database, info, source, onSource }: ViewProps) {
  const [offset, setOffset] = useState(0)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [result, setResult] = useState<ChangeOut | null>(null)
  const [flashKey, setFlashKey] = useState<string | null>(null)
  const ref = { schema: info.schema, table: info.table }
  const rows = useRows(database, ref, offset, source)

  const data = rows.data
  const selectedRow = useMemo<Row | null>(
    () => (selectedKey && data ? (data.rows.find((row) => rowKey(info.primary_key, row) === selectedKey) ?? null) : null),
    [selectedKey, data, info.primary_key],
  )

  useEffect(() => {
    if (flashKey === null) return
    const id = setTimeout(() => setFlashKey(null), 2800)
    return () => clearTimeout(id)
  }, [flashKey])

  function executed(change: ChangeOut, operation: Operation) {
    setResult(change)
    if (operation === 'DELETE') setSelectedKey(null)
    else if (change.row) setFlashKey(rowKey(info.primary_key, change.row))
  }

  const first = offset + 1
  const last = offset + (data?.rows.length ?? 0)

  return (
    <>
      <section aria-label={`Rows of ${info.schema}.${info.table}`} className="overflow-hidden rounded-lg border bg-card">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate font-mono text-sm font-semibold">
              <span className="text-muted-foreground">{info.schema}.</span>
              {info.table}
            </h2>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              {info.columns.length} columns
              {info.primary_key.length > 0 ? (
                <span className="inline-flex items-center gap-1"><KeyRound aria-hidden className="size-3 text-update" />{info.primary_key.join(', ')}</span>
              ) : (
                <span className="text-update">no primary key</span>
              )}
            </p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {data && <RouteBadge route={data.route} />}
            <Segmented label="Read from" value={source} options={SOURCES} onChange={onSource} />
            <Button variant="outline" size="sm" aria-label="Refresh rows" onClick={() => rows.refetch()} disabled={rows.isFetching}>
              <RefreshCw aria-hidden className={cn('size-3.5', rows.isFetching && 'animate-spin')} />
            </Button>
          </div>
        </header>

        {rows.isError && !data ? (
          <div className="p-4"><ErrorBanner message={rows.error.message} onRetry={() => rows.refetch()} retrying={rows.isFetching} /></div>
        ) : !data ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground" role="status">Loading rows…</p>
        ) : data.rows.length === 0 ? (
          <EmptyState icon={<Table2 className="size-5" />} title={offset > 0 ? 'No more rows' : 'This table is empty'}>
            {offset > 0 ? 'You have reached the end.' : 'Use the builder below to insert the first row.'}
          </EmptyState>
        ) : (
          <>
            <DataGrid columns={data.columns} rows={data.rows} primaryKey={info.primary_key} selectedKey={selectedKey} flashKey={flashKey} onSelect={(row) => setSelectedKey(row ? rowKey(info.primary_key, row) : null)} />
            <div className="flex items-center justify-between gap-3 border-t px-4 py-2.5 text-sm text-muted-foreground">
              <span aria-live="polite">Rows {first}–{last}</span>
              <div className="flex items-center gap-1">
                <Button size="icon" variant="outline" aria-label="Previous page" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - ROWS_PER_PAGE))}>
                  <ChevronLeft aria-hidden className="size-4" />
                </Button>
                <Button size="icon" variant="outline" aria-label="Next page" disabled={!data.has_more} onClick={() => setOffset(offset + ROWS_PER_PAGE)}>
                  <ChevronRight aria-hidden className="size-4" />
                </Button>
              </div>
            </div>
            <details className="border-t px-4 py-2.5 text-sm">
              <summary className="cursor-pointer text-muted-foreground select-none">SQL of this read</summary>
              <pre className="mt-2 overflow-x-auto rounded-md bg-muted/60 p-3 font-mono text-xs whitespace-pre-wrap">{data.sql}</pre>
            </details>
          </>
        )}
      </section>

      <Builder database={database} table={info} selectedRow={selectedRow} onExecuted={executed} />

      {result && <ResultPanel result={result} onDismiss={() => setResult(null)} />}
    </>
  )
}
