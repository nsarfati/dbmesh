# Persistent row auditing

DBMesh captures row changes with PostgreSQL triggers and delivers committed events
from a source outbox to an independent PostgreSQL audit database.

## Enable

Add an `audit` section to DBMesh's `config.yaml` (it is included in
`config_example.yaml`):

```yaml
audit:
  sinks: [postgres]
  postgres:
    url: "postgres://dbmesh_audit:dbmesh_audit@localhost:55435/dbmesh_audit?sslmode=disable"
  retention: 168h        # keep delivered events this long; 0 keeps them forever
  cleanup_interval: 1m   # time between cleanup runs
  cleanup_batch: 1000    # rows deleted per transaction
```

Run `docker compose up -d audit` and restart `make run`. The audit database must
exist; the worker creates `public.audit_events` on first delivery. Without
`sinks`, row-audit connections are rejected and no workers run. Unknown/duplicate
sink names are rejected. Only `postgres` is implemented in this version. Auditing
applies to every database in `databases`; each gets its own outbox, worker and
cleaner, and all deliver to the same audit database.

The Python connection selects tables independently of other connections:

```python
dsn = (
    "postgresql://dbmesh@localhost:6432/demo"
    "?sslmode=disable&audit=public.users"
)
with dbmesh.connect(dsn) as conn:
    with conn.request(user_id="812", request_id="req-123", service="billing"):
        with conn.cursor() as cur:
            cur.execute("UPDATE users SET plan=%s WHERE id=%s", ("enterprise", 1))
```

The wrapper removes `audit` before libpq parses the URI, translating it to standard
startup `options`: `-c dbmesh.audit_tables=public.users`. DBMesh consumes the option,
prepares the source tables and acknowledges the selection before returning a usable
connection. The wrapper refuses a server that does not confirm the selection.

## Capture and transaction semantics

Preparation creates a `dbmesh` schema, generic trigger functions, `audit_outbox`
and `audit_delivery`, plus triggers on selected tables. This requires source DDL
permissions. Installation is serialized with a transaction advisory lock across
processes and connections. Missing/unsupported tables fail startup. Triggers stay
installed after disconnect but only capture the executing connection's selection.
Connections without `audit` do not generate row events on these tables.

Before each primary operation, DBMesh renews the reserved `dbmesh.context` setting
on that client's private primary connection. It includes table selection, sinks
and request metadata; outside `request()` identity fields are NULL. Session scope
avoids injecting BEGIN/COMMIT and preserves user transaction boundaries. Context
is renewed after rollback/savepoint recovery too. Aborted transactions are allowed
to execute recovery commands without setting context first. Internal settings do
not pass through the router or make replica reads sticky to primary.

For each INSERT/UPDATE/DELETE row, the trigger writes the before/after images and
pending deliveries in the same transaction. ROLLBACK removes both the business
change and event. Capture failure fails the write. INSERT has NULL previous value;
DELETE has NULL new value. SELECTs remain eligible for replicas and produce only
the existing execution log, not row-change events.

Both the source outbox and destination contain:

```text
event_id UUID (unique) | db | schema | table | operation
audit_user_id | audit_request_id | audit_service
previous_value JSONB | new_value JSONB | created_at TIMESTAMPTZ
```

`created_at` is capture time, not commit order. Quote `"schema"` and `"table"` in SQL.
`audit_delivery` tracks `(event_id, sink, delivered_at)` independently for each sink.

## Worker and recovery

The trigger emits `NOTIFY dbmesh_audit_pending` with an empty payload. A dedicated
internal primary connection per source database establishes LISTEN before scanning
pending events. It drains on notifications and every five seconds as backup.
Failures retry with a one-second backoff. For each configured database, DBMesh
looks for an existing outbox at startup, when audited clients connect, and every
30 seconds, so pending events recover even when applications have not
reconnected. The configured writer role needs connection access to each audited
database. This does not add client LISTEN/NOTIFY support.

The worker persists each event at the destination before acknowledging delivery
in the source. A crash between these steps causes redelivery: the destination's
unique event_id prevents duplicates. No user SQL is retried. The destination is
asynchronous, so events can arrive after the client receives success.

Future queue/stream sinks implement `RowSink.Deliver` and acknowledge only durable
acceptance; deliveries are at-least-once. PostgreSQL sinks have a separate connection
per worker. Triggers never connect to remote sinks. New sinks are not automatically
backfilled with historical events.

Pending events survive destination outages but consume source space, so watch the
delivery status below.

## Cleanup and delivery status

A small cleaner runs next to each database's worker (unless `retention` is `0`).
Every `cleanup_interval` it deletes outbox events in batches of `cleanup_batch`,
one transaction per batch, and only when both conditions hold:

- **every** sink has acknowledged the event (no pending `audit_delivery` row), and
- the most recent acknowledgement is older than `retention`.

An event that any sink has not yet delivered is never removed, however old it is.
Cleaning skips rows locked by another transaction and picks them up on the next run.

Delivery health is stored in the source database and readable with plain SQL:

```sql
SELECT sink, pending, oldest_pending_age, last_success_at, last_error, last_error_at
FROM dbmesh.audit_delivery_status;
```

| Column               | Meaning                                                        |
| -------------------- | -------------------------------------------------------------- |
| `pending`            | Events created but not yet acknowledged by the sink            |
| `oldest_pending_age` | Age of the oldest pending event (`NULL` when none is pending)  |
| `last_success_at`    | Last time the worker delivered a batch to the sink             |
| `last_error`         | Message of the sink's most recent delivery failure (truncated) |
| `last_error_at`      | When that failure happened                                     |

`last_error` is kept after the sink recovers; compare it with `last_success_at` to
tell whether it is current. A sink appears in the view once it has pending events
or has succeeded or failed at least once. The status table is written by the
worker on a best-effort basis: if it cannot be written, delivery continues and a
warning is logged.

## MVP boundaries

- One statement per Simple Query message on row-audited connections; send
  BEGIN/UPDATE/COMMIT separately. Other connections retain multi-statement support.
- Permanent ordinary tables with unquoted lowercase `schema.table` names, with
  no table-count limit and a 4096-byte limit on the selection parameter.
  Partitioned/inherited tables, views, temporary/unlogged tables and quoted
  identifiers are unsupported. TRUNCATE on selected tables is explicitly rejected.
- Immediate INSERT/UPDATE/DELETE triggers only. No row history for reads, DDL,
  failed attempts or TRUNCATE. Do not drop/rename audited tables or disable their
  triggers during use; reconnect to validate preparation after schema changes.
  Deferred user triggers and procedures that manage transactions are outside the
  supported audit contract.
- Selection and metadata are application-declared, not tamper-proof identity.
  The demo uses a privileged upstream role. SQL modifying DBMesh's internal
  settings/schema/triggers can change or bypass auditing. This is not a security
  boundary against a malicious SQL client.
- Repeated edits of a row have different event IDs; row keys are in the JSON.
  Multiple source clusters sharing a destination would need an extra source
  identity to disambiguate identical database/schema/table names.

## Inspect and test

```bash
psql 'postgres://dbmesh_audit:dbmesh_audit@localhost:55435/dbmesh_audit?sslmode=disable' \
  -c 'SELECT db, "schema", "table", audit_user_id, audit_request_id, previous_value, new_value FROM audit_events ORDER BY created_at DESC LIMIT 10;'
```

Real-database tests use fixture tables and preserve existing demo rows:

```bash
export DBMESH_TEST_WRITER_URL='postgres://dbmesh:dbmesh@localhost:55432/demo?sslmode=disable'
export DBMESH_TEST_READER_URLS='postgres://dbmesh:dbmesh@localhost:55433/demo?sslmode=disable,postgres://dbmesh:dbmesh@localhost:55434/demo?sslmode=disable'
export DBMESH_TEST_AUDIT_URL='postgres://dbmesh_audit:dbmesh_audit@localhost:55435/dbmesh_audit?sslmode=disable'
go test -race ./... -count=1
DBMESH_TEST_PROXY_URL='postgresql://dbmesh@localhost:6432/demo?sslmode=disable' \
  .venv/bin/python -m unittest discover -s clients/python/tests -v
```

Tests cover concurrent installation, per-connection selection, row images,
rollback/savepoints, metadata isolation, notification delivery with a one-hour
fallback interval, listener termination/reconnect, sink unavailability and
redelivery after destination commit, batched cleanup (including sinks that are
still pending or acknowledged inside the retention window, run in a throwaway
database) and the delivery status view. Python tests exercise DSN → startup → trigger
→ sink, including preserving UPDATE RETURNING results.
