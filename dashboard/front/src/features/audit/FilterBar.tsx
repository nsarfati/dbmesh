import { X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { Facets } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Select } from '@/components/ui/select'
import { activeFilterCount, DEFAULT_FILTERS, type Filters, type Operation } from '@/lib/filters'
import { RANGES } from '@/lib/time'
import { cn } from '@/lib/utils'

const OPERATIONS: { value: Operation | ''; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'INSERT', label: 'Insert' },
  { value: 'UPDATE', label: 'Update' },
  { value: 'DELETE', label: 'Delete' },
]

function Field({ id, label, children, className }: { id: string; label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}

/** Facet values plus the current one, so a shared link to a value not listed still renders. */
function options(values: readonly string[] | undefined, current: string): string[] {
  const list = [...(values ?? [])]
  if (current && !list.includes(current)) list.unshift(current)
  return list
}

function FacetSelect({ id, label, all, value, values, onChange, className }: {
  id: string; label: string; all: string; value: string; values: readonly string[] | undefined; onChange: (value: string) => void; className?: string
}) {
  return (
    <Field id={id} label={label} className={className}>
      <Select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{all}</option>
        {options(values, value).map((v) => (
          <option key={v} value={v}>{v}</option>
        ))}
      </Select>
    </Field>
  )
}

interface Props {
  filters: Filters
  facets: Facets | undefined
  onChange: (filters: Filters) => void
}

export function FilterBar({ filters, facets, onChange }: Props) {
  const set = <K extends keyof Filters>(key: K, value: Filters[K]) => onChange({ ...filters, [key]: value })

  // Typing a request id shouldn't refetch on every keystroke.
  const [request, setRequest] = useState(filters.request_id)
  useEffect(() => setRequest(filters.request_id), [filters.request_id])
  useEffect(() => {
    if (request === filters.request_id) return
    const id = setTimeout(() => onChange({ ...filters, request_id: request.trim() }), 300)
    return () => clearTimeout(id)
  }, [request, filters, onChange])

  const active = activeFilterCount(filters)
  return (
    <section aria-label="Filters" className="rounded-lg border bg-card p-3 sm:p-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <FacetSelect id="f-table" label="Table" all="All tables" value={filters.table} values={facets?.tables} onChange={(v) => set('table', v)} className="col-span-2 lg:col-span-1" />
        <FacetSelect id="f-user" label="User" all="All users" value={filters.user_id} values={facets?.users} onChange={(v) => set('user_id', v)} />
        <FacetSelect id="f-service" label="Service" all="All services" value={filters.service} values={facets?.services} onChange={(v) => set('service', v)} />
        <Field id="f-request" label="Request ID" className="col-span-2 lg:col-span-1">
          <Input id="f-request" value={request} onChange={(event) => setRequest(event.target.value)} placeholder="req-123" spellCheck={false} className="font-mono" />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Segmented label="Operation" value={filters.operation} options={OPERATIONS} onChange={(v) => set('operation', v)} />
        <Segmented label="Time range" value={filters.range} options={RANGES} onChange={(v) => set('range', v)} />
        {active > 0 && (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => onChange(DEFAULT_FILTERS)}>
            <X aria-hidden className="size-3.5" />
            Clear {active} {active === 1 ? 'filter' : 'filters'}
          </Button>
        )}
      </div>
    </section>
  )
}
