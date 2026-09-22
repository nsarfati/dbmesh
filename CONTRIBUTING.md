# Contributing to DBMesh

DBMesh focuses on contextual PostgreSQL row auditing, with read/write routing
and a dashboard for investigating changes. Contributions to documentation,
bug fixes, tests and product features are welcome.

## Report a bug or propose a change

Open an issue describing what you expected, what happened and how to reproduce
it. Include relevant versions, SQL and logs, using synthetic data and removing
credentials and personal information.

For larger changes, start with an issue explaining the problem and proposed
approach. The [roadmap](README.md#roadmap) describes planned work, including
additional audit sinks and contextual audit clients for more languages. Python
is currently the only supported client for contextual row auditing.

## Set up your environment

Follow the [Quick start](README.md#quick-start) to configure and run the local
proxy, primary, replicas and audit database. Keep local credentials in the ignored
configuration files; use the example files as templates.

For the Python client:

```bash
python3 -m venv venv
venv/bin/python -m pip install -e './clients/python[binary]'
```

For dashboard development, see the [dashboard guide](dashboard/README.md#run-it)
and the setup instructions for its [API](dashboard/api/README.md) and
[front end](dashboard/front/README.md).

## Useful commands

Run these commands from the repository root after setting up the configuration
files. For the dashboard, copy `config_dashboard.example.yaml` to
`config_dashboard.yaml` once and adjust it to match your proxy and audit database.

| Command | Purpose |
| ------- | ------- |
| `make local-up` | Start the internal development dependencies: primary, replicas, audit database and Prometheus. |
| `make run` | Start the Go proxy using `config_proxy.yaml`. |
| `make dashboard` | Build the front end and start the API serving it at http://127.0.0.1:8000. |
| `make dashboard-api` | Start the dashboard API on port 8000. |
| `make dashboard-front` | Start the front-end development server with hot reload on port 5173. |
| `make dashboard-build` | Type-check and build the front end. |
| `make test` | Run the proxy's Go tests. |
| `make dashboard-api-test` | Run the dashboard API tests. |
| `make dashboard-front-test` | Run the front-end unit and component tests. |
| `make dashboard-test` | Run the API tests, then the front-end tests. |
| `make demo` | Open a `psql` session through the local proxy. |
| `make local-down` | Stop the Docker Compose environment and delete its volumes. |

Keep `make run` running in its own terminal. Use `make dashboard` to serve the
built interface, or run `make dashboard-api` and `make dashboard-front` in separate
terminals for front-end development. The dashboard targets install dependencies
when needed. Database integration tests require the variables described below.

## Make a focused change

Keep changes small and tied to one problem. Preserve PostgreSQL semantics and
route uncertain statements to the primary. Audit changes should preserve
transactional capture, request-context isolation and durable delivery.

Add regression coverage for bug fixes and tests for new behavior. Update the
documentation when configuration, guarantees or user-facing behavior changes.
Format changed Go files with `gofmt`.

## Check your changes

Run the checks relevant to the parts you changed from the repository root:

```bash
# Proxy
go vet ./...
make test             # integration tests skip without a database

# Python client (after installing it above)
venv/bin/python -m unittest discover -s clients/python/tests -v

# Dashboard API and front end (or make dashboard-test for both)
make dashboard-api-test
make dashboard-front-test
make -C dashboard/front typecheck
```

When changing the dashboard API contract, regenerate its OpenAPI document with
`make -C dashboard/api openapi`, then regenerate the front-end types with
`make -C dashboard/front gen-api` and include both generated files.

### Integration tests

Tests that skip without a database do not validate integration behavior.
`make local-down` deletes the local cluster's volumes.

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

Python end-to-end checks also require a running proxy:

```bash
DBMESH_TEST_PROXY_URL='postgresql://dbmesh@localhost:6432/demo?sslmode=disable' \
  venv/bin/python -m unittest discover -s clients/python/tests -v
```

Row-audit integration tests use fixture tables and preserve existing demo rows.
With the database environment variables above set, run `go test -race ./... -count=1`
to include the race detector.

Tests cover concurrent installation, per-connection selection, row images,
rollback/savepoints, metadata isolation, notification delivery with a one-hour
fallback interval, listener termination/reconnect, sink unavailability and
redelivery after destination commit, batched cleanup (including sinks that are
still pending or acknowledged inside the retention window, run in a throwaway
database) and the delivery status view. Python tests exercise DSN → startup → trigger
→ sink, including preserving UPDATE RETURNING results.

## Submit a pull request

Describe the problem, the resulting behavior and how you verified the change.
Link the relevant issue, include screenshots for visual dashboard changes, and
mention any checks you could not run. Keep unrelated changes in separate pull
requests and leave local configuration, credentials and generated runtime data
out of the diff.
