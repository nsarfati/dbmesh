# DBMesh

**PostgreSQL row auditing with request context, behind one endpoint.**

DBMesh captures before/after row images for selected tables and associates
changes with application context: user, request ID and service. Its Python client
attaches that context to queries, while the proxy records audit events in a
durable outbox for delivery to a separate audit database.

DBMesh also provides read/write routing through a PostgreSQL-compatible endpoint.
Safe reads go to healthy replicas; writes, locking reads, transactions and
session-sensitive work stay on the primary. Ordinary PostgreSQL clients can use
the routing endpoint; contextual row auditing requires the Python client.

> **Test it now**
>
> Explore the [live DBMesh demo](https://dbmesh.products.snackfactory.io/).
>
> **Password:** `XV#@87R&^jMzfmsV`

> **Status: early prototype.** Inspired by PgBouncer, DBMesh focuses on contextual
> row auditing and read/write routing. See [Limitations](#limitations) before
> pointing it at anything important.

## Contents

- [How it works](#how-it-works)
- [Technology stack](#technology-stack)
- [Project structure](#project-structure)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Row auditing and client support](#row-auditing-and-client-support)
- [Dashboard](#dashboard)
- [Examples](#examples)
- [Reader health and replication lag](#reader-health-and-replication-lag)
- [Correctness rule](#correctness-rule)
- [Limitations](#limitations)
- [Roadmap](#roadmap)

## How it works

```text
psql / app / ORM
       |
       | PostgreSQL wire protocol
       v
   +---------+      one entry per database in config_proxy.yaml
   | DBMesh  |
   +----+----+
        |
    +---+----------------+
    |                    |
 primary              replicas
                          |
                    round-robin
```

- Supports the PostgreSQL startup handshake and the Simple Query Protocol.
- Plain `SELECT`s go round-robin to replicas that are healthy and within the
  configured WAL lag limit.
- `INSERT` / `UPDATE` / `DELETE` / DDL, `SELECT ... FOR UPDATE/SHARE` and
  anything unrecognised go to the primary.
- `BEGIN` pins the session to the primary until `COMMIT` / `ROLLBACK`.
  Stateful statements such as `SET` pin the whole session.
- Route decisions are reported to the client as `NOTICE` messages and in the
  structured server log. The notice's `DETAIL` carries the same decision as JSON
  (`target`, `reader`, `reason`, `lag_bytes`, `duration_us`) for programs; the
  Python client exposes it as `conn.last_route`.
- Several databases can be served at once, each with its own writer, readers and
  health policy.

SQL is parsed with PostgreSQL 17's parser via
[`pg_query_go`](https://github.com/pganalyze/pg_query_go). The classifier walks
every statement and nested AST node; a message goes to the primary if any part
writes, locks, changes session state, or uses syntax it does not recognise.

## Technology stack

DBMesh combines a Go proxy, PostgreSQL row auditing and a web dashboard for
exploring changes and observing query traffic.

| Area | Technologies | Role in DBMesh |
| ---- | ------------ | -------------- |
| Proxy and SQL classification | Go, pgx, pg_query_go | Handle PostgreSQL connections and parse SQL into an AST to make conservative routing decisions. |
| Audit capture and storage | PostgreSQL, triggers, JSONB, transactional outbox | Capture before/after row images in the same transaction as each change and deliver committed events to a separate audit database. |
| Current audit client | Python, psycopg 3 | Select audited tables and attach user, request and service context to queries. Support for more languages and clients is planned. |
| Dashboard API | FastAPI, Uvicorn | Serve audit events and support data exploration and changes through DBMesh. |
| Dashboard interface | React, TypeScript, Vite, Tailwind CSS, TanStack Query | Build the audit log, data explorer and metrics views, with styling and server-data fetching. |
| Metrics | Prometheus | Collect proxy traffic, routing, error and latency metrics for the dashboard. |
| Local environment | Docker Compose | Run the demo primary, streaming replicas, audit database and Prometheus. |

## Project structure

This repository contains the Go proxy, the language clients and the dashboard.
The proxy's Go module lives at the repository root, with its entry point in
`cmd/dbmesh/` and implementation in `internal/`.

```text
cmd/dbmesh/          Proxy entry point
internal/
  audit/             Audit capture, delivery and retention
  config/            Proxy configuration
  proxy/             PostgreSQL client sessions and query handling
  router/            SQL classification and routing decisions
  upstream/          Primary and replica connections and health monitoring
clients/
  python/            Python audit client; more language clients are planned
dashboard/
  api/               Python/FastAPI dashboard backend
  front/             React/TypeScript dashboard interface
docker/              Internal development and local testing infrastructure
```

The `docker/` directory contains PostgreSQL initialization scripts, replica setup
and Prometheus configuration for internal development and local testing.
The root `docker-compose.yml` starts this development environment.

The root also contains the `Makefile`, Dockerfiles and example configuration
files used to run the project. Each client and dashboard
component has its own dependencies and setup instructions; see the
[Python client](clients/python/README.md), [dashboard API](dashboard/api/README.md)
and [dashboard front end](dashboard/front/README.md) guides.

## Quick start

Prerequisites: Go 1.23+, a C compiler (the parser uses CGO, with `CGO_ENABLED=1`),
Docker Compose and `psql`.

```bash
cp config_proxy.example.yaml config_proxy.yaml   # local settings; ignored by Git
make local-up                           # primary, two replicas, audit database and Prometheus
make run                             # DBMesh on :6432
```

In another terminal:

```bash
make demo                            # psql to postgresql://dbmesh@localhost:6432/demo
```

`make local-up` starts these containers on the host:

| Service    | Host port | Purpose                                        |
| ---------- | --------- | ---------------------------------------------- |
| primary    | 55432     | Demo primary (user/password `dbmesh`, db `demo`) |
| replica1   | 55433     | Streaming replica                              |
| replica2   | 55434     | Streaming replica                              |
| audit      | 55435     | Row-audit destination (`dbmesh_audit`)           |
| prometheus | 9090      | Proxy metrics storage and querying             |

Replicas take a physical base backup before accepting connections. Check that
the primary returns `f` and both replicas return `t`:

```bash
for port in 55432 55433 55434; do
  psql "postgres://dbmesh:dbmesh@localhost:$port/demo?sslmode=disable" \
    -X -c 'SELECT pg_is_in_recovery();'
done
```

`make local-up` respects Compose health dependencies: `replica1` starts after
`primary` is healthy, and `replica2` starts after `replica1` is healthy, so the two
base backups never overlap. It does not wait for all services to become healthy. `make local-down` removes the
containers and **deletes their volumes**.

## Configuration

DBMesh reads a YAML file, `config_proxy.yaml` by default. Pass another path with
`-config path/to/file.yaml` or `DBMESH_CONFIG`. Unknown keys are rejected so a
typo never silently changes behaviour. [`config_proxy.example.yaml`](config_proxy.example.yaml)
documents every option:

```yaml
listen: ":6432"
metrics_listen: "127.0.0.1:9091"    # optional; empty disables the Prometheus endpoint

databases:
  demo:                          # the database name clients connect to
    writer:
      user: dbmesh
      pwd: dbmesh
      host: "localhost:55432"
    reader:                      # optional; without it every query uses the writer
      user: dbmesh
      pwd: dbmesh
      host: ["localhost:55433", "localhost:55434"]
      check_interval: 1s
      check_timeout: 500ms
      max_lag_bytes: 1048576
      status_max_age: 3s

audit:                           # optional, see "Row auditing"
  sinks: [postgres]
  postgres:
    url: "postgres://dbmesh_audit:dbmesh_audit@localhost:55435/dbmesh_audit"
  retention: 168h
```

| Key                                 | Default | Meaning                                                          |
| ----------------------------------- | ------- | ---------------------------------------------------------------- |
| `listen`                            | `:6432` | Address for client connections                                   |
| `metrics_listen`                    | empty (disabled) | HTTP address for Prometheus metrics (`/metrics`)          |
| `databases.<name>.writer`           | —       | `user`, `pwd`, `host` (`host:port`), optional `sslmode`          |
| `databases.<name>.reader`           | none    | `user`, `pwd`, `host` (a list), optional `sslmode`, health policy |
| `reader.check_interval`             | `1s`    | Time between monitoring rounds                                   |
| `reader.check_timeout`              | `500ms` | Timeout per monitoring probe and reader connection attempt       |
| `reader.max_lag_bytes`              | `1048576` | Maximum WAL bytes a reader may trail the writer; `0` is allowed |
| `reader.status_max_age`             | `3s`    | Oldest primary sample still trusted for lag                      |
| `audit.sinks`                       | none    | Enabled sinks; only `postgres` exists today                      |
| `audit.postgres.url`                | —       | Destination database (required with the `postgres` sink)         |
| `audit.retention`                   | `168h`  | Keep delivered events this long; `0` keeps them forever          |
| `audit.cleanup_interval`            | `1m`    | Time between cleanup runs                                        |
| `audit.cleanup_batch`               | `1000`  | Rows deleted per transaction                                     |

- The key under `databases` is both the name clients ask for and the database
  name used upstream. A client asking for a database that is not configured is
  rejected with `3D000`.
- Credentials are yours to protect: keep `config_proxy.yaml` out of version control
  (it is in `.gitignore`) and restrict its file permissions.
- Durations use Go syntax (`500ms`, `30s`, `168h`); a bare `0` is also accepted.

## Row auditing and client support

DBMesh's main goal is to make row changes traceable: what changed, the values
before and after, and the application user, request and service associated with
the change. Read/write routing supports this through a single PostgreSQL endpoint.

Currently, **Python is the only supported client for contextual row auditing**.
Support for more languages and clients is planned. Ordinary PostgreSQL clients
can already use the routing endpoint.

The [Python client](clients/python/README.md) wraps psycopg 3 and adds an
encoded SQL comment with request context to each execution. DBMesh strips it
before routing and executing the SQL. Without a table selection the context only
enriches the statement execution log (`query audited`); with `&audit=schema.table`
DBMesh installs triggers that write committed row changes to a per-database
outbox and delivers them at-least-once, deduplicated by event ID, to the audit
database.

### Enable row auditing

Add an `audit` section to DBMesh's `config_proxy.yaml` (it is included in
`config_proxy.example.yaml`):

```yaml
audit:
  sinks: [postgres]
  postgres:
    url: "postgres://dbmesh_audit:dbmesh_audit@localhost:55435/dbmesh_audit?sslmode=disable"
  retention: 168h        # keep delivered events this long; 0 keeps them forever
  cleanup_interval: 1m   # time between cleanup runs
  cleanup_batch: 1000    # rows deleted per transaction
```

`make local-up` already starts the audit service and creates the `dbmesh_audit`
database. If you change the audit configuration while DBMesh is running, restart
the proxy with `make run`. For an external audit destination, create the database
before using it; the worker creates `public.audit_events` on first delivery. Without
`sinks`, row-audit connections are rejected and no workers run. Unknown/duplicate
sink names are rejected. Only `postgres` is implemented in this version. Auditing
applies to every database in `databases`; each gets its own outbox, worker and
cleaner, and all deliver to the same audit database.

### Python client with request context

```bash
python3 -m venv venv
venv/bin/python -m pip install -e './clients/python[binary]'
```

```python
import dbmesh

dsn = "postgresql://dbmesh@localhost:6432/demo?sslmode=disable&audit=public.users"

with dbmesh.connect(dsn) as conn:
    with conn.request(user_id="812", request_id="req-123", service="billing"):
        with conn.cursor() as cur:
            cur.execute("UPDATE users SET plan = %s WHERE id = %s", ("enterprise", 1))
```

`&audit=public.users` asks DBMesh to capture row changes to that table; the
request context is stored with every captured event.

The wrapper removes `audit` before libpq parses the URI, translating it to standard
startup `options`: `-c dbmesh.audit_tables=public.users`. DBMesh consumes the option,
prepares the source tables and acknowledges the selection before returning a usable
connection. The wrapper refuses a server that does not confirm the selection.

### Capture and transaction semantics

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

### Worker and recovery

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

### Cleanup and delivery status

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

### Audit limitations

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

### Inspect audit events

```bash
psql 'postgres://dbmesh_audit:dbmesh_audit@localhost:55435/dbmesh_audit?sslmode=disable' \
  -c 'SELECT db, "schema", "table", audit_user_id, audit_request_id, previous_value, new_value FROM audit_events ORDER BY created_at DESC LIMIT 10;'
```

## Dashboard

The DBMesh dashboard brings the audit trail, data explorer and traffic metrics
into one interface. Use it to investigate what changed, compare row values before
and after a change, and trace it to the application-declared user, request and
service.

- **Audit log**: browse captured INSERT, UPDATE and DELETE events. Filter by table,
  operation, user, service, request ID and time range, then open an event for a
  field-by-field diff and full row images. Filters are stored in the URL so you
  can share a link to the same view.
- **Explorer**: browse tables and see which node served a read and its reported
  replication lag. Use the query builder to preview and execute changes through
  DBMesh, then inspect the resulting audit event and how long each replica took
  to reflect the change.
- **Metrics**: follow query traffic, routing across the writer and readers, SQL
  errors and upstream latency. Filter by database and time period to understand
  how the proxy is handling application traffic.

### Open the dashboard

After the Quick start, with DBMesh running and `audit.sinks` configured, run this
in another terminal:

```bash
make dashboard      # builds and serves the dashboard on http://127.0.0.1:8000
```

Open http://127.0.0.1:8000 and sign in with the password printed at startup, or
set one with `DASHBOARD_PASSWORD=secret make dashboard`.

The dashboard reads the audit database, sends queries and changes through DBMesh
using the Python client, and gets traffic metrics from Prometheus. It currently
supports development and demos; keep it on localhost. See
[dashboard/README.md](dashboard/README.md) for development setup and its security
model.

### Prometheus metrics

Set `metrics_listen: "127.0.0.1:9091"` in `config_proxy.yaml` and restart DBMesh.
An omitted or empty setting disables the endpoint. `make local-up` also starts
Prometheus. To start only the collector, use `docker compose up -d prometheus`,
then open **Metrics** in the dashboard.
The dashboard API reads `prometheus_url` from its config (default `http://127.0.0.1:9090`).
Restart the dashboard API and rebuild the front end (`make dashboard`) after updating.

The Compose collector uses **host networking** because the demo proxy runs on the
host. This works on Linux; Docker Desktop needs host networking enabled. Both
Prometheus (`:9090`) and the proxy metrics listener (`:9091`) bind to loopback in
this setup. For a remote collector, configure a reachable metrics address and
change `docker/prometheus/prometheus.yml`. The metrics listener has no authentication;
keep it on a trusted interface. PostgreSQL remains on its own port (`:6432`).

Prometheus scrapes `GET /metrics` every 15 seconds and retains samples for 7 days
in the `prometheus-data` volume. No HTTP request occurs in the query path. Metrics
update in memory and the proxy continues working when Prometheus is unavailable.

- `dbmesh_queries_total{database,operation,target,reader,outcome}` counts **completed
  attempts to execute client Simple Query messages upstream**, once per message.
  `target` is the actual `primary` or `replica`, including reader fallback; `reader`
  is `0` for the writer and the configured 1-based reader number otherwise.
- `operation` is the outer AST statement kind: `select`, `insert`, `update`,
  `delete`, `merge`, `transaction`, `other`, `empty`, or `unknown` (parse failure).
  Several statements in a parsed message use `multi`, even if execution stops early.
  A SELECT with a modifying CTE remains `select`, with its actual primary destination.
- `outcome` is `success`, `error` (SQL error), or `unknown` (transport failure).
  Success does not imply a transaction committed. Requests rejected before execution,
  internal health queries and audit setup/delivery queries are excluded.
- `dbmesh_query_duration_seconds{database,target,reader}` is a histogram of upstream
  execution and result-reading time, excluding routing, audit setup and client delivery.

Period totals use `sum(increase(...))` and rates use `sum(rate(...))`, applying the
function to each counter before aggregation to handle restarts. Totals are estimates
and may be fractional; scraping can miss activity before a first sample or around a
restart. This is monitoring, not an exact audit ledger. Allow at least two scrapes
after startup. The dashboard distinguishes collection failures from zero traffic.

## Examples

### Several databases with their own replicas

```yaml
databases:
  shop:
    writer: {user: dbmesh, pwd: "s3cret", host: "shop-primary:5432"}
    reader:
      user: dbmesh
      pwd: "s3cret"
      host: ["shop-replica-1:5432", "shop-replica-2:5432"]
  analytics:
    writer: {user: dbmesh, pwd: "s3cret", host: "analytics-primary:5432"}
    reader:
      user: dbmesh
      pwd: "s3cret"
      host: ["analytics-replica:5432"]
      max_lag_bytes: 4194304     # analytics tolerates more lag
```

Clients pick the database in the usual way:
`psql "postgresql://dbmesh@localhost:6432/analytics"`.

### Watching the routing

```sql
SELECT * FROM users;                                  -- NOTICE: dbmesh -> replica (read-only SELECT, 1.2ms)
UPDATE users SET plan = 'enterprise' WHERE id = 1;    -- NOTICE: dbmesh -> primary (write statement, 900µs)
SELECT * FROM users WHERE id = 1 FOR UPDATE;          -- NOTICE: dbmesh -> primary (locking SELECT, ...)

BEGIN;                                                -- primary from here...
SELECT * FROM users;                                  -- NOTICE: dbmesh -> primary (transaction pinned to primary, ...)
COMMIT;                                               -- ...until here
```

Multiple statements in one Simple Query message are routed together:
`SELECT 1; UPDATE users SET plan = plan WHERE false;` runs entirely on the
primary. Function calls, including `count(*)`, conservatively use the primary
and pin the session, so use a fresh session to see replica routing again.

## Reader health and replication lag

A monitor per database uses dedicated upstream connections and caches each
reader's health and WAL replay position. Before routing a read, DBMesh consults
that cache; it never issues monitoring queries on client connections. Reader IDs
in notices and logs are one-based positions in the configured `host` list.

A round probes the primary, then all readers concurrently; rounds never overlap.
The primary's `pg_current_wal_lsn()` is compared with each standby's
`pg_last_wal_replay_lsn()`, so WAL that is received but not yet applied does not
count as caught up. Choose `status_max_age` longer than `check_interval` plus the
expected probe time to avoid needless fallbacks.

A reader is excluded after a failed check, a missing replay position, an
endpoint that is not a standby, excessive lag or an expired sample. If none
qualifies (including before the first successful sample), reads go to the
primary with the reason in the notice and log. A temporary fallback does not pin
the session.

Reader connections open lazily for the requested database. A failed connection
does not reject the client, and a query that fails mid-flight is **not
replayed**. Monitoring limits observed lag; it does not guarantee read-after-write
consistency, because even a zero-byte gap can be outdated before a query runs.

All DSNs of one database must belong to the same replication cluster and
timeline. Failover and cluster discovery are out of scope.

## Correctness rule

**If a statement falls outside the supported read syntax, route it to the primary.**

AST classification is syntactic, not a proof of read-only behaviour. Views,
row-level security, user-defined operators and casts can hide side effects that
the parser cannot resolve, and function calls are not resolved against the
catalog. Transaction state comes from the upstream connection (including the
failed-transaction status) rather than from guessing at SQL keywords.

## Limitations

- Simple Query Protocol only; no extended protocol, prepared statements or `COPY`.
- Client authentication is terminated by DBMesh and there is no TLS on the client
  side. Upstream connections use the credentials in `config_proxy.yaml` (client
  usernames are not used upstream), and each upstream `sslmode` is configurable.
- Only databases listed in `config_proxy.yaml` are reachable. A newly created database
  may briefly be unavailable on a replica until replication catches up.
- Session-state handling is deliberately conservative: stateful statements make
  the session sticky to the primary.
- No connection pooling, failover or leader election.

## Known issues

Found during a code review; not exhaustive and not release-blocking on their own.

- No panic recovery: a panic in a client's connection goroutine crashes the
  whole process, dropping every other client (`internal/proxy/server.go:106-111`).
  `newID()` also panics on a `crypto/rand` failure instead of returning an error
  (`server.go:435-441`).
- Full SQL text, including inline literals, is logged whenever the log level is
  raised above the `error` default (`server.go:322-328`,
  `internal/audit/sink.go:44-55`). Because the proxy only supports the simple
  query protocol, values from statements like `ALTER USER ... PASSWORD` or an
  `INSERT` with PII land in plaintext logs, with no redaction.
- No per-query timeout is enforced by DBMesh itself; a stuck or long-running
  query pins an upstream connection indefinitely unless the upstream database
  sets `statement_timeout`.
- `sslmode` has no safe default or validation in `internal/config/config.go`; an
  empty value falls back to `prefer`, which does not verify certificates.
- `Dispatcher.Run`'s discovery loop keeps ticking every 30 seconds after startup
  with a no-op select (`internal/audit/worker.go:30-65`) — harmless, just unclear.
- `PostgresSink.Deliver` re-runs the advisory-lock and destination DDL setup on
  every reconnect, not only on first use (`internal/audit/rows.go:153-177`),
  adding latency under a flaky network.

## Roadmap

The next focus is JVM client support together with the PostgreSQL protocol
features needed by drivers and ORMs. The areas below describe planned work and
longer-term direction, without release dates or a promise of full PostgreSQL
compatibility.

| Area | Planned work |
| ---- | ------------ |
| Clients and integrations | Add a JVM client for Java/Kotlin with JDBC integration and audit-context propagation. Define a shared audit-context specification and expand support to more languages and clients. Python is the only supported audit client today. |
| PostgreSQL compatibility | Implement the Extended Query Protocol (`Parse`, `Bind`, `Execute`, `Describe`, `Close`, `Sync`), parameter binding and prepared statements. Validate behavior with drivers and ORMs, and expand SQL coverage incrementally while preserving routing and audit guarantees. |
| Proxy authentication and access control | Authenticate clients connecting to DBMesh and authorize access to configured databases, independently of the upstream credentials used by the proxy. Keep authenticated connection identity distinct from application-declared audit context. Today, clients can connect without a password. |
| Audit coverage | Support partitioned tables and schema changes, and define capture semantics for operations currently excluded from auditing, including `TRUNCATE` and `COPY`. |
| Audit delivery and operations | Add more audit sinks and expose pending deliveries, errors and recovery status in the dashboard. |
| Audit exploration | Add per-record history, request-level investigation and export of audit results. |
| Transport and data security | Add client-facing TLS, dashboard access permissions and controls over sensitive data captured in audit events. |
| Routing and consistency | Improve read safety using catalog information and broader function classification. Add read-after-write consistency using WAL positions. |

See [Contributing](CONTRIBUTING.md) for development setup, testing and pull request guidelines.

## License

DBMesh is licensed under the [Business Source License 1.1](LICENSE). The
source is available to read, modify and use, including in production — the
only restriction is offering DBMesh itself as a hosted or managed service
that competes with the licensor. Each release converts to Apache License 2.0
four years after its publication date.
