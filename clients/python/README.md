# DBMesh Python client

Track PostgreSQL data changes with the application context behind them. The DBMesh
Python client lets you choose which tables to audit and attach a user, request ID
and service to each operation.

View the resulting changes in the DBMesh dashboard, including before/after values
and their request context.

## Installation and requirements

This synchronous client wraps psycopg 3. It is independently installable from
this repository and is not published to PyPI yet.

Requires Python 3.10+ and a running DBMesh proxy. Follow the repository's
[Quick start](../../README.md#quick-start) to start the local environment.
For row auditing, configure `audit.sinks: [postgres]` and `audit.postgres.url`
in `config_proxy.yaml`; the selected tables must already exist.

Run from the repository root:

```bash
python3 -m venv venv
venv/bin/python -m pip install -e './clients/python[binary]'
```

The `binary` extra bundles libpq. To use a local libpq installation instead,
install with `venv/bin/python -m pip install -e ./clients/python`.

## Quick start

This example uses the demo's `public.users` table. If a row with `id = 1` exists,
it updates its plan and captures the before/after values with the request context.

```python
import dbmesh

dsn = "postgresql://dbmesh@localhost:6432/demo?sslmode=disable&audit=public.users"

with dbmesh.connect(dsn) as conn:
    with conn.request(user_id="812", request_id="req-123", service="billing"):
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE public.users SET plan = %s WHERE id = %s RETURNING id, plan",
                ("enterprise", 1),
            )
            print(cur.fetchone())
```

`audit=public.users` enables row capture for that connection. `request()` supplies
the user, request and service metadata. Without an `audit` table selection,
request context enriches statement execution logs only; it does not enable
persistent row auditing.

The connection uses **autocommit**: this UPDATE commits independently.
`request()` groups context, not transactions. Audit delivery is asynchronous,
so the event may appear in the dashboard after the query returns.

## Table selection and request context

Select multiple tables with one comma-separated `audit` URI parameter:

```text
postgresql://dbmesh@localhost:6432/demo?sslmode=disable&audit=public.users,public.orders
```

Both tables must exist. Selection is per connection; request metadata can change
for each `request()` block on that connection.

- Table names must use unquoted lowercase `schema.table` identifiers. There is
  no table-count limit, but the selection is limited to 4096 bytes.
- DBMesh prepares triggers before confirming the connection. Missing or
  unsupported tables, or missing server sink configuration, fail the connection.
- `user_id` and `request_id` must be non-empty strings. `service` is optional.
  Each field is limited to 256 UTF-8 bytes and cannot contain control characters.
- Nested `request()` blocks restore the outer context, including after exceptions.
  An existing cursor picks up the active context at execution time.
- Outside a request block, selected table changes are still captured, with NULL
  identity fields. Queries contain no DBMesh audit-context header.

Metadata is application-declared context, not authenticated end-user identity.
See [row auditing](../../README.md#row-auditing-and-client-support) for supported
tables, capture guarantees, retention and server limitations.

## Transactions and errors

`request()` does not begin, commit or roll back a transaction. Without explicit
SQL transaction commands, each write commits independently, even if a later
operation in the block raises an exception.

For an atomic group of changes, send BEGIN, each statement and COMMIT separately:

```python
with dbmesh.connect(dsn) as conn:
    with conn.request(user_id="812", request_id="req-124", service="billing"):
        with conn.cursor() as cur:
            cur.execute("BEGIN")
            try:
                cur.execute(
                    "UPDATE public.users SET plan = %s WHERE id = %s",
                    ("enterprise", 1),
                )
                cur.execute(
                    "UPDATE public.users SET plan = %s WHERE id = %s",
                    ("team", 2),
                )
                cur.execute("COMMIT")
            except Exception:
                cur.execute("ROLLBACK")
                raise
```

Transactions stay on the primary. Rolling back removes both the row changes
and their audit events. Exiting the connection's `with` block closes it and
rolls back any explicit transaction still open; it does not commit it.

Use one connection per concurrent worker. Eligible reads outside transactions
can use replicas and may lag earlier writes.

## Where a query ran

DBMesh reports routing decisions in NOTICE messages. The client parses their
structured `DETAIL` and exposes the latest decision as `conn.last_route`:

```python
with dbmesh.connect(dsn) as conn:
    with conn.execute("SELECT * FROM public.users") as cur:
        print(cur.fetchall())
    route = conn.last_route
    if route is not None:
        print(route.target, route.reader, route.lag_bytes)
```

The query can use a replica or the primary, depending on routing and reader
health. `Route` contains:

| Field | Meaning |
| ----- | ------- |
| `target` | `"primary"` or `"replica"`. |
| `reader` | One-based configured reader position; `0` for the primary. |
| `readers` | Total number of readers configured for the database. |
| `reason` | Explanation of the routing decision. |
| `duration_us` | Reported query duration in microseconds. |
| `lag_bytes` | Reader's last monitored WAL lag; present for replica routes. |
| `fallback` | Whether a read fell back to the primary because no reader could serve it. |

`last_route` is `None` before the first execution and after an execution whose
route the server did not report. To display notices directly, register a handler:

```python
conn.add_notice_handler(lambda notice: print(notice.message_primary))
```

## Compatibility and limitations

Parameters are adapted by psycopg's `ClientCursor`, using Simple Query Protocol.
Use `%s` or named placeholders and pass values separately; do not interpolate
values into SQL yourself. `psycopg.sql` composition is also supported.

- Send one SQL statement per execution when row auditing is enabled.
- The wrapper does not expose async, pooling, `executemany`, binary results or
  prepared statements.
- `autocommit`, `cursor_factory` and `prepare_threshold` are managed by DBMesh;
  passing overrides to `dbmesh.connect()` raises `TypeError`. Other keyword
  arguments are passed to psycopg.
- The client requires the startup capability `dbmesh_audit=comment-v1`. It rejects
  plain PostgreSQL or an incompatible DBMesh server instead of silently dropping
  audit metadata. It also verifies acknowledgement of selected audit tables.

See the [roadmap](../../README.md#roadmap) for planned protocol and client support.

## Install into another project

Until the package is published, build it here and install it into the virtualenv
of the project that will use it. That virtualenv must already exist:

```bash
cd clients/python
make install VENV=$HOME/code/other-repo/venv
```

`make install` builds a wheel in `dist/`, replaces any installed version and pulls
in `psycopg[binary]`; set `EXTRAS=` to use a local libpq installation. Rerun it
after changing the client. Other targets, run from `clients/python/`, are
`make install-dev` (editable install into this repository's `venv`), `make test`
and `make clean`.

## Protocol details

The client translates the URI's `audit` parameter to the standard PostgreSQL
startup option `dbmesh.audit_tables`; it removes the custom URI parameter before
passing the connection string to psycopg.

For request context, it prepends `/*dbmesh:v1:BASE64URL*/` plus a newline to SQL.
BASE64URL is unpadded URL-safe base64 of a UTF-8 JSON object containing `user_id`,
`request_id` and `service`. This is encoding, not encryption or authentication.
The entire header is limited to 2048 bytes. Unicode, quotes and comment delimiters
in metadata are encoded safely.

The proxy accepts the header only at the beginning, after optional whitespace,
and replaces it with spaces before routing and forwarding SQL. Ordinary comments
and SQL literals are left untouched.

DBMesh logs one `query audited` event per annotated Simple Query message. On
connections without row auditing, a multi-statement message shares one context
and produces one execution-log event with its completed command tags. The log
reports execution outcome, SQLSTATE, row counts, actual primary/reader target
and transaction status. `success` does not mean a later transaction committed;
`unknown` means a transport error prevented certainty. These execution logs are
separate from persistent row-change events.

## Tests

Run from the repository root after installing the client:

```bash
venv/bin/python -m unittest discover -s clients/python/tests -v
```

Integration tests skip unless their environment variables are set. The routing
and context checks require `DBMESH_TEST_PROXY_URL`, the demo's `users` table and
an eligible reader. Their UPDATE uses `WHERE false` and does not change rows.

Persistent row-audit checks additionally require `DBMESH_TEST_WRITER_URL` and
`DBMESH_TEST_AUDIT_URL`. They create an isolated schema, perform INSERT, UPDATE,
DELETE and rollback operations, verify delivered events and clean up their data.
They also check captured request metadata and UPDATE RETURNING behavior.

```bash
export DBMESH_TEST_PROXY_URL='postgresql://dbmesh@localhost:6432/demo?sslmode=disable'
export DBMESH_TEST_WRITER_URL='postgres://dbmesh:dbmesh@localhost:55432/demo?sslmode=disable'
export DBMESH_TEST_AUDIT_URL='postgres://dbmesh_audit:dbmesh_audit@localhost:55435/dbmesh_audit?sslmode=disable'
venv/bin/python -m unittest discover -s clients/python/tests -v
```

Use the local demo environment for integration checks. See
[Contributing](../../CONTRIBUTING.md#check-your-changes) for the broader proxy and
dashboard test suites.
