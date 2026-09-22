# DBMesh dashboard front end

Explore what changed in your PostgreSQL data and the application context behind
it. The DBMesh dashboard brings audit investigation, data exploration and query
traffic into one interface, so you can follow a change from its SQL and request
context to its audit event and visibility on replicas.

For a complete product overview and local demo, see the
[DBMesh README](../../README.md#dashboard).

## What you can do

- **Audit log**: row changes captured by DBMesh, newest first. Filter by table,
  operation, user, service, request ID and time range; filters live in the URL,
  so a link reproduces the view. **Live** refreshes every 5 seconds. Opening an
  event shows a field-by-field before/after diff and the full row images, and
  `?event=<id>` deep-links to one.
- **Explorer**: browse a database's tables and change data through DBMesh.
  - Rows are shown with the route that served the read (`replica 1 · 0 B behind`),
    and can be read from a replica or pinned to the primary.
  - The **query builder** turns INSERT, UPDATE and DELETE into a form generated from
    the table's columns: typed inputs, NULL and "database default" per field, live
    validation, JSON and array editors. An update starts from the selected row and
    sends only the fields you changed. Deleting takes two clicks.
  - The **audit context** (user, service, request ID) travels with the change, and a
    checkbox chooses whether it is captured in the audit log.
  - The **SQL preview** shows the statement before you run it, with values inlined
    to read and copy, or as the parameterised statement that is actually sent.
  - After running, the **result** shows the SQL that ran, the audit event with its
    before/after diff (with a link to the Audit log), and how long each replica
    took to show the change.
- **Metrics**: inspect estimated query counts, messages per second, routing to
  the writer and individual readers, SQL errors, unknown outcomes and p95 upstream
  latency. Filter by database and period (5 minutes to 24 hours); the view refreshes
  every 15 seconds and distinguishes collection failures from zero traffic.
- **Sign in**: one shared password, set by `DASHBOARD_PASSWORD` when the API starts.

It follows the system light or dark theme (switchable), works on phones, where
the table becomes cards, and is keyboard operable.

## Technology and API

The interface uses React, TypeScript, Vite and Tailwind CSS, with TanStack Query
for server data and Radix for dialogs. At runtime it communicates only with the
[dashboard API](../api/README.md), which handles authentication, audit queries,
changes through DBMesh and Prometheus queries. Browser code does not connect
directly to PostgreSQL or Prometheus.

## Develop

Requires Node.js and npm compatible with the locked dependencies, plus Make.
For example, Node.js 24.15+ on the 24.x line satisfies the declared Node
requirements. The API requires Python 3.10+.

First follow the repository's [Quick start](../../README.md#quick-start) to start
the internal development environment and DBMesh. From the repository root,
create the dashboard configuration once:

```bash
cp config_dashboard.example.yaml config_dashboard.yaml
```

Then run these commands in separate terminals, both starting at the repository
root:

```bash
# Terminal 1: API on http://127.0.0.1:8000, using config_dashboard.yaml
make dashboard-api
```

```bash
# Terminal 2: front end on http://localhost:5173
make dashboard-front
```

Open the front-end URL and sign in with the password printed by the API, or set
`DASHBOARD_PASSWORD` when starting it. These root commands delegate to `make run`
in `dashboard/api/` and `dashboard/front/` respectively.

The front-end Makefile installs dependencies when needed. Vite proxies `/api`
and `/healthz` to `http://127.0.0.1:8000`, keeping session requests on the browser's
origin. From `dashboard/front/`, use
`make run DASHBOARD_API=http://host:port` to select another API.

## Build and serve

From `dashboard/front/`, `make build` type-checks the interface and writes `dist/`.
The API serves it when it finds `dashboard/front/dist`, so
`make dashboard` in the repository root builds and runs everything as one process, with
no Node needed at run time. The page loads no inline scripts (the theme is applied by
`public/theme-init.js`), which lets the API send a strict Content-Security-Policy.

The dashboard currently targets development and demos. See the
[security model](../README.md#security) before exposing it beyond localhost.

## Commands

Run these commands from `dashboard/front/`. Make targets install dependencies
when needed; if you run npm scripts directly, run `npm install` first.

| Command                        | Purpose                                                     |
| ------------------------------ | ----------------------------------------------------------- |
| `make run` / `npm run dev`     | Dev server with hot reload                                  |
| `make build` / `npm run build` | Type-check and build into `dist/`                           |
| `make test` / `npm test`       | Unit and component tests (Vitest, Testing Library)          |
| `make typecheck`               | `tsc --noEmit`                                              |
| `make gen-api`                 | Regenerate `src/api/schema.d.ts` from `../api/openapi.json` |
| `make install`                 | Install dependencies only                                   |
| `make clean`                   | Remove `dist/`                                              |

## API types

`src/api/schema.d.ts` is generated from the API's committed
[`openapi.json`](../api/openapi.json), to keep the front end aligned with the API
contract. After changing the API run `make openapi` in `dashboard/api`, then
`make gen-api` here. A test in the API fails when `openapi.json` is stale.

The project currently uses TypeScript 5.x; check `package.json` and
`package-lock.json` for the dependency versions used by the build.

## Layout

```text
src/
  api/          fetch client, query hooks and the generated schema
  components/   shared UI: layout, feedback, JSON and diff views, ui/ primitives
  features/     audit/ (filters, events table, detail drawer) and explorer/ (grid,
                query builder, SQL preview, result and replication views)
  lib/          pure helpers (time, filters, change summaries, form-to-request
                logic for the builder), tested on their own
  pages/        Login, AuditLog, Explorer, Metrics
tests/          Vitest suites; helpers.tsx mocks the API with fetch
```

## Known issues

Found during a code review; not exhaustive and not release-blocking on their own.

- Live mode refetches every already-loaded page on each 5-second tick, with no
  `maxPages` (`src/api/hooks.ts:57-67`, `useEvents`). Loading several pages and
  then enabling Live can cascade into many sequential requests, and since the
  feed keeps growing, a deep page's cursor can drift and return duplicate or
  skipped events.
- No ESLint (or `eslint-plugin-react-hooks`) is configured for the project;
  nothing enforces hook dependency arrays, which is how the next issue slipped
  through.
- `Builder.tsx:104-106`'s `useEffect` is missing `execute` from its dependency
  array. Currently benign, but fragile to future refactors.
- `useExecute`'s `onSuccess` invalidates `['rows']`/`['tables']` without
  scoping to the affected database or table (`hooks.ts:128-138`), refetching
  every cached table/page from the session instead of just the one that changed.
- The singular `'table'` query key (`useTable`, `hooks.ts:92-99`) is never
  invalidated after an execute, so an open table view's `auditable` flag can go
  stale after DBMesh installs an audit trigger on first write.
- `sameValue` in `src/lib/explorer.ts:87-94` has a redundant, tautological
  condition — not a bug, just confusing to read.
- Custom ARIA widgets (`Segmented`, the mode switches in `FieldInput.tsx` and
  `SqlBlock.tsx`, `RawTabs` in `EventSheet.tsx`) use `role="radio"`/`role="tab"`
  without the arrow-key roving-tabindex navigation the ARIA pattern expects;
  `RawTabs` also has no associated `role="tabpanel"`.
- No virtualization on the events/data tables. Fine at current page sizes, but
  combined with the Live mode issue above, a long session can accumulate a
  large number of DOM rows.
- `Metrics.tsx` recomputes `.filter`/`.reduce` passes over all rows on every
  render, including on tooltip hover state. Not a real problem at current data
  volumes, but a candidate for memoization if it grows.
- Numeric fields use `inputMode="decimal"` (`FieldInput.tsx:87`), which hides
  the minus key on many mobile keyboards, making negative values awkward to type.
- Test gaps: `Layout.tsx`, `useTheme.ts`, the clipboard-denied fallback in
  `CopyButton.tsx`, and `ReplicationTimeline`/`RouteBadge` in isolation are
  untested.

## Tests

`make test` runs Vitest and Testing Library with mocked API responses; no running
proxy, database or API is required. Run `make typecheck` for TypeScript validation
and `make build` to verify the application build. Real database and proxy checks
live in the [API test suite](../api/README.md#tests).

See [Contributing](../../CONTRIBUTING.md) for pull request guidelines and checks
across the repository.
