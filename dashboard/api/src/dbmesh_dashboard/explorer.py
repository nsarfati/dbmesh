"""Browse tables and run structured changes through the DBMesh proxy.

Every statement goes through DBMesh using the repository's Python client, so the
dashboard sees the same routing and row auditing as any application. Identifiers
are validated against `information_schema` and values are always parameters; the
dashboard never accepts free-form SQL.
"""

from __future__ import annotations

import re
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from datetime import time as dtime
from decimal import Decimal
from typing import Any, Callable, Iterator, Mapping
from urllib.parse import quote, urlencode

import dbmesh
import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb

from .audit import AuditStore, EventFilter
from .config import Settings

HIDDEN_SCHEMAS = ("pg_catalog", "information_schema", "dbmesh")
MAX_ROWS = 200
TABLE_TTL = 10.0  # seconds a table's metadata is reused, so typing in the builder does not re-read the catalog
OPERATIONS = ("INSERT", "UPDATE", "DELETE")
# DBMesh only audits unquoted lowercase schema.table names.
AUDITABLE = re.compile(r"[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_]{0,62}")

TABLES_SQL = """SELECT table_schema, table_name FROM information_schema.tables
WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema', 'dbmesh')
ORDER BY table_schema, table_name"""

COLUMNS_SQL = """SELECT column_name, data_type, is_nullable, column_default, is_generated, identity_generation
FROM information_schema.columns WHERE table_schema = %s AND table_name = %s ORDER BY ordinal_position"""

PRIMARY_KEY_SQL = """SELECT kcu.column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
 AND kcu.table_name = tc.table_name
WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = %s AND tc.table_name = %s
ORDER BY kcu.ordinal_position"""


class ExplorerError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status, self.message = status, message


@dataclass(frozen=True)
class Column:
    name: str
    data_type: str
    nullable: bool
    has_default: bool  # may be omitted on INSERT
    generated: bool  # GENERATED ALWAYS: the database refuses explicit values


@dataclass(frozen=True)
class TableInfo:
    schema: str
    table: str
    columns: tuple[Column, ...]
    primary_key: tuple[str, ...]

    @property
    def auditable(self) -> bool:
        return bool(AUDITABLE.fullmatch(f"{self.schema}.{self.table}"))

    @property
    def qualified(self) -> str:
        return f"{self.schema}.{self.table}"


def _fetch(cursor: Any) -> tuple[list[str], list[tuple]]:
    """Column names and rows; a statement without a result set (older proxies drop it when empty) is just empty."""
    if not cursor.description:
        return [], []
    return [d.name for d in cursor.description], cursor.fetchall()


def jsonable(value: Any) -> Any:
    """Turn a psycopg value into something JSON can carry, losslessly enough to compare."""
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        return value if value == value and value not in (float("inf"), float("-inf")) else str(value)
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (datetime, date, dtime)):
        return value.isoformat()
    if isinstance(value, timedelta):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return "\\x" + bytes(value).hex()
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, Mapping):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    return str(value)


def _adapt(column: Column, value: Any) -> Any:
    """Prepare a JSON value for a column; structured values only where the column can hold them."""
    if value is None:
        return None
    if column.data_type in ("json", "jsonb"):
        return Jsonb(value)
    if isinstance(value, dict) or (isinstance(value, list) and column.data_type != "ARRAY"):
        raise ExplorerError(400, f"column {column.name!r} ({column.data_type}) does not accept a structured value")
    return value


def _columns_by_name(info: TableInfo, names: Any, what: str) -> dict[str, Column]:
    by_name = {c.name: c for c in info.columns}
    unknown = sorted(set(names) - by_name.keys())
    if unknown:
        raise ExplorerError(400, f"unknown column(s) in {what}: {', '.join(unknown)}")
    return by_name


class _Binder:
    """Turns a value into a placeholder (collecting the parameter) or, for display, into a SQL literal."""

    def __init__(self, literal: bool):
        self.literal = literal
        self.params: list[Any] = []

    def __call__(self, column: Column, value: Any) -> sql.Composable:
        adapted = _adapt(column, value)
        if self.literal:
            return sql.Literal(adapted)
        self.params.append(adapted)
        return sql.Placeholder()


def _key_clause(info: TableInfo, key: Mapping[str, Any], bind: _Binder) -> sql.Composable:
    by_name = _columns_by_name(info, key, "key")
    if not info.primary_key:
        raise ExplorerError(400, f"{info.qualified} has no primary key; only INSERT is supported")
    if set(key) != set(info.primary_key):
        raise ExplorerError(400, f"key must give exactly the primary key column(s): {', '.join(info.primary_key)}")
    if any(v is None for v in key.values()):
        raise ExplorerError(400, "primary key values must not be null")
    return sql.SQL(" AND ").join(sql.SQL("{} = {}").format(sql.Identifier(c), bind(by_name[c], key[c])) for c in info.primary_key)


def build_statement(info: TableInfo, operation: str, key: Mapping[str, Any], values: Mapping[str, Any],
                    literal: bool = False) -> tuple[sql.Composable, list[Any]]:
    """One statement RETURNING the affected row. Identifiers come only from `info`.

    Values become placeholders and the returned parameters; with `literal=True` they are inlined as SQL
    literals instead (and no parameters are returned), for showing the statement to a person.
    """
    table = sql.Identifier(info.schema, info.table)
    bind = _Binder(literal)
    if operation == "INSERT":
        if key:
            raise ExplorerError(400, "key is only used by UPDATE and DELETE")
        by_name = _columns_by_name(info, values, "values")
        if not values:
            return sql.SQL("INSERT INTO {} DEFAULT VALUES RETURNING *").format(table), []
        names = list(values)
        stmt = sql.SQL("INSERT INTO {} ({}) VALUES ({}) RETURNING *").format(
            table, sql.SQL(", ").join(map(sql.Identifier, names)), sql.SQL(", ").join(bind(by_name[n], values[n]) for n in names))
        return stmt, bind.params
    if operation == "UPDATE":
        by_name = _columns_by_name(info, values, "values")
        if not values:
            raise ExplorerError(400, "UPDATE needs at least one value")
        # Placeholders are numbered by construction order, so build the SET list before the WHERE clause.
        assignments = sql.SQL(", ").join(sql.SQL("{} = {}").format(sql.Identifier(n), bind(by_name[n], values[n])) for n in values)
        where = _key_clause(info, key, bind)
        return sql.SQL("UPDATE {} SET {} WHERE {} RETURNING *").format(table, assignments, where), bind.params
    if operation == "DELETE":
        if values:
            raise ExplorerError(400, "DELETE does not take values")
        where = _key_clause(info, key, bind)
        return sql.SQL("DELETE FROM {} WHERE {} RETURNING *").format(table, where), bind.params
    raise ExplorerError(400, f"unsupported operation {operation!r}")


@dataclass
class Statement:
    """A statement as a person reads it: parameterised (what runs), and with the values inlined."""

    statement: str
    params: list[Any]
    sql: str


def _plain(param: Any) -> Any:
    return jsonable(param.obj if isinstance(param, Jsonb) else param)


def describe(info: TableInfo, operation: str, key: Mapping[str, Any], values: Mapping[str, Any]) -> tuple[sql.Composable, list[Any], Statement]:
    stmt, params = build_statement(info, operation, key, values)
    inlined, _ = build_statement(info, operation, key, values, literal=True)
    return stmt, params, Statement(stmt.as_string(), [_plain(p) for p in params], inlined.as_string())


def translate(err: psycopg.Error) -> ExplorerError:
    """Map a database error to an HTTP status and a message a person can act on."""
    diag = getattr(err, "diag", None)
    message = (diag.message_primary if diag and diag.message_primary else None) or str(err).strip()
    if diag and diag.message_detail and not diag.message_detail.startswith("{"):
        message = f"{message}: {diag.message_detail}"
    if isinstance(err, psycopg.errors.IntegrityError):
        return ExplorerError(409, message)
    if isinstance(err, (psycopg.OperationalError, psycopg.InterfaceError)) and not getattr(err, "sqlstate", None):
        return ExplorerError(502, "DBMesh is not reachable")
    return ExplorerError(400, message)


@dataclass
class ReaderReport:
    reader: int
    visible_after_ms: int | None
    stale_reads: int
    lag_bytes: int | None


@dataclass
class ReplicationReport:
    readers: list[ReaderReport]
    fallback_reads: int
    timed_out: bool
    note: str | None = None


@dataclass
class AuditOutcome:
    expected: int
    delivered: int
    waited_ms: int
    timed_out: bool
    events: list[dict[str, Any]]
    error: str | None = None


@dataclass
class ChangeResult:
    request_id: str
    operation: str
    rowcount: int
    row: dict[str, Any] | None
    route: dbmesh.Route | None
    audit: AuditOutcome | None
    replication: ReplicationReport | None
    statement: Statement


@dataclass
class Preview:
    """What a change would run, without running it."""

    statement: Statement
    audited: bool
    audit_problem: str | None


@dataclass
class ChangeRequest:
    schema: str
    table: str
    operation: str
    user_id: str
    key: Mapping[str, Any]
    values: Mapping[str, Any]
    request_id: str | None = None
    service: str = "dashboard"
    audit: bool = True
    wait_seconds: float = 10.0
    measure_replicas: bool = True
    measure_seconds: float = 3.0


class Explorer:
    def __init__(self, settings: Settings, store: AuditStore, *, connect: Callable[[str], Any] = dbmesh.connect,
                 clock: Callable[[], float] = time.monotonic, sleep: Callable[[float], None] = time.sleep):
        self._settings, self._store = settings, store
        self._connect_fn, self._clock, self._sleep = connect, clock, sleep
        self._table_cache: dict[tuple[str, str, str], tuple[float, TableInfo]] = {}

    # -- connections -------------------------------------------------------------------------------------------

    def _dsn(self, database: str, audit_table: str | None = None) -> str:
        s = self._settings
        query = {"sslmode": "disable", "application_name": "dbmesh-dashboard"}
        if audit_table:
            query["audit"] = audit_table
        host = f"[{s.proxy_host}]" if ":" in s.proxy_host else s.proxy_host
        return f"postgresql://dashboard@{host}:{s.proxy_port}/{quote(database, safe='')}?{urlencode(query)}"

    def _check_database(self, database: str) -> None:
        if database not in self._settings.databases:
            raise ExplorerError(404, f"database {database!r} is not configured")

    @contextmanager
    def _session(self, database: str, audit_table: str | None = None, pin_primary: bool = False) -> Iterator[Any]:
        """A DBMesh connection. `pin_primary` sends a SET first, which DBMesh routes (and pins) to the primary."""
        self._check_database(database)
        try:
            conn = self._connect_fn(self._dsn(database, audit_table))
        except psycopg.Error as err:
            if getattr(err, "sqlstate", None) in ("22023", "3D000"):
                raise ExplorerError(400 if err.sqlstate == "22023" else 404, translate(err).message) from err
            raise ExplorerError(502, f"DBMesh is not reachable at {self._settings.proxy_host}:{self._settings.proxy_port}") from err
        try:
            if pin_primary:
                conn.execute("SET application_name = 'dbmesh-dashboard'").close()
            yield conn
        except psycopg.Error as err:
            raise translate(err) from err
        finally:
            conn.close()

    # -- metadata ----------------------------------------------------------------------------------------------

    def tables(self, database: str) -> list[dict[str, Any]]:
        # Metadata must reflect the primary: a table created a moment ago may not have reached a replica.
        with self._session(database, pin_primary=True) as conn:
            _, rows = _fetch(conn.execute(TABLES_SQL))
        return [{"schema": s, "table": t, "auditable": bool(AUDITABLE.fullmatch(f"{s}.{t}"))} for s, t in rows]

    def table(self, database: str, schema: str, table: str) -> TableInfo:
        cached = self._table_cache.get((database, schema, table))
        if cached and self._clock() - cached[0] < TABLE_TTL:
            return cached[1]
        with self._session(database, pin_primary=True) as conn:
            _, columns = _fetch(conn.execute(COLUMNS_SQL, (schema, table)))
            _, keys = _fetch(conn.execute(PRIMARY_KEY_SQL, (schema, table)))
        if not columns or schema in HIDDEN_SCHEMAS:
            raise ExplorerError(404, f"table {schema}.{table} not found")
        info = TableInfo(
            schema, table,
            tuple(Column(name, dtype, nullable == "YES", default is not None or identity is not None,
                         generated == "ALWAYS" or identity == "ALWAYS")
                  for name, dtype, nullable, default, generated, identity in columns),
            tuple(k for (k,) in keys),
        )
        self._table_cache[(database, schema, table)] = (self._clock(), info)
        return info

    def rows(self, database: str, schema: str, table: str, limit: int = 50, offset: int = 0,
             source: str = "replica") -> dict[str, Any]:
        info = self.table(database, schema, table)
        limit = max(1, min(limit, MAX_ROWS))
        order = sql.SQL(" ORDER BY {}").format(sql.SQL(", ").join(map(sql.Identifier, info.primary_key))) if info.primary_key else sql.SQL("")
        query = sql.SQL("SELECT * FROM {}{} LIMIT {} OFFSET {}").format(
            sql.Identifier(schema, table), order, sql.Literal(limit + 1), sql.Literal(max(0, offset)))
        with self._session(database, pin_primary=(source == "primary")) as conn:
            names, fetched = _fetch(conn.execute(query))
            route = conn.last_route
        names = names or [c.name for c in info.columns]
        return {
            "columns": names, "rows": [dict(zip(names, map(jsonable, r))) for r in fetched[:limit]],
            "route": route, "limit": limit, "offset": max(0, offset), "has_more": len(fetched) > limit, "source": source,
            "sql": query.as_string(),
        }

    # -- changes -----------------------------------------------------------------------------------------------

    @staticmethod
    def _audit_problem(info: TableInfo) -> str:
        return f"{info.qualified} cannot be audited: DBMesh needs unquoted lowercase schema.table names"

    def preview(self, database: str, req: ChangeRequest) -> Preview:
        """The SQL a change would run, and whether it would be audited. Nothing is executed."""
        info = self.table(database, req.schema, req.table)
        _, _, statement = describe(info, req.operation, req.key, req.values)
        problem = self._audit_problem(info) if req.audit and not info.auditable else None
        return Preview(statement, req.audit and problem is None, problem)

    def execute(self, database: str, req: ChangeRequest) -> ChangeResult:
        info = self.table(database, req.schema, req.table)
        statement, params, shown = describe(info, req.operation, req.key, req.values)
        audit_table = None
        if req.audit:
            if not info.auditable:
                raise ExplorerError(400, self._audit_problem(info))
            audit_table = info.qualified
        request_id = req.request_id or f"dash-{uuid.uuid4().hex[:12]}"
        try:
            with self._session(database, audit_table) as conn:
                with conn.request(user_id=req.user_id, request_id=request_id, service=req.service):
                    cursor = conn.cursor()
                    cursor.execute(statement, params)
                    names, fetched = _fetch(cursor)
                    rowcount = cursor.rowcount
                route = conn.last_route
        except ValueError as err:  # request context rejected by the client (empty id, control characters, ...)
            raise ExplorerError(400, str(err)) from err
        row = dict(zip(names, map(jsonable, fetched[0]))) if fetched else None

        replication = None
        if req.measure_replicas and rowcount > 0:
            replication = self._measure_replicas(database, info, req.operation, req.key, row, req.measure_seconds)
        audit = self._wait_for_events(request_id, rowcount, req.wait_seconds) if audit_table and rowcount > 0 else None
        return ChangeResult(request_id, req.operation, rowcount, row, route, audit, replication, shown)

    def _wait_for_events(self, request_id: str, expected: int, wait_seconds: float) -> AuditOutcome:
        started = self._clock()
        events: list[dict[str, Any]] = []
        error = None
        while True:
            try:
                events, _ = self._store.list_events(EventFilter(request_id=request_id), limit=200)
            except Exception:  # the audit database being down must not fail a change that already committed
                error = "audit database unavailable"
                break
            if len(events) >= expected or self._clock() - started >= wait_seconds:
                break
            self._sleep(0.1)
        waited = int((self._clock() - started) * 1000)
        events = sorted(events, key=lambda e: (e["created_at"], e["event_id"]))
        return AuditOutcome(expected, len(events), waited, len(events) < expected, events, error)

    def _measure_replicas(self, database: str, info: TableInfo, operation: str, key: Mapping[str, Any],
                          row: dict[str, Any] | None, timeout: float) -> ReplicationReport:
        """Poll the row through DBMesh until every reader shows the change; this is the observed replication delay.

        The reader count isn't declared anywhere in dashboard config — DBMesh reports it on every route NOTICE
        (`route.readers`), so it's learned from the first poll response instead.
        """
        if not info.primary_key:
            return ReplicationReport([], 0, False, "table has no primary key to poll")
        source = row if operation != "DELETE" else key
        try:
            key_values = {c: source[c] for c in info.primary_key}
        except (KeyError, TypeError):
            return ReplicationReport([], 0, False, "primary key not available to poll")
        by_name = {c.name: c for c in info.columns}
        where = sql.SQL(" AND ").join(sql.SQL("{} = %s").format(sql.Identifier(c)) for c in info.primary_key)
        query = sql.SQL("SELECT * FROM {} WHERE {}").format(sql.Identifier(info.schema, info.table), where)
        params = [_adapt(by_name[c], key_values[c]) for c in info.primary_key]
        expected = None if operation == "DELETE" else row

        started = self._clock()
        seen: dict[int, int] = {}
        stale: dict[int, int] = {}
        lag: dict[int, int | None] = {}
        fallback_reads = consecutive_fallbacks = 0
        readers = None  # learned from the first route NOTICE
        timed_out = False
        with self._session(database) as conn:  # unpinned, so reads round-robin over the readers
            while True:
                names, fetched = _fetch(conn.execute(query, params))
                route = conn.last_route
                elapsed_ms = int((self._clock() - started) * 1000)
                current = dict(zip(names, map(jsonable, fetched[0]))) if fetched else None
                if route is not None:
                    readers = route.readers
                if route is None or route.target != "replica":
                    fallback_reads += 1
                    consecutive_fallbacks += 1
                else:
                    consecutive_fallbacks = 0
                    lag[route.reader] = route.lag_bytes
                    if current == expected:
                        seen.setdefault(route.reader, elapsed_ms)
                    else:
                        stale[route.reader] = stale.get(route.reader, 0) + 1
                if readers == 0 or (readers and len(seen) >= readers):
                    break
                if consecutive_fallbacks >= 5 or self._clock() - started >= timeout:
                    timed_out = self._clock() - started >= timeout
                    break
                self._sleep(0.02)
        if readers == 0:
            note = "no readers configured for this database"
        elif consecutive_fallbacks >= 5:
            note = "reads fell back to the primary: no reader was eligible"
        else:
            note = None
        indices = range(1, readers + 1) if readers else sorted(set(seen) | set(stale) | set(lag))
        return ReplicationReport(
            [ReaderReport(r, seen.get(r), stale.get(r, 0), lag.get(r)) for r in indices],
            fallback_reads, timed_out, note,
        )
