# dbmesh-python-client

A small synchronous psycopg 3 wrapper for DBMesh's `comment-v1` audit context.
This is an independently installable package inside the DBMesh repository; it
can be moved into a separate repository later. It is not published to PyPI yet.

From the repository root:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e './clients/python[binary]'
```

Use the binary extra for a bundled libpq; otherwise install with
`pip install -e ./clients/python` and provide a local libpq installation.

```python
import dbmesh

dsn = "postgresql://dbmesh@localhost:6432/demo?sslmode=disable"
with dbmesh.connect(dsn) as conn:
    conn.add_notice_handler(lambda notice: print(notice.message_primary))
    with conn.request(user_id="812", request_id="req-123", service="billing"):
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM users WHERE id = %s", (1,))
            print(cur.fetchone())
            cur.execute(
                "UPDATE users SET plan = %s WHERE id = %s",
                ("enterprise", 1),
            )
            print(cur.rowcount)
```

`request()` adds a comment to each execution; it does **not** open, commit or
roll back a transaction. The connection runs in autocommit. Each UPDATE commits
independently, even if a later operation in the Python block raises an exception.
Eligible SELECTs can use readers. Explicit SQL transactions still pin to primary;
the request context does not change their semantics. Replica reads can lag writes.

Parameters are adapted by psycopg's `ClientCursor`, using Simple Query Protocol.
Use `%s` or named placeholders and pass values separately; do not interpolate
values into SQL yourself. `psycopg.sql` composition is also supported. This MVP
does not expose async, pooling, executemany, binary results or prepared statements.
Use one connection per concurrent worker; do not share transactions across workers.

Nested `request()` blocks restore the outer context, including after exceptions.
Outside a request block, queries contain no DBMesh audit header. An existing
cursor picks up the context at execution time. IDs must be non-empty strings;
`service` is optional. Each field is limited to 256 UTF-8 bytes without control
characters. Unicode, quotes and comment delimiters in metadata are safely encoded.

The client checks the startup `dbmesh_audit=comment-v1` capability. A plain
PostgreSQL server or older DBMesh is rejected rather than silently ignoring audit
metadata. Standard PostgreSQL clients continue to work with DBMesh.

## Wire format and audit semantics

The wrapper prepends `/*dbmesh:v1:BASE64URL*/` plus a newline. BASE64URL is
unpadded URL-safe base64 of a UTF-8 JSON object with `user_id`, `request_id`,
and optional `service`. This is encoding, not encryption or authentication.
The entire header is limited to 2048 bytes. The proxy accepts it only at the
beginning, after optional whitespace, and replaces it with spaces before routing
and forwarding SQL. Ordinary comments and SQL literals are left untouched.

DBMesh logs one `query audited` event per annotated Simple Query message. A
multi-statement message shares one context and produces one event with its
completed command tags. The event reports execution outcome, SQLSTATE, row counts,
actual primary/reader target and transaction status. `success` does not mean a
later transaction committed; `unknown` means a transport error prevented certainty.
The context is application-declared, not a verified end-user identity. Without
an `audit` table selection, it produces only statement execution logs.

## Select tables for persistent row auditing

```python
dsn = "postgresql://dbmesh@localhost:6432/demo?sslmode=disable&audit=public.users"
with dbmesh.connect(dsn) as conn:
    with conn.request(user_id="812", request_id="req-123", service="billing"):
        with conn.cursor() as cur:
            cur.execute("UPDATE users SET plan=%s WHERE id=%s", ("enterprise", 1))
```

The wrapper translates the URI's custom `audit` parameter to startup `options`.
DBMesh prepares triggers before confirming the connection and the wrapper verifies
the acknowledged selection. Unquoted lowercase schema.table names are supported,
without a table-count limit; the selection has a 4096-byte size limit.
Missing tables or missing server sink configuration fail connection.
Table selection is per connection, while user/request/service remain per request.

With row auditing enabled, send one SQL statement per execute; BEGIN and COMMIT
must be separate executions. The proxy refreshes trigger context before primary
operations. Triggers capture committed row changes in a source outbox; delivery
to the independent PostgreSQL sink is asynchronous, with retries and deduplication.
Outside request(), selected table changes are still captured with NULL identity
fields. SELECT routing and returned rows/command tags are preserved.

See [service setup and boundaries](../../docs/row-audit.md). The service must have
`audit.sinks: [postgres]` and `audit.postgres.url` set in its `config.yaml`.

## Tests

```bash
.venv/bin/python -m unittest discover -s clients/python/tests -v
DBMESH_TEST_PROXY_URL='postgresql://dbmesh@localhost:6432/demo?sslmode=disable' \
  .venv/bin/python -m unittest discover -s clients/python/tests -v
```

Integration tests expect the local demo's `users` table and two healthy readers.
Their UPDATEs use `WHERE false` and do not change rows. Server-side audit content
and error cases are covered by the Go integration tests.
