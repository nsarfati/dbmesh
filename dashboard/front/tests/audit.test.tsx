import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authenticated, makeEvent, mockApi, renderApp } from './helpers'

afterEach(() => vi.unstubAllGlobals())

const page = (events: ReturnType<typeof makeEvent>[], next: string | null = null) => ({ body: { events, next_cursor: next } })
/** The nth event row of the desktop table, once it has loaded. */
async function eventRow(n = 0) {
  const [table] = await screen.findAllByRole('table')
  return within(table).getAllByRole('row')[n + 1]
}
const lastEventsUrl = (api: ReturnType<typeof authenticated>) => api.to('/api/events').at(-1)!.url

describe('audit log', () => {
  it('lists events with operation, table, summary and copyable request id', async () => {
    const insert = makeEvent({ operation: 'INSERT', table: 'orders', schema: 'shop', previous: null, new: { id: 9, sku: 'A' }, changes: [{ field: 'id', before: null, after: 9 }, { field: 'sku', before: null, after: 'A' }] })
    authenticated(() => page([makeEvent(), insert]))
    renderApp()
    const rows = await screen.findAllByRole('row')
    const table = within(screen.getAllByRole('table')[0])
    expect(table.getAllByRole('row')).toHaveLength(3) // header + 2
    expect(rows[1]).toHaveTextContent('UPDATE')
    expect(rows[1]).toHaveTextContent('public.users')
    expect(rows[1]).toHaveTextContent('plan')
    expect(rows[1]).toHaveTextContent('"free"')
    expect(rows[1]).toHaveTextContent('"pro"')
    expect(rows[2]).toHaveTextContent('INSERT')
    expect(rows[2]).toHaveTextContent('new row · 2 fields')
    expect(screen.getByText('2 events')).toBeInTheDocument()
  })

  it('sends filters to the API and shows the active count', async () => {
    const api = authenticated(() => page([makeEvent()]))
    renderApp()
    await screen.findAllByRole('row')

    await userEvent.selectOptions(screen.getByLabelText('Table'), 'shop.orders')
    await waitFor(() => expect(lastEventsUrl(api).searchParams.get('table')).toBe('orders'))
    expect(lastEventsUrl(api).searchParams.get('schema')).toBe('shop')

    await userEvent.click(screen.getByRole('radio', { name: 'Update' }))
    await waitFor(() => expect(lastEventsUrl(api).searchParams.get('operation')).toBe('UPDATE'))

    await userEvent.selectOptions(screen.getByLabelText('User'), '440')
    await userEvent.selectOptions(screen.getByLabelText('Service'), 'checkout')
    await userEvent.click(screen.getByRole('radio', { name: '1h' }))
    await waitFor(() => {
      const q = lastEventsUrl(api).searchParams
      expect(q.get('user_id')).toBe('440')
      expect(q.get('service')).toBe('checkout')
      expect(new Date(q.get('since')!).getTime()).toBeGreaterThan(Date.now() - 3_700_000)
    })
    expect(screen.getByRole('button', { name: 'Clear 5 filters' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Clear 5 filters' }))
    await waitFor(() => expect(lastEventsUrl(api).search).toBe('?limit=50'))
  })

  it('debounces the request id filter', async () => {
    const api = authenticated(() => page([makeEvent()]))
    renderApp()
    await screen.findAllByRole('row')
    const before = api.to('/api/events').length
    await userEvent.type(screen.getByLabelText('Request ID'), 'req-42')
    expect(api.to('/api/events').length).toBe(before) // nothing per keystroke
    await waitFor(() => expect(lastEventsUrl(api).searchParams.get('request_id')).toBe('req-42'))
    expect(api.to('/api/events').length).toBe(before + 1)
  })

  it('restores filters from the URL', async () => {
    const api = authenticated(() => page([makeEvent()]))
    renderApp('/audit?table=shop.orders&operation=DELETE&request=r-1')
    await screen.findAllByRole('row')
    const q = api.to('/api/events')[0].url.searchParams
    expect([q.get('schema'), q.get('table'), q.get('operation'), q.get('request_id')]).toEqual(['shop', 'orders', 'DELETE', 'r-1'])
    expect(screen.getByLabelText('Table')).toHaveValue('shop.orders')
    expect(screen.getByRole('radio', { name: 'Delete' })).toBeChecked()
  })

  it('loads more pages with the cursor', async () => {
    const first = [makeEvent(), makeEvent()]
    const second = [makeEvent()]
    const api = authenticated((url) => (url.searchParams.get('cursor') === 'c1' ? page(second) : page(first, 'c1')))
    renderApp()
    await screen.findByText('2 events loaded')
    await userEvent.click(screen.getByRole('button', { name: 'Load 50 more' }))
    await screen.findByText('3 events')
    expect(api.to('/api/events').some((c) => c.url.searchParams.get('cursor') === 'c1')).toBe(true)
    expect(screen.queryByRole('button', { name: /Load 50 more/ })).not.toBeInTheDocument()
  })

  it('opens an event in a drawer with the field diff and closes with Escape', async () => {
    const event = makeEvent({ request_id: 'req-open' })
    const api = authenticated(() => page([event]))
    renderApp()
    await userEvent.click(await eventRow())

    const drawer = await screen.findByRole('dialog')
    expect(drawer).toHaveTextContent('public.users')
    expect(within(drawer).getByRole('heading', { name: 'Changed fields' })).toBeInTheDocument()
    expect(drawer).toHaveTextContent('req-open')
    expect(drawer).toHaveTextContent(event.event_id)
    expect(api.to('/api/events').length).toBeGreaterThan(0)

    // unchanged fields are hidden until asked for
    expect(within(drawer).queryByText('name')).not.toBeInTheDocument()
    await userEvent.click(within(drawer).getByRole('button', { name: /Show 2 unchanged fields/ }))
    expect(within(drawer).getByText('name')).toBeInTheDocument()

    // raw row images
    await userEvent.click(within(drawer).getByRole('tab', { name: 'Before' }))
    expect(within(drawer).getByRole('region', { name: 'Row before the change' })).toHaveTextContent('"plan": "free"')

    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('shows a deleted row and an inserted row appropriately', async () => {
    const del = makeEvent({ operation: 'DELETE', new: null, changes: [{ field: 'id', before: 1, after: null }] })
    authenticated(() => page([del]))
    renderApp()
    await userEvent.click(await eventRow())
    const drawer = await screen.findByRole('dialog')
    expect(within(drawer).getByRole('heading', { name: 'Deleted values' })).toBeInTheDocument()
    // a delete opens on its only image, "Before"
    expect(within(drawer).getByRole('tab', { name: 'Before' })).toHaveAttribute('aria-selected', 'true')
    await userEvent.click(within(drawer).getByRole('tab', { name: 'After' }))
    expect(within(drawer).getByText('A deleted row has no new image.')).toBeInTheDocument()
  })

  it('filters by the request of the open event', async () => {
    const api = authenticated(() => page([makeEvent({ request_id: 'req-same' })]))
    renderApp()
    await userEvent.click(await eventRow())
    await userEvent.click(await screen.findByRole('button', { name: /Show every event of this request/ }))
    await waitFor(() => expect(lastEventsUrl(api).searchParams.get('request_id')).toBe('req-same'))
    expect(screen.getByLabelText('Request ID')).toHaveValue('req-same')
  })

  it('opens a linked event that is not on a loaded page', async () => {
    const linked = makeEvent({ table: 'invoices', request_id: 'req-linked' })
    const api = authenticated(() => page([makeEvent()]), { '/api/events/*': () => ({ body: linked }) })
    renderApp(`/audit?event=${linked.event_id}`)
    const drawer = await screen.findByRole('dialog')
    await waitFor(() => expect(drawer).toHaveTextContent('public.invoices'))
    expect(api.calls.some((c) => c.url.pathname === `/api/events/${linked.event_id}`)).toBe(true)
  })

  it('says so when a linked event no longer exists', async () => {
    authenticated(() => page([makeEvent()]), { '/api/events/*': () => ({ status: 404, body: { detail: 'event not found' } }) })
    renderApp('/audit?event=00000000-0000-4000-8000-00000000dead')
    expect(await screen.findByText(/no longer exists/)).toBeInTheDocument()
  })
})

describe('audit log states', () => {
  it('teaches how to produce events when the log is empty', async () => {
    authenticated(() => page([]))
    renderApp()
    expect(await screen.findByText('No audited changes yet')).toBeInTheDocument()
    expect(screen.getByText(/audit=public.users/)).toBeInTheDocument()
  })

  it('offers to clear filters when nothing matches', async () => {
    const api = authenticated((url) => page(url.searchParams.get('operation') ? [] : [makeEvent()]))
    renderApp('/audit?operation=DELETE')
    expect(await screen.findByText('No events match these filters')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    await screen.findAllByRole('row')
    expect(lastEventsUrl(api).searchParams.get('operation')).toBeNull()
  })

  it('shows the API error and retries', async () => {
    let fail = true
    authenticated(() => (fail ? { status: 503, body: { detail: 'audit database unavailable' } } : page([makeEvent()])))
    renderApp()
    expect(await screen.findByRole('alert')).toHaveTextContent('audit database unavailable')
    fail = false
    await userEvent.click(screen.getByRole('button', { name: /Retry/ }))
    await screen.findAllByRole('row')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('returns to the login form when the session expires', async () => {
    let session = true
    mockApi({
      '/api/session': () => ({ body: { authenticated: session } }),
      '/api/status': () => ({ body: { audit_available: true, databases: [] } }),
      '/api/events/facets': () => ({ body: { databases: [], tables: [], users: [], services: [], operations: [] } }),
      '/api/events': () => {
        session = false
        return { status: 401, body: { detail: 'login required' } }
      },
    })
    renderApp()
    expect(await screen.findByLabelText('Password')).toBeInTheDocument()
  })

  it('toggles live refresh and reports audit database health', async () => {
    authenticated(() => page([makeEvent()]))
    renderApp()
    await screen.findAllByRole('row')
    const live = screen.getByRole('button', { name: 'Live' })
    expect(live).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(live)
    expect(live).toHaveAttribute('aria-pressed', 'true')
    expect((await screen.findAllByText('Audit database connected'))[0]).toBeInTheDocument()
  })

  it('reports an unreachable audit database', async () => {
    authenticated(() => page([]), { '/api/status': () => ({ body: { audit_available: false, databases: [] } }) })
    renderApp()
    expect((await screen.findAllByText('Audit database unreachable'))[0]).toBeInTheDocument()
  })
})
