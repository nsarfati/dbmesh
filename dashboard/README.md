# DBMesh dashboard

A web dashboard for DBMesh: see every audited row change with its before/after,
browse tables and run changes through DBMesh, and watch how long replicas take to
catch up. A metrics screen shows proxy traffic and routing from Prometheus.
The dashboard runs as a separate service; DBMesh exposes only `/metrics`
over HTTP when configured, on a port separate from PostgreSQL.

```text
  browser
     |  HTTP (session cookie)
     v
  dashboard API (FastAPI) ---- reads ----> audit database   <---- delivers events ---- DBMesh
     |                                                                                    ^
     '-- queries and changes, with audit context, through the Python client -------------'
```

| Part                   | What it is                                                                 |
| ---------------------- | -------------------------------------------------------------------------- |
| [`api/`](api/README.md)   | Python (FastAPI). Reads the audit database and talks to DBMesh as a client. |
| [`front/`](front/README.md) | React and TypeScript single-page app; the API serves it once built.       |

The API reads DBMesh's own `config.yaml`: the audit database URL, where the proxy
listens and which databases exist. It never connects to the primary or the readers
itself, so what you see is what any application would see.

## Run it

DBMesh must be running, with `audit.sinks: [postgres]` configured, for there to be
anything to see (`make local-up` and `make run` in the repository root).

**One process** (how you would run it day to day):

```bash
make dashboard        # builds the front end, then serves everything on http://127.0.0.1:8000
```

The API prints a random password at startup unless you set one:
`DASHBOARD_PASSWORD=secret make dashboard`.

**Development** (two terminals, with hot reload on the front end):

```bash
make dashboard-api    # the API on :8000
make dashboard-front  # the front end on http://localhost:5173, proxying /api to it
```

`make dashboard-test` runs both test suites. The commands work from the repository
root; each part also has its own Makefile.

## What you can do

- **Metrics**: estimated message counts by operation, writer and individual readers,
  average messages/second, SQL errors, unknown outcomes and p95 upstream latency.
  Filter by database and period (5 minutes through 24 hours); refreshes every 15 seconds.
  Messages containing several statements count once as `multi`.

- **Audit log**: every captured INSERT, UPDATE and DELETE, newest first. Filter by
  table, operation, user, service, request ID and time range; open an event for a
  field-by-field diff and the full row images. Filters live in the URL, so a link
  reproduces the view.
- **Explorer**: browse a table (with the route and lag that served the read) and change
  it through a query builder. The SQL is shown before you run it and afterwards, with
  the audit event that resulted and how long each replica took to show the change.

## Security

This is a **development and demo tool**. It exposes row contents, which may include
personal data, and it can write to your databases through DBMesh, which does not
authenticate its clients. Anyone who can sign in can change data.

- It listens on `127.0.0.1` by default and warns when told to bind elsewhere. If you
  expose it, put a reverse proxy with TLS in front.
- Access is one shared password (random when unset), exchanged for a signed,
  `HttpOnly`, `SameSite=Strict` session cookie valid for 8 hours. Repeated wrong
  passwords are throttled.
- Every response carries `X-Frame-Options: DENY` and `nosniff`; the page has a strict
  Content-Security-Policy (no inline scripts); API responses are never cached.
- There is no free-form SQL. Table and column names are validated against the
  database's catalog and values are always bound parameters.
- For the audit database, use a read-only role outside a demo: the dashboard only
  needs `SELECT`.

## Layout and tests

```text
dashboard/
  api/     FastAPI service, its tests and the committed openapi.json contract
  front/   the single-page app; src/api/schema.d.ts is generated from that contract
```

The API's tests run against a real PostgreSQL when `DBMESH_TEST_AUDIT_URL` is set,
and, with `DBMESH_TEST_PROXY` pointing at a running DBMesh, exercise the whole path
from a change to its audit event and the replicas. See the READMEs of each part.
