import type { ChangeBody, ColumnOut, Row } from '@/api/types'

export type Operation = 'INSERT' | 'UPDATE' | 'DELETE'
export type Kind = 'boolean' | 'number' | 'json' | 'array' | 'text'
/** How a field takes part in a change: a typed value, an explicit NULL, or left out for the database default. */
export type Mode = 'value' | 'null' | 'omit'

export interface FieldState {
  mode: Mode
  text: string
}
export type FormState = Record<string, FieldState>

const NUMERIC_TYPES = new Set(['smallint', 'integer', 'bigint', 'numeric', 'decimal', 'real', 'double precision', 'money'])
const NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/

export function kindOf(column: Pick<ColumnOut, 'data_type'>): Kind {
  const type = column.data_type
  if (type === 'boolean') return 'boolean'
  if (type === 'json' || type === 'jsonb') return 'json'
  if (type === 'ARRAY') return 'array'
  if (NUMERIC_TYPES.has(type)) return 'number'
  return 'text'
}

/** Text shown in an input for a value read from the table. */
export function toText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') return JSON.stringify(value, null, 2)
  return String(value)
}

/** Insert leaves defaults out and asks for the rest; update starts from the selected row. */
export function initialForm(operation: Operation, columns: readonly ColumnOut[], row: Row | null): FormState {
  const form: FormState = {}
  for (const column of columns) {
    if (operation === 'UPDATE' && row) {
      const value = row[column.name]
      form[column.name] = value === null || value === undefined ? { mode: 'null', text: '' } : { mode: 'value', text: toText(value) }
    } else {
      const required = !column.nullable && !column.has_default
      form[column.name] = { mode: required ? 'value' : 'omit', text: '' }
    }
  }
  return form
}

export type Parsed = { ok: true; value: unknown } | { ok: false; error: string }

export function parseField(column: ColumnOut, state: FieldState): Parsed {
  if (state.mode === 'null') {
    return column.nullable ? { ok: true, value: null } : { ok: false, error: 'This column does not accept NULL' }
  }
  const text = state.text
  switch (kindOf(column)) {
    case 'boolean':
      if (text === 'true') return { ok: true, value: true }
      if (text === 'false') return { ok: true, value: false }
      return { ok: false, error: 'Choose true or false' }
    case 'number': {
      const trimmed = text.trim()
      if (!NUMBER.test(trimmed)) return { ok: false, error: 'Enter a number' }
      const number = Number(trimmed)
      // Send a number only when it round-trips exactly; huge integers, long decimals and
      // exponent forms go as text, which the database parses without loss.
      return { ok: true, value: Number.isFinite(number) && String(number) === trimmed.replace(/^(-?)0+(?=\d)/, '$1') ? number : trimmed }
    }
    case 'json':
    case 'array': {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch (error) {
        return { ok: false, error: `Invalid JSON: ${error instanceof Error ? error.message : 'cannot parse'}` }
      }
      if (kindOf(column) === 'array' && !Array.isArray(parsed)) return { ok: false, error: 'Enter a JSON array, such as ["a", "b"]' }
      return { ok: true, value: parsed }
    }
    default:
      if (text === '' && !column.nullable && !column.has_default) return { ok: false, error: 'Required' }
      return { ok: true, value: text }
  }
}

/** Whether two values mean the same thing for this column, so unchanged fields are not sent. */
export function sameValue(column: ColumnOut, a: unknown, b: unknown): boolean {
  if (kindOf(column) === 'number' && a !== null && b !== null && a !== '' && b !== '') {
    const x = Number(a)
    const y = Number(b)
    if (Number.isFinite(x) && Number.isFinite(y)) return x === y && (Number.isSafeInteger(x) || String(a) === String(b) || x === y)
  }
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

export interface Context {
  user_id: string
  service: string
  request_id: string
  audit: boolean
}

export interface Built {
  body: ChangeBody | null
  errors: Record<string, string>
  /** Human-readable reason there is nothing to run yet. */
  blocked: string | null
  changed: string[]
}

export function primaryKeyOf(primaryKey: readonly string[], row: Row | null): Record<string, unknown> | null {
  if (!row || primaryKey.length === 0) return null
  const key: Record<string, unknown> = {}
  for (const name of primaryKey) {
    if (row[name] === undefined || row[name] === null) return null
    key[name] = row[name]
  }
  return key
}

interface Target {
  schema: string
  table: string
  columns: readonly ColumnOut[]
  primary_key: readonly string[]
}

/** Turns the form into an API request, or explains what is missing. */
export function buildChange(operation: Operation, target: Target, form: FormState, row: Row | null, context: Context): Built {
  const base = {
    schema: target.schema,
    table: target.table,
    operation,
    user_id: context.user_id.trim(),
    service: context.service.trim(),
    audit: context.audit,
    ...(context.request_id.trim() ? { request_id: context.request_id.trim() } : {}),
  }
  const errors: Record<string, string> = {}
  const done = (body: ChangeBody | null, blocked: string | null, changed: string[] = []): Built => ({ body, errors, blocked, changed })

  if (!base.user_id) return done(null, 'Enter a user ID for the audit context')

  if (operation === 'DELETE') {
    const key = primaryKeyOf(target.primary_key, row)
    if (target.primary_key.length === 0) return done(null, 'This table has no primary key')
    if (!key) return done(null, 'Select a row in the table to delete')
    return done({ ...base, key, values: {} }, null)
  }

  // An update needs a row before anything else is worth validating.
  const key = primaryKeyOf(target.primary_key, row)
  if (operation === 'UPDATE') {
    if (target.primary_key.length === 0) return done(null, 'This table has no primary key')
    if (!key) return done(null, 'Select a row in the table to update')
  }

  const values: Record<string, unknown> = {}
  const changed: string[] = []
  for (const column of target.columns) {
    const state = form[column.name]
    if (!state) continue
    const isKey = operation === 'UPDATE' && target.primary_key.includes(column.name)
    if (isKey || column.generated) continue
    if (operation === 'INSERT' && state.mode === 'omit') continue
    const parsed = parseField(column, state)
    if (!parsed.ok) {
      errors[column.name] = parsed.error
      continue
    }
    if (operation === 'UPDATE' && row && sameValue(column, row[column.name], parsed.value)) continue
    values[column.name] = parsed.value
    changed.push(column.name)
  }
  if (Object.keys(errors).length > 0) {
    // Untouched required fields are not "wrong" yet, so they are asked for rather than flagged.
    const untouched = Object.keys(errors).every((name) => form[name]?.text === '')
    return done(null, untouched ? 'Fill in the required fields' : 'Fix the highlighted fields', changed)
  }

  if (operation === 'INSERT') return done({ ...base, key: {}, values }, null, changed)

  if (changed.length === 0) return done(null, 'Change at least one field')
  return done({ ...base, key: key!, values }, null, changed)
}

/** Stable identity of a row, from its primary key values. */
export function rowKey(primaryKey: readonly string[], row: Row): string {
  return primaryKey.length ? JSON.stringify(primaryKey.map((name) => row[name])) : JSON.stringify(row)
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function formatMicros(us: number): string {
  if (us < 1000) return `${us} µs`
  if (us < 1_000_000) return `${(us / 1000).toFixed(us < 10_000 ? 1 : 0)} ms`
  return `${(us / 1_000_000).toFixed(2)} s`
}

export function formatMillis(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`
}
