import { describe, expect, it } from 'vitest'
import type { ColumnOut } from '@/api/types'
import {
  buildChange, formatBytes, formatMicros, formatMillis, initialForm, kindOf, parseField, primaryKeyOf, rowKey, sameValue, toText,
  type Context, type FormState,
} from '@/lib/explorer'

const col = (name: string, data_type: string, over: Partial<ColumnOut> = {}): ColumnOut => ({
  name, data_type, nullable: true, has_default: false, generated: false, primary_key: false, ...over,
})
const COLUMNS: ColumnOut[] = [
  col('id', 'bigint', { nullable: false, has_default: true, primary_key: true }),
  col('name', 'text', { nullable: false }),
  col('plan', 'text', { has_default: true }),
  col('active', 'boolean'),
  col('score', 'numeric'),
  col('meta', 'jsonb'),
  col('tags', 'ARRAY'),
]
const TARGET = { schema: 'public', table: 'users', columns: COLUMNS, primary_key: ['id'] }
const CONTEXT: Context = { user_id: '812', service: 'dashboard', request_id: '', audit: true }
const ROW = { id: 7, name: 'Ada', plan: 'free', active: true, score: '12.50', meta: { a: 1 }, tags: ['x'] }

const value = (text: string): FormState[string] => ({ mode: 'value', text })

describe('field kinds and text', () => {
  it('maps Postgres types to input kinds', () => {
    expect(['bigint', 'numeric', 'double precision'].map((t) => kindOf({ data_type: t }))).toEqual(['number', 'number', 'number'])
    expect(kindOf({ data_type: 'boolean' })).toBe('boolean')
    expect(kindOf({ data_type: 'jsonb' })).toBe('json')
    expect(kindOf({ data_type: 'ARRAY' })).toBe('array')
    expect(['text', 'uuid', 'timestamp with time zone'].map((t) => kindOf({ data_type: t }))).toEqual(['text', 'text', 'text'])
  })

  it('renders values as input text', () => {
    expect(toText(null)).toBe('')
    expect(toText('a')).toBe('a')
    expect(toText(5)).toBe('5')
    expect(toText(false)).toBe('false')
    expect(toText({ a: 1 })).toBe('{\n  "a": 1\n}')
  })
})

describe('parseField', () => {
  const number = col('n', 'numeric')
  it.each([
    ['5', 5], ['-3.25', -3.25], ['  12  ', 12], ['0.5', 0.5],
  ])('parses %s as the number %s', (text, expected) => {
    expect(parseField(number, value(text))).toEqual({ ok: true, value: expected })
  })

  it('keeps numbers that would lose precision, or that JSON would rewrite, as text', () => {
    expect(parseField(number, value('1e3'))).toEqual({ ok: true, value: '1e3' }) // the database parses it exactly
    expect(parseField(number, value('9007199254740993'))).toEqual({ ok: true, value: '9007199254740993' })
    expect(parseField(number, value('0.10000000000000000001'))).toEqual({ ok: true, value: '0.10000000000000000001' })
  })

  it.each(['', 'abc', '1,5', '--1', '1.', ' '])('rejects %j as a number', (text) => {
    expect(parseField(number, value(text)).ok).toBe(false)
  })

  it('handles booleans, NULL and required text', () => {
    expect(parseField(col('b', 'boolean'), value('true'))).toEqual({ ok: true, value: true })
    expect(parseField(col('b', 'boolean'), value(''))).toMatchObject({ ok: false })
    expect(parseField(col('t', 'text'), { mode: 'null', text: '' })).toEqual({ ok: true, value: null })
    expect(parseField(col('t', 'text', { nullable: false }), { mode: 'null', text: '' })).toMatchObject({ ok: false })
    expect(parseField(col('t', 'text', { nullable: false }), value(''))).toEqual({ ok: false, error: 'Required' })
    expect(parseField(col('t', 'text'), value(''))).toEqual({ ok: true, value: '' })
  })

  it('validates json and arrays', () => {
    expect(parseField(col('j', 'jsonb'), value('{"a": [1]}'))).toEqual({ ok: true, value: { a: [1] } })
    expect(parseField(col('j', 'jsonb'), value('{oops'))).toMatchObject({ ok: false, error: expect.stringContaining('Invalid JSON') })
    expect(parseField(col('a', 'ARRAY'), value('["x","y"]'))).toEqual({ ok: true, value: ['x', 'y'] })
    expect(parseField(col('a', 'ARRAY'), value('{"x":1}'))).toMatchObject({ ok: false })
  })
})

describe('sameValue', () => {
  it('treats numerically equal values as unchanged', () => {
    expect(sameValue(col('n', 'numeric'), '12.50', 12.5)).toBe(true)
    expect(sameValue(col('n', 'numeric'), 12, 13)).toBe(false)
    expect(sameValue(col('n', 'numeric'), null, 0)).toBe(false)
    expect(sameValue(col('t', 'text'), 'a', 'a')).toBe(true)
    expect(sameValue(col('t', 'text'), null, '')).toBe(false)
    expect(sameValue(col('j', 'jsonb'), { a: 1 }, { a: 1 })).toBe(true)
  })
})

describe('initialForm', () => {
  it('starts an insert with defaults omitted and required fields open', () => {
    const form = initialForm('INSERT', COLUMNS, null)
    expect(form.name).toEqual({ mode: 'value', text: '' })
    expect(form.id.mode).toBe('omit')
    expect(form.plan.mode).toBe('omit')
    expect(form.active.mode).toBe('omit')
  })

  it('starts an update from the selected row', () => {
    const form = initialForm('UPDATE', COLUMNS, { ...ROW, active: null })
    expect(form.name).toEqual({ mode: 'value', text: 'Ada' })
    expect(form.active).toEqual({ mode: 'null', text: '' })
    expect(form.meta.text).toBe('{\n  "a": 1\n}')
  })
})

describe('buildChange', () => {
  it('needs a user id first', () => {
    const built = buildChange('DELETE', TARGET, {}, ROW, { ...CONTEXT, user_id: ' ' })
    expect(built.body).toBeNull()
    expect(built.blocked).toMatch(/user ID/)
  })

  it('builds an insert from filled fields only', () => {
    const form = { ...initialForm('INSERT', COLUMNS, null), name: value('Ada'), score: value('3.5') }
    const built = buildChange('INSERT', TARGET, form, null, CONTEXT)
    expect(built.blocked).toBeNull()
    expect(built.body).toMatchObject({ operation: 'INSERT', schema: 'public', table: 'users', key: {}, user_id: '812', audit: true })
    expect(built.body?.values).toEqual({ name: 'Ada', score: 3.5 }) // typed fields are sent, omitted ones are not
    expect(built.changed).toEqual(['name', 'score'])
  })

  it('explains a missing required field', () => {
    const built = buildChange('INSERT', TARGET, initialForm('INSERT', COLUMNS, null), null, CONTEXT)
    expect(built.body).toBeNull()
    expect(built.errors.name).toBe('Required')
    expect(built.blocked).toBe('Fill in the required fields') // nothing typed yet, so nothing is "wrong"
    const typed = buildChange('INSERT', TARGET, { ...initialForm('INSERT', COLUMNS, null), name: value('x'), score: value('abc') }, null, CONTEXT)
    expect(typed.blocked).toBe('Fix the highlighted fields')
  })

  it('sends null only when chosen, and reports every invalid field at once', () => {
    const form = {
      ...initialForm('INSERT', COLUMNS, null), name: value('x'),
      active: { mode: 'null' as const, text: '' }, meta: value('{bad'), score: value('nope'),
    }
    const built = buildChange('INSERT', TARGET, form, null, CONTEXT)
    expect(Object.keys(built.errors).sort()).toEqual(['meta', 'score'])
    const ok = buildChange('INSERT', TARGET, { ...form, meta: value('{}'), score: value('1') }, null, CONTEXT)
    expect(ok.body?.values).toEqual({ name: 'x', active: null, meta: {}, score: 1 })
  })

  it('updates only the fields that changed and keys the row by primary key', () => {
    const form = { ...initialForm('UPDATE', COLUMNS, ROW), plan: value('pro'), score: value('12.5') }
    const built = buildChange('UPDATE', TARGET, form, ROW, { ...CONTEXT, request_id: ' req-1 ', service: 'billing' })
    expect(built.body).toMatchObject({ operation: 'UPDATE', key: { id: 7 }, values: { plan: 'pro' }, request_id: 'req-1', service: 'billing' })
    expect(built.changed).toEqual(['plan']) // 12.50 and 12.5 are the same number
  })

  it('does not let an update touch the primary key or generated columns', () => {
    const columns = [...COLUMNS, col('created', 'timestamp', { generated: true })]
    const form = { ...initialForm('UPDATE', columns, ROW), id: value('99'), created: value('2020-01-01'), name: value('Grace') }
    const built = buildChange('UPDATE', { ...TARGET, columns }, form, ROW, CONTEXT)
    expect(built.body?.values).toEqual({ name: 'Grace' })
    expect(built.body?.key).toEqual({ id: 7 })
  })

  it('blocks updates and deletes without a selection, a change or a primary key', () => {
    const form = initialForm('UPDATE', COLUMNS, ROW)
    expect(buildChange('UPDATE', TARGET, form, ROW, CONTEXT).blocked).toBe('Change at least one field')
    expect(buildChange('UPDATE', TARGET, initialForm('UPDATE', COLUMNS, null), null, CONTEXT).blocked).toBe('Select a row in the table to update')
    expect(buildChange('DELETE', TARGET, {}, null, CONTEXT).blocked).toBe('Select a row in the table to delete')
    expect(buildChange('DELETE', { ...TARGET, primary_key: [] }, {}, ROW, CONTEXT).blocked).toBe('This table has no primary key')
  })

  it('builds a delete from the key alone', () => {
    const built = buildChange('DELETE', TARGET, {}, ROW, { ...CONTEXT, audit: false })
    expect(built.body).toMatchObject({ operation: 'DELETE', key: { id: 7 }, values: {}, audit: false })
  })

  it('supports composite keys', () => {
    const target = { ...TARGET, primary_key: ['id', 'name'] }
    expect(buildChange('DELETE', target, {}, ROW, CONTEXT).body?.key).toEqual({ id: 7, name: 'Ada' })
    expect(primaryKeyOf(['id', 'missing'], ROW)).toBeNull()
    expect(primaryKeyOf([], ROW)).toBeNull()
    expect(primaryKeyOf(['id'], { id: null })).toBeNull()
  })
})

describe('helpers', () => {
  it('identifies rows by primary key', () => {
    expect(rowKey(['id'], ROW)).toBe('[7]')
    expect(rowKey([], { a: 1 })).toBe('{"a":1}')
  })

  it('formats sizes and durations', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(null)).toBe('—')
    expect(formatMicros(640)).toBe('640 µs')
    expect(formatMicros(1500)).toBe('1.5 ms')
    expect(formatMicros(25_000)).toBe('25 ms')
    expect(formatMicros(2_500_000)).toBe('2.50 s')
    expect(formatMillis(33)).toBe('33 ms')
    expect(formatMillis(1500)).toBe('1.50 s')
  })
})
