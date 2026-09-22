import json
from io import BytesIO
from urllib.error import URLError
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from dbmesh_dashboard.config import Settings
from dbmesh_dashboard.main import create_app
from dbmesh_dashboard.metrics import MetricsStore


def sample(value, **labels):
    return {"metric": labels, "value": [100, str(value)]}


def test_snapshot_aggregates_per_series_before_summing_and_handles_nan(monkeypatch):
    calls = []
    labels = dict(database="demo", operation="multi", target="primary", reader="0", outcome="error")

    def query(expression, timestamp):
        calls.append((expression, timestamp))
        if "increase(" in expression:
            return [sample(2.5, **labels)]
        if "histogram_quantile" in expression:
            return [sample("NaN")]
        if expression.startswith("up"):
            return [sample(1), sample(0)]
        return [sample(0.1, **labels)]

    store = MetricsStore("http://prometheus", ("demo",))
    monkeypatch.setattr(store, "_query", query)
    result = store.snapshot("15m", "demo")
    assert result.rows[0].count == 2.5
    assert result.rows[0].per_second == 0.1
    assert result.rows[0].operation == "multi"
    assert result.p95_seconds is None
    assert (result.targets_up, result.targets_total) == (1, 2)
    assert len({timestamp for _, timestamp in calls}) == 1
    assert any('sum by (database,operation,target,reader,outcome) (increase(' in q for q, _ in calls)
    assert all('database="demo"' in q for q, _ in calls if not q.startswith("up"))


def test_missing_database_rejected_before_network():
    with pytest.raises(HTTPException) as err:
        MetricsStore("http://unused", ("demo",)).snapshot("5m", "other")
    assert err.value.status_code == 404


def test_prometheus_get_and_failure_handling(monkeypatch):
    calls = []

    def open_url(url, timeout):
        calls.append((url, timeout))
        return BytesIO(json.dumps({"status": "success", "data": {"resultType": "vector", "result": []}}).encode())

    monkeypatch.setattr("dbmesh_dashboard.metrics.urlopen", open_url)
    store = MetricsStore("http://prometheus:9090/", ("demo",))
    assert store._query('up{job="dbmesh"}', 123) == []
    assert parse_qs(urlparse(calls[0][0]).query)["query"] == ['up{job="dbmesh"}']
    assert calls[0][1] == 5

    def unavailable(*args, **kwargs):
        raise URLError("connection refused")

    monkeypatch.setattr("dbmesh_dashboard.metrics.urlopen", unavailable)
    with pytest.raises(HTTPException) as err:
        store._query("up", 123)
    assert err.value.status_code == 503


def test_api_auth_validation_and_empty_samples(monkeypatch):
    store = MetricsStore("http://unused", ("demo",))
    monkeypatch.setattr(store, "_query", lambda *args: [])
    settings = Settings(audit_url="postgres://unused", proxy_host="localhost", proxy_port=6432,
                        databases=("demo",), password="test")
    with TestClient(create_app(settings, store=object(), metrics=store)) as client:
        assert client.get("/api/metrics").status_code == 401
        client.post("/api/login", json={"password": "test"})
        assert client.get("/api/metrics?window=1s").status_code == 422
        assert client.get("/api/metrics?database=missing").status_code == 404
        response = client.get("/api/metrics?window=1h")
        assert response.status_code == 200
        assert response.json()["rows"] == []
        assert response.json()["targets_total"] == 0


def test_database_names_are_escaped(monkeypatch):
    queries = []
    store = MetricsStore("http://unused", ('odd"db', 'a.b'))
    monkeypatch.setattr(store, "_query", lambda q, _: queries.append(q) or [])
    store.snapshot("5m")
    assert any('database=~"odd\\\"db|a\\\\.b"' in q for q in queries)


def test_invalid_sample_returns_service_unavailable(monkeypatch):
    store = MetricsStore("http://unused", ("demo",))
    monkeypatch.setattr(store, "_query", lambda *args: [sample("NaN")])
    with pytest.raises(HTTPException) as err:
        store.snapshot("5m")
    assert err.value.status_code == 503
