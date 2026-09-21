"""A deliberately small synchronous wrapper around psycopg's ClientCursor."""

import base64
from contextlib import contextmanager
from contextvars import ContextVar
import json
import unicodedata

import psycopg
from psycopg import sql


def _header(*, user_id: str, request_id: str, service: str = "") -> str:
    fields = {"user_id": user_id, "request_id": request_id, "service": service}
    for name, value in fields.items():
        if not isinstance(value, str):
            raise TypeError(f"{name} must be a string")
        if name != "service" and not value.strip():
            raise ValueError(f"{name} must not be empty")
        if len(value.encode("utf-8")) > 256:
            raise ValueError(f"{name} must be at most 256 UTF-8 bytes")
        if any(unicodedata.category(c) == "Cc" for c in value):
            raise ValueError(f"{name} must not contain control characters")
    data = json.dumps(fields, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    encoded = base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")
    header = f"/*dbmesh:v1:{encoded}*/"
    if len(header) > 2048:
        raise ValueError("audit header must be at most 2048 bytes")
    return header + "\n"


def connect(conninfo: str = "", **kwargs) -> "Connection":
    """Connect to DBMesh with autocommit and Simple Query Protocol.

    Extra keyword arguments are psycopg connection options. These protocol
    settings are fixed by this MVP rather than silently accepting incompatible
    cursor factories, prepared statements, or implicit transactions.
    """
    for option in ("autocommit", "cursor_factory", "prepare_threshold"):
        if option in kwargs:
            raise TypeError(f"{option} is managed by dbmesh")
    raw = psycopg.connect(
        conninfo, autocommit=True, cursor_factory=psycopg.ClientCursor,
        prepare_threshold=None, **kwargs,
    )
    if raw.info.parameter_status("dbmesh_audit") != "comment-v1":
        raw.close()
        raise psycopg.NotSupportedError("server does not advertise DBMesh comment-v1 audit support")
    return Connection(raw)


class Connection:
    def __init__(self, raw):
        self._raw = raw
        # Contexts are specific to this connection and to the current execution
        # context. Nested requests restore their parent, including on exceptions.
        self._header = ContextVar(f"dbmesh_request_{id(self)}", default="")

    @contextmanager
    def request(self, *, user_id: str, request_id: str, service: str = ""):
        """Attach context to every execute in this block; never BEGIN or COMMIT."""
        if self.closed:
            raise psycopg.InterfaceError("connection is closed")
        token = self._header.set(_header(user_id=user_id, request_id=request_id, service=service))
        try:
            yield self
        finally:
            self._header.reset(token)

    def cursor(self) -> "Cursor":
        return Cursor(self, self._raw.cursor())

    def execute(self, query, params=None) -> "Cursor":
        cursor = self.cursor()
        try:
            return cursor.execute(query, params)
        except BaseException:
            cursor.close()
            raise

    @property
    def closed(self):
        return self._raw.closed

    @property
    def info(self):
        return self._raw.info

    def add_notice_handler(self, callback):
        """Register a psycopg diagnostic callback (for example for route NOTICEs)."""
        self._raw.add_notice_handler(callback)

    def close(self):
        self._raw.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        # Autocommit queries are already committed. Closing rolls back any
        # transaction the caller explicitly opened with SQL.
        self.close()


class Cursor:
    def __init__(self, connection, raw):
        self._connection = connection
        self._raw = raw

    def execute(self, query, params=None) -> "Cursor":
        if not isinstance(query, (str, sql.Composable)):
            raise TypeError("query must be a string or psycopg.sql.Composable")
        header = self._connection._header.get()
        if header:
            # Metadata never undergoes SQL parameter interpolation. Its URL-safe
            # base64 alphabet cannot contain %, quotes, newlines or */.
            query = sql.SQL(header) + (sql.SQL(query) if isinstance(query, str) else query)
        self._raw.execute(query, params)
        return self

    def fetchone(self):
        return self._raw.fetchone()

    def fetchmany(self, size=None):
        return self._raw.fetchmany() if size is None else self._raw.fetchmany(size)

    def fetchall(self):
        return self._raw.fetchall()

    def nextset(self):
        return self._raw.nextset()

    @property
    def rowcount(self):
        return self._raw.rowcount

    @property
    def description(self):
        return self._raw.description

    @property
    def statusmessage(self):
        return self._raw.statusmessage

    def close(self):
        self._raw.close()

    def __iter__(self):
        return iter(self._raw)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.close()
