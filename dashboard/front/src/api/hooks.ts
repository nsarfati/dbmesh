import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toEventQuery, type Filters } from '@/lib/filters'
import { api, queryString } from './client'
import { SESSION_KEY } from './queryClient'
import type { MetricsSnapshot } from './types'
import type { ChangeBody, ChangeOut, EventPage, Facets, PreviewOut, RowEvent, RowsOut, Status, TableList, TableOut } from './types'

export const PAGE_SIZE = 50
export const LIVE_INTERVAL_MS = 5_000

export function useMetrics(window: string, database: string) {
  return useQuery({
    queryKey: ['metrics', window, database],
    queryFn: () => api<MetricsSnapshot>(`/api/metrics${queryString({ window, database })}`),
    refetchInterval: 15_000,
    retry: false,
  })
}

export function useSession() {
  return useQuery({
    queryKey: SESSION_KEY,
    queryFn: () => api<{ authenticated: boolean }>('/api/session'),
    staleTime: Infinity,
    retry: false,
  })
}

export function useLogin() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (password: string) => api<{ authenticated: boolean }>('/api/login', { method: 'POST', body: JSON.stringify({ password }) }),
    onSuccess: () => client.setQueryData(SESSION_KEY, { authenticated: true }),
  })
}

export function useLogout() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => api<{ authenticated: boolean }>('/api/logout', { method: 'POST' }),
    onSettled: () => {
      // Drop cached data, but keep the session query itself: the app is subscribed to it.
      client.removeQueries({ predicate: (query) => query.queryKey[0] !== SESSION_KEY[0] })
      client.setQueryData(SESSION_KEY, { authenticated: false })
    },
  })
}

export function useStatus() {
  return useQuery({ queryKey: ['status'], queryFn: () => api<Status>('/api/status'), refetchInterval: 15_000 })
}

export function useFacets() {
  return useQuery({ queryKey: ['facets'], queryFn: () => api<Facets>('/api/events/facets'), staleTime: 30_000 })
}

export function useEvents(filters: Filters, live: boolean) {
  return useInfiniteQuery({
    queryKey: ['events', filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api<EventPage>(`/api/events${queryString({ ...toEventQuery(filters), limit: PAGE_SIZE, cursor: pageParam })}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    refetchInterval: live ? LIVE_INTERVAL_MS : false,
    placeholderData: keepPreviousData,
  })
}

/** One event by id, for links that open before the list has loaded that page. */
export function useEvent(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['event', id],
    queryFn: () => api<RowEvent>(`/api/events/${encodeURIComponent(id ?? '')}`),
    enabled: enabled && id !== null,
    staleTime: 60_000,
  })
}

// Explorer

const seg = encodeURIComponent

export function useTables(database: string | null) {
  return useQuery({
    queryKey: ['tables', database],
    queryFn: () => api<TableList>(`/api/explorer/${seg(database ?? '')}/tables`),
    enabled: database !== null,
    staleTime: 15_000,
  })
}

export function useTable(database: string | null, ref: { schema: string; table: string } | null) {
  return useQuery({
    queryKey: ['table', database, ref?.schema, ref?.table],
    queryFn: () => api<TableOut>(`/api/explorer/${seg(database ?? '')}/tables/${seg(ref?.schema ?? '')}/${seg(ref?.table ?? '')}`),
    enabled: database !== null && ref !== null,
    staleTime: 10_000,
  })
}

export const ROWS_PER_PAGE = 25

export function useRows(database: string | null, ref: { schema: string; table: string } | null, offset: number, source: 'replica' | 'primary') {
  return useQuery({
    queryKey: ['rows', database, ref?.schema, ref?.table, offset, source],
    queryFn: () =>
      api<RowsOut>(
        `/api/explorer/${seg(database ?? '')}/tables/${seg(ref?.schema ?? '')}/${seg(ref?.table ?? '')}/rows${queryString({ limit: ROWS_PER_PAGE, offset, source })}`,
      ),
    enabled: database !== null && ref !== null,
    placeholderData: keepPreviousData,
    staleTime: 0,
  })
}

/** The SQL a change would run; nothing executes. `body` is null until the form is valid. */
export function usePreview(database: string | null, body: ChangeBody | null) {
  return useQuery({
    queryKey: ['preview', database, body],
    queryFn: () => api<PreviewOut>(`/api/explorer/${seg(database ?? '')}/preview`, { method: 'POST', body: JSON.stringify(body) }),
    enabled: database !== null && body !== null,
    retry: false,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  })
}

export function useExecute(database: string | null) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (body: ChangeBody) =>
      api<ChangeOut>(`/api/explorer/${seg(database ?? '')}/execute`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      // The table changed, and so did the audit log.
      for (const key of ['rows', 'events', 'facets', 'tables'] as const) void client.invalidateQueries({ queryKey: [key] })
    },
  })
}
