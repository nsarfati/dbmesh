"""Explorer logic against a scripted fake of the DBMesh connection (no database needed)."""

from contextlib import contextmanager
from datetime import datetime, timezone
from decimal import Decimal
from uuid import UUID

import dbmesh
import psycopg
import pytest
from psycopg.errors import ForeignKeyViolation, ProgrammingError, UniqueViolation
from psycopg.types.json import Jsonb

from dbmesh_dashboard.config import Settings
from dbmesh_dashboard.explorer import (
    TABLE_TTL, ChangeRequest, Column, Explorer, ExplorerError, TableInfo, build_statement, describe, jsonable, translate,
)

USERS = TableInfo(
    "public", "users",
    (Column("id", "bigint", False, True, False), Column("name", "text", False, False, False),
     Column("plan", "text", True, True, False), Column("meta", "jsonb", True, True, False),
     Column("tags", "ARRAY", True, True, False)),
    ("id",),
)
NO_PK = TableInfo("public", "log", (Column("msg", "text", True, False, False),), ())


def sql_of(stmt):
    return stmt.as_string()


# -- statement building ------------------------------------------------------------------------------------------


def test_insert():
    stmt, params = build_statement(USERS, "INSERT", {}, {"name": "Ada", "plan": "pro"})
    assert sql_of(stmt) == 'INSERT INTO "public"."users" ("name", "plan") VALUES (%s, %s) RETURNING *'
    assert params == ["Ada", "pro"]


def test_insert_with_no_values_uses_defaults():
    stmt, params = build_statement(USERS, "INSERT", {}, {})
    assert sql_of(stmt) == 'INSERT INTO "public"."users" DEFAULT VALUES RETURNING *' and params == []


def test_update_and_delete_are_keyed_by_primary_key():
    stmt, params = build_statement(USERS, "UPDATE", {"id": 7}, {"plan": "free", "name": "Ada"})
    assert sql_of(stmt) == 'UPDATE "public"."users" SET "plan" = %s, "name" = %s WHERE "id" = %s RETURNING *'
    assert params == ["free", "Ada", 7]
    stmt, params = build_statement(USERS, "DELETE", {"id": 7}, {})
    assert sql_of(stmt) == 'DELETE FROM "public"."users" WHERE "id" = %s RETURNING *' and params == [7]


def test_composite_primary_keys():
    info = TableInfo("public", "m", (Column("a", "int", False, False, False), Column("b", "int", False, False, False),
                                       Column("v", "text", True, False, False)), ("a", "b"))
    stmt, params = build_statement(info, "DELETE", {"b": 2, "a": 1}, {})
    assert sql_of(stmt) == 'DELETE FROM "public"."m" WHERE "a" = %s AND "b" = %s RETURNING *' and params == [1, 2]
    with pytest.raises(ExplorerError, match="exactly the primary key"):
        build_statement(info, "DELETE", {"a": 1}, {})


@pytest.mark.parametrize(
    "info, op, key, values, message",
    [
        (USERS, "INSERT", {}, {"nope": 1}, "unknown column"),
        (USERS, "UPDATE", {"id": 1}, {"nope": 1}, "unknown column"),
        (USERS, "UPDATE", {"nope": 1}, {"plan": "x"}, "unknown column"),
        (USERS, "UPDATE", {}, {"plan": "x"}, "exactly the primary key"),
        (USERS, "UPDATE", {"id": 1, "name": "x"}, {"plan": "x"}, "exactly the primary key"),
        (USERS, "UPDATE", {"id": 1}, {}, "at least one value"),
        (USERS, "UPDATE", {"id": None}, {"plan": "x"}, "must not be null"),
        (USERS, "DELETE", {"id": 1}, {"plan": "x"}, "does not take values"),
        (USERS, "INSERT", {"id": 1}, {"name": "x"}, "only used by UPDATE and DELETE"),
        (NO_PK, "UPDATE", {}, {"msg": "x"}, "no primary key"),
        (NO_PK, "DELETE", {}, {}, "no primary key"),
        (USERS, "TRUNCATE", {}, {}, "unsupported operation"),
        (USERS, "INSERT", {}, {"name": {"a": 1}}, "structured value"),
        (USERS, "INSERT", {}, {"plan": ["a"]}, "structured value"),
    ],
)
def test_invalid_requests_are_rejected(info, op, key, values, message):
    with pytest.raises(ExplorerError, match=message) as err:
        build_statement(info, op, key, values)
    assert err.value.status == 400


def test_hostile_values_never_reach_the_sql_text():
    nasty = "x'); DROP TABLE users; --"
    stmt, params = build_statement(USERS, "INSERT", {}, {"name": nasty})
    assert nasty not in sql_of(stmt) and params == [nasty]


def test_json_and_array_columns_accept_structured_values():
    _, params = build_statement(USERS, "INSERT", {}, {"meta": {"a": [1, 2]}, "tags": ["x", "y"]})
    assert isinstance(params[0], Jsonb) and params[1] == ["x", "y"]
    _, params = build_statement(USERS, "INSERT", {}, {"meta": None, "plan": None})
    assert params == [None, None]


# -- statements shown to a person ----------------------------------------------------------------------------------


def test_literal_rendering_inlines_values_in_placeholder_order():
    stmt, params = build_statement(USERS, "UPDATE", {"id": 7}, {"plan": "free", "name": "Ada"}, literal=True)
    assert params == []
    assert sql_of(stmt) == 'UPDATE "public"."users" SET "plan" = \'free\', "name" = \'Ada\' WHERE "id" = 7 RETURNING *'
    stmt, _ = build_statement(USERS, "DELETE", {"id": 7}, {}, literal=True)
    assert sql_of(stmt) == 'DELETE FROM "public"."users" WHERE "id" = 7 RETURNING *'


def test_literals_escape_hostile_values_and_render_special_types():
    nasty = "x'); DROP TABLE users; --"
    stmt, _ = build_statement(USERS, "INSERT", {}, {"name": nasty, "plan": None, "meta": {"a": [1]}, "tags": ["x", "y"]}, literal=True)
    text = sql_of(stmt)
    assert "'x''); DROP TABLE users; --'" in text  # the quote is doubled, so it stays inside the string
    assert 'NULL' in text and "'{\"a\": [1]}'::jsonb" in text and "'{x,y}'" in text
    assert text.startswith('INSERT INTO "public"."users" ("name", "plan", "meta", "tags") VALUES (')


def test_describe_gives_the_parameterised_and_the_inlined_form():
    stmt, params, shown = describe(USERS, "UPDATE", {"id": 7}, {"meta": {"a": 1}, "plan": "pro"})
    assert shown.statement == 'UPDATE "public"."users" SET "meta" = %s, "plan" = %s WHERE "id" = %s RETURNING *'
    assert shown.params == [{"a": 1}, "pro", 7]  # JSON wrappers are unwrapped for display
    assert "'pro'" in shown.sql and "%s" not in shown.sql
    assert len(params) == 3 and isinstance(params[0], Jsonb)


def test_jsonable():
    assert jsonable(Decimal("1.50")) == "1.50"
    assert jsonable(datetime(2026, 9, 21, 12, tzinfo=timezone.utc)) == "2026-09-21T12:00:00+00:00"
    assert jsonable(UUID(int=1)) == "00000000-0000-0000-0000-000000000001"
    assert jsonable(b"\x00\xff") == "\\x00ff"
    assert jsonable({"a": (1, Decimal("2"))}) == {"a": [1, "2"]}
    assert jsonable(float("nan")) == "nan" and jsonable(1.5) == 1.5 and jsonable(None) is None


def test_translate_maps_errors_to_statuses():
    assert translate(UniqueViolation("duplicate key")).status == 409
    assert translate(ForeignKeyViolation("fk")).status == 409
    assert translate(ProgrammingError("bad")).status == 400
    assert translate(psycopg.OperationalError("connection refused")).status == 502


# -- scripted connections ----------------------------------------------------------------------------------------


class FakeCursor:
    def __init__(self, names=(), rows=(), rowcount=None):
        self.description = [type("D", (), {"name": n})() for n in names] or None
        self._rows = list(rows)
        self.rowcount = len(self._rows) if rowcount is None else rowcount

    def fetchall(self):
        return self._rows

    def close(self):
        pass


class FakeConn:
    """`respond(text, params, conn)` returns a FakeCursor, and may set `conn.last_route`."""

    def __init__(self, respond, dsn):
        self.respond, self.dsn, self.closed = respond, dsn, False
        self.last_route = None
        self.statements: list[str] = []
        self.request_args = None

    def _run(self, query, params=None):
        text = query if isinstance(query, str) else query.as_string()
        self.statements.append(text)
        return self.respond(text, params, self)

    execute = _run

    def cursor(self):
        conn = self

        class C:
            description = None
            rowcount = 0

            def execute(self, query, params=None):
                cur = conn._run(query, params)
                self.description, self.rowcount, self._rows = cur.description, cur.rowcount, cur._rows

            def fetchall(self):
                return self._rows

        return C()

    @contextmanager
    def request(self, **kwargs):
        self.request_args = kwargs
        yield self

    def close(self):
        self.closed = True


def route(target="primary", reader=0, lag=None, fallback=False, readers=0):
    return dbmesh.Route(target, reader, "test", 100, lag_bytes=lag, fallback=fallback, readers=readers)


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class FakeStore:
    def __init__(self, arrive_after=0, fail=False):
        self.calls, self.arrive_after, self.fail = 0, arrive_after, fail

    def list_events(self, flt, limit=50, cursor=None):
        self.calls += 1
        if self.fail:
            raise RuntimeError("audit db down")
        if self.calls <= self.arrive_after:
            return [], None
        at = datetime(2026, 9, 21, tzinfo=timezone.utc)
        return [{"event_id": "e1", "created_at": at, "request_id": flt.request_id, "operation": "UPDATE"}], None


SETTINGS = Settings(audit_url="x", proxy_host="localhost", proxy_port=6432, databases=("demo",),
                    password="p", secret=b"s" * 32)

METADATA = {
    "information_schema.columns": (
        ("column_name", "data_type", "is_nullable", "column_default", "is_generated", "identity_generation"),
        [("id", "bigint", "NO", "nextval(...)", "NEVER", None), ("name", "text", "NO", None, "NEVER", None),
         ("plan", "text", "YES", "'free'", "NEVER", None)]),
    "table_constraints": (("column_name",), [("id",)]),
}


def make_explorer(respond, settings=SETTINGS, store=None, clock=None):
    clock = clock or Clock()
    conns: list[FakeConn] = []

    def connect(dsn):
        conn = FakeConn(respond, dsn)
        conns.append(conn)
        return conn

    explorer = Explorer(settings, store or FakeStore(), connect=connect, clock=clock, sleep=clock.sleep)
    return explorer, conns


def metadata_or(handler):
    def respond(text, params, conn):
        if text.startswith("SET "):
            return FakeCursor()
        for marker, (names, rows) in METADATA.items():
            if marker in text:
                return FakeCursor(names, rows)
        return handler(text, params, conn)
    return respond


def test_metadata_is_read_from_the_primary_and_typed():
    explorer, conns = make_explorer(metadata_or(lambda *a: FakeCursor()))
    info = explorer.table("demo", "public", "users")
    assert info.primary_key == ("id",) and info.auditable
    assert [(c.name, c.has_default, c.nullable) for c in info.columns] == [("id", True, False), ("name", False, False), ("plan", True, True)]
    assert conns[0].statements[0].startswith("SET application_name")  # pins the session to the primary
    assert "audit=" not in conns[0].dsn and conns[0].closed


def test_dsn_identifies_the_dashboard_and_the_database():
    explorer, conns = make_explorer(metadata_or(lambda *a: FakeCursor()))
    explorer.table("demo", "public", "users")
    dsn = conns[0].dsn
    assert dsn.startswith("postgresql://dashboard@localhost:6432/demo?") and "application_name=dbmesh-dashboard" in dsn


def test_unknown_table_and_hidden_schemas_are_404():
    explorer, _ = make_explorer(lambda *a: FakeCursor(("x",), []) if False else FakeCursor())
    with pytest.raises(ExplorerError) as err:
        explorer.table("demo", "public", "missing")
    assert err.value.status == 404
    with pytest.raises(ExplorerError) as err:
        explorer.table("other", "public", "users")
    assert err.value.status == 404 and "not configured" in err.value.message


def test_rows_paginate_and_report_the_route():
    def respond(text, params, conn):
        conn.last_route = route("replica", 2, lag=64)
        assert 'ORDER BY "id" LIMIT 3 OFFSET 0' in text
        return FakeCursor(("id", "name", "plan"), [(1, "Ada", "pro"), (2, "Grace", None), (3, "Linus", "pro")])
    explorer, conns = make_explorer(metadata_or(respond))
    page = explorer.rows("demo", "public", "users", limit=2)
    assert page["has_more"] is True and len(page["rows"]) == 2 and page["rows"][1] == {"id": 2, "name": "Grace", "plan": None}
    assert page["route"].reader == 2 and page["route"].lag_bytes == 64
    assert page["sql"] == 'SELECT * FROM "public"."users" ORDER BY "id" LIMIT 3 OFFSET 0'
    assert not conns[-1].statements[0].startswith("SET")  # replica reads are not pinned


def test_rows_from_primary_pin_the_session_and_empty_tables_keep_columns():
    explorer, conns = make_explorer(metadata_or(lambda text, params, conn: FakeCursor()))
    page = explorer.rows("demo", "public", "users", source="primary")
    assert page["rows"] == [] and page["columns"] == ["id", "name", "plan"] and page["has_more"] is False
    assert conns[-1].statements[0].startswith("SET application_name")


def test_tables_listing_flags_auditable_names():
    def respond(text, params, conn):
        if "information_schema.tables" in text:
            return FakeCursor(("table_schema", "table_name"), [("public", "users"), ("Sales", "Orders")])
        return FakeCursor()
    explorer, _ = make_explorer(respond)
    assert explorer.tables("demo") == [{"schema": "public", "table": "users", "auditable": True},
                                       {"schema": "Sales", "table": "Orders", "auditable": False}]


# -- executing changes -------------------------------------------------------------------------------------------


def update_request(**over):
    return ChangeRequest(schema="public", table="users", operation="UPDATE", user_id="812", key={"id": 1},
                         values={"plan": "enterprise"}, request_id="req-1", **over)


def change_responder(post_write):
    """Writes return the updated row; later plain reads are handled by `post_write`."""
    def respond(text, params, conn):
        if text.startswith("UPDATE"):
            conn.last_route = route("primary")
            return FakeCursor(("id", "name", "plan"), [(1, "Ada", "enterprise")])
        return post_write(text, params, conn)
    return metadata_or(respond)


def test_metadata_is_cached_briefly():
    explorer, conns = make_explorer(metadata_or(lambda *a: FakeCursor()))
    clock = explorer._clock
    first = explorer.table("demo", "public", "users")
    assert explorer.table("demo", "public", "users") is first and len(conns) == 1  # typing in the builder reuses it
    clock.now += TABLE_TTL + 1
    explorer.table("demo", "public", "users")
    assert len(conns) == 2


def test_unknown_tables_are_not_cached():
    explorer, conns = make_explorer(lambda *a: FakeCursor())
    for _ in range(2):
        with pytest.raises(ExplorerError):
            explorer.table("demo", "public", "later_created")
    assert len(conns) == 2


def test_preview_shows_the_sql_without_running_it():
    explorer, conns = make_explorer(change_responder(lambda *a: FakeCursor()))
    preview = explorer.preview("demo", update_request())
    assert preview.statement.statement == 'UPDATE "public"."users" SET "plan" = %s WHERE "id" = %s RETURNING *'
    assert preview.statement.params == ["enterprise", 1]
    assert preview.statement.sql == 'UPDATE "public"."users" SET "plan" = \'enterprise\' WHERE "id" = 1 RETURNING *'
    assert preview.audited is True and preview.audit_problem is None
    assert all("audit=" not in c.dsn for c in conns)
    assert not any(stmt.startswith("UPDATE") for c in conns for stmt in c.statements)  # nothing was executed


def test_preview_reports_an_unauditable_table_instead_of_failing():
    def respond(text, params, conn):
        if text.startswith("SET "):
            return FakeCursor()
        if "information_schema.columns" in text:
            return FakeCursor(*METADATA["information_schema.columns"])
        return FakeCursor(("column_name",), [("id",)])
    explorer, _ = make_explorer(respond)
    request = ChangeRequest(schema="Sales", table="Orders", operation="UPDATE", user_id="1", key={"id": 1}, values={"plan": "x"})
    preview = explorer.preview("demo", request)
    assert preview.audited is False and "cannot be audited" in preview.audit_problem
    request.audit = False
    preview = explorer.preview("demo", request)
    assert preview.audited is False and preview.audit_problem is None


def test_preview_rejects_invalid_requests_like_execute():
    explorer, _ = make_explorer(change_responder(lambda *a: FakeCursor()))
    with pytest.raises(ExplorerError, match="unknown column"):
        explorer.preview("demo", ChangeRequest(schema="public", table="users", operation="UPDATE", user_id="1",
                                                key={"id": 1}, values={"nope": 1}))


def test_change_runs_audited_and_reports_events_and_replication():
    reads = iter([(2, False), (1, False), (2, True), (1, True)])  # (reader, visible)

    def post_write(text, params, conn):
        reader, visible = next(reads)
        conn.last_route = route("replica", reader, lag=0, readers=2)
        return FakeCursor(("id", "name", "plan"), [(1, "Ada", "enterprise" if visible else "pro")])

    explorer, conns = make_explorer(change_responder(post_write), store=FakeStore(arrive_after=2))
    result = explorer.execute("demo", update_request())

    write = next(c for c in conns if "audit=public.users" in c.dsn)
    assert write.request_args == {"user_id": "812", "request_id": "req-1", "service": "dashboard"}
    assert result.rowcount == 1 and result.row == {"id": 1, "name": "Ada", "plan": "enterprise"}
    assert result.statement.sql == 'UPDATE "public"."users" SET "plan" = \'enterprise\' WHERE "id" = 1 RETURNING *'
    assert result.statement.params == ["enterprise", 1]
    assert result.route.target == "primary"
    assert (result.audit.delivered, result.audit.expected, result.audit.timed_out) == (1, 1, False)
    assert result.audit.waited_ms >= 200  # two polls at 100 ms before the event arrived
    reader1, reader2 = result.replication.readers
    assert (reader1.reader, reader1.stale_reads) == (1, 1) and (reader2.reader, reader2.stale_reads) == (2, 1)
    assert reader1.visible_after_ms is not None and reader2.visible_after_ms is not None
    assert result.replication.fallback_reads == 0 and not result.replication.timed_out
    assert all(c.closed for c in conns)


def test_unaudited_change_has_no_audit_outcome_and_no_audit_option_in_the_dsn():
    explorer, conns = make_explorer(change_responder(lambda *a: FakeCursor()), store=FakeStore())
    result = explorer.execute("demo", update_request(audit=False, measure_replicas=False))
    assert result.audit is None and result.replication is None
    assert all("audit=" not in c.dsn for c in conns)


def test_audit_wait_times_out_without_failing_the_change():
    explorer, _ = make_explorer(change_responder(lambda *a: FakeCursor()), store=FakeStore(arrive_after=10**9))
    result = explorer.execute("demo", update_request(wait_seconds=0.5, measure_replicas=False))
    assert result.rowcount == 1 and result.audit.timed_out and result.audit.delivered == 0 and result.audit.waited_ms >= 500


def test_unavailable_audit_database_is_reported_not_raised():
    explorer, _ = make_explorer(change_responder(lambda *a: FakeCursor()), store=FakeStore(fail=True))
    result = explorer.execute("demo", update_request(measure_replicas=False))
    assert result.rowcount == 1 and result.audit.error == "audit database unavailable"


def test_no_rows_affected_means_no_events_to_wait_for_and_no_replication_poll():
    def respond(text, params, conn):
        conn.last_route = route("primary")
        return FakeCursor(("id", "name", "plan"), [])
    explorer, _ = make_explorer(metadata_or(respond))
    result = explorer.execute("demo", update_request())
    assert result.rowcount == 0 and result.row is None and result.audit is None and result.replication is None


def test_replica_measurement_gives_up_when_every_read_falls_back_to_the_primary():
    def post_write(text, params, conn):
        conn.last_route = route("primary", fallback=True, readers=2)  # readers exist but none is eligible
        return FakeCursor(("id", "name", "plan"), [(1, "Ada", "enterprise")])
    explorer, _ = make_explorer(change_responder(post_write))
    replication = explorer.execute("demo", update_request(audit=False)).replication
    assert replication.fallback_reads == 5 and all(r.visible_after_ms is None for r in replication.readers)
    assert "no reader was eligible" in replication.note


def test_replica_measurement_times_out_on_a_stuck_replica():
    def post_write(text, params, conn):
        conn.last_route = route("replica", 1, lag=999, readers=1)
        return FakeCursor(("id", "name", "plan"), [(1, "Ada", "pro")])  # never catches up
    explorer, _ = make_explorer(change_responder(post_write))
    replication = explorer.execute("demo", update_request(audit=False, measure_seconds=0.3)).replication
    assert replication.timed_out and replication.readers[0].visible_after_ms is None
    assert replication.readers[0].stale_reads > 1 and replication.readers[0].lag_bytes == 999


def test_delete_is_visible_once_the_row_is_gone_from_the_reader():
    seen = iter([[(1, "Ada", "x")], [], []])

    def respond(text, params, conn):
        if text.startswith("DELETE"):
            conn.last_route = route("primary")
            return FakeCursor(("id", "name", "plan"), [(1, "Ada", "x")])
        conn.last_route = route("replica", 1 + (next_reader := len(conn.statements) % 2), lag=0, readers=2)
        rows = next(seen)
        return FakeCursor(("id", "name", "plan") if rows else (), rows)  # an empty result may lack a description
    explorer, _ = make_explorer(metadata_or(respond))
    result = explorer.execute("demo", ChangeRequest(schema="public", table="users", operation="DELETE", user_id="1",
                                                    key={"id": 1}, values={}, audit=False))
    assert {r.reader for r in result.replication.readers} == {1, 2}
    assert all(r.visible_after_ms is not None for r in result.replication.readers)


def test_measurement_reports_no_reader_when_routes_never_leave_the_primary():
    explorer, _ = make_explorer(change_responder(lambda *a: FakeCursor()))
    replication = explorer.execute("demo", update_request(audit=False)).replication
    assert replication.readers == [] and "no reader" in replication.note


def test_unauditable_table_is_rejected_only_when_auditing_is_requested():
    upper = {"information_schema.columns": (METADATA["information_schema.columns"][0],
                                            METADATA["information_schema.columns"][1])}

    def respond(text, params, conn):
        if text.startswith("SET "):
            return FakeCursor()
        if "information_schema.columns" in text:
            return FakeCursor(*upper["information_schema.columns"])
        if "table_constraints" in text:
            return FakeCursor(("column_name",), [("id",)])
        conn.last_route = route("primary")
        return FakeCursor(("id", "name", "plan"), [(1, "Ada", "x")])
    explorer, _ = make_explorer(respond)
    request = ChangeRequest(schema="Sales", table="Orders", operation="UPDATE", user_id="1", key={"id": 1}, values={"plan": "x"})
    with pytest.raises(ExplorerError, match="cannot be audited") as err:
        explorer.execute("demo", request)
    assert err.value.status == 400
    request.audit, request.measure_replicas = False, False
    assert explorer.execute("demo", request).rowcount == 1


def test_client_side_context_validation_becomes_a_400():
    class Rejecting(FakeConn):
        @contextmanager
        def request(self, **kwargs):
            raise ValueError("user_id must not be empty")
            yield
    explorer, conns = make_explorer(change_responder(lambda *a: FakeCursor()))
    explorer._connect_fn = lambda dsn: Rejecting(explorer_respond, dsn)
    explorer_respond = change_responder(lambda *a: FakeCursor())
    with pytest.raises(ExplorerError, match="user_id must not be empty") as err:
        explorer.execute("demo", update_request())
    assert err.value.status == 400


def test_database_errors_are_translated():
    def respond(text, params, conn):
        if text.startswith("UPDATE"):
            raise UniqueViolation("duplicate key value violates unique constraint")
        return FakeCursor()
    explorer, conns = make_explorer(metadata_or(respond))
    with pytest.raises(ExplorerError) as err:
        explorer.execute("demo", update_request())
    assert err.value.status == 409 and "duplicate key" in err.value.message
    assert all(c.closed for c in conns)


def test_connection_failures_are_reported_clearly():
    def refuse(dsn):
        raise psycopg.OperationalError("connection refused")
    explorer, _ = make_explorer(lambda *a: FakeCursor())
    explorer._connect_fn = refuse
    with pytest.raises(ExplorerError, match="not reachable at localhost:6432") as err:
        explorer.tables("demo")
    assert err.value.status == 502


def test_audit_preparation_failure_from_the_proxy_is_a_400():
    class Rejected(psycopg.OperationalError):
        sqlstate = "22023"
    explorer, _ = make_explorer(lambda *a: FakeCursor())

    def refuse(dsn):
        raise Rejected("FATAL: row auditing requires audit.sinks to include postgres")
    explorer._connect_fn = refuse
    with pytest.raises(ExplorerError) as err:
        explorer.tables("demo")
    assert err.value.status == 400 and "row auditing" in err.value.message
