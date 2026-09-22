"""A deliberately small synchronous wrapper around psycopg's ClientCursor."""

import base64
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
import json
import unicodedata
import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import psycopg
from psycopg import sql


@dataclass(frozen=True)
class Route:
    """Where DBMesh ran the last statement, from the structured DETAIL of its NOTICE."""

    target: str  # "primary" or "replica"
    reader: int  # one-based reader position; 0 when the primary served it
    reason: str
    duration_us: int
    lag_bytes: "int | None" = None  # last monitor sample of the serving reader
    fallback: bool = False  # a read that could not use a reader
    readers: int = 0  # total readers configured for this database


def _parse_route(diag):
    """Return a Route for a DBMesh route NOTICE, or None for any other diagnostic."""
    if not (diag.message_primary or "").startswith("dbmesh -> ") or not diag.message_detail:
        return None
    try:
        data = json.loads(diag.message_detail)
        return Route(
            target=str(data["target"]), reader=int(data.get("reader", 0)), reason=str(data.get("reason", "")),
            duration_us=int(data.get("duration_us", 0)), lag_bytes=data.get("lag_bytes"),
            fallback=bool(data.get("fallback", False)), readers=int(data.get("readers", 0)),
        )
    except (ValueError, KeyError, TypeError):
        return None


def _audit_options(conninfo, kwargs):
    """Translate our URI extension to a standard startup options parameter."""
    if not conninfo.startswith(("postgresql://", "postgres://")):
        return conninfo, None
    parts = urlsplit(conninfo)
    query = parse_qsl(parts.query, keep_blank_values=True)
    values = [value for key, value in query if key == "audit"]
    if not values:
        return conninfo, None
    if len(values) != 1:
        raise ValueError("audit must occur once")
    tables = list(dict.fromkeys(values[0].split(",")))
    if len(values[0]) > 4096:
        raise ValueError("audit table selection must be at most 4096 bytes")
    for table in tables:
        if not re.fullmatch(r"[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*", table):
            raise ValueError("audit tables must use unquoted schema.table names")
        schema, name = table.split(".")
        if max(len(schema), len(name)) > 63 or schema in ("dbmesh", "information_schema") or schema.startswith("pg_"):
            raise ValueError("unsupported audit table")
    existing = kwargs.get("options")
    if existing is None:
        existing = next((v for k, v in reversed(query) if k == "options"), "")
    if "dbmesh.audit" in existing:
        raise ValueError("audit conflicts with an explicit dbmesh.audit option")
    selected = ",".join(tables)
    kwargs["options"] = (existing + " -c dbmesh.audit_tables=" + selected).strip()
    clean = [(k, v) for k, v in query if k not in ("audit", "options")]
    return urlunsplit(parts._replace(query=urlencode(clean))), selected


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
    conninfo, tables = _audit_options(conninfo, kwargs)
    raw = psycopg.connect(
        conninfo, autocommit=True, cursor_factory=psycopg.ClientCursor,
        prepare_threshold=None, **kwargs,
    )
    if raw.info.parameter_status("dbmesh_audit") != "comment-v1":
        raw.close()
        raise psycopg.NotSupportedError("server does not advertise DBMesh comment-v1 audit support")
    if tables is not None and raw.info.parameter_status("dbmesh_audit_tables") != tables:
        raw.close()
        raise psycopg.NotSupportedError("server did not confirm requested audit tables")
    return Connection(raw)


class Connection:
    def __init__(self, raw):
        self._raw = raw
        self._last_route = None
        raw.add_notice_handler(self._on_notice)
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

    def _on_notice(self, diag):
        route = _parse_route(diag)
        if route is not None:
            self._last_route = route

    @property
    def last_route(self):
        """The Route of the most recent statement, or None (older proxy, or no statement yet)."""
        return self._last_route

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
        self._connection._last_route = None  # this statement's NOTICE arrives during execute
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
