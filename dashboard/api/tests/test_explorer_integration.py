"""End to end through a running DBMesh. Opt in with DBMESH_TEST_PROXY=host:port and DBMESH_TEST_AUDIT_URL.

DBMesh must be running with `audit.sinks: [postgres]` delivering to DBMESH_TEST_AUDIT_URL. The test creates and
drops its own table. Set DBMESH_TEST_WRITER_URL to also clean the source outbox rows it produced, and
DBMESH_TEST_READERS to the number of readers DBMesh has configured (default 2).
"""

import os
import uuid

import dbmesh
import psycopg
import pytest

from dbmesh_dashboard.audit import AuditStore
from dbmesh_dashboard.config import Settings
from dbmesh_dashboard.explorer import ChangeRequest, Explorer, ExplorerError

PROXY = os.environ.get("DBMESH_TEST_PROXY")
AUDIT_URL = os.environ.get("DBMESH_TEST_AUDIT_URL")
WRITER_URL = os.environ.get("DBMESH_TEST_WRITER_URL")
DATABASE = os.environ.get("DBMESH_TEST_DATABASE", "demo")
READERS = int(os.environ.get("DBMESH_TEST_READERS", "2"))

pytestmark = pytest.mark.skipif(not (PROXY and AUDIT_URL), reason="set DBMESH_TEST_PROXY and DBMESH_TEST_AUDIT_URL")


@pytest.fixture
def scratch():
    host, _, port = PROXY.rpartition(":")
    table = f"dashboard_it_{uuid.uuid4().hex[:10]}"
    settings = Settings(audit_url=AUDIT_URL, proxy_host=host or "localhost", proxy_port=int(port), databases=(DATABASE,),
                        readers={DATABASE: READERS}, password="x")
    store = AuditStore(AUDIT_URL)
    store.open()
    explorer = Explorer(settings, store)
    dsn = f"postgresql://dashboard@{settings.proxy_host}:{settings.proxy_port}/{DATABASE}?sslmode=disable"
    with dbmesh.connect(dsn) as conn:  # DDL goes to the primary through DBMesh
        conn.execute(f"CREATE TABLE public.{table} (id bigserial PRIMARY KEY, name text NOT NULL, plan text DEFAULT 'free', meta jsonb, created timestamptz DEFAULT now())")
    try:
        yield explorer, table
    finally:
        with dbmesh.connect(dsn) as conn:
            conn.execute(f"DROP TABLE IF EXISTS public.{table}")
        with psycopg.connect(AUDIT_URL, autocommit=True) as audit:
            audit.execute('DELETE FROM public.audit_events WHERE "table" = %s', [table])
        if WRITER_URL:
            with psycopg.connect(WRITER_URL, autocommit=True) as source:
                ids = "SELECT event_id FROM dbmesh.audit_outbox WHERE \"table\" = %s"
                source.execute(f"DELETE FROM dbmesh.audit_delivery WHERE event_id IN ({ids})", [table])
                source.execute('DELETE FROM dbmesh.audit_outbox WHERE "table" = %s', [table])
        store.close()


def change(table, operation, **kw):
    return ChangeRequest(schema="public", table=table, operation=operation, user_id="it-user", service="it",
                         key=kw.pop("key", {}), values=kw.pop("values", {}), **kw)


def test_full_round_trip(scratch):
    explorer, table = scratch
    assert any(t["table"] == table and t["auditable"] for t in explorer.tables(DATABASE))
    info = explorer.table(DATABASE, "public", table)
    assert info.primary_key == ("id",) and [c.name for c in info.columns] == ["id", "name", "plan", "meta", "created"]
    assert explorer.rows(DATABASE, "public", table)["rows"] == []  # an empty table still describes its columns
    assert explorer.rows(DATABASE, "public", table)["columns"] == ["id", "name", "plan", "meta", "created"]

    inserted = explorer.execute(DATABASE, change(table, "INSERT", values={"name": "Ada", "meta": {"tags": ["a", "b"]}}))
    assert inserted.route.target == "primary" and inserted.rowcount == 1
    row_id = inserted.row["id"]
    assert (inserted.audit.delivered, inserted.audit.timed_out) == (1, False)
    assert inserted.audit.events[0]["new"]["name"] == "Ada" and inserted.audit.events[0]["user_id"] == "it-user"
    assert inserted.audit.events[0]["service"] == "it" and inserted.audit.events[0]["request_id"] == inserted.request_id
    assert all(r.visible_after_ms is not None for r in inserted.replication.readers)

    updated = explorer.execute(DATABASE, change(table, "UPDATE", key={"id": row_id}, values={"plan": "pro"}, request_id="it-update"))
    assert updated.request_id == "it-update" and updated.row["plan"] == "pro"
    [event] = updated.audit.events
    assert event["changes"] == [{"field": "plan", "before": "free", "after": "pro"}]

    # The SQL shown to a person must be runnable as displayed and give the row that was reported.
    assert updated.statement.statement.count("%s") == len(updated.statement.params) == 2
    preview = explorer.preview(DATABASE, change(table, "UPDATE", key={"id": row_id}, values={"plan": "pro"}))
    assert preview.statement.sql == updated.statement.sql and preview.audited is True
    dsn = f"postgresql://dashboard@{explorer._settings.proxy_host}:{explorer._settings.proxy_port}/{DATABASE}?sslmode=disable"
    with dbmesh.connect(dsn) as conn:
        conn.execute("BEGIN")
        try:
            row = conn.execute(updated.statement.sql).fetchall()[0]
            assert row[:4] == (row_id, "Ada", "pro", {"tags": ["a", "b"]}) and row[4].tzinfo is not None  # timestamptz decodes
        finally:
            conn.execute("ROLLBACK")

    # Timestamps must survive DBMesh: without the server's TimeZone, psycopg cannot decode them.
    assert isinstance(explorer.rows(DATABASE, "public", table, source="replica")["rows"][0]["created"], str)

    page = explorer.rows(DATABASE, "public", table, source="primary")
    assert page["sql"].startswith(f'SELECT * FROM "public"."{table}" ORDER BY "id" LIMIT')
    assert page["route"].target == "primary" and page["rows"][0]["meta"] == {"tags": ["a", "b"]}

    deleted = explorer.execute(DATABASE, change(table, "DELETE", key={"id": row_id}))
    assert deleted.audit.events[0]["previous"]["name"] == "Ada" and deleted.audit.events[0]["new"] is None
    assert explorer.rows(DATABASE, "public", table, source="primary")["rows"] == []


def test_errors_and_isolation(scratch):
    explorer, table = scratch
    with pytest.raises(ExplorerError) as err:  # NOT NULL violation
        explorer.execute(DATABASE, change(table, "INSERT", values={"plan": "x"}, audit=False))
    assert err.value.status == 409 and "name" in err.value.message
    with pytest.raises(ExplorerError) as err:
        explorer.execute(DATABASE, change(table, "UPDATE", key={"id": 1}, values={"nope": 1}))
    assert err.value.status == 400
    with pytest.raises(ExplorerError) as err:
        explorer.table(DATABASE, "public", "users; DROP TABLE users")
    assert err.value.status == 404
    missing = explorer.execute(DATABASE, change(table, "UPDATE", key={"id": -1}, values={"plan": "x"}))
    assert missing.rowcount == 0 and missing.audit is None
