import { useState, type ReactNode } from 'react'
import type { StatementOut } from '@/api/types'
import { cn } from '@/lib/utils'
import { CopyButton } from './CopyButton'

const KEYWORDS =
  'SELECT|FROM|WHERE|INSERT INTO|VALUES|UPDATE|SET|DELETE FROM|RETURNING|ORDER BY|LIMIT|OFFSET|DEFAULT VALUES|AND|NULL|TRUE|FALSE'
// Quoted identifiers, string literals, placeholders, keywords, then numbers.
const TOKEN = new RegExp(`("(?:[^"]|"")*")|('(?:[^']|'')*')|(%s)|\\b(${KEYWORDS})\\b|(?<![\\w"'])(-?\\d+(?:\\.\\d+)?)(?![\\w"'])`, 'gi')

/** Colours SQL without changing a character of it. */
export function highlightSql(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let index = 0
  for (const match of text.matchAll(TOKEN)) {
    const at = match.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    const [whole, ident, literal, placeholder, keyword] = match
    const cls = ident ? 'text-json-key' : literal ? 'text-json-string' : placeholder ? 'text-update' : keyword ? 'text-json-keyword font-semibold' : 'text-json-number'
    out.push(<span key={index++} className={cls}>{whole}</span>)
    last = at + whole.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

interface Props {
  title?: string
  statement: Pick<StatementOut, 'sql'> & Partial<StatementOut>
  /** Says the statement reaches DBMesh with the audit comment header. */
  audited?: boolean
  className?: string
}

/** A statement as run: with values inlined to read and copy, or parameterised as sent. */
export function SqlBlock({ title = 'SQL', statement, audited, className }: Props) {
  const [view, setView] = useState<'values' | 'parameters'>('values')
  const parameterised = statement.statement !== undefined && statement.params !== undefined
  const shown = view === 'parameters' && parameterised ? statement.statement! : statement.sql

  return (
    <section aria-label={title} className={cn('min-w-0', className)}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {parameterised && (
          <div role="radiogroup" aria-label="SQL form" className="inline-flex rounded-md border border-input bg-muted p-0.5">
            {(['values', 'parameters'] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={view === option}
                onClick={() => setView(option)}
                className={cn('h-6 rounded-[5px] px-2 text-[11px] font-medium transition-colors', view === option ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground')}
              >
                {option === 'values' ? 'With values' : 'Parameterized'}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="group relative rounded-md border bg-muted/50">
        <CopyButton value={shown} label="SQL" className="absolute top-1.5 right-1.5 bg-card/80 opacity-70 group-hover:opacity-100" />
        <pre className="overflow-x-auto p-3 pr-9 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]" role="region" tabIndex={0} aria-label={`${title} text`}>
          <code>{highlightSql(shown)}</code>
        </pre>
      </div>
      {view === 'parameters' && parameterised && (
        <ol className="mt-2 space-y-1 font-mono text-xs" aria-label="Parameters">
          {statement.params!.length === 0 ? (
            <li className="text-muted-foreground">No parameters.</li>
          ) : (
            statement.params!.map((param, i) => (
              <li key={i} className="flex gap-2">
                <span className="w-6 shrink-0 text-right text-muted-foreground">{i + 1}</span>
                <span className="min-w-0 break-all">{JSON.stringify(param)}</span>
              </li>
            ))
          )}
        </ol>
      )}
      {audited && (
        <p className="mt-2 text-xs text-muted-foreground">
          DBMesh receives it with a comment header carrying the audit context; the header is removed before the statement runs.
        </p>
      )}
    </section>
  )
}
