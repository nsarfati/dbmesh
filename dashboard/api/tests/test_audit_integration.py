"""Runs against a real PostgreSQL in a throwaway database; opt in with DBMESH_TEST_AUDIT_URL."""

import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg
import pytest
from psycopg.conninfo import make_conninfo
from psycopg.types.json import Jsonb

from dbmesh_dashboard.audit import AuditStore, EventFilter, InvalidCursor

URL = os.environ.get("DBMESH_TEST_AUDIT_URL")
DESTINATION_DDL = Path(__file__).resolve().parents[3] / "internal" / "audit" / "destination.sql"
BASE = datetime(2026, 9, 21, 12, 0, tzinfo=timezone.utc)

pytestmark = pytest.mark.skipif(not URL, reason="set DBMESH_TEST_AUDIT_URL")


@pytest.fixture
def scratch_url():
    """A fresh database, so tests never read or delete real audit data."""
    name = f"dashboard_test_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(URL, autocommit=True) as admin:
        admin.execute(f'CREATE DATABASE "{name}"')
    try:
        yield make_conninfo(URL, dbname=name)
    finally:
        with psycopg.connect(URL, autocommit=True) as admin:
            admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


@pytest.fixture
def store(scratch_url):
    with psycopg.connect(scratch_url, autocommit=True) as conn:
        conn.execute(DESTINATION_DDL.read_text())
    s = AuditStore(scratch_url)
    s.open()
    yield s
    s.close()


def insert(url, **over):
    row = {
        "event_id": str(uuid.uuid4()), "db": "demo", "schema": "public", "table": "users", "operation": "UPDATE",
        "user_id": "812", "request_id": "req-1", "service": "billing",
        "previous": {"id": 1, "plan": "free"}, "new": {"id": 1, "plan": "pro"}, "created_at": BASE,
    } | over
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute(
            """INSERT INTO public.audit_events(event_id, db, "schema", "table", operation, audit_user_id,
               audit_request_id, audit_service, previous_value, new_value, created_at)
               VALUES (%(event_id)s, %(db)s, %(schema)s, %(table)s, %(operation)s, %(user_id)s, %(request_id)s,
               %(service)s, %(previous)s, %(new)s, %(created_at)s)""",
            row | {"previous": Jsonb(row["previous"]) if row["previous"] is not None else None,
                   "new": Jsonb(row["new"]) if row["new"] is not None else None},
        )
    return row["event_id"]


def test_missing_table_yields_empty_results(scratch_url):
    # No destination DDL applied: DBMesh has not delivered anything yet.
    s = AuditStore(scratch_url)
    s.open()
    try:
        assert s.list_events(EventFilter()) == ([], None)
        assert s.get_event(str(uuid.uuid4())) is None
        assert s.facets()["tables"] == [] and s.facets()["operations"] == ["INSERT", "UPDATE", "DELETE"]
        assert s.available()
    finally:
        s.close()


def test_event_shape_and_changes(store, scratch_url):
    event_id = insert(scratch_url)
    [event], cursor = store.list_events(EventFilter())
    assert cursor is None and event["event_id"] == event_id
    assert (event["schema"], event["table"], event["user_id"], event["request_id"]) == ("public", "users", "812", "req-1")
    assert event["changes"] == [{"field": "plan", "before": "free", "after": "pro"}]
    assert store.get_event(event_id)["previous"] == {"id": 1, "plan": "free"}
    assert store.get_event(str(uuid.uuid4())) is None
    assert store.get_event("not-a-uuid") is None


def test_filters(store, scratch_url):
    insert(scratch_url, table="users", operation="INSERT", previous=None, new={"id": 2}, user_id="1", request_id="a")
    insert(scratch_url, table="orders", operation="DELETE", previous={"id": 9}, new=None, user_id="2", request_id="b",
           service="shop", created_at=BASE + timedelta(hours=2))
    insert(scratch_url, table="users", operation="UPDATE", user_id="2", request_id="c", created_at=BASE + timedelta(hours=1))

    def ids(**kw):
        return [e["request_id"] for e in store.list_events(EventFilter(**kw))[0]]

    assert ids() == ["b", "c", "a"]  # newest first
    assert ids(table="orders") == ["b"]
    assert ids(operation="UPDATE") == ["c"]
    assert ids(user_id="2") == ["b", "c"]
    assert ids(service="shop") == ["b"]
    assert ids(request_id="a") == ["a"]
    assert ids(table="users", user_id="2") == ["c"]
    assert ids(since=BASE + timedelta(minutes=30)) == ["b", "c"]
    assert ids(until=BASE + timedelta(minutes=30)) == ["a"]
    assert ids(table="nope") == []


def test_filters_are_parameterised(store, scratch_url):
    insert(scratch_url)
    assert store.list_events(EventFilter(table="users'; DROP TABLE public.audit_events; --"))[0] == []
    assert len(store.list_events(EventFilter())[0]) == 1


def test_keyset_pagination_covers_every_event_once(store, scratch_url):
    # Many events share a timestamp, so the event_id tiebreaker is what keeps pages stable.
    expected = {insert(scratch_url, created_at=BASE + timedelta(seconds=i // 5), request_id=str(i)) for i in range(23)}
    seen, cursor = [], None
    for _ in range(10):
        page, cursor = store.list_events(EventFilter(), limit=7, cursor=cursor)
        seen += [e["event_id"] for e in page]
        if cursor is None:
            break
    assert len(seen) == len(set(seen)) == 23 and set(seen) == expected
    assert seen == sorted(seen, key=lambda i: (store.get_event(i)["created_at"], i), reverse=True)


def test_invalid_cursor(store):
    with pytest.raises(InvalidCursor):
        store.list_events(EventFilter(), cursor="garbage")


def test_facets(store, scratch_url):
    insert(scratch_url, table="users", user_id="1", service="billing")
    insert(scratch_url, table="orders", user_id="2", service="shop", db="shop")
    insert(scratch_url, table="orders", user_id=None, service=None)
    facets = store.facets()
    assert facets["tables"] == ["public.orders", "public.users"]
    assert facets["users"] == ["1", "2"] and facets["services"] == ["billing", "shop"]
    assert facets["databases"] == ["demo", "shop"]


def test_destination_indexes_exist(store, scratch_url):
    with psycopg.connect(scratch_url) as conn:
        names = {r[0] for r in conn.execute("SELECT indexname FROM pg_indexes WHERE tablename = 'audit_events'")}
    assert {"audit_events_created", "audit_events_table", "audit_events_request"} <= names


def test_unavailable_database_is_reported():
    s = AuditStore("postgres://nobody@127.0.0.1:1/none")
    s.open()
    try:
        assert not s.available()
    finally:
        s.close()
