import type { ColumnOut } from '@/api/types'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { kindOf, type FieldState, type Mode } from '@/lib/explorer'
import { cn } from '@/lib/utils'

const LABELS: Record<Mode, string> = { value: 'Value', null: 'NULL', omit: 'Default' }

interface Props {
  column: ColumnOut
  state: FieldState
  error?: string
  /** Modes this field may take; a single one hides the switch. */
  modes: readonly Mode[]
  /** Set when the value cannot be edited, such as a primary key in an update. */
  fixed?: string
  onChange: (state: FieldState) => void
}

export function FieldInput({ column, state, error, modes, fixed, onChange }: Props) {
  const kind = kindOf(column)
  // A field is only flagged once it has content; an empty required one is just asked for.
  const shownError = state.text !== '' ? error : undefined
  const id = `field-${column.name}`
  const canOmit = modes.includes('omit')
  const editable = fixed === undefined
  // Typing fills the field in; clearing an optional one hands it back to the database.
  const set = (text: string) => onChange(canOmit && text === '' ? { mode: 'omit', text: '' } : { mode: 'value', text })
  const placeholder = column.has_default ? 'database default' : canOmit ? 'left out (NULL)' : undefined
  const labelFor = (mode: Mode) => (mode === 'omit' && !column.has_default ? 'Omit' : LABELS[mode])

  return (
    <div className={cn('rounded-md border p-3', shownError && 'border-delete/60')}>
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <label htmlFor={id} className="font-mono text-[13px] font-medium">{column.name}</label>
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{column.data_type}</span>
        {column.primary_key && <span className="rounded bg-update/12 px-1.5 py-0.5 text-[10px] font-semibold text-update">PK</span>}
        {!column.nullable && !column.has_default && <span className="text-[10px] font-medium text-muted-foreground">required</span>}
        {column.generated && <span className="text-[10px] font-medium text-muted-foreground">generated</span>}
        {fixed === undefined && modes.length > 1 && (
          <div role="radiogroup" aria-label={`${column.name} value mode`} className="ml-auto inline-flex rounded-md border border-input bg-muted p-0.5">
            {modes.map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={state.mode === mode}
                onClick={() => onChange({ mode, text: mode === 'omit' ? '' : state.text })}
                className={cn('h-6 rounded-[5px] px-2 text-[11px] font-medium transition-colors', state.mode === mode ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground')}
              >
                {labelFor(mode)}
              </button>
            ))}
          </div>
        )}
      </div>

      {fixed !== undefined ? (
        <p className="font-mono text-[13px] text-muted-foreground" id={id}>{fixed} <span className="font-sans text-xs">(identifies the row)</span></p>
      ) : column.generated ? (
        <p className="text-xs text-muted-foreground">The database generates this value.</p>
      ) : state.mode === 'null' ? (
        <p className="text-xs text-muted-foreground">Will be set to NULL.</p>
      ) : kind === 'boolean' ? (
        <Select id={id} value={state.text} onChange={(event) => set(event.target.value)} aria-invalid={shownError ? true : undefined}>
          <option value="">{canOmit ? (column.has_default ? 'Default' : 'Omit') : 'Choose…'}</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </Select>
      ) : kind === 'json' || kind === 'array' || state.text.includes('\n') ? (
        <textarea
          id={id}
          value={state.text}
          onChange={(event) => set(event.target.value)}
          rows={Math.min(8, Math.max(3, state.text.split('\n').length))}
          spellCheck={false}
          placeholder={placeholder ?? (kind === 'array' ? '["a", "b"]' : kind === 'json' ? '{"key": "value"}' : undefined)}
          aria-invalid={shownError ? true : undefined}
          disabled={!editable}
          className="w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-[13px] focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
        />
      ) : (
        <Input
          id={id}
          value={state.text}
          onChange={(event) => set(event.target.value)}
          inputMode={kind === 'number' ? 'decimal' : undefined}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={shownError ? true : undefined}
          className="font-mono"
        />
      )}
      {shownError && <p role="alert" className="mt-1.5 text-xs text-delete">{shownError}</p>}
    </div>
  )
}
