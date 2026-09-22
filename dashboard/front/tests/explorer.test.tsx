import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChangeOut, ColumnOut, TableOut } from '@/api/types'
import { mockApi, renderApp, type Reply } from './helpers'

beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

const col = (name: string, data_type: string, over: Partial<ColumnOut> = {}): ColumnOut => ({
  name, data_type, nullable: true, has_default: false, generated: false, primary_key: false, ...over,
})
const USERS: TableOut = {
  schema: 'public', table: 'users', auditable: true, primary_key: ['id'],
  columns: [
    col('id', 'bigint', { nullable: false, has_default: true, primary_key: true }),
    col('name', 'text', { nullable: false }),
    col('plan', 'text', { has_default: true }),
    col('meta', 'jsonb'),
  ],
}
const ROWS = [
  { id: 1, name: 'Ada', plan: 'pro', meta: { a: 1 } },
  { id: 2, name: 'Grace', plan: 'free', meta: null },
]
const ROUTE = { target: 'replica', reader: 1, reason: 'read-only SELECT; reader 1', duration_us: 640, lag_bytes: 0, fallback: false }
const STATEMENT = {
  statement: 'UPDATE "public"."users" SET "plan" = %s WHERE "id" = %s RETURNING *', params: ['enterprise', 2],
  sql: `UPDATE "public"."users" SET "plan" = 'enterprise' WHERE "id" = 2 RETURNING *`,
}

interface Options {
  table?: TableOut
  tables?: { schema: string; table: string; auditable: boolean }[]
  rows?: unknown[]
  execute?: (body: Record<string, unknown>) => Reply
}

function explorerApi(options: Options = {}) {
  const table = options.table ?? USERS
  let rows = options.rows ?? ROWS
  return mockApi({
    '/api/session': () => ({ body: { authenticated: true } }),
    '/api/status': () => ({ body: { audit_available: true, databases: ['demo'] } }),
    '/api/explorer/demo/tables': () => ({
      body: { tables: options.tables ?? [{ schema: table.schema, table: table.table, auditable: table.auditable }, { schema: 'Sales', table: 'Orders', auditable: false }] },
    }),
    [`/api/explorer/demo/tables/${table.schema}/${table.table}`]: () => ({ body: table }),
    [`/api/explorer/demo/tables/${table.schema}/${table.table}/rows`]: (url) => ({
      body: {
        sql: `SELECT * FROM "${table.schema}"."${table.table}" ORDER BY "id" LIMIT 26 OFFSET 0`,
        columns: table.columns.map((c) => c.name), rows, route: ROUTE, limit: 25, offset: 0, has_more: false,
        source: url.searchParams.get('source') ?? 'replica',
      },
    }),
    '/api/explorer/demo/preview': (_url, init) => {
      const body = JSON.parse(String(init?.body))
      return { body: { statement: STATEMENT, audited: body.audit, audit_problem: null } }
    },
    '/api/explorer/demo/execute': (_url, init) => {
      const body = JSON.parse(String(init?.body))
      if (options.execute) return options.execute(body)
      rows = rows.map((row) => (String((row as { id: number }).id) === String(body.key?.id) ? { ...(row as object), ...body.values } : row))
      return { body: changeResult(body) }
    },
  })
}

function changeResult(body: Record<string, unknown>): ChangeOut {
  return {
    request_id: (body.request_id as string) ?? 'dash-abc123', operation: body.operation as string, rowcount: 1,
    row: { id: 2, name: 'Grace', plan: 'enterprise', meta: null },
    route: { target: 'primary', reader: 0, reason: 'write statement', duration_us: 1500, lag_bytes: null, fallback: false },
    statement: STATEMENT,
    audit: {
      expected: 1, delivered: 1, waited_ms: 12, timed_out: false,
      events: [{
        event_id: 'evt-1', operation: 'UPDATE', request_id: 'dash-abc123', created_at: '2026-09-21T12:00:00Z',
        previous: { id: 2, plan: 'free' }, new: { id: 2, plan: 'enterprise' }, changes: [{ field: 'plan', before: 'free', after: 'enterprise' }],
      }],
    },
    replication: {
      readers: [
        { reader: 1, visible_after_ms: 8, stale_reads: 0, lag_bytes: 0 },
        { reader: 2, visible_after_ms: 33, stale_reads: 2, lag_bytes: 512 },
      ],
      fallback_reads: 0, timed_out: false,
    },
  } as ChangeOut
}

const lastExecute = (api: ReturnType<typeof explorerApi>) => JSON.parse(String(api.to('/api/explorer/demo/execute').at(-1)?.init?.body))
const lastPreview = (api: ReturnType<typeof explorerApi>) => JSON.parse(String(api.to('/api/explorer/demo/preview').at(-1)?.init?.body))
const gridRow = async (text: string) => {
  const grid = await screen.findByRole('table', { name: 'Table rows' })
  return within(grid).getByText(text).closest('tr') as HTMLElement
}

describe('explorer: browsing', () => {
  it('is in the navigation and lists the database tables with their audit support', async () => {
    explorerApi()
    renderApp('/explorer')
    expect((await screen.findAllByRole('link', { name: 'Explorer' }))[0]).toBeInTheDocument()
    const list = await screen.findByRole('navigation', { name: 'Tables' })
    expect(within(list).getByText('users')).toBeInTheDocument()
    expect(within(list).getByLabelText('can be audited')).toBeInTheDocument()
    expect(within(list).getByLabelText(/cannot be audited/)).toBeInTheDocument()
  })

  it('shows rows, columns, the primary key and the route that served the read', async () => {
    explorerApi()
    renderApp('/explorer?table=public.users')
    await gridRow('Ada')
    expect(screen.getByText('replica 1')).toBeInTheDocument()
    expect(screen.getByText(/0 B behind/)).toBeInTheDocument()
    expect(screen.getByLabelText('primary key')).toBeInTheDocument()
    expect(screen.getByText('4 columns')).toBeInTheDocument()
    expect(within(screen.getByRole('table', { name: 'Table rows' })).getByText('NULL')).toBeInTheDocument() // Grace has no meta
    expect(screen.getByText(/SELECT \* FROM "public"."users"/)).toBeInTheDocument()
  })

  it('reads from the primary when asked', async () => {
    const api = explorerApi()
    renderApp('/explorer?table=public.users')
    await gridRow('Ada')
    await userEvent.click(screen.getByRole('radio', { name: 'Primary' }))
    await waitFor(() => expect(api.to('/api/explorer/demo/tables/public/users/rows').at(-1)?.url.searchParams.get('source')).toBe('primary'))
  })

  it('offers to choose a table, and says when a table is empty', async () => {
    explorerApi({ rows: [] })
    renderApp('/explorer')
    expect(await screen.findByText('Pick a table')).toBeInTheDocument()
    await userEvent.click(within(await screen.findByRole('navigation', { name: 'Tables' })).getByRole('button', { name: /users/ }))
    expect(await screen.findByText('This table is empty')).toBeInTheDocument()
  })
})

describe('explorer: update', () => {
  it('sends only the changed fields, previews the SQL, and shows the result', async () => {
    const api = explorerApi()
    renderApp('/explorer?table=public.users')
    await userEvent.click(await gridRow('Grace'))
    await userEvent.click(screen.getByRole('radio', { name: 'Update' }))
    const builder = screen.getByRole('region', { name: 'Query builder' })

    expect(within(builder).getByText('Change at least one field')).toBeInTheDocument()
    expect(within(builder).getByRole('button', { name: 'Run update' })).toBeDisabled()

    const plan = within(builder).getByLabelText('plan')
    await userEvent.clear(plan)
    await userEvent.type(plan, 'enterprise')
    await waitFor(() => expect(lastPreview(api)).toMatchObject({ operation: 'UPDATE', key: { id: 2 }, values: { plan: 'enterprise' } }))
    expect(lastPreview(api).values).not.toHaveProperty('name') // untouched fields are not sent
    expect(await within(builder).findByRole('region', { name: 'SQL preview text' })).toHaveTextContent(`SET "plan" = 'enterprise'`)
    expect(within(builder).getByText('1 field to send')).toBeInTheDocument()

    await userEvent.click(within(builder).getByRole('button', { name: 'Run update' }))
    const result = await screen.findByRole('region', { name: 'Result' })
    expect(lastExecute(api)).toMatchObject({ operation: 'UPDATE', user_id: 'dashboard', service: 'dashboard', audit: true, key: { id: 2 }, values: { plan: 'enterprise' } })

    expect(within(result).getByText('1 row updated')).toBeInTheDocument()
    expect(within(result).getByText('dash-abc123')).toBeInTheDocument()
    expect(within(result).getByText(/primary/)).toBeInTheDocument()
    expect(within(result).getByRole('region', { name: 'SQL that ran text' })).toHaveTextContent(`SET "plan" = 'enterprise'`)
    // audit event
    expect(within(result).getByText('delivered in 12 ms')).toBeInTheDocument()
    expect(within(result).getByText('"free"')).toBeInTheDocument()
    expect(within(result).getByText('"enterprise"')).toBeInTheDocument()
    expect(within(result).getByRole('link', { name: /Open in audit log/ })).toHaveAttribute('href', '/audit?event=evt-1')
    // replication timeline
    expect(within(result).getByText('visible after 8 ms')).toBeInTheDocument()
    expect(within(result).getByText('visible after 33 ms')).toBeInTheDocument()
    expect(within(result).getByText(/2 stale reads before it caught up · 512 B behind/)).toBeInTheDocument()
    // the table is reloaded after a change
    await waitFor(() => expect(api.to('/api/explorer/demo/tables/public/users/rows').length).toBeGreaterThan(1))
  })

  it('shows the parameterised form and its parameters', async () => {
    explorerApi()
    renderApp('/explorer?table=public.users')
    await userEvent.click(await gridRow('Grace'))
    await userEvent.click(screen.getByRole('radio', { name: 'Update' }))
    const plan = within(screen.getByRole('region', { name: 'Query builder' })).getByLabelText('plan')
    await userEvent.clear(plan)
    await userEvent.type(plan, 'x')
    await userEvent.click(await screen.findByRole('button', { name: 'Run update' }))
    const result = await screen.findByRole('region', { name: 'Result' })
    await userEvent.click(within(result).getByRole('radio', { name: 'Parameterized' }))
    expect(within(result).getByRole('region', { name: 'SQL that ran text' })).toHaveTextContent('SET "plan" = %s WHERE "id" = %s')
    const params = within(result).getByRole('list', { name: 'Parameters' })
    expect(params).toHaveTextContent('"enterprise"')
    expect(params).toHaveTextContent('2')
  })

  it('asks for a row first, and disables update and delete without a primary key', async () => {
    explorerApi({ table: { ...USERS, primary_key: [], columns: USERS.columns.map((c) => ({ ...c, primary_key: false })) } })
    renderApp('/explorer?table=public.users')
    await gridRow('Ada')
    expect(screen.getByRole('radio', { name: 'Update' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'Delete' })).toBeDisabled()
    expect(screen.getByText('no primary key')).toBeInTheDocument()
  })

  it('tells you to pick a row before an update', async () => {
    explorerApi()
    renderApp('/explorer?table=public.users')
    await gridRow('Ada')
    await userEvent.click(screen.getByRole('radio', { name: 'Update' }))
    expect(screen.getByText(/Select a row in the table above to edit it/)).toBeInTheDocument()
  })
})

describe('explorer: insert', () => {
  it('asks for required fields, validates as you type, and leaves optional ones out', async () => {
    const api = explorerApi()
    renderApp('/explorer?table=public.users')
    await gridRow('Ada')
    const builder = screen.getByRole('region', { name: 'Query builder' })
    const run = within(builder).getByRole('button', { name: 'Run insert' })

    expect(run).toBeDisabled()
    expect(within(builder).getByText('Fill in the required fields')).toBeInTheDocument()
    expect(within(builder).queryByText('Required')).not.toBeInTheDocument() // nothing flagged before it is touched

    await userEvent.type(within(builder).getByLabelText('name'), 'Margaret')
    await userEvent.type(within(builder).getByLabelText('meta'), '{{"a": ')
    expect(await within(builder).findByText(/Invalid JSON/)).toBeInTheDocument()
    expect(run).toBeDisabled()
    await userEvent.type(within(builder).getByLabelText('meta'), '1}')
    await waitFor(() => expect(lastPreview(api)).toMatchObject({ operation: 'INSERT', values: { name: 'Margaret', meta: { a: 1 } } }))
    expect(lastPreview(api).values).not.toHaveProperty('plan') // left to the database default
    expect(lastPreview(api).values).not.toHaveProperty('id')

    await userEvent.click(run)
    await screen.findByRole('region', { name: 'Result' })
    expect(lastExecute(api).operation).toBe('INSERT')
  })

  it('can set a field to NULL explicitly', async () => {
    const api = explorerApi()
    renderApp('/explorer?table=public.users')
    await gridRow('Ada')
    const builder = screen.getByRole('region', { name: 'Query builder' })
    await userEvent.type(within(builder).getByLabelText('name'), 'x')
    await userEvent.click(within(builder).getByRole('radiogroup', { name: 'plan value mode' }).querySelector('[role=radio]:nth-child(2)')!)
    expect(within(builder).getByText('Will be set to NULL.')).toBeInTheDocument()
    await waitFor(() => expect(lastPreview(api).values).toEqual({ name: 'x', plan: null }))
  })
})

describe('explorer: delete, audit options and errors', () => {
  it('needs confirmation in a popup to delete', async () => {
    const api = explorerApi()
    renderApp('/explorer?table=public.users')
    await userEvent.click(await gridRow('Ada'))
    await userEvent.click(screen.getByRole('radio', { name: 'Delete' }))
    const builder = screen.getByRole('region', { name: 'Query builder' })
    expect(await within(builder).findByRole('region', { name: 'Row to delete' })).toHaveTextContent('Ada')

    await userEvent.click(await within(builder).findByRole('button', { name: 'Delete row' }))
    expect(api.to('/api/explorer/demo/execute')).toHaveLength(0)
    const dialog = await screen.findByRole('dialog', { name: 'Delete this row?' })
    expect(dialog).toHaveTextContent('Ada')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete row' }))
    await screen.findByRole('region', { name: 'Result' })
    expect(lastExecute(api)).toMatchObject({ operation: 'DELETE', key: { id: 1 }, values: {} })
  })

  it('cancelling the delete popup does not run the statement', async () => {
    const api = explorerApi()
    renderApp('/explorer?table=public.users')
    await userEvent.click(await gridRow('Ada'))
    await userEvent.click(screen.getByRole('radio', { name: 'Delete' }))
    const builder = screen.getByRole('region', { name: 'Query builder' })
    await userEvent.click(await within(builder).findByRole('button', { name: 'Delete row' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete this row?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete this row?' })).not.toBeInTheDocument())
    expect(api.to('/api/explorer/demo/execute')).toHaveLength(0)
  })

  it('does not audit a table DBMesh cannot audit', async () => {
    const api = explorerApi({ table: { ...USERS, schema: 'Sales', table: 'Orders', auditable: false } })
    renderApp('/explorer?table=Sales.Orders')
    await screen.findByRole('table', { name: 'Table rows' })
    const builder = screen.getByRole('region', { name: 'Query builder' })
    const audit = within(builder).getByRole('checkbox', { name: /Capture this change/ })
    expect(audit).toBeDisabled()
    expect(audit).not.toBeChecked()
    expect(within(builder).getByText(/cannot be audited: DBMesh needs unquoted lowercase/)).toBeInTheDocument()
    await userEvent.type(within(builder).getByLabelText('name'), 'x')
    await waitFor(() => expect(lastPreview(api).audit).toBe(false))
  })

  it('lets the audit context be customised and remembers the user', async () => {
    const api = explorerApi()
    renderApp('/explorer?table=public.users')
    await gridRow('Ada')
    const builder = screen.getByRole('region', { name: 'Query builder' })
    await userEvent.clear(within(builder).getByLabelText(/User ID/))
    await userEvent.type(within(builder).getByLabelText(/User ID/), '812')
    await userEvent.clear(within(builder).getByLabelText('Service'))
    await userEvent.type(within(builder).getByLabelText('Service'), 'billing')
    await userEvent.type(within(builder).getByLabelText('Request ID'), 'req-42')
    await userEvent.type(within(builder).getByLabelText('name'), 'x')
    await userEvent.click(await within(builder).findByRole('button', { name: 'Run insert' }))
    await screen.findByRole('region', { name: 'Result' })
    expect(lastExecute(api)).toMatchObject({ user_id: '812', service: 'billing', request_id: 'req-42' })
    expect(localStorage.getItem('dbmesh-dashboard-user')).toBe('812')
  })

  it('requires a user id', async () => {
    explorerApi()
    renderApp('/explorer?table=public.users')
    await gridRow('Ada')
    const builder = screen.getByRole('region', { name: 'Query builder' })
    await userEvent.clear(within(builder).getByLabelText(/User ID/))
    await userEvent.type(within(builder).getByLabelText('name'), 'x')
    expect(await within(builder).findByText('Enter a user ID for the audit context')).toBeInTheDocument()
    expect(within(builder).getByRole('button', { name: 'Run insert' })).toBeDisabled()
  })

  it('shows a database error and keeps the form', async () => {
    explorerApi({ execute: () => ({ status: 409, body: { detail: 'duplicate key value violates unique constraint "users_pkey"' } }) })
    renderApp('/explorer?table=public.users')
    await gridRow('Ada')
    const builder = screen.getByRole('region', { name: 'Query builder' })
    await userEvent.type(within(builder).getByLabelText('name'), 'x')
    await userEvent.click(await within(builder).findByRole('button', { name: 'Run insert' }))
    expect(await within(builder).findByRole('alert')).toHaveTextContent('duplicate key value violates unique constraint')
    expect(within(builder).getByLabelText('name')).toHaveValue('x')
    expect(screen.queryByRole('region', { name: 'Result' })).not.toBeInTheDocument()
  })

  it('reports an audit event that has not arrived yet', async () => {
    explorerApi({
      execute: (body) => ({
        body: { ...changeResult(body), audit: { expected: 1, delivered: 0, waited_ms: 10000, timed_out: true, events: [] } },
      }),
    })
    renderApp('/explorer?table=public.users')
    await gridRow('Ada')
    const builder = screen.getByRole('region', { name: 'Query builder' })
    await userEvent.type(within(builder).getByLabelText('name'), 'x')
    await userEvent.click(await within(builder).findByRole('button', { name: 'Run insert' }))
    const result = await screen.findByRole('region', { name: 'Result' })
    expect(within(result).getByText('not delivered after 10.00 s')).toBeInTheDocument()
    expect(within(result).getByText(/safe in DBMesh's outbox/)).toBeInTheDocument()
  })

  it('says when no rows matched and when a replica never showed the change', async () => {
    explorerApi({
      execute: (body) => ({
        body: {
          ...changeResult(body), rowcount: 0, row: null, audit: null,
          replication: { readers: [{ reader: 1, visible_after_ms: null, stale_reads: 9, lag_bytes: 2048 }], fallback_reads: 0, timed_out: true },
        },
      }),
    })
    renderApp('/explorer?table=public.users')
    await gridRow('Ada')
    const builder = screen.getByRole('region', { name: 'Query builder' })
    await userEvent.type(within(builder).getByLabelText('name'), 'x')
    await userEvent.click(await within(builder).findByRole('button', { name: 'Run insert' }))
    const result = await screen.findByRole('region', { name: 'Result' })
    expect(within(result).getByText('No rows matched')).toBeInTheDocument()
    expect(within(result).getByText('not visible yet')).toBeInTheDocument()
    expect(within(result).getByText(/not captured in the audit log/)).toBeInTheDocument()
  })

  it('can dismiss the result', async () => {
    explorerApi()
    renderApp('/explorer?table=public.users')
    await gridRow('Ada')
    const builder = screen.getByRole('region', { name: 'Query builder' })
    await userEvent.type(within(builder).getByLabelText('name'), 'x')
    await userEvent.click(await within(builder).findByRole('button', { name: 'Run insert' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss result' }))
    expect(screen.queryByRole('region', { name: 'Result' })).not.toBeInTheDocument()
  })
})
