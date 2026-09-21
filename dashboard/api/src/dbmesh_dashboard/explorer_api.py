"""HTTP routes for the Explorer: table browsing and structured changes."""

from __future__ import annotations

from dataclasses import asdict
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel, ConfigDict, Field

from .explorer import MAX_ROWS, ChangeRequest, Explorer


class Model(BaseModel):
    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


class RouteOut(Model):
    """Where DBMesh ran a statement, as reported by the proxy."""
    target: str
    reader: int
    reason: str
    duration_us: int
    lag_bytes: int | None = None
    fallback: bool = False


class TableRef(Model):
    schema_name: str = Field(alias="schema")
    table: str
    auditable: bool


class TableList(Model):
    tables: list[TableRef]


class ColumnOut(Model):
    name: str
    data_type: str
    nullable: bool
    has_default: bool
    generated: bool
    primary_key: bool


class TableOut(Model):
    schema_name: str = Field(alias="schema")
    table: str
    auditable: bool
    primary_key: list[str]
    columns: list[ColumnOut]


class StatementOut(Model):
    """A statement as it ran: parameterised, and with the values inlined for copying."""
    statement: str
    params: list[Any]
    sql: str


class PreviewOut(Model):
    statement: StatementOut
    audited: bool
    audit_problem: str | None = None


class RowsOut(Model):
    sql: str
    columns: list[str]
    rows: list[dict[str, Any]]
    route: RouteOut | None
    limit: int
    offset: int
    has_more: bool
    source: Literal["replica", "primary"]


class ChangeIn(Model):
    schema_name: str = Field(alias="schema", min_length=1)
    table: str = Field(min_length=1)
    operation: Literal["INSERT", "UPDATE", "DELETE"]
    user_id: str = Field(min_length=1)
    key: dict[str, Any] = {}
    values: dict[str, Any] = {}
    request_id: str | None = None
    service: str = "dashboard"
    audit: bool = True
    wait_seconds: float = Field(10.0, ge=0, le=30)
    measure_replicas: bool = True
    measure_seconds: float = Field(3.0, ge=0, le=10)


class ReaderOut(Model):
    reader: int
    visible_after_ms: int | None
    stale_reads: int
    lag_bytes: int | None


class ReplicationOut(Model):
    readers: list[ReaderOut]
    fallback_reads: int
    timed_out: bool
    note: str | None = None


class AuditEvent(Model):
    event_id: str
    operation: str
    request_id: str | None = None
    previous: dict[str, Any] | None = None
    new: dict[str, Any] | None = None
    changes: list[dict[str, Any]] = []
    created_at: datetime


class AuditOut(Model):
    expected: int
    delivered: int
    waited_ms: int
    timed_out: bool
    events: list[AuditEvent]
    error: str | None = None


class ChangeOut(Model):
    request_id: str
    operation: str
    rowcount: int
    row: dict[str, Any] | None
    route: RouteOut | None
    audit: AuditOut | None
    replication: ReplicationOut | None
    statement: StatementOut


def _change_request(body: ChangeIn) -> ChangeRequest:
    return ChangeRequest(
        schema=body.schema_name, table=body.table, operation=body.operation, user_id=body.user_id,
        key=body.key, values=body.values, request_id=body.request_id, service=body.service, audit=body.audit,
        wait_seconds=body.wait_seconds, measure_replicas=body.measure_replicas, measure_seconds=body.measure_seconds,
    )


def build_router(explorer: Explorer, dependencies: list) -> APIRouter:
    router = APIRouter(prefix="/api/explorer", dependencies=dependencies)

    @router.get("/{database}/tables")
    def tables(database: str) -> TableList:
        return TableList(tables=explorer.tables(database))

    @router.get("/{database}/tables/{schema}/{table}")
    def table(database: str, schema: str, table: str) -> TableOut:
        info = explorer.table(database, schema, table)
        return TableOut(
            schema=info.schema, table=info.table, auditable=info.auditable, primary_key=list(info.primary_key),
            columns=[ColumnOut(**asdict(c), primary_key=c.name in info.primary_key) for c in info.columns],
        )

    @router.get("/{database}/tables/{schema}/{table}/rows")
    def rows(
        database: str, schema: str, table: str,
        limit: Annotated[int, Query(ge=1, le=MAX_ROWS)] = 50,
        offset: Annotated[int, Query(ge=0)] = 0,
        source: Literal["replica", "primary"] = "replica",
    ) -> RowsOut:
        return RowsOut.model_validate(explorer.rows(database, schema, table, limit, offset, source))

    @router.post("/{database}/preview")
    def preview(database: str, body: ChangeIn) -> PreviewOut:
        """The SQL this change would run, without running it."""
        return PreviewOut.model_validate(explorer.preview(database, _change_request(body)))

    @router.post("/{database}/execute")
    def execute(database: str, body: ChangeIn) -> ChangeOut:
        return ChangeOut.model_validate(explorer.execute(database, _change_request(body)))

    return router
