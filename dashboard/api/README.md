# DBMesh dashboard API

The dashboard API connects the DBMesh audit trail with the tools used to explore
and change application data. It powers three workflows:

- **Investigate changes**: find captured row changes by table, user, request or
  service, then inspect their before/after values and changed fields.
- **Explore and change data**: browse tables, preview SQL and execute structured
  INSERT, UPDATE and DELETE operations with audit context. Follow the resulting
  event and observe when replicas reflect the change.
- **Understand traffic**: report query volume, routing, errors and latency for
  the selected database and time period.

It serves the [dashboard front end](../front/README.md). For the complete product
and local demo, start with the [DBMesh README](../../README.md#dashboard).

## How it connects

The API reads events directly from the audit database, queries Prometheus for
metrics, and sends application queries and changes through DBMesh using the
[Python client](../../clients/python/README.md). It does not connect directly to
application primaries or replicas. Routing and row capture remain the proxy's
responsibility.

## Run locally

Requires Python 3.10+ and Make. First follow the repository's
[Quick start](../../README.md#quick-start) to start the internal development
environment and proxy. `make local-up` already starts the audit database and
Prometheus. Row capture requires the proxy's audit sink configuration.

From `dashboard/api/`, create the dashboard configuration once:

```bash
cp ../../config_dashboard.example.yaml ../../config_dashboard.yaml
make run
```

`make run` creates a local `.venv`, installs the API and Python client, and starts
Uvicorn at http://127.0.0.1:8000. Sign in with the password printed at startup,
or choose one with `DASHBOARD_PASSWORD=secret make run`.

To build and serve the full dashboard, run `make dashboard` from the repository
root after creating the configuration file above. For front-end development,
run the [Vite development server](../front/README.md#develop) separately.

## Configuration

The API Makefile selects the root `config_dashboard.yaml` via `DBMESH_CONFIG`.
This file is separate from the proxy's `config_proxy.yaml` and does not need
writer or reader credentials. Its database names and audit destination must
match the proxy configuration.

| Setting | Purpose |
| ------- | ------- |
| `audit.postgres.url` | Required. Audit database to read events from. |
| `dashboard_proxy_addr` | Address used to connect to DBMesh, such as `localhost:6432`. Takes precedence over `listen`. |
| `listen` | Fallback proxy address when `dashboard_proxy_addr` is absent; defaults to `:6432`. Wildcard hosts are converted to `localhost`. |
| `databases` | Required database-name mapping. Only the keys are used; they must identify databases served by DBMesh. |
| `prometheus_url` | Prometheus address; defaults to `http://127.0.0.1:9090`. |

Use `make run DBMESH_CONFIG=/absolute/path/to/config_dashboard.yaml` to select
another file. When invoking `python -m dbmesh_dashboard` directly, set
`DBMESH_CONFIG` explicitly: the Python loader still falls back to `config.yaml`
in the current directory when the variable is absent.

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `DASHBOARD_PASSWORD` | random | Shared login password; generated value is printed at startup. |
| `DASHBOARD_HOST` | `127.0.0.1` | Bind address. |
| `DASHBOARD_PORT` | `8000` | Port. |
| `DASHBOARD_SECRET` | random | Signs session cookies; set it to keep sessions across restarts. |
| `DASHBOARD_STATIC` | `dashboard/front/dist` if built | Built front-end directory; set an empty value to disable static serving. |
| `DASHBOARD_LOG_LEVEL` | `error` | Uvicorn log level. |

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

## Authentication and access

The dashboard currently supports development and demos. Anyone who can sign in
can view captured row contents and change application data through DBMesh.
Dashboard login does not authenticate clients at the PostgreSQL proxy. Keep the
API on localhost for local use; externally hosted demos need a reverse proxy
with TLS. See the [dashboard security model](../README.md#security).

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
| `GET /api/metrics` | Proxy traffic, routing, errors and latency from Prometheus |
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

## Metrics

`GET /api/metrics` requires a dashboard session. It accepts `database` (a
configured database name; omit for all configured databases) and `window`
(`5m`, `15m`, `1h`, `6h` or `24h`, default `15m`).

Enable the proxy's `metrics_listen` and configure Prometheus scraping as described
in [Prometheus metrics](../../README.md#prometheus-metrics). Counts are estimates
from scraped counters, not an exact audit ledger. The response includes collection
health so the interface can distinguish unavailable metrics from zero traffic.

## Explorer

The Explorer needs DBMesh reachable at `dashboard_proxy_addr` and, for auditing,
`audit.sinks: [postgres]` in the proxy's `config_proxy.yaml` so events reach the
audit database.

**Reading.** Table metadata is always read from the primary, so a table created a
moment ago is visible. Row reads are eligible for replicas by default, with primary fallback, and can
show slightly old data; pass `source=primary` to pin the read to the primary. Every
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

Run these commands from `dashboard/api/`. `make test` installs dependencies and
runs pytest. Integration checks skip unless their environment variables are set;
they do not read test connection settings from the dashboard YAML.

```bash
make test                                            # unit tests when integration variables are unset
DBMESH_TEST_AUDIT_URL='postgres://dbmesh_audit:dbmesh_audit@localhost:55435/dbmesh_audit?sslmode=disable' \
  make test                                          # plus PostgreSQL integration tests
```

The audit integration tests create and drop their own database, so they never
read or modify existing audit events. The test role needs permission to create
and drop a database; use the local development cluster.

The Explorer round-trip test goes through a running DBMesh that delivers to the
same audit database. It creates and drops its own table and removes its events:

```bash
DBMESH_TEST_PROXY=localhost:6432 \
DBMESH_TEST_AUDIT_URL='postgres://dbmesh_audit:dbmesh_audit@localhost:55435/dbmesh_audit?sslmode=disable' \
DBMESH_TEST_WRITER_URL='postgres://dbmesh:dbmesh@localhost:55432/demo?sslmode=disable' \
  make test        # DBMESH_TEST_DATABASE defaults to demo
```

`DBMESH_TEST_PROXY` takes `host:port`, unlike the Python client's
`DBMESH_TEST_PROXY_URL` URI. Set `DBMESH_TEST_WRITER_URL` as shown to clean up
source outbox events as well as destination events.

See [Contributing](../../CONTRIBUTING.md#check-your-changes) for the checks across
the repository. After changing the API contract, run `make openapi` here and
`make gen-api` in `dashboard/front/`; include both generated files with the change.
