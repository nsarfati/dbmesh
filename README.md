# DBMesh

**One PostgreSQL endpoint. Reads go to replicas. Writes go to the primary.**

DBMesh is a small PostgreSQL-compatible read/write router. Applications connect
to DBMesh with an ordinary PostgreSQL client. DBMesh parses each SQL statement
and sends safe reads to healthy read replicas, while writes, locking reads,
transactions and session-sensitive work stay on the primary.

It also ships an optional **row audit** feature: a Python client attaches request
context (user, request ID, service) to queries, and DBMesh records before/after
row images of selected tables in a durable outbox delivered to a separate
database.

> **Status: early prototype.** DBMesh is not a PgBouncer or Pgpool replacement.
> See [Limitations](#limitations) before pointing it at anything important.

## Contents

- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Examples](#examples)
- [Reader health and replication lag](#reader-health-and-replication-lag)
- [Correctness rule](#correctness-rule)
- [Row auditing and the Python client](#row-auditing-and-the-python-client)
- [Limitations](#limitations)
- [Development and testing](#development-and-testing)
- [Roadmap](#roadmap)

## How it works

```text
psql / app / ORM
       |
       | PostgreSQL wire protocol
       v
   +---------+      one entry per database in config.yaml
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

## Quick start

Prerequisites: Go 1.23+, a C compiler (the parser uses CGO, with `CGO_ENABLED=1`),
Docker Compose and `psql`.

```bash
cp config_example.yaml config.yaml   # local settings; ignored by Git
make db-up                           # primary, two replicas and an audit database
make run                             # DBMesh on :6432
```

In another terminal:

```bash
make demo                            # psql to postgresql://dbmesh@localhost:6432/demo
```

`make db-up` starts these containers on the host:

| Service  | Host port | Purpose                                         |
| -------- | --------- | ----------------------------------------------- |
| primary  | 55432     | Demo primary (user/password `dbmesh`, db `demo`) |
| replica1 | 55433     | Streaming replica                               |
| replica2 | 55434     | Streaming replica                               |
| audit    | 55435     | Row-audit destination (`dbmesh_audit`)          |

Replicas take a physical base backup before accepting connections. Check that
the primary returns `f` and both replicas return `t`:

```bash
for port in 55432 55433 55434; do
  psql "postgres://dbmesh:dbmesh@localhost:$port/demo?sslmode=disable" \
    -X -c 'SELECT pg_is_in_recovery();'
done
```

`make db-up` waits for each service to be healthy (`replica2` starts after
`replica1`, so the two base backups never overlap). `make db-down` removes the
containers and **deletes their volumes**.

## Configuration

DBMesh reads a YAML file, `config.yaml` by default. Pass another path with
`-config path/to/file.yaml` or `DBMESH_CONFIG`. Unknown keys are rejected so a
typo never silently changes behaviour. [`config_example.yaml`](config_example.yaml)
documents every option:

```yaml
listen: ":6432"

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
- Credentials are yours to protect: keep `config.yaml` out of version control
  (it is in `.gitignore`) and restrict its file permissions.
- Durations use Go syntax (`500ms`, `30s`, `168h`); a bare `0` is also accepted.

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

### Python client with request context

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e './clients/python[binary]'
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

### Checking audit delivery

Each audited database has a status view, queryable with plain `psql` against the
**source** database:

```sql
SELECT sink, pending, oldest_pending_age, last_success_at, last_error, last_error_at
FROM dbmesh.audit_delivery_status;
```

```text
   sink   | pending | oldest_pending_age |        last_success_at | last_error | last_error_at
----------+---------+--------------------+------------------------+------------+--------------
 postgres |       0 |                    | 2026-09-21 20:24:30+00 |            |
```

`pending` and `oldest_pending_age` grow while a sink is unavailable, and
`last_error` shows why. The [row audit guide](docs/row-audit.md) explains the
delivery guarantees and cleanup.

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

## Row auditing and the Python client

The [Python client](clients/python/README.md) wraps psycopg 3 and adds an
encoded SQL comment with request context to each execution. DBMesh strips it
before routing and executing the SQL. Without a table selection the context only
enriches the statement execution log (`query audited`); with `&audit=schema.table`
DBMesh installs triggers that write committed row changes to a per-database
outbox and delivers them at-least-once, deduplicated by event ID, to the audit
database.

- Delivered events are cleaned up in batches once **every** sink acknowledged
  them and `audit.retention` has passed.
- `dbmesh.audit_delivery_status` reports pending events, the age of the oldest
  and the last sink error.
- Request metadata is application-declared context, not authenticated identity.

See [docs/row-audit.md](docs/row-audit.md) for setup, guarantees, limitations and
tests.

## Limitations

- Simple Query Protocol only; no extended protocol, prepared statements or `COPY`.
- Client authentication is terminated by DBMesh and there is no TLS on the client
  side. Upstream connections use the credentials in `config.yaml` (client
  usernames are not used upstream), and each upstream `sslmode` is configurable.
- Only databases listed in `config.yaml` are reachable. A newly created database
  may briefly be unavailable on a replica until replication catches up.
- Session-state handling is deliberately conservative: stateful statements make
  the session sticky to the primary.
- No connection pooling, failover or leader election.

## Development and testing

```bash
go vet ./...
go test ./...          # unit tests; integration tests skip without a database
```

Integration tests run against the demo cluster and are enabled by environment
variables:

```bash
export DBMESH_TEST_WRITER_URL='postgres://dbmesh:dbmesh@localhost:55432/demo?sslmode=disable'
export DBMESH_TEST_READER_URLS='postgres://dbmesh:dbmesh@localhost:55433/demo?sslmode=disable,postgres://dbmesh:dbmesh@localhost:55434/demo?sslmode=disable'
export DBMESH_TEST_AUDIT_URL='postgres://dbmesh_audit:dbmesh_audit@localhost:55435/dbmesh_audit?sslmode=disable'
go test ./... -count=1
```

Adding `DBMESH_TEST_REPLICATION_CONTROL=1` also pauses replica replay to verify
lag exclusion, fallback and recovery. Use the demo cluster only; if a run is
killed, execute `SELECT pg_wal_replay_resume();` on the paused replica.

Python tests:

```bash
.venv/bin/python -m unittest discover -s clients/python/tests -v
# with a running proxy, for the end-to-end checks:
DBMESH_TEST_PROXY_URL='postgresql://dbmesh@localhost:6432/demo?sslmode=disable' \
  .venv/bin/python -m unittest discover -s clients/python/tests -v
```

## Roadmap

1. Catalog-aware read safety and broader function classification.
2. Read-after-write consistency using WAL positions.
3. Additional audit sinks.
4. Extended Query Protocol and prepared statements.
