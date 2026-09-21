"""Read-only access to the audit database that DBMesh delivers row events to."""

from __future__ import annotations

import base64
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

MAX_PAGE = 200
FACET_LIMIT = 200
OPERATIONS = ("INSERT", "UPDATE", "DELETE")


class InvalidCursor(ValueError):
    pass


@dataclass(frozen=True)
class EventFilter:
    db: str | None = None
    schema: str | None = None
    table: str | None = None
    operation: str | None = None
    user_id: str | None = None
    request_id: str | None = None
    service: str | None = None
    since: datetime | None = None
    until: datetime | None = None


def compute_changes(operation: str, previous: dict | None, new: dict | None) -> list[dict[str, Any]]:
    """Field-level before/after for one event; unchanged UPDATE fields are omitted."""
    previous, new = previous or {}, new or {}
    changes = []
    for field in sorted(previous.keys() | new.keys()):
        before, after = previous.get(field), new.get(field)
        if operation == "UPDATE" and before == after:
            continue
        changes.append({"field": field, "before": before, "after": after})
    return changes


def encode_cursor(created_at: datetime, event_id: str) -> str:
    return base64.urlsafe_b64encode(f"{created_at.isoformat()}|{event_id}".encode()).decode()


def decode_cursor(cursor: str) -> tuple[datetime, str]:
    try:
        created, _, event_id = base64.urlsafe_b64decode(cursor.encode()).decode().partition("|")
        return datetime.fromisoformat(created), str(event_id)
    except (ValueError, UnicodeDecodeError) as err:
        raise InvalidCursor("invalid cursor") from err


_COLUMNS = """event_id::text AS event_id, db, "schema", "table", operation,
  audit_user_id AS user_id, audit_request_id AS request_id, audit_service AS service,
  previous_value AS previous, new_value AS new, created_at"""

_EQUALS = {
    "db": "db", "schema": '"schema"', "table": '"table"', "operation": "operation",
    "user_id": "audit_user_id", "request_id": "audit_request_id", "service": "audit_service",
}


def _event(row: dict[str, Any]) -> dict[str, Any]:
    row["changes"] = compute_changes(row["operation"], row["previous"], row["new"])
    return row


class AuditStore:
    """Queries `public.audit_events`. The table is created by DBMesh's first delivery."""

    def __init__(self, url: str, max_size: int = 4):
        self._pool = ConnectionPool(
            url, min_size=1, max_size=max_size, open=False, timeout=5,
            kwargs={"row_factory": dict_row, "autocommit": True, "application_name": "dbmesh-dashboard"},
        )

    def open(self) -> None:
        self._pool.open(wait=False)

    def close(self) -> None:
        self._pool.close()

    def available(self) -> bool:
        try:
            with self._pool.connection(timeout=2) as conn:
                conn.execute("SELECT 1")
            return True
        except Exception:
            return False

    def list_events(self, flt: EventFilter, limit: int = 50, cursor: str | None = None) -> tuple[list[dict], str | None]:
        limit = max(1, min(limit, MAX_PAGE))
        where: list[str] = []
        params: list[Any] = []
        for name, column in _EQUALS.items():
            value = getattr(flt, name)
            if value:
                where.append(f"{column} = %s")
                params.append(value)
        if flt.since:
            where.append("created_at >= %s")
            params.append(flt.since)
        if flt.until:
            where.append("created_at < %s")
            params.append(flt.until)
        if cursor:
            created, event_id = decode_cursor(cursor)
            where.append("(created_at, event_id) < (%s, %s::uuid)")
            params += [created, event_id]
        sql = f"SELECT {_COLUMNS} FROM public.audit_events"
        if where:
            sql += " WHERE " + " AND ".join(where)
        # One extra row tells us whether another page exists.
        sql += " ORDER BY created_at DESC, event_id DESC LIMIT %s"
        try:
            with self._pool.connection() as conn:
                rows = conn.execute(sql, [*params, limit + 1]).fetchall()
        except psycopg.errors.UndefinedTable:
            return [], None
        page = rows[:limit]
        next_cursor = encode_cursor(page[-1]["created_at"], page[-1]["event_id"]) if len(rows) > limit else None
        return [_event(row) for row in page], next_cursor

    def get_event(self, event_id: str) -> dict[str, Any] | None:
        try:
            with self._pool.connection() as conn:
                row = conn.execute(
                    f"SELECT {_COLUMNS} FROM public.audit_events WHERE event_id = %s::uuid", [event_id]
                ).fetchone()
        except psycopg.errors.UndefinedTable:
            return None
        except psycopg.errors.InvalidTextRepresentation:
            return None
        return _event(row) if row else None

    def facets(self) -> dict[str, list[str]]:
        queries = {
            "databases": "SELECT DISTINCT db AS v FROM public.audit_events ORDER BY v LIMIT %s",
            "tables": """SELECT DISTINCT "schema" || '.' || "table" AS v FROM public.audit_events ORDER BY v LIMIT %s""",
            "users": "SELECT DISTINCT audit_user_id AS v FROM public.audit_events WHERE audit_user_id IS NOT NULL ORDER BY v LIMIT %s",
            "services": "SELECT DISTINCT audit_service AS v FROM public.audit_events WHERE audit_service IS NOT NULL ORDER BY v LIMIT %s",
        }
        try:
            with self._pool.connection() as conn:
                result = {name: [r["v"] for r in conn.execute(sql, [FACET_LIMIT]).fetchall()] for name, sql in queries.items()}
        except psycopg.errors.UndefinedTable:
            result = {name: [] for name in queries}
        result["operations"] = list(OPERATIONS)
        return result
