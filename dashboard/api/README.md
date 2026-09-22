# DBMesh dashboard API

The HTTP API behind the DBMesh dashboard. DBMesh exposes an optional HTTP metrics
endpoint; PostgreSQL traffic uses its separate PostgreSQL listener. This service:

- reads the **audit database** that DBMesh delivers row changes to, directly;
- queries **Prometheus** for proxy traffic, routing, errors and latency;
- browses tables and runs structured changes **through the DBMesh proxy**, using
  this repository's Python client, so it sees the same routing and auditing as
  any application. It never connects to the primary or the readers itself.

> **Development and demo tool.** It exposes row images (which may contain
> personal data) and can write to your databases through the proxy, which does
> not authenticate its clients. Anyone who can log in can change data. Keep it
> on localhost, or behind a reverse proxy with TLS. Never expose it directly to
> the internet.

## Run

```bash
cp ../../config_example.yaml ../../config.yaml   # once; the same file DBMesh uses
make run
```

The API reads DBMesh's own `config.yaml` (override with `DBMESH_CONFIG`):

| From `config.yaml`   | Used for                                          |
| -------------------- | ------------------------------------------------- |
| `audit.postgres.url` | The audit database the events are read from       |
| `listen`             | Where the proxy is (`:6432` becomes `localhost:6432`) |
| `databases` (keys)   | The databases the dashboard offers                |

Everything else comes from environment variables:

| Variable             | Default     | Meaning                                              |
| -------------------- | ----------- | ---------------------------------------------------- |
| `DASHBOARD_PASSWORD` | random      | Shared login password. If unset, a random one is printed at startup |
| `DASHBOARD_HOST`     | `127.0.0.1` | Bind address                                         |
| `DASHBOARD_PORT`     | `8000`      | Port                                                 |
| `DASHBOARD_PROMETHEUS_URL` | `http://127.0.0.1:9090` | Prometheus queried by the authenticated `/api/metrics` endpoint |
| `DASHBOARD_SECRET`   | random      | Signs session cookies; set it to keep sessions across restarts |
| `DASHBOARD_STATIC`   | `../front/dist` if built | Built front end to serve; set to another directory, or to empty to serve none |

## Serving the front end

When `dashboard/front/dist` exists (`make build` in `dashboard/front`, or `make dashboard`
in the repository root), the API serves it: hashed assets with a long cache lifetime,
and `index.html` for every client-side route, so a page can be reloaded or linked to
directly. Unknown `/api/...` paths still answer with a JSON `404`, never the page. The
page is sent with a strict Content-Security-Policy, and every response carries
`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and `Referrer-Policy:
no-referrer`. `/api/` responses are sent with `Cache-Control: no-store` because they can
contain row contents. Without a build the API runs alone, as during front-end
development.

## Authentication

One shared password. `POST /api/login` with `{"password": "..."}` sets a signed,
`HttpOnly`, `SameSite=Strict` session cookie valid for 8 hours. Every `/api/*`
route except login, logout and session requires it; `/healthz` is public.
After 5 failed logins from one address the login answers `429` for a minute.
Restarting the API ends all sessions unless `DASHBOARD_SECRET` is set.

## Endpoints

Interactive documentation is served at `/docs` (OpenAPI at `/openapi.json`).

| Method and path             | Purpose                                                      |
| --------------------------- | ------------------------------------------------------------ |
| `GET /healthz`              | Liveness                                                     |
| `POST /api/login`, `/api/logout`, `GET /api/session` | Session                                |
| `GET /api/status`           | Audit database reachability and configured databases         |
| `GET /api/events`           | Row-change events, newest first, with filters and cursor paging |
| `GET /api/events/{id}`      | One event, with before/after and the list of changed fields  |
| `GET /api/events/facets`    | Values for filter dropdowns (tables, users, services…)       |
| `GET /api/explorer/{db}/tables` | Tables of a configured database, and whether each can be audited |
| `GET /api/explorer/{db}/tables/{schema}/{table}` | Columns, types, defaults and primary key |
| `GET /api/explorer/{db}/tables/{schema}/{table}/rows` | Rows with paging, and the route that served them |
| `POST /api/explorer/{db}/preview` | The SQL a change would run, without running it |
| `POST /api/explorer/{db}/execute` | INSERT, UPDATE or DELETE with audit context; see below |

`/api/events` filters: `db`, `schema`, `table`, `operation` (`INSERT`, `UPDATE`,
`DELETE`), `user_id`, `request_id`, `service`, `since`, `until` (ISO 8601),
`limit` (1–200, default 50) and `cursor` (the `next_cursor` of the previous page).
Paging is keyset-based, so it stays stable while new events arrive. Before the
first delivery the audit table does not exist yet, and the endpoints return
empty results rather than errors.

## Explorer

The Explorer needs DBMesh running (its `listen` address in `config.yaml`) and, for
auditing, `audit.sinks: [postgres]` so events reach the audit database.

**Reading.** Table metadata is always read from the primary, so a table created a
moment ago is visible. Rows are read from a replica by default, which can show
slightly old data; pass `source=primary` to pin the read to the primary. Every
response carries the `route` DBMesh reported: `target`, `reader`, `reason`,
`duration_us` and `lag_bytes` (the last monitored lag of the serving reader).

**Changing.** `POST /api/explorer/{db}/execute` takes a structured request; there
is no free-form SQL:

```json
{"schema": "public", "table": "users", "operation": "UPDATE",
 "key": {"id": 1}, "values": {"plan": "enterprise"},
 "user_id": "812", "request_id": "req-1", "service": "billing"}
```

- `key` holds the primary key (UPDATE and DELETE); `values` the columns to write
  (INSERT and UPDATE). Column and table names are checked against
  `information_schema` and values are always bound parameters.
- The statement runs on a connection opened with `audit=<schema.table>` and the
  request context, so DBMesh installs the audit trigger and records the change.
  Send `"audit": false` to skip auditing. Tables need unquoted lowercase names to
  be audited.
- `request_id` is generated when omitted. Reusing one makes earlier events with
  the same id show up in the result.
- The response has the affected `row`, the write's `route`, the `statement` that
  ran, and two follow-ups:
  - `audit`: the API waits up to `wait_seconds` (default 10) for the event to reach
    the audit database and returns it with its before/after `changes`. A timeout is
    reported as `timed_out`, it does not fail the change.
  - `replication`: after the write, the API re-reads the row through DBMesh until
    each configured reader shows it, and reports `visible_after_ms`, `stale_reads`
    and `lag_bytes` per reader. That is the delay you would observe as a client;
    `null` means the reader had not caught up within `measure_seconds` (default 3),
    and `note` explains why polling stopped early, for example when every read fell
    back to the primary. Disable it with `"measure_replicas": false`.

**Seeing the SQL.** `statement` (and `POST .../preview`, which takes the same body
but executes nothing) gives the statement three ways: `statement`, the parameterised
text that is sent (`%s` placeholders); `params`, its values as JSON; and `sql`, the
same statement with the values inlined as SQL literals, quoted by psycopg, so it can
be read and pasted into `psql`. A preview also reports whether the change would be
audited and, if not, why (`audit_problem`). Row reads carry their `sql` too. Table
metadata is cached for 10 seconds so a preview does not re-read the catalog on
every keystroke.

Errors carry an HTTP status and a message: `400` invalid request or column,
`404` unknown database or table, `409` constraint violations, `502` DBMesh
unreachable.

## Tests

```bash
make test                                            # unit tests
DBMESH_TEST_AUDIT_URL='postgres://dbmesh_audit:dbmesh_audit@localhost:55435/dbmesh_audit?sslmode=disable' \
  make test                                          # plus PostgreSQL integration tests
```

The audit integration tests create and drop their own database, so they never
read or modify real audit data.

The Explorer round-trip test goes through a running DBMesh that delivers to the
same audit database. It creates and drops its own table and removes its events:

```bash
DBMESH_TEST_PROXY=localhost:6432 \
DBMESH_TEST_AUDIT_URL='postgres://dbmesh_audit:dbmesh_audit@localhost:55435/dbmesh_audit?sslmode=disable' \
DBMESH_TEST_WRITER_URL='postgres://dbmesh:dbmesh@localhost:55432/demo?sslmode=disable' \
  make test        # DBMESH_TEST_READERS defaults to 2; DBMESH_TEST_DATABASE to demo
```
