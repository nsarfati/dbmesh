import base64
import json
import os
import unittest
import time
import uuid
from unittest.mock import Mock, patch

import psycopg
from psycopg import sql

import dbmesh
from dbmesh.client import Connection, Route, _header, _audit_options, _parse_route


class FakeCursor:
    def __init__(self):
        self.calls = []
        self.fail = False

    def execute(self, query, params):
        self.calls.append((query.as_string() if isinstance(query, sql.Composable) else query, params))
        if self.fail:
            raise psycopg.ProgrammingError("test query error")


class ClientTests(unittest.TestCase):
    def test_audit_url_becomes_startup_options(self):
        kwargs = {}
        clean, tables = _audit_options(
            "postgresql://user:p%40ss@localhost/demo?sslmode=disable&audit=public.users,public.accounts&options=-c%20statement_timeout%3D5000",
            kwargs,
        )
        self.assertNotIn("audit=", clean)
        self.assertIn("p%40ss", clean)
        self.assertIn("sslmode=disable", clean)
        self.assertEqual(tables, "public.users,public.accounts")
        self.assertEqual(kwargs["options"], "-c statement_timeout=5000 -c dbmesh.audit_tables=public.users,public.accounts")
        for value in ("", "users", "public.users;DROP", "dbmesh.audit_outbox", "public.Users"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                _audit_options("postgresql://localhost/demo?audit=" + value, {})

    @patch("dbmesh.client.psycopg.connect")
    def test_audit_tables_must_be_confirmed(self, connect):
        raw = connect.return_value
        raw.info.parameter_status.side_effect = lambda name: {"dbmesh_audit": "comment-v1", "dbmesh_audit_tables": "public.users"}.get(name)
        dbmesh.connect("postgresql://localhost/demo?audit=public.users")
        self.assertEqual(connect.call_args.kwargs["options"], "-c dbmesh.audit_tables=public.users")
        with self.assertRaises(psycopg.NotSupportedError):
            dbmesh.connect("postgresql://localhost/demo?audit=public.accounts")
        raw.close.assert_called_once()

    def setUp(self):
        self.raw_cursor = FakeCursor()
        self.raw = Mock(closed=False)
        self.raw.cursor.return_value = self.raw_cursor
        self.conn = Connection(self.raw)

    def metadata(self, query):
        encoded = query.split(":", 2)[2].split("*/", 1)[0]
        return json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))

    def test_existing_cursor_attaches_at_execution_and_restores_context(self):
        cur = self.conn.cursor()
        cur.execute("SELECT %s", (1,))
        with self.conn.request(user_id="812", request_id="outer", service="billing"):
            cur.execute("SELECT %s", (2,))
            with self.assertRaises(RuntimeError):
                with self.conn.request(user_id="813", request_id="inner"):
                    cur.execute("SELECT %s", (3,))
                    raise RuntimeError("leave nested context")
            cur.execute("SELECT %s", (4,))
        cur.execute("SELECT %s", (5,))
        calls = self.raw_cursor.calls
        self.assertEqual(calls[0], ("SELECT %s", (1,)))
        self.assertEqual(self.metadata(calls[1][0])["request_id"], "outer")
        self.assertEqual(self.metadata(calls[2][0])["request_id"], "inner")
        self.assertEqual(self.metadata(calls[3][0])["request_id"], "outer")
        self.assertEqual(calls[4], ("SELECT %s", (5,)))
        # No BEGIN, SET, COMMIT, or cleanup SQL was added.
        self.assertEqual(len(calls), 5)

    def test_parameters_remain_separate_and_composition_is_supported(self):
        value = "'; DROP TABLE users; --"
        with self.conn.request(user_id="812", request_id="r"):
            self.conn.cursor().execute(sql.SQL("SELECT %s"), (value,))
        query, params = self.raw_cursor.calls[0]
        self.assertTrue(query.endswith("SELECT %s"))
        self.assertNotIn(value, query)
        self.assertEqual(params, (value,))

    def test_metadata_encoding_and_validation(self):
        value = "812 */ -- '%s' café"
        query = _header(user_id=value, request_id="r")
        self.assertEqual(self.metadata(query)["user_id"], value)
        self.assertEqual(query.count("*/"), 1)
        for value in ("", " ", "x\n", "x\x00", "é" * 129):
            with self.subTest(value=value), self.assertRaises(ValueError):
                _header(user_id=value, request_id="r")
        with self.assertRaises(TypeError):
            _header(user_id=812, request_id="r")

    def test_error_does_not_leak_to_next_request_or_other_connection(self):
        other_raw = Mock(closed=False)
        other_cursor = FakeCursor()
        other_raw.cursor.return_value = other_cursor
        other = Connection(other_raw)
        with self.assertRaises(psycopg.ProgrammingError):
            with self.conn.request(user_id="812", request_id="r"):
                other.cursor().execute("SELECT 1")
                self.raw_cursor.fail = True
                self.conn.cursor().execute("SELECT bad")
        self.raw_cursor.fail = False
        self.conn.cursor().execute("SELECT 2")
        self.assertEqual(other_cursor.calls[0][0], "SELECT 1")
        self.assertEqual(self.raw_cursor.calls[-1][0], "SELECT 2")

    @patch("dbmesh.client.psycopg.connect")
    def test_connect_uses_simple_query_autocommit_and_requires_capability(self, connect):
        raw = connect.return_value
        raw.info.parameter_status.return_value = "comment-v1"
        conn = dbmesh.connect("postgres://example/demo")
        self.assertIsInstance(conn, Connection)
        self.assertTrue(connect.call_args.kwargs["autocommit"])
        self.assertIs(connect.call_args.kwargs["cursor_factory"], psycopg.ClientCursor)
        self.assertIsNone(connect.call_args.kwargs["prepare_threshold"])
        raw.info.parameter_status.return_value = None
        with self.assertRaises(psycopg.NotSupportedError):
            dbmesh.connect("postgres://example/demo")
        raw.close.assert_called_once()
        with self.assertRaises(TypeError):
            dbmesh.connect(autocommit=False)


@unittest.skipUnless(os.getenv("DBMESH_TEST_PROXY_URL"), "set DBMESH_TEST_PROXY_URL")
class IntegrationTests(unittest.TestCase):
    def test_select_update_and_context_cleanup(self):
        with dbmesh.connect(os.environ["DBMESH_TEST_PROXY_URL"]) as conn:
            notices = []
            conn.add_notice_handler(lambda n: notices.append(n.message_primary))
            with conn.cursor() as cur:
                with conn.request(user_id="812", request_id="python-select", service="billing"):
                    cur.execute("SELECT %s AS value", ("quotes ' ; */ café %s",))
                    self.assertEqual(cur.fetchone()[0], "quotes ' ; */ café %s")
                    self.assertIn("dbmesh -> replica", notices[-1])
                    cur.execute("SELECT %s", (2,))
                    self.assertEqual(cur.fetchone(), (2,))
                    self.assertIn("dbmesh -> replica", notices[-1])
                with conn.request(user_id="813", request_id="python-update"):
                    cur.execute("UPDATE users SET plan=%s WHERE false", ("audit-test",))
                    self.assertEqual(cur.rowcount, 0)
                    self.assertIn("dbmesh -> primary", notices[-1])
                with self.assertRaises(psycopg.errors.DivisionByZero):
                    with conn.request(user_id="814", request_id="python-error"):
                        cur.execute("SELECT 1/0")
                cur.execute("SELECT 3")
                self.assertEqual(cur.fetchone(), (3,))
                self.assertIn("dbmesh -> replica", notices[-1])
                self.assertEqual(conn.info.transaction_status, psycopg.pq.TransactionStatus.IDLE)


@unittest.skipUnless(
    all(os.getenv(k) for k in ("DBMESH_TEST_PROXY_URL", "DBMESH_TEST_WRITER_URL", "DBMESH_TEST_AUDIT_URL")),
    "set DBMESH_TEST_PROXY_URL, DBMESH_TEST_WRITER_URL and DBMESH_TEST_AUDIT_URL",
)
class RowAuditIntegrationTests(unittest.TestCase):
    def test_python_dsn_to_persistent_row_events(self):
        schema = "python_audit_" + uuid.uuid4().hex
        request = "python-" + uuid.uuid4().hex
        with psycopg.connect(os.environ["DBMESH_TEST_WRITER_URL"], autocommit=True) as source, \
                psycopg.connect(os.environ["DBMESH_TEST_AUDIT_URL"], autocommit=True) as destination:
            source.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
            table = sql.Identifier(schema, "items")
            source.execute(sql.SQL("CREATE TABLE {} (id int primary key, value text)").format(table))
            try:
                dsn = os.environ["DBMESH_TEST_PROXY_URL"]
                dsn += ("&" if "?" in dsn else "?") + "audit=" + schema + ".items"
                with dbmesh.connect(dsn) as conn:
                    notices = []
                    conn.add_notice_handler(lambda n: notices.append(n.message_primary))
                    with conn.request(user_id="812", request_id=request, service="billing"):
                        with conn.cursor() as cur:
                            cur.execute("SELECT 1")
                            self.assertEqual(cur.fetchone(), (1,))
                            self.assertIn("dbmesh -> replica", notices[-1])
                            cur.execute(sql.SQL("INSERT INTO {} VALUES (%s,%s)").format(table), (1, "before"))
                            cur.execute(sql.SQL("UPDATE {} SET value=%s WHERE id=%s RETURNING value").format(table), ("after", 1))
                            self.assertEqual(cur.fetchone(), ("after",))
                            cur.execute("BEGIN")
                            cur.execute(sql.SQL("UPDATE {} SET value='rolled-back'").format(table))
                            cur.execute("ROLLBACK")
                            cur.execute(sql.SQL("DELETE FROM {} WHERE id=%s").format(table), (1,))
                deadline = time.monotonic() + 10
                events = []
                while time.monotonic() < deadline:
                    exists = destination.execute("SELECT to_regclass('public.audit_events')").fetchone()[0]
                    if exists:
                        events = destination.execute(
                            'SELECT operation, previous_value, new_value, audit_user_id, audit_service, db, "schema", "table" '
                            'FROM public.audit_events WHERE audit_request_id=%s ORDER BY created_at', (request,),
                        ).fetchall()
                    if len(events) == 3:
                        break
                    time.sleep(0.05)
                self.assertEqual(len(events), 3)
                self.assertEqual([e[0] for e in events], ["INSERT", "UPDATE", "DELETE"])
                self.assertIsNone(events[0][1])
                self.assertEqual(events[1][1], {"id": 1, "value": "before"})
                self.assertEqual(events[1][2], {"id": 1, "value": "after"})
                self.assertIsNone(events[2][2])
                for event in events:
                    self.assertEqual(event[3:5], ("812", "billing"))
                    self.assertEqual(event[6:], (schema, "items"))
            finally:
                # Remove only this test's objects/events, preserving demo data.
                if source.execute("SELECT to_regclass('dbmesh.audit_outbox')").fetchone()[0]:
                    source.execute('DELETE FROM dbmesh.audit_delivery WHERE event_id IN (SELECT event_id FROM dbmesh.audit_outbox WHERE "schema"=%s)', (schema,))
                    source.execute('DELETE FROM dbmesh.audit_outbox WHERE "schema"=%s', (schema,))
                source.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))
                if destination.execute("SELECT to_regclass('public.audit_events')").fetchone()[0]:
                    destination.execute('DELETE FROM public.audit_events WHERE "schema"=%s', (schema,))


if __name__ == "__main__":
    unittest.main()


class RouteTests(unittest.TestCase):
    @staticmethod
    def diag(message="dbmesh -> replica (read-only SELECT; reader 2, 1ms)", detail=None):
        return Mock(message_primary=message, message_detail=detail)

    def test_parses_the_structured_detail(self):
        detail = json.dumps({"target": "replica", "reader": 2, "reason": "read-only SELECT; reader 2",
                             "lag_bytes": 128, "duration_us": 1500})
        self.assertEqual(
            _parse_route(self.diag(detail=detail)),
            Route("replica", 2, "read-only SELECT; reader 2", 1500, lag_bytes=128, fallback=False),
        )

    def test_primary_route_and_fallback(self):
        route = _parse_route(self.diag(detail=json.dumps(
            {"target": "primary", "reason": "no eligible readers", "duration_us": 9, "fallback": True})))
        self.assertEqual((route.target, route.reader, route.lag_bytes, route.fallback), ("primary", 0, None, True))

    def test_ignores_other_notices_and_malformed_details(self):
        self.assertIsNone(_parse_route(self.diag(message="something else", detail='{"target":"x"}')))
        self.assertIsNone(_parse_route(self.diag(detail=None)))
        for detail in ("not json", "{}", '{"target":"primary","reader":"x"}', "[1]"):
            with self.subTest(detail=detail):
                self.assertIsNone(_parse_route(self.diag(detail=detail)))

    def test_connection_tracks_the_last_route_per_statement(self):
        raw = Mock(closed=False)
        raw.cursor.return_value = FakeCursor()
        conn = Connection(raw)
        handler = raw.add_notice_handler.call_args.args[0]
        self.assertIsNone(conn.last_route)

        def notice_during_execute(query, params):
            handler(self.diag(detail=json.dumps({"target": "primary", "reason": "write", "duration_us": 5})))

        conn.cursor()._raw.execute = notice_during_execute
        cursor = conn.cursor()
        cursor._raw.execute = notice_during_execute
        cursor.execute("UPDATE t SET a = 1")
        self.assertEqual(conn.last_route.target, "primary")
        # A statement whose NOTICE never arrives (older proxy) must not report a stale route.
        cursor._raw.execute = lambda query, params: None
        cursor.execute("SELECT 1")
        self.assertIsNone(conn.last_route)

    def test_route_is_exported(self):
        self.assertIs(dbmesh.Route, Route)
