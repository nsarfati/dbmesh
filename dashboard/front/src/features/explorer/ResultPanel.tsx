import { CircleCheck, CircleSlash, ExternalLink, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { AuditOut, ChangeOut } from '@/api/types'
import { ChangesDiff } from '@/components/ChangesDiff'
import { CopyButton } from '@/components/CopyButton'
import { OperationBadge } from '@/components/OperationBadge'
import { SqlBlock } from '@/components/SqlBlock'
import { Button } from '@/components/ui/button'
import { formatMillis } from '@/lib/explorer'
import { ReplicationTimeline } from './ReplicationTimeline'
import { RouteBadge } from './RouteBadge'

function AuditSection({ audit, operation }: { audit: AuditOut | null | undefined; operation: string }) {
  if (!audit) {
    return (
      <section aria-label="Audit event">
        <h3 className="text-sm font-semibold">Audit event</h3>
        <p className="mt-2 rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
          {operation ? 'This change was not captured in the audit log.' : ''}
        </p>
      </section>
    )
  }
  const late = audit.timed_out
  return (
    <section aria-label="Audit event" className="min-w-0">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">Audit event</h3>
        <span className={late ? 'text-xs text-update' : 'text-xs text-insert'} role="status">
          {audit.error
            ? audit.error
            : late
              ? `not delivered after ${formatMillis(audit.waited_ms)}`
              : `delivered in ${formatMillis(audit.waited_ms)}`}
        </span>
      </div>
      {audit.events.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
          The event has not reached the audit database yet. It is safe in DBMesh's outbox and will be delivered when the worker catches up; check the
          Audit log in a moment.
        </p>
      ) : (
        <div className="space-y-3">
          {audit.events.map((event) => (
            <div key={event.event_id} className="overflow-hidden rounded-lg border">
              <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
                <OperationBadge operation={event.operation} />
                <Link to={`/audit?event=${encodeURIComponent(event.event_id)}`} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                  Open in audit log <ExternalLink aria-hidden className="size-3" />
                </Link>
              </div>
              <ChangesDiff event={event} />
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

interface Props {
  result: ChangeOut
  onDismiss: () => void
}

export function ResultPanel({ result, onDismiss }: Props) {
  const changed = result.rowcount > 0
  return (
    <section aria-label="Result" className="overflow-hidden rounded-lg border bg-card">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3">
        {changed ? <CircleCheck aria-hidden className="size-5 text-insert" /> : <CircleSlash aria-hidden className="size-5 text-update" />}
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">
            {changed ? `${result.rowcount} ${result.rowcount === 1 ? 'row' : 'rows'} ${verb(result.operation)}` : 'No rows matched'}
          </h2>
          <p className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
            {result.request_id}
            <CopyButton value={result.request_id} label="request ID" className="size-5" />
          </p>
        </div>
        <RouteBadge route={result.route} />
        <Button variant="ghost" size="icon" aria-label="Dismiss result" className="ml-auto" onClick={onDismiss}>
          <X aria-hidden className="size-4" />
        </Button>
      </header>
      <div className="grid gap-6 p-4 xl:grid-cols-2">
        <div className="min-w-0 space-y-6">
          <SqlBlock title="SQL that ran" statement={result.statement} audited={Boolean(result.audit)} />
          {result.replication && <ReplicationTimeline replication={result.replication} />}
        </div>
        <AuditSection audit={result.audit} operation={result.operation} />
      </div>
    </section>
  )
}

function verb(operation: string): string {
  return operation === 'INSERT' ? 'inserted' : operation === 'DELETE' ? 'deleted' : 'updated'
}
