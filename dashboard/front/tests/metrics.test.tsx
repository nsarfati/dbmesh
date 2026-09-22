import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { mockApi, renderApp } from './helpers'

afterEach(() => vi.unstubAllGlobals())

const snapshot = {
  sampled_at: 1789990000, window: '15m', targets_up: 1, targets_total: 1, p95_seconds: 0.012,
  rows: [
    { database: 'demo', operation: 'select', target: 'replica', reader: '1', outcome: 'success', count: 20, per_second: 2 },
    { database: 'demo', operation: 'update', target: 'primary', reader: '0', outcome: 'success', count: 5, per_second: 0.5 },
    { database: 'demo', operation: 'multi', target: 'primary', reader: '0', outcome: 'error', count: 1, per_second: 0.1 },
  ],
}

function routes(reply: object, status = 200) {
  return mockApi({
    '/api/session': () => ({ body: { authenticated: true } }),
    '/api/status': () => ({ body: { audit_available: true, databases: ['demo'] } }),
    '/api/metrics': () => ({ body: reply, status }),
  })
}

it('shows operations, individual destinations and sends period/database filters', async () => {
  const api = routes(snapshot)
  renderApp('/metrics')
  expect(await screen.findByText('26')).toBeInTheDocument()
  expect(screen.getByText('12 ms')).toBeInTheDocument()
  expect(screen.getByText('multi')).toBeInTheDocument()
  const table = screen.getByRole('table')
  expect(within(table).getByText('demo / Reader 1')).toBeInTheDocument()
  expect(within(table).getByText('demo / Writer')).toBeInTheDocument()
  const user = userEvent.setup()
  await user.selectOptions(screen.getByLabelText('Metrics database'), 'demo')
  await user.selectOptions(screen.getByLabelText('Metrics period'), '1h')
  await waitFor(() => expect(api.to('/api/metrics').some(({ url }) => url.searchParams.get('window') === '1h' && url.searchParams.get('database') === 'demo')).toBe(true))
})

it('shows collection failure instead of zero traffic', async () => {
  routes({ detail: 'Prometheus unavailable' }, 503)
  renderApp('/metrics')
  expect(await screen.findByRole('alert')).toHaveTextContent('Prometheus unavailable')
  expect(screen.queryByText('Messages · estimated')).not.toBeInTheDocument()
})

it('distinguishes missing samples from unreachable proxy targets', async () => {
  routes({ ...snapshot, targets_up: 0, targets_total: 0, rows: [], p95_seconds: null })
  renderApp('/metrics')
  expect(await screen.findByText('Waiting for metric samples')).toBeInTheDocument()
  expect(screen.getByRole('alert')).toHaveTextContent('Proxy metrics unavailable or incomplete')
})
