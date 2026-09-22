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


def test_thread_pool_is_created_once_and_reused_across_snapshots(monkeypatch):
    # Spy on the constructor itself: comparing store._pool's identity across calls would pass
    # even if snapshot() ignored it and made its own pool each time, since nothing would ever
    # reassign the unused attribute.
    import dbmesh_dashboard.metrics as metrics_module

    created = []
    real_executor = metrics_module.ThreadPoolExecutor

    def spy(*args, **kwargs):
        pool = real_executor(*args, **kwargs)
        created.append(pool)
        return pool

    monkeypatch.setattr(metrics_module, "ThreadPoolExecutor", spy)
    store = MetricsStore("http://unused", ("demo",))
    monkeypatch.setattr(store, "_query", lambda *args: [])
    store.snapshot("5m")
    store.snapshot("15m")
    assert len(created) == 1, "a pool must not be created per snapshot() call"
    store.close()
    assert created[0]._shutdown


def test_database_names_are_escaped(monkeypatch):
    queries = []
    store = MetricsStore("http://unused", ('odd"db', 'a.b'))
    monkeypatch.setattr(store, "_query", lambda q, _: queries.append(q) or [])
    store.snapshot("5m")
    assert any('database=~"odd\\\"db|a\\\\.b"' in q for q in queries)


def test_a_bad_sample_is_dropped_not_fatal(monkeypatch, caplog):
    # One invalid series (e.g. a fleeting negative rate() right after DBMesh resets its counters
    # on restart) must not take down the whole snapshot; it is dropped and logged instead.
    good = dict(database="demo", operation="select", target="replica", reader="1", outcome="success")
    bad = dict(database="demo", operation="update", target="primary", reader="0", outcome="success")

    def query(expression, timestamp):
        if "increase(" in expression:
            return [sample(5, **good), sample("NaN", **bad)]
        if "histogram_quantile" in expression:
            return [sample("NaN")]
        if expression.startswith("up"):
            return [sample(1), sample("NaN")]
        return [sample(0.2, **good), sample(-1, **bad)]

    store = MetricsStore("http://unused", ("demo",))
    monkeypatch.setattr(store, "_query", query)
    with caplog.at_level("WARNING"):
        result = store.snapshot("5m")
    assert [row.operation for row in result.rows] == ["select"]
    assert result.rows[0].count == 5 and result.rows[0].per_second == 0.2
    assert result.p95_seconds is None
    assert (result.targets_up, result.targets_total) == (1, 2)
    assert "invalid Prometheus" in caplog.text


def test_all_samples_invalid_still_returns_200(monkeypatch):
    store = MetricsStore("http://unused", ("demo",))
    monkeypatch.setattr(store, "_query", lambda *args: [sample("NaN")])
    result = store.snapshot("5m")
    assert result.rows == [] and result.p95_seconds is None and result.targets_up == 0


def test_a_malformed_row_missing_a_label_is_dropped(monkeypatch, caplog):
    store = MetricsStore("http://unused", ("demo",))

    def query(expression, timestamp):
        if "increase(" in expression:
            return [{"metric": {"database": "demo"}, "value": [100, "1"]}]  # missing labels
        return []

    monkeypatch.setattr(store, "_query", query)
    with caplog.at_level("WARNING"):
        result = store.snapshot("5m")
    assert result.rows == []
