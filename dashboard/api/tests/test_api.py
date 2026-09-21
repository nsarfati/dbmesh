from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from dbmesh_dashboard.audit import InvalidCursor
from dbmesh_dashboard.config import Settings
from dbmesh_dashboard.main import create_app

PASSWORD = "correct horse"
NOW = datetime(2026, 9, 21, 20, 0, tzinfo=timezone.utc)


def make_event(**over):
    event = {
        "event_id": "8b1c0e0a-1111-4222-8333-444455556666", "db": "demo", "schema": "public", "table": "users",
        "operation": "UPDATE", "user_id": "812", "request_id": "req-1", "service": "billing",
        "previous": {"id": 1, "plan": "free"}, "new": {"id": 1, "plan": "pro"},
        "changes": [{"field": "plan", "before": "free", "after": "pro"}], "created_at": NOW,
    }
    return event | over


class FakeStore:
    def __init__(self):
        self.calls = []
        self.up = True

    def available(self):
        return self.up

    def list_events(self, flt, limit, cursor):
        self.calls.append((flt, limit, cursor))
        if cursor == "bad":
            raise InvalidCursor("invalid cursor")
        return [make_event()], "next-page"

    def get_event(self, event_id):
        return make_event() if event_id == "known" else None

    def facets(self):
        return {"databases": ["demo"], "tables": ["public.users"], "users": ["812"], "services": ["billing"],
                "operations": ["INSERT", "UPDATE", "DELETE"]}


@pytest.fixture
def store():
    return FakeStore()


@pytest.fixture
def client(store):
    settings = Settings(audit_url="postgres://x", proxy_host="localhost", proxy_port=6432,
                        databases=("demo",), password=PASSWORD, secret=b"s" * 32)
    with TestClient(create_app(settings, store)) as c:
        yield c


@pytest.fixture
def logged_in(client):
    assert client.post("/api/login", json={"password": PASSWORD}).status_code == 200
    return client


def test_healthz_is_public(client):
    assert client.get("/healthz").json() == {"status": "ok"}


@pytest.mark.parametrize("path", ["/api/events", "/api/events/facets", "/api/events/known", "/api/status"])
def test_protected_routes_need_a_session(client, path):
    assert client.get(path).status_code == 401


def test_login_sets_a_strict_httponly_cookie(client):
    response = client.post("/api/login", json={"password": PASSWORD})
    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=strict" in cookie and "max-age=28800" in cookie
    assert client.get("/api/session").json() == {"authenticated": True}


def test_wrong_password_and_throttle(client):
    for _ in range(5):
        assert client.post("/api/login", json={"password": "nope"}).status_code == 401
    assert client.post("/api/login", json={"password": PASSWORD}).status_code == 429
    assert client.get("/api/session").json() == {"authenticated": False}


def test_login_rejects_non_json_bodies(client):
    assert client.post("/api/login", data={"password": PASSWORD}).status_code == 422


def test_logout_ends_the_session(logged_in):
    logged_in.post("/api/logout")
    assert logged_in.get("/api/events").status_code == 401


def test_forged_cookie_is_rejected(client):
    client.cookies.set("dbmesh_session", "9999999999.forged")
    assert client.get("/api/events").status_code == 401


def test_events_maps_query_params_to_the_filter(logged_in, store):
    response = logged_in.get("/api/events", params={
        "table": "users", "schema": "public", "operation": "UPDATE", "user_id": "812",
        "request_id": "req-1", "service": "billing", "limit": 10, "cursor": "c1",
        "since": "2026-09-21T00:00:00Z"})
    assert response.status_code == 200
    body = response.json()
    assert body["next_cursor"] == "next-page"
    event = body["events"][0]
    assert event["schema"] == "public" and event["changes"] == [{"field": "plan", "before": "free", "after": "pro"}]
    flt, limit, cursor = store.calls[0]
    assert (flt.table, flt.schema, flt.operation, flt.user_id, flt.request_id, flt.service) == (
        "users", "public", "UPDATE", "812", "req-1", "billing")
    assert flt.since.year == 2026 and (limit, cursor) == (10, "c1")


@pytest.mark.parametrize("params", [{"operation": "DROP"}, {"limit": 0}, {"limit": 1000}, {"since": "yesterday"}])
def test_events_validates_parameters(logged_in, params):
    assert logged_in.get("/api/events", params=params).status_code == 422


def test_invalid_cursor_is_a_400(logged_in):
    assert logged_in.get("/api/events", params={"cursor": "bad"}).status_code == 400


def test_event_detail_and_not_found(logged_in):
    assert logged_in.get("/api/events/known").json()["request_id"] == "req-1"
    assert logged_in.get("/api/events/unknown").status_code == 404


def test_facets_route_is_not_shadowed_by_event_id(logged_in):
    assert logged_in.get("/api/events/facets").json()["tables"] == ["public.users"]


def test_status_reports_audit_availability(logged_in, store):
    assert logged_in.get("/api/status").json() == {"audit_available": True, "databases": ["demo"]}
    store.up = False
    assert logged_in.get("/api/status").json()["audit_available"] is False
