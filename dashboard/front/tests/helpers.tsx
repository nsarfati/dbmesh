import { QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'
import { createQueryClient } from '@/api/queryClient'
import { Gate } from '@/App'
import type { RowEvent } from '@/api/types'

export interface Reply {
  status?: number
  body?: unknown
}
type Handler = (url: URL, init?: RequestInit) => Reply | Promise<Reply>

/** Replaces fetch with routes keyed by pathname; records every request. */
export function mockApi(routes: Record<string, Handler>) {
  const calls: { url: URL; init?: RequestInit }[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    calls.push({ url, init })
    const handler = routes[url.pathname] ?? Object.entries(routes).find(([pattern]) => pattern.endsWith('*') && url.pathname.startsWith(pattern.slice(0, -1)))?.[1]
    if (!handler) return new Response(JSON.stringify({ detail: `no mock for ${url.pathname}` }), { status: 500 })
    const { status = 200, body = null } = await handler(url, init)
    return new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)
  return {
    calls,
    /** Requests to a path, oldest first. */
    to: (path: string) => calls.filter((c) => c.url.pathname === path),
  }
}

export function renderApp(initialEntry = '/audit') {
  const client = createQueryClient()
  client.setDefaultOptions({ queries: { retry: false, staleTime: 0, refetchOnWindowFocus: false } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Gate />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

let counter = 0
export function makeEvent(over: Partial<RowEvent> = {}): RowEvent {
  counter += 1
  return {
    event_id: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    db: 'demo', schema: 'public', table: 'users', operation: 'UPDATE',
    user_id: '812', request_id: `req-${counter}`, service: 'billing',
    previous: { id: counter, name: 'Ada', plan: 'free' }, new: { id: counter, name: 'Ada', plan: 'pro' },
    changes: [{ field: 'plan', before: 'free', after: 'pro' }],
    created_at: new Date(Date.now() - counter * 60_000).toISOString(),
    ...over,
  }
}

export const FACETS = {
  databases: ['demo'], tables: ['public.users', 'shop.orders'], users: ['812', '440'],
  services: ['billing', 'checkout'], operations: ['INSERT', 'UPDATE', 'DELETE'],
}

/** The routes every authenticated screen needs; override `events` per test. */
export function authenticated(events: (url: URL) => Reply, extra: Record<string, Handler> = {}) {
  return mockApi({
    '/api/session': () => ({ body: { authenticated: true } }),
    '/api/status': () => ({ body: { audit_available: true, databases: ['demo'] } }),
    '/api/events/facets': () => ({ body: FACETS }),
    '/api/events': events,
    ...extra,
  })
}
