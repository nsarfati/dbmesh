# DBMesh dashboard front end

A single-page app for the [dashboard API](../api/README.md): React, TypeScript,
Vite and Tailwind CSS, with TanStack Query for data and Radix for the drawer.
It has no runtime dependency on anything but that API.

Screens:

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
- **Sign in**: one shared password, set by `DASHBOARD_PASSWORD` when the API starts.

It follows the system light or dark theme (switchable), works on phones, where
the table becomes cards, and is keyboard operable.

## Develop

```bash
# terminal 1: the API, configured from ../../config.yaml
cd dashboard/api && make run

# terminal 2: the front end, proxying /api to it
cd dashboard/front
make run           # http://localhost:5173
```

`make run` installs the dependencies first when needed. The dev server proxies
`/api` to `http://127.0.0.1:8000`, keeping the session cookie same-origin. Point
it elsewhere with `make run DASHBOARD_API=http://host:port`.

## Commands

Each `make` target wraps an npm script, so either works.

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
[`openapi.json`](../api/openapi.json), so the front and the API cannot silently
drift. After changing the API run `make openapi` in `dashboard/api`, then
`make gen-api` here. A test in the API fails when `openapi.json` is stale.

TypeScript is pinned to 5.x because `openapi-typescript` needs the compiler's
JavaScript API, which TypeScript 7 no longer ships.

## Layout

```text
src/
  api/          fetch client, query hooks and the generated schema
  components/   shared UI: layout, feedback, JSON and diff views, ui/ primitives
  features/     audit/ (filters, events table, detail drawer) and explorer/ (grid,
                query builder, SQL preview, result and replication views)
  lib/          pure helpers (time, filters, change summaries, form-to-request
                logic for the builder), tested on their own
  pages/        Login, AuditLog, Explorer
tests/          Vitest suites; helpers.tsx mocks the API with fetch
```
