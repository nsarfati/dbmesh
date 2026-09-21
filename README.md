# DBMesh

**One PostgreSQL endpoint. Reads go to replicas. Writes go to primary.**

DBMesh is a small PostgreSQL-compatible read/write router. Applications connect to DBMesh with a normal PostgreSQL client; DBMesh inspects each SQL statement and sends safe reads to read replicas while keeping writes, locking operations, transactions, and session-sensitive work on the primary.

> This repository is intentionally scoped as a take-home prototype, not a production database proxy.

## Architecture

```text
psql / app / ORM
       |
       | PostgreSQL wire protocol
       v
   +---------+
   | DBMesh  |
   +----+----+
        |
    +---+----------------+
    |                    |
 primary              replicas
                          |
                    round-robin
```

## What currently works

- PostgreSQL StartupMessage (SSL/GSS requests are rejected and plaintext startup continues).
- Simple Query Protocol.
- Supported SELECTs routed round-robin to healthy replicas within the configured WAL lag limit.
- INSERT / UPDATE / DELETE / DDL routed to primary.
- `SELECT ... FOR UPDATE/SHARE` routed to primary.
- `BEGIN` pins the session to primary until `COMMIT` / `ROLLBACK`.
- Stateful statements such as `SET` pin the session to primary.
- Unknown statements route to primary.
- Route decisions appear in `psql` as NOTICE messages.

SQL is parsed with PostgreSQL 17's parser via `github.com/pganalyze/pg_query_go/v6`. The classifier walks every statement and nested AST node. A message goes to primary if any part writes, locks, changes session state, or uses unsupported syntax.

## Run locally

Prerequisites: Go, a C compiler (GCC or Clang), CGO enabled (`CGO_ENABLED=1`), Docker Compose, and `psql`. The parser uses CGO; its C sources are bundled with the Go module.

```bash
cp .env.example .env
make db-up
go mod tidy
go test ./...
make run
```

DBMesh runs on the host. `.env.example` uses the published host ports:

| Service | Default container name | Host port | Container port |
| --- | --- | --- | --- |
| primary | proxy_db-primary-1 | 55432 | 5432 |
| replica1 | proxy_db-replica1-1 | 55433 | 5432 |
| replica2 | proxy_db-replica2-1 | 55434 | 5432 |

All three use user `routepg`, password `routepg`, and database `demo`.
These local demo credentials retain their original names so existing PostgreSQL
volumes continue to work after the rename to DBMesh.
`make run` sources `.env` with automatic export enabled; `go run` alone
does not load this file. The listen variable is `DBMESH_LISTEN`.
`.env` is ignored by Git; `.env.example` is intended to be versioned.

The replicas take a physical base backup before accepting connections.
Before connecting to DBMesh, check `docker compose ps -a` and verify all
three databases from the host:

```bash
for port in 55432 55433 55434; do
  psql "postgres://routepg:routepg@localhost:$port/demo?sslmode=disable" \
    -X -v ON_ERROR_STOP=1 \
    -c 'SELECT current_database(), pg_is_in_recovery();'
done
```

The primary should return `f`, and both replicas should return `t`.
Only the primary has a Docker healthcheck; the SQL checks verify that the
replicas are ready. If a replica is still starting, wait and repeat the check.

For an existing primary initialized before `002-replication.sh` was added,
apply the replication authentication rule without deleting its data:

```bash
docker compose exec -T primary bash /docker-entrypoint-initdb.d/002-replication.sh
docker compose exec -T primary psql -U routepg -d demo -c 'SELECT pg_reload_conf();'
docker compose up -d replica1 replica2
```

New primary databases run this script automatically during initialization.
The rule allows SCRAM-authenticated physical replication for the demo role
on directly connected networks. Avoid `make db-down` when preserving data:
that target runs `docker compose down -v` and deletes volumes.

In another terminal:

```bash
make demo
```

Or connect directly with:

```bash
psql "postgresql://routepg@localhost:6432/demo?sslmode=disable"
```

Try:

```sql
SELECT * FROM users;
-- Function calls (including count) conservatively use and pin to primary.
-- Run them in a separate session when testing replica routing.
UPDATE users SET plan = 'enterprise' WHERE id = 1;
SELECT * FROM users WHERE id = 1 FOR UPDATE;

BEGIN;
SELECT * FROM users;
UPDATE users SET plan = 'pro' WHERE id = 2;
SELECT * FROM users;
COMMIT;
SELECT * FROM users;
```

Plain reads outside the transaction produce replica notices; writes and every
statement from `BEGIN` through `COMMIT` produce primary notices. The final
SELECT returns to a replica. Multiple statements in one Simple Query message
are routed together: `SELECT 1; UPDATE users SET plan=plan WHERE false;` goes
entirely to primary.

Run the opt-in integration test against the local databases with:

```bash
set -a
. ./.env
set +a
DBMESH_TEST_WRITER_URL="$DBMESH_WRITER_URL" \
DBMESH_TEST_READER_URLS="$DBMESH_READER_URLS" \
go test ./internal/proxy -run TestASTRoutingIntegration -v -count=1
```

This starts its own proxy connection on an ephemeral local port. It checks
routing, multi-statement results, failed transactions, savepoints and chained
transactions without changing existing rows.

After the updates, query `SELECT id, plan FROM users ORDER BY id;` directly
on ports 55433 and 55434 to verify both replicas receive the changes. Replication
is asynchronous, so a reader may briefly lag behind the primary.

You should see notices similar to:

```text
NOTICE:  dbmesh -> replica (read-only SELECT, 1.2ms)
NOTICE:  dbmesh -> primary (write statement, 900µs)
NOTICE:  dbmesh -> primary (transaction pinned to primary, 700µs)
```

## Reader health and replication lag

A server-wide monitor uses dedicated upstream connections and caches each
reader's health and WAL replay position. Before routing a read, DBMesh checks
that cached status; it does not issue monitoring queries on client connections.
Reader IDs in NOTICE messages and logs are one-based indexes into
`DBMESH_READER_URLS`.

All settings below are optional and configurable in `.env`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `DBMESH_READER_CHECK_INTERVAL` | `1s` | Interval between monitoring rounds |
| `DBMESH_READER_CHECK_TIMEOUT` | `500ms` | Timeout per monitor endpoint and reader connection attempt |
| `DBMESH_READER_MAX_LAG_BYTES` | `1048576` | Maximum sampled WAL distance in bytes (1 MiB); zero is allowed |
| `DBMESH_READER_STATUS_MAX_AGE` | `3s` | Maximum age of the primary sample used to measure a reader |

Durations must be positive Go durations (for example `250ms`, `5s`).
A round probes the primary, then all readers concurrently. If probes take longer
than the interval, rounds do not overlap. Prefer a max age longer than the
interval plus the expected probe duration to avoid unnecessary fallbacks.

The primary's `pg_current_wal_lsn()` is compared with each standby's
`pg_last_wal_replay_lsn()`: received but unapplied WAL does not count as caught up.
WAL positions are cluster-wide, not per database. A reader beyond the earlier
primary sample is treated as zero lag. This assumes all DSNs belong to the same
physical replication cluster and timeline; failover/cluster discovery is out
of scope. The configured roles must be able to connect to the DSN databases and
execute these monitoring functions. Monitoring failure is treated conservatively.

Failed checks, missing replay positions, non-standby endpoints, excessive lag,
and expired samples exclude readers. If no reader qualifies, reads go to primary
with the fallback reason in NOTICE messages and structured logs. Before the first
successful sample, reads also go to primary. A temporary fallback does not pin
the session; ordinary transaction/session pinning still applies.

Reader connections are opened lazily for the requested database. A failed reader
connection does not reject the client; another eligible reader or the primary is
used. Closed connections are re-established on a subsequent read once monitoring
permits it, with an interval-based cooldown after failed connection attempts.
If a connection fails during a user query, that query returns an error and is
**not automatically replayed**. A failure can occur between a health check and a
query; monitoring is not an availability guarantee.

This limits observed lag, not the age of individual rows and not read-after-write
consistency. Even a zero-byte sampled gap can become outdated before a query runs.

To run all integration checks, including temporarily pausing replica replay:

```bash
set -a
. ./.env
set +a
DBMESH_TEST_WRITER_URL="$DBMESH_WRITER_URL" \
DBMESH_TEST_READER_URLS="$DBMESH_READER_URLS" \
DBMESH_TEST_REPLICATION_CONTROL=1 go test ./... -count=1
```

Use the demo cluster for this test. It pauses the first replica, generates WAL
with a rolled-back update and a WAL switch, verifies exclusion and primary
fallback, resumes replay, and verifies recovery. Replay is also resumed during
test cleanup. A forcibly killed test may require manually running
`SELECT pg_wal_replay_resume();` directly on that replica.

## Why not parse SQL with strings?

The PostgreSQL AST distinguishes writable CTEs, locking SELECTs, comments,
string literals and multiple statements. Unsupported nodes and parse failures
go to primary; the upstream server still reports any SQL error.

Function calls, including aggregates such as `count(*)` and diagnostic
functions such as `pg_is_in_recovery()`, conservatively go to primary and make
the session sticky because their effects are not resolved against the catalog.
Unknown syntax also pins conservatively, even after an error. Reconnect to
clear this routing state.

Transaction state comes from the upstream PostgreSQL connection, including
the failed-transaction status, rather than being inferred from SQL keywords.

## Correctness rule

**If a statement falls outside the supported read syntax, route it to primary.**

AST classification is syntactic, not a proof of semantic read-only behavior.
This demo assumes ordinary tables and built-in operators/types. Views, row
security policies, user-defined operators and casts can hide effects that the
raw parser cannot resolve. Catalog-aware validation is still needed before
claiming safe routing for arbitrary databases.

## MVP limitations

- Simple Query Protocol only.
- Client auth is terminated by DBMesh; upstream credentials come from environment DSNs.
- The requested database overrides the database in every upstream DSN. `\c postgres`
  connects to `postgres` on the primary and readers; a nonexistent database
  produces PostgreSQL's connection error. When omitted from startup, the database
  defaults to the requested username. Access uses the configured upstream role,
  not the client username. A newly created database may briefly be unavailable
  on a replica until replication catches up.
- No TLS.
- Session-state handling is deliberately conservative: stateful statements make the session sticky to primary.
- Lag limits use periodically sampled WAL positions; they do not guarantee read-after-write consistency.
- No failover.

## Python request context and audit sinks

The pip-installable client lives in [clients/python](clients/python/README.md).
It wraps psycopg 3's Simple Query cursor and uses autocommit:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e './clients/python[binary]'
```

```python
import dbmesh

with dbmesh.connect("postgresql://routepg@localhost:6432/demo?sslmode=disable") as conn:
    with conn.request(user_id="812", request_id="req-123", service="billing"):
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM users WHERE id = %s", (1,))
            print(cur.fetchone())
            cur.execute("UPDATE users SET plan = %s WHERE id = %s", ("enterprise", 1))
```

`request()` attaches a versioned, encoded SQL comment to each execution. It does
not create a transaction. DBMesh extracts the metadata and masks the header with
spaces before routing and executing the SQL. The context never reaches PostgreSQL
as session settings: no `set_config`, triggers, or internal transactions are used.
Ordinary SELECTs still use eligible replicas; UPDATEs use the primary. Existing
transaction and function-routing policies still apply. Parameters are adapted by
psycopg, never interpolated by the wrapper.

The client requires the startup capability `dbmesh_audit=comment-v1`, preventing
silent loss of audit metadata against older proxies or a direct PostgreSQL server.
Clients without this extension keep their existing behavior. Metadata is opt-in,
application-declared context, not authenticated end-user identity.

The first sink writes `query audited` structured log events using the service's
logger. Each includes a random query ID and connection ID, request context,
requested database/client user, cleaned SQL, actual target/reader, duration,
completed command tags, row counts, SQLSTATE, execution outcome, and upstream
transaction state before/after. One Simple Query message produces one event;
all statements in a batch share its context. Empty queries do not emit an event.
SQL in audit logs includes literal parameters; configure log access accordingly.
Malformed reserved headers are rejected before SQL execution, without logging
their payload as audit context.

`success` means execution completed, not that a later explicit transaction
committed. A transaction can subsequently roll back. `unknown` reports transport
errors where DBMesh cannot determine the result. Rows report command-tag counts
(including SELECT rows); they are not a durable count of committed modifications.
This is an execution audit, not before/after row history or a transactional outbox.

Additional destinations can implement `internal/audit.Sink.Emit(context, event)`
and be wired into the server. The interface is concurrent and synchronous; the
MVP implements only the log sink, with no queue, remote sink configuration or
durability guarantee. A sink failure is logged and does not turn already-executed
SQL into a retryable failure. No SQL is automatically retried for audit delivery.

Python tests (with an optional running proxy for end-to-end checks):

```bash
.venv/bin/python -m unittest discover -s clients/python/tests -v
DBMESH_TEST_PROXY_URL='postgresql://routepg@localhost:6432/demo?sslmode=disable' \
  .venv/bin/python -m unittest discover -s clients/python/tests -v
```

## Roadmap

1. Catalog-aware read safety and broader function classification.
2. Read-after-write consistency using WAL positions.
3. Additional audit sinks and delivery guarantees.
4. Extended Query Protocol and prepared statements.
