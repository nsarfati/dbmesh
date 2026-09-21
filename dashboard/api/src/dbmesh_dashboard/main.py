"""FastAPI application: login plus the audit-event endpoints."""

from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime
from typing import Annotated, Any

import psycopg_pool
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from .audit import AuditStore, EventFilter, InvalidCursor
from .auth import COOKIE, SESSION_SECONDS, LoginThrottle, SessionSigner, password_matches
from .config import Settings
from .explorer import Explorer, ExplorerError
from .explorer_api import build_router as build_explorer_router


class Login(BaseModel):
    password: str


class FieldChange(BaseModel):
    field: str
    before: Any = None
    after: Any = None


class Event(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    event_id: str
    db: str
    schema_name: str = Field(alias="schema")
    table: str
    operation: str
    user_id: str | None = None
    request_id: str | None = None
    service: str | None = None
    previous: dict[str, Any] | None = None
    new: dict[str, Any] | None = None
    changes: list[FieldChange] = []
    created_at: datetime


class EventPage(BaseModel):
    events: list[Event]
    next_cursor: str | None = None


class Facets(BaseModel):
    databases: list[str]
    tables: list[str]
    users: list[str]
    services: list[str]
    operations: list[str]


class Status(BaseModel):
    audit_available: bool
    databases: list[str]


def create_app(settings: Settings, store: AuditStore | None = None, explorer: Explorer | None = None) -> FastAPI:
    store = store or AuditStore(settings.audit_url)
    explorer = explorer or Explorer(settings, store)
    signer = SessionSigner(settings.secret)
    throttle = LoginThrottle()

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if hasattr(store, "open"):
            store.open()
        yield
        if hasattr(store, "close"):
            store.close()

    app = FastAPI(title="DBMesh dashboard API", lifespan=lifespan)

    @app.exception_handler(ExplorerError)
    def explorer_error(_: Request, err: ExplorerError) -> JSONResponse:
        return JSONResponse(status_code=err.status, content={"detail": err.message})

    def require_session(request: Request) -> None:
        if not signer.valid(request.cookies.get(COOKIE)):
            raise HTTPException(status_code=401, detail="login required")

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    public = APIRouter(prefix="/api")

    @public.post("/login")
    def login(body: Login, request: Request, response: Response) -> dict[str, bool]:
        client = request.client.host if request.client else "unknown"
        if throttle.blocked(client):
            raise HTTPException(status_code=429, detail="too many failed attempts; try again in a minute")
        if not password_matches(settings.password, body.password):
            throttle.record_failure(client)
            raise HTTPException(status_code=401, detail="wrong password")
        throttle.reset(client)
        response.set_cookie(COOKIE, signer.issue(), max_age=SESSION_SECONDS, httponly=True, samesite="strict", path="/")
        return {"authenticated": True}

    @public.post("/logout")
    def logout(response: Response) -> dict[str, bool]:
        response.delete_cookie(COOKIE, path="/")
        return {"authenticated": False}

    @public.get("/session")
    def session(request: Request) -> dict[str, bool]:
        return {"authenticated": signer.valid(request.cookies.get(COOKIE))}

    protected = APIRouter(prefix="/api", dependencies=[Depends(require_session)])

    @protected.get("/status")
    def status() -> Status:
        return Status(audit_available=store.available(), databases=list(settings.databases))

    @protected.get("/events")
    def list_events(
        db: str | None = None,
        schema: str | None = None,
        table: str | None = None,
        operation: Annotated[str | None, Query(pattern="^(INSERT|UPDATE|DELETE)$")] = None,
        user_id: str | None = None,
        request_id: str | None = None,
        service: str | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        limit: Annotated[int, Query(ge=1, le=200)] = 50,
        cursor: str | None = None,
    ) -> EventPage:
        flt = EventFilter(db, schema, table, operation, user_id, request_id, service, since, until)
        try:
            events, next_cursor = store.list_events(flt, limit, cursor)
        except InvalidCursor:
            raise HTTPException(status_code=400, detail="invalid cursor") from None
        except psycopg_pool.PoolTimeout:
            raise HTTPException(status_code=503, detail="audit database unavailable") from None
        return EventPage(events=events, next_cursor=next_cursor)

    @protected.get("/events/facets")
    def facets() -> Facets:
        try:
            return Facets(**store.facets())
        except psycopg_pool.PoolTimeout:
            raise HTTPException(status_code=503, detail="audit database unavailable") from None

    @protected.get("/events/{event_id}")
    def get_event(event_id: str) -> Event:
        try:
            event = store.get_event(event_id)
        except psycopg_pool.PoolTimeout:
            raise HTTPException(status_code=503, detail="audit database unavailable") from None
        if event is None:
            raise HTTPException(status_code=404, detail="event not found")
        return Event(**event)

    app.include_router(public)
    app.include_router(protected)
    app.include_router(build_explorer_router(explorer, [Depends(require_session)]))
    return app
