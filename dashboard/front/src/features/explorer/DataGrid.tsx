import { KeyRound } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import type { Row } from '@/api/types'
import { rowKey } from '@/lib/explorer'
import { cn } from '@/lib/utils'

function Cell({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground/70 italic">NULL</span>
  if (typeof value === 'boolean') return <span className="text-json-keyword">{String(value)}</span>
  if (typeof value === 'number') return <span className="text-json-number tabular-nums">{String(value)}</span>
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return (
    <span className="block max-w-[20rem] truncate" title={text}>
      {text}
    </span>
  )
}

interface Props {
  columns: readonly string[]
  rows: readonly Row[]
  primaryKey: readonly string[]
  selectedKey: string | null
  /** A row to flash after a change, by key. */
  flashKey: string | null
  onSelect: (row: Row | null) => void
}

export function DataGrid({ columns, rows, primaryKey, selectedKey, flashKey, onSelect }: Props) {
  const onKey = (row: Row, key: string) => (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect(key === selectedKey ? null : row)
    }
  }
  return (
    <div className="max-h-[26rem] overflow-auto">
      <table className="w-full border-collapse text-left text-[13px]" aria-label="Table rows">
        <thead className="sticky top-0 z-10 bg-card shadow-[0_1px_0_var(--border)]">
          <tr>
            {columns.map((name) => (
              <th key={name} scope="col" className="px-3 py-2 font-mono text-xs font-medium whitespace-nowrap text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  {primaryKey.includes(name) && <KeyRound aria-label="primary key" className="size-3 text-update" />}
                  {name}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(primaryKey, row)
            const selected = key === selectedKey
            return (
              <tr
                key={key}
                tabIndex={0}
                aria-selected={selected}
                aria-label={`Row ${primaryKey.map((name) => `${name} ${String(row[name])}`).join(', ') || ''}`.trim()}
                onClick={() => onSelect(selected ? null : row)}
                onKeyDown={onKey(row, key)}
                className={cn(
                  'cursor-pointer border-t transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-offset-[-2px]',
                  selected && 'bg-primary/10 hover:bg-primary/10',
                  key === flashKey && 'row-flash',
                )}
              >
                {columns.map((name) => (
                  <td key={name} className="px-3 py-2 align-top font-mono whitespace-nowrap">
                    <Cell value={row[name]} />
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
