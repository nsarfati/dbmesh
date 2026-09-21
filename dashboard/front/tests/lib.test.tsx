import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { RowEvent } from '@/api/types'
import { formatValue, fullDiff, identity, summarize } from '@/lib/changes'
import { activeFilterCount, DEFAULT_FILTERS, parseFilters, toEventQuery, toSearchParams } from '@/lib/filters'
import { fullTime, relativeTime, sinceFor } from '@/lib/time'
import { highlight } from '@/components/JsonView'

const NOW = Date.parse('2026-09-21T12:00:00Z')
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString()

const update = (changes: RowEvent['changes'], extra: Partial<RowEvent> = {}): RowEvent => ({
  event_id: 'e1', db: 'demo', schema: 'public', table: 'users', operation: 'UPDATE', created_at: ago(5),
  previous: { id: 1, name: 'Ada', plan: 'free', tier: 1 }, new: { id: 1, name: 'Ada', plan: 'pro', tier: 2 },
  changes, ...extra,
})

describe('time', () => {
  it.each([
    [2, 'just now'], [30, '30s ago'], [59, '59s ago'], [60, '1m ago'], [3599, '59m ago'],
    [3600, '1h ago'], [86_399, '23h ago'], [86_400, '1d ago'], [6 * 86_400, '6d ago'],
  ])('relativeTime(%is) = %s', (seconds, expected) => {
    expect(relativeTime(ago(seconds), NOW)).toBe(expected)
  })

  it('falls back to a date for old events and passes through garbage', () => {
    expect(relativeTime(ago(30 * 86_400), NOW)).toMatch(/2026/)
    expect(relativeTime('not a date', NOW)).toBe('not a date')
    expect(fullTime('not a date')).toBe('not a date')
    expect(fullTime('2026-09-21T12:00:00.123Z')).toMatch(/2026/)
  })

  it('computes the lower bound of a range', () => {
    expect(sinceFor('all', NOW)).toBeUndefined()
    expect(sinceFor('1h', NOW)).toBe('2026-09-21T11:00:00.000Z')
    expect(sinceFor('7d', NOW)).toBe('2026-09-14T12:00:00.000Z')
  })
})

describe('changes', () => {
  it('formats values on one line and truncates', () => {
    expect(formatValue(null)).toBe('null')
    expect(formatValue('abc')).toBe('"abc"')
    expect(formatValue({ a: 1 })).toBe('{"a":1}')
    expect(formatValue('x'.repeat(50), 10)).toBe('"xxxxxxxx…')
  })

  it('identifies a row by id, else its first field', () => {
    expect(identity(update([]))).toBe('id=1')
    expect(identity({ previous: { sku: 'A1', qty: 2 }, new: null })).toBe('sku="A1"')
    expect(identity({ previous: null, new: null })).toBeNull()
    expect(identity({ previous: {}, new: {} })).toBeNull()
  })

  it('summarises updates with a limit and inserts by field count', () => {
    const changes = [
      { field: 'plan', before: 'free', after: 'pro' },
      { field: 'tier', before: 1, after: 2 },
      { field: 'name', before: 'a', after: 'b' },
    ]
    const summary = summarize(update(changes))
    expect(summary.shown.map((c) => c.field)).toEqual(['plan', 'tier'])
    expect(summary.hidden).toBe(1)
    expect(summary.row).toBe('id=1')
    const insert = summarize({ ...update(changes), operation: 'INSERT', previous: null })
    expect(insert.shown).toEqual([]) // the table renders a field count instead
    expect(insert.fields).toBe(3)
  })

  it('flags unchanged fields only for updates', () => {
    const diff = fullDiff(update([]))
    expect(diff.filter((d) => d.unchanged).map((d) => d.field)).toEqual(['id', 'name'])
    expect(diff.find((d) => d.field === 'plan')).toMatchObject({ before: 'free', after: 'pro', unchanged: false })
    const del = fullDiff({ operation: 'DELETE', previous: { id: 1 }, new: null })
    expect(del).toEqual([{ field: 'id', before: 1, after: null, unchanged: false }])
    expect(fullDiff({ operation: 'INSERT', previous: null, new: null })).toEqual([])
  })
})

describe('filters', () => {
  it('parses defaults and ignores invalid values', () => {
    expect(parseFilters(new URLSearchParams())).toEqual(DEFAULT_FILTERS)
    const parsed = parseFilters(new URLSearchParams('operation=DROP&range=forever&table=public.users&user=812'))
    expect(parsed).toMatchObject({ operation: '', range: 'all', table: 'public.users', user_id: '812' })
  })

  it('writes only non-default values and round-trips', () => {
    expect(toSearchParams(DEFAULT_FILTERS).toString()).toBe('')
    const filters = { table: 'shop.orders', operation: 'UPDATE' as const, user_id: '1', request_id: 'r 1', service: 'billing', range: '1h' as const }
    expect(parseFilters(toSearchParams(filters))).toEqual(filters)
    expect(activeFilterCount(filters)).toBe(6)
    expect(activeFilterCount(DEFAULT_FILTERS)).toBe(0)
  })

  it('builds the API query, splitting schema and table', () => {
    expect(toEventQuery(DEFAULT_FILTERS, NOW)).toEqual({})
    expect(toEventQuery({ ...DEFAULT_FILTERS, table: 'shop.orders', range: '15m', operation: 'DELETE' }, NOW)).toEqual({
      schema: 'shop', table: 'orders', operation: 'DELETE', since: '2026-09-21T11:45:00.000Z',
    })
    expect(toEventQuery({ ...DEFAULT_FILTERS, table: 'orders' }, NOW)).toEqual({ table: 'orders' })
  })
})

describe('json highlighting', () => {
  const json = JSON.stringify({ id: 5, name: 'Ada "the" first', ok: true, gone: null, ratio: -1500.25, big: 1e21, nested: { a: [1] } }, null, 2)

  it('preserves the text exactly', () => {
    const { container } = render(<pre>{highlight(json)}</pre>)
    expect(container.textContent).toBe(json)
  })

  it('colours keys, strings, numbers and keywords', () => {
    const { container } = render(<pre>{highlight(json)}</pre>)
    const cls = (text: string) => [...container.querySelectorAll('span')].find((s) => s.textContent === text)?.className
    expect(cls('"id"')).toContain('json-key')
    expect(cls('"Ada \\"the\\" first"')).toContain('json-string')
    expect(cls('5')).toContain('json-number')
    expect(cls('-1500.25')).toContain('json-number')
    expect(cls('1e+21')).toContain('json-number')
    expect(cls('true')).toContain('json-keyword')
    expect(cls('null')).toContain('json-keyword')
  })
})
