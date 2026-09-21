import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockApi, renderApp } from './helpers'

afterEach(() => vi.unstubAllGlobals())

describe('login', () => {
  const signedOut = { '/api/session': () => ({ body: { authenticated: false } }) }

  it('shows the login form when there is no session, and needs a password to submit', async () => {
    mockApi(signedOut)
    renderApp()
    const submit = await screen.findByRole('button', { name: 'Sign in' })
    expect(submit).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Password'), 'x')
    expect(submit).toBeEnabled()
  })

  it('posts the password as JSON and then shows the app', async () => {
    let authed = false
    const api = mockApi({
      '/api/session': () => ({ body: { authenticated: authed } }),
      '/api/login': () => {
        authed = true
        return { body: { authenticated: true } }
      },
      '/api/status': () => ({ body: { audit_available: true, databases: [] } }),
      '/api/events/facets': () => ({ body: { databases: [], tables: [], users: [], services: [], operations: [] } }),
      '/api/events': () => ({ body: { events: [], next_cursor: null } }),
    })
    renderApp()
    await userEvent.type(await screen.findByLabelText('Password'), 'hunter2')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('heading', { name: 'Audit log' })).toBeInTheDocument()
    const [login] = api.to('/api/login')
    expect(login.init?.method).toBe('POST')
    expect(JSON.parse(String(login.init?.body))).toEqual({ password: 'hunter2' })
  })

  it('reports a wrong password without leaving the form', async () => {
    mockApi({ ...signedOut, '/api/login': () => ({ status: 401, body: { detail: 'wrong password' } }) })
    renderApp()
    await userEvent.type(await screen.findByLabelText('Password'), 'nope')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong password.')
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true')
  })

  it('surfaces the throttling message from the API', async () => {
    mockApi({ ...signedOut, '/api/login': () => ({ status: 429, body: { detail: 'too many failed attempts; try again in a minute' } }) })
    renderApp()
    await userEvent.type(await screen.findByLabelText('Password'), 'nope')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('too many failed attempts')
  })

  it('explains an unreachable API instead of showing a blank page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('network'))))
    renderApp()
    expect(await screen.findByRole('alert')).toHaveTextContent(/Cannot reach the dashboard API/)
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument()
  })

  it('signs out back to the login form', async () => {
    let authed = true
    mockApi({
      '/api/session': () => ({ body: { authenticated: authed } }),
      '/api/logout': () => {
        authed = false
        return { body: { authenticated: false } }
      },
      '/api/status': () => ({ body: { audit_available: true, databases: [] } }),
      '/api/events/facets': () => ({ body: { databases: [], tables: [], users: [], services: [], operations: [] } }),
      '/api/events': () => ({ body: { events: [], next_cursor: null } }),
    })
    renderApp()
    await screen.findByRole('heading', { name: 'Audit log' })
    await userEvent.click(screen.getAllByRole('button', { name: 'Sign out' })[0])
    await waitFor(() => expect(screen.getByLabelText('Password')).toBeInTheDocument())
  })
})
