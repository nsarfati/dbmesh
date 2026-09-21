import base64
import json
import os
import unittest
from unittest.mock import Mock, patch

import psycopg
from psycopg import sql

import dbmesh
from dbmesh.client import Connection, _header


class FakeCursor:
    def __init__(self):
        self.calls = []
        self.fail = False

    def execute(self, query, params):
        self.calls.append((query.as_string() if isinstance(query, sql.Composable) else query, params))
        if self.fail:
            raise psycopg.ProgrammingError("test query error")


class ClientTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
