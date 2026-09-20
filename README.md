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
- SELECTs routed to replicas.
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
- No replica-lag awareness yet.
- No failover.

## Roadmap

1. Catalog-aware read safety and broader function classification.
2. Reader health checks, lag awareness, and fallback.
3. Request/user audit context (`app.user_id`, `app.request_id`, `app.service`).
4. Extended Query Protocol and prepared statements.
