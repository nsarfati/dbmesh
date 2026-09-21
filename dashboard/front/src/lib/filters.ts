import type { EventQuery } from '@/api/types'
import { sinceFor, type Range } from './time'

export type Operation = 'INSERT' | 'UPDATE' | 'DELETE'

export interface Filters {
  /** `schema.table` as offered by the facets endpoint. */
  table: string
  operation: Operation | ''
  user_id: string
  request_id: string
  service: string
  range: Range
}

export const DEFAULT_FILTERS: Filters = { table: '', operation: '', user_id: '', request_id: '', service: '', range: 'all' }

const OPERATIONS: readonly string[] = ['INSERT', 'UPDATE', 'DELETE']
const RANGES: readonly string[] = ['15m', '1h', '24h', '7d', 'all']

export function parseFilters(params: URLSearchParams): Filters {
  const operation = params.get('operation') ?? ''
  const range = params.get('range') ?? DEFAULT_FILTERS.range
  return {
    table: params.get('table') ?? '',
    operation: OPERATIONS.includes(operation) ? (operation as Operation) : '',
    user_id: params.get('user') ?? '',
    request_id: params.get('request') ?? '',
    service: params.get('service') ?? '',
    range: RANGES.includes(range) ? (range as Range) : DEFAULT_FILTERS.range,
  }
}

/** Only non-default values are written, keeping shared links short. */
export function toSearchParams(filters: Filters): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.table) params.set('table', filters.table)
  if (filters.operation) params.set('operation', filters.operation)
  if (filters.user_id) params.set('user', filters.user_id)
  if (filters.request_id) params.set('request', filters.request_id)
  if (filters.service) params.set('service', filters.service)
  if (filters.range !== DEFAULT_FILTERS.range) params.set('range', filters.range)
  return params
}

export function activeFilterCount(filters: Filters): number {
  return (Object.keys(DEFAULT_FILTERS) as (keyof Filters)[]).filter((key) => filters[key] !== DEFAULT_FILTERS[key]).length
}

/** The API query for these filters; `now` lets tests and live mode control the time window. */
export function toEventQuery(filters: Filters, now: number = Date.now()): EventQuery {
  const query: EventQuery = {}
  if (filters.table) {
    const dot = filters.table.indexOf('.')
    if (dot > 0) {
      query.schema = filters.table.slice(0, dot)
      query.table = filters.table.slice(dot + 1)
    } else {
      query.table = filters.table
    }
  }
  if (filters.operation) query.operation = filters.operation
  if (filters.user_id) query.user_id = filters.user_id
  if (filters.request_id) query.request_id = filters.request_id
  if (filters.service) query.service = filters.service
  const since = sinceFor(filters.range, now)
  if (since) query.since = since
  return query
}
