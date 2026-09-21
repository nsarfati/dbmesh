import type { FieldChange, RowEvent } from '@/api/types'

const MAX_SUMMARY_VALUE = 28

/** A compact, single-line rendering of a JSON value for summaries. */
export function formatValue(value: unknown, max: number = MAX_SUMMARY_VALUE): string {
  const text = value === null || value === undefined ? 'null' : typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** The row's identity for display: its `id` when present, else its first field. */
export function identity(event: Pick<RowEvent, 'previous' | 'new'>): string | null {
  const row = event.new ?? event.previous
  if (!row) return null
  const key = 'id' in row ? 'id' : Object.keys(row)[0]
  return key === undefined ? null : `${key}=${formatValue(row[key], 20)}`
}

export interface ChangeSummary {
  /** The row this event is about, such as `id=5`. */
  row: string | null
  /** Field changes to show inline for an UPDATE. */
  shown: FieldChange[]
  /** How many further changed fields were left out. */
  hidden: number
  /** Total fields, for INSERT and DELETE. */
  fields: number
}

export function summarize(event: RowEvent, limit = 2): ChangeSummary {
  const changes = event.changes ?? []
  const shown = event.operation === 'UPDATE' ? changes.slice(0, limit) : []
  return {
    row: identity(event),
    shown,
    hidden: event.operation === 'UPDATE' ? Math.max(0, changes.length - limit) : 0,
    fields: changes.length,
  }
}

export interface RowDiff extends FieldChange {
  unchanged: boolean
}

/** Every field of the row with an `unchanged` flag; the API only lists changed fields for an UPDATE. */
export function fullDiff(event: Pick<RowEvent, 'operation' | 'previous' | 'new'>): RowDiff[] {
  const before = event.previous ?? {}
  const after = event.new ?? {}
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  return keys.map((field) => {
    const b = before[field] ?? null
    const a = after[field] ?? null
    return { field, before: b, after: a, unchanged: event.operation === 'UPDATE' && JSON.stringify(b) === JSON.stringify(a) }
  })
}
