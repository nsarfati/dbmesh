import { Loader2, Play, ShieldAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { ApiError } from '@/api/client'
import { useExecute, usePreview } from '@/api/hooks'
import type { ChangeOut, Row, TableOut } from '@/api/types'
import { ErrorBanner } from '@/components/Feedback'
import { JsonView } from '@/components/JsonView'
import { SqlBlock } from '@/components/SqlBlock'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { buildChange, initialForm, rowKey, type Context, type FormState, type Mode, type Operation } from '@/lib/explorer'
import { useDebounced } from '@/lib/useDebounced'
import { cn } from '@/lib/utils'
import { FieldInput } from './FieldInput'

const USER_KEY = 'dbmesh-dashboard-user'

function savedUser(): string {
  try {
    return localStorage.getItem(USER_KEY) || 'dashboard'
  } catch {
    return 'dashboard'
  }
}

interface Props {
  database: string
  table: TableOut
  selectedRow: Row | null
  onExecuted: (result: ChangeOut, operation: Operation) => void
}

export function Builder({ database, table, selectedRow, onExecuted }: Props) {
  const hasKey = table.primary_key.length > 0
  const [operation, setOperation] = useState<Operation>('INSERT')
  const [context, setContext] = useState<Context>(() => ({ user_id: savedUser(), service: 'dashboard', request_id: '', audit: true }))
  const update = (patch: Partial<Context>) => {
    setContext((current) => ({ ...current, ...patch }))
    if (patch.user_id !== undefined) {
      try {
        localStorage.setItem(USER_KEY, patch.user_id)
      } catch {
        // Not persisting the name is harmless.
      }
    }
  }
  const rowIdentity = selectedRow ? rowKey(table.primary_key, selectedRow) + JSON.stringify(selectedRow) : ''

  return (
    <section aria-label="Query builder" className="rounded-lg border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Query builder</h2>
        <Segmented
          label="Operation"
          value={operation}
          onChange={setOperation}
          options={[
            { value: 'INSERT', label: 'Insert' },
            { value: 'UPDATE', label: 'Update', disabled: !hasKey, title: hasKey ? undefined : 'Needs a primary key' },
            { value: 'DELETE', label: 'Delete', disabled: !hasKey, title: hasKey ? undefined : 'Needs a primary key' },
          ]}
        />
      </header>
      <BuilderForm
        key={`${table.schema}.${table.table}|${operation}|${rowIdentity}`}
        database={database}
        table={table}
        operation={operation}
        row={operation === 'INSERT' ? null : selectedRow}
        context={context}
        onContext={update}
        onExecuted={onExecuted}
      />
    </section>
  )
}

interface FormProps {
  database: string
  table: TableOut
  operation: Operation
  row: Row | null
  context: Context
  onContext: (patch: Partial<Context>) => void
  onExecuted: (result: ChangeOut, operation: Operation) => void
}

function modesFor(operation: Operation, column: TableOut['columns'][number]): Mode[] {
  const modes: Mode[] = ['value']
  if (column.nullable) modes.push('null')
  if (operation === 'INSERT' && (column.has_default || column.nullable)) modes.push('omit')
  return modes
}

function BuilderForm({ database, table, operation, row, context, onContext, onExecuted }: FormProps) {
  const [form, setForm] = useState<FormState>(() => initialForm(operation, table.columns, row))
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const effective = useMemo<Context>(() => ({ ...context, audit: context.audit && table.auditable }), [context, table.auditable])
  const built = useMemo(() => buildChange(operation, table, form, row, effective), [operation, table, form, row, effective])

  const preview = usePreview(database, useDebounced(built.body))
  const execute = useExecute(database)
  useEffect(() => {
    if (execute.isError) execute.reset()
  }, [built.body])

  const previewError = built.body && preview.isError ? (preview.error instanceof ApiError ? preview.error.message : 'Could not build the statement') : null
  const auditProblem = built.body ? preview.data?.audit_problem : null
  const canRun = built.body !== null && !previewError && !auditProblem && !execute.isPending

  function runExecute() {
    if (!built.body) return
    execute.mutate(built.body, { onSuccess: (result) => onExecuted(result, operation) })
  }

  function run() {
    if (!built.body || !canRun) return
    if (operation === 'DELETE') {
      setConfirmingDelete(true)
      return
    }
    runExecute()
  }

  return (
    <div className="space-y-5 p-4">
      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-2 text-xs font-medium text-muted-foreground">Audit context</legend>
        <div>
          <label htmlFor="ctx-user" className="mb-1 block text-xs font-medium">User ID <span className="text-delete">*</span></label>
          <Input id="ctx-user" value={context.user_id} onChange={(e) => onContext({ user_id: e.target.value })} className="font-mono" />
        </div>
        <div>
          <label htmlFor="ctx-service" className="mb-1 block text-xs font-medium">Service</label>
          <Input id="ctx-service" value={context.service} onChange={(e) => onContext({ service: e.target.value })} />
        </div>
        <div>
          <label htmlFor="ctx-request" className="mb-1 block text-xs font-medium">Request ID</label>
          <Input id="ctx-request" value={context.request_id} onChange={(e) => onContext({ request_id: e.target.value })} placeholder="generated" className="font-mono" />
        </div>
        <div className="sm:col-span-3">
          <label className={cn('flex items-center gap-2 text-sm', !table.auditable && 'opacity-60')}>
            <input
              type="checkbox"
              checked={effective.audit}
              disabled={!table.auditable}
              onChange={(e) => onContext({ audit: e.target.checked })}
              className="size-4 accent-[var(--primary)]"
            />
            Capture this change in the audit log
          </label>
          {!table.auditable ? (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-update">
              <ShieldAlert aria-hidden className="size-3.5" />
              {table.schema}.{table.table} cannot be audited: DBMesh needs unquoted lowercase schema.table names.
            </p>
          ) : (
            effective.audit && (
              <p className="mt-1 text-xs text-muted-foreground">
                The first audited change to a table makes DBMesh install audit triggers on it.
              </p>
            )
          )}
        </div>
      </fieldset>

      {operation === 'DELETE' ? (
        <section aria-label="Row to delete">
          <h3 className="mb-2 text-sm font-semibold">Row to delete</h3>
          {row ? (
            <JsonView value={row} label="Selected row as JSON" />
          ) : (
            <p className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">Select a row in the table above.</p>
          )}
        </section>
      ) : operation === 'UPDATE' && !row ? (
        <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
          Select a row in the table above to edit it. Only the fields you change are sent.
        </p>
      ) : (
        <section aria-label="Fields" className="grid gap-3 md:grid-cols-2">
          {table.columns.map((column) => (
            <FieldInput
              key={column.name}
              column={column}
              state={form[column.name] ?? { mode: 'omit', text: '' }}
              error={built.errors[column.name]}
              modes={modesFor(operation, column)}
              fixed={operation === 'UPDATE' && column.primary_key ? String(row?.[column.name]) : undefined}
              onChange={(state) => setForm((current) => ({ ...current, [column.name]: state }))}
            />
          ))}
        </section>
      )}

      <div aria-live="polite">
        {built.body === null ? (
          // The row picker above already says a row is needed.
          operation !== 'INSERT' && !row ? null : <p className="text-sm text-muted-foreground">{built.blocked}</p>
        ) : previewError ? (
          <p role="alert" className="text-sm text-delete">{previewError}</p>
        ) : preview.data ? (
          <SqlBlock title="SQL preview" statement={preview.data.statement} audited={preview.data.audited} />
        ) : (
          <p className="text-sm text-muted-foreground" role="status">Building the statement…</p>
        )}
        {auditProblem && <p role="alert" className="mt-2 text-sm text-update">{auditProblem}</p>}
      </div>

      {execute.isError && <ErrorBanner message={execute.error.message} />}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {built.changed.length > 0 && operation !== 'DELETE' && (
          <span className="mr-auto text-xs text-muted-foreground">
            {built.changed.length} {built.changed.length === 1 ? 'field' : 'fields'} to send
          </span>
        )}
        <Button variant="outline" onClick={() => setForm(initialForm(operation, table.columns, row))}>
          Reset
        </Button>
        <Button
          variant="primary"
          disabled={!canRun}
          onClick={run}
          className={cn(operation === 'DELETE' && 'bg-delete text-white hover:opacity-90')}
        >
          {execute.isPending ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Play aria-hidden className="size-4" />}
          {operation === 'DELETE' ? 'Delete row' : `Run ${operation.toLowerCase()}`}
        </Button>
      </div>

      {operation === 'DELETE' && (
        <ConfirmDialog
          open={confirmingDelete}
          onOpenChange={setConfirmingDelete}
          title="Delete this row?"
          description="This runs a DELETE statement. It cannot be undone from here."
          confirmLabel="Delete row"
          onConfirm={() => { setConfirmingDelete(false); runExecute() }}
        >
          {row && <JsonView value={row} label="Row to delete as JSON" />}
        </ConfirmDialog>
      )}
    </div>
  )
}
