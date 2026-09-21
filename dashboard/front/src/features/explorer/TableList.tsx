import { ShieldCheck, ShieldOff } from 'lucide-react'
import type { TableRef } from '@/api/types'
import { Select } from '@/components/ui/select'
import { cn } from '@/lib/utils'

const id = (t: TableRef) => `${t.schema}.${t.table}`

interface Props {
  tables: readonly TableRef[]
  selected: string | null
  onSelect: (name: string) => void
}

/** Tables as a list on wide screens and a select on phones. */
export function TableList({ tables, selected, onSelect }: Props) {
  return (
    <>
      <div className="lg:hidden">
        <label htmlFor="table-select" className="mb-1 block text-xs font-medium text-muted-foreground">Table</label>
        <Select id="table-select" value={selected ?? ''} onChange={(event) => event.target.value && onSelect(event.target.value)}>
          <option value="">Choose a table…</option>
          {tables.map((t) => (
            <option key={id(t)} value={id(t)}>{id(t)}</option>
          ))}
        </Select>
      </div>
      <nav aria-label="Tables" className="hidden lg:block">
        <h2 className="mb-2 px-2 text-xs font-medium text-muted-foreground">Tables</h2>
        <ul className="space-y-0.5">
          {tables.map((t) => {
            const name = id(t)
            const active = name === selected
            return (
              <li key={name}>
                <button
                  type="button"
                  aria-current={active ? 'true' : undefined}
                  onClick={() => onSelect(name)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left font-mono text-[13px] transition-colors',
                    active ? 'bg-primary/10 text-primary' : 'hover:bg-hover',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">
                    <span className="text-muted-foreground">{t.schema}.</span>
                    {t.table}
                  </span>
                  {t.auditable ? (
                    <ShieldCheck aria-label="can be audited" className="size-3.5 shrink-0 text-insert" />
                  ) : (
                    <ShieldOff aria-label="cannot be audited: needs unquoted lowercase names" className="size-3.5 shrink-0 text-muted-foreground/60" />
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      </nav>
    </>
  )
}
