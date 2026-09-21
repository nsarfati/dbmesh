from datetime import datetime, timezone

import dbmesh
import pytest
from fastapi.testclient import TestClient

from dbmesh_dashboard.config import Settings
from dbmesh_dashboard.explorer import (
    AuditOutcome, ChangeResult, Column, ExplorerError, Preview, ReaderReport, ReplicationReport, Statement, TableInfo,
)
from dbmesh_dashboard.main import create_app

PASSWORD = "pw"
INFO = TableInfo("public", "users", (Column("id", "bigint", False, True, False), Column("name", "text", False, False, False)), ("id",))
ROUTE = dbmesh.Route("replica", 1, "read-only SELECT; reader 1", 700, lag_bytes=0)
STATEMENT = Statement('UPDATE "public"."users" SET "name" = %s WHERE "id" = %s RETURNING *', ["Ada", 1],
                      "UPDATE \"public\".\"users\" SET \"name\" = 'Ada' WHERE \"id\" = 1 RETURNING *")


class FakeExplorer:
    def __init__(self):
        self.calls = []
        self.error = None

    def _maybe_fail(self):
        if self.error:
            raise self.error

    def tables(self, database):
        self.calls.append(("tables", database))
        self._maybe_fail()
        return [{"schema": "public", "table": "users", "auditable": True}]

    def table(self, database, schema, table):
        self.calls.append(("table", database, schema, table))
        self._maybe_fail()
        return INFO

    def rows(self, database, schema, table, limit, offset, source):
        self.calls.append(("rows", database, schema, table, limit, offset, source))
        return {"columns": ["id", "name"], "rows": [{"id": 1, "name": "Ada"}], "route": ROUTE, "limit": limit,
                "offset": offset, "has_more": False, "source": source, "sql": 'SELECT * FROM "public"."users" LIMIT 51 OFFSET 0'}

    def preview(self, database, req):
        self.calls.append(("preview", database, req))
        self._maybe_fail()
        return Preview(STATEMENT, req.audit, None)

    def execute(self, database, req):
        self.calls.append(("execute", database, req))
        self._maybe_fail()
        at = datetime(2026, 9, 21, tzinfo=timezone.utc)
        event = {"event_id": "e1", "operation": req.operation, "request_id": "r1", "previous": {"id": 1}, "new": None,
                 "changes": [{"field": "id", "before": 1, "after": None}], "created_at": at}
        return ChangeResult("r1", req.operation, 1, {"id": 1, "name": "Ada"}, dbmesh.Route("primary", 0, "write statement", 90),
                            AuditOutcome(1, 1, 12, False, [event]),
                            ReplicationReport([ReaderReport(1, 8, 0, 0), ReaderReport(2, None, 3, 512)], 0, True), STATEMENT)


class FakeStore:
    def available(self):
        return True


@pytest.fixture
def explorer():
    return FakeExplorer()


@pytest.fixture
def client(explorer):
    settings = Settings(audit_url="x", proxy_host="h", proxy_port=1, databases=("demo",), password=PASSWORD, secret=b"s" * 32)
    with TestClient(create_app(settings, FakeStore(), explorer)) as c:
        c.post("/api/login", json={"password": PASSWORD})
        yield c


def test_routes_require_a_session(explorer):
    settings = Settings(audit_url="x", proxy_host="h", proxy_port=1, databases=("demo",), password=PASSWORD)
    with TestClient(create_app(settings, FakeStore(), explorer)) as anonymous:
        for method, path in [("get", "/api/explorer/demo/tables"), ("get", "/api/explorer/demo/tables/public/users"),
                             ("get", "/api/explorer/demo/tables/public/users/rows"), ("post", "/api/explorer/demo/execute"), ("post", "/api/explorer/demo/preview")]:
            assert getattr(anonymous, method)(path).status_code == 401
    assert explorer.calls == []


def test_table_list_and_detail(client):
    assert client.get("/api/explorer/demo/tables").json() == {"tables": [{"schema": "public", "table": "users", "auditable": True}]}
    body = client.get("/api/explorer/demo/tables/public/users").json()
    assert body["schema"] == "public" and body["primary_key"] == ["id"] and body["auditable"] is True
    assert [(c["name"], c["primary_key"]) for c in body["columns"]] == [("id", True), ("name", False)]


def test_rows_pass_paging_source_and_route(client, explorer):
    body = client.get("/api/explorer/demo/tables/public/users/rows", params={"limit": 25, "offset": 50, "source": "primary"}).json()
    assert explorer.calls[-1] == ("rows", "demo", "public", "users", 25, 50, "primary")
    assert body["rows"] == [{"id": 1, "name": "Ada"}] and body["route"]["lag_bytes"] == 0 and body["route"]["reader"] == 1
    assert body["sql"] == 'SELECT * FROM "public"."users" LIMIT 51 OFFSET 0'


@pytest.mark.parametrize("params", [{"limit": 0}, {"limit": 201}, {"offset": -1}, {"source": "moon"}])
def test_rows_validate_parameters(client, params):
    assert client.get("/api/explorer/demo/tables/public/users/rows", params=params).status_code == 422


def test_execute_maps_the_request_and_returns_everything(client, explorer):
    response = client.post("/api/explorer/demo/execute", json={
        "schema": "public", "table": "users", "operation": "UPDATE", "user_id": "812", "key": {"id": 1},
        "values": {"name": "Ada"}, "request_id": "r1", "service": "billing", "wait_seconds": 2})
    assert response.status_code == 200
    _, database, req = explorer.calls[-1]
    assert (database, req.schema, req.table, req.operation, req.user_id, req.service, req.wait_seconds) == (
        "demo", "public", "users", "UPDATE", "812", "billing", 2)
    assert (req.audit, req.measure_replicas, req.request_id) == (True, True, "r1")
    body = response.json()
    assert body["route"]["target"] == "primary" and body["rowcount"] == 1 and body["row"]["name"] == "Ada"
    assert body["audit"]["events"][0]["changes"] == [{"field": "id", "before": 1, "after": None}]
    assert body["audit"]["events"][0]["created_at"].startswith("2026-09-21")
    assert body["replication"]["readers"][1] == {"reader": 2, "visible_after_ms": None, "stale_reads": 3, "lag_bytes": 512}
    assert body["replication"]["timed_out"] is True
    assert body["statement"] == {"statement": STATEMENT.statement, "params": ["Ada", 1], "sql": STATEMENT.sql}


def test_preview_returns_the_sql_without_executing(client, explorer):
    response = client.post("/api/explorer/demo/preview", json={
        "schema": "public", "table": "users", "operation": "UPDATE", "user_id": "812", "key": {"id": 1}, "values": {"name": "Ada"}})
    assert response.status_code == 200
    assert response.json() == {
        "statement": {"statement": STATEMENT.statement, "params": ["Ada", 1], "sql": STATEMENT.sql},
        "audited": True, "audit_problem": None,
    }
    assert [call[0] for call in explorer.calls] == ["preview"]


def test_preview_reports_problems_like_execute(client, explorer):
    explorer.error = ExplorerError(400, "unknown column(s) in values: nope")
    response = client.post("/api/explorer/demo/preview", json={
        "schema": "public", "table": "users", "operation": "UPDATE", "user_id": "812", "key": {"id": 1}, "values": {"nope": 1}})
    assert response.status_code == 400 and response.json() == {"detail": "unknown column(s) in values: nope"}


def test_preview_validates_the_body(client):
    assert client.post("/api/explorer/demo/preview", json={"schema": "public", "table": "users", "operation": "DROP", "user_id": "1"}).status_code == 422


@pytest.mark.parametrize(
    "body",
    [
        {"schema": "public", "table": "users", "operation": "TRUNCATE", "user_id": "1"},
        {"schema": "public", "table": "users", "operation": "UPDATE", "user_id": ""},
        {"schema": "public", "table": "users", "operation": "UPDATE"},
        {"schema": "", "table": "users", "operation": "UPDATE", "user_id": "1"},
        {"schema": "public", "table": "users", "operation": "UPDATE", "user_id": "1", "wait_seconds": 999},
        {"schema": "public", "table": "users", "operation": "UPDATE", "user_id": "1", "measure_seconds": -1},
    ],
)
def test_execute_validates_the_body(client, body):
    assert client.post("/api/explorer/demo/execute", json=body).status_code == 422


@pytest.mark.parametrize("status", [400, 404, 409, 502])
def test_explorer_errors_keep_their_status_and_message(client, explorer, status):
    explorer.error = ExplorerError(status, "something specific")
    for response in (client.get("/api/explorer/demo/tables"),
                     client.post("/api/explorer/demo/execute", json={"schema": "public", "table": "users",
                                                                     "operation": "DELETE", "user_id": "1", "key": {"id": 1}})):
        assert response.status_code == status and response.json() == {"detail": "something specific"}


def test_openapi_documents_the_explorer(client):
    paths = client.get("/openapi.json").json()["paths"]
    assert "/api/explorer/{database}/execute" in paths and "/api/explorer/{database}/tables/{schema}/{table}/rows" in paths
