from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from dbmesh_dashboard.config import DEFAULT_STATIC, Settings, load_settings
from dbmesh_dashboard.main import create_app
from dbmesh_dashboard.static import CONTENT_SECURITY_POLICY

PASSWORD = "pw"
INDEX = "<!doctype html><title>DBMesh</title><div id=root></div>"


class FakeStore:
    def available(self):
        return True


class FakeExplorer:
    pass


def settings(static_dir: Path | None) -> Settings:
    return Settings(audit_url="x", proxy_host="h", proxy_port=1, databases=("demo",), password=PASSWORD,
                    secret=b"s" * 32, static_dir=static_dir)


@pytest.fixture
def dist(tmp_path):
    root = tmp_path / "dist"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text(INDEX)
    (root / "assets" / "app-3f9a.js").write_text("console.log('app')")
    (root / "assets" / "app-3f9a.css").write_text("body{}")
    (root / "theme-init.js").write_text("// theme")
    (tmp_path / "secret.txt").write_text("outside the build directory")
    return root


@pytest.fixture
def client(dist):
    with TestClient(create_app(settings(dist), FakeStore(), FakeExplorer())) as c:
        yield c


def test_root_and_client_side_routes_get_the_page(client):
    for path in ("/", "/audit", "/explorer", "/explorer/deep/link"):
        response = client.get(path)
        assert response.status_code == 200 and response.text == INDEX, path
        assert response.headers["content-type"].startswith("text/html")
        assert response.headers["cache-control"] == "no-cache"


def test_the_page_gets_a_strict_content_security_policy(client):
    csp = client.get("/").headers["content-security-policy"]
    assert csp == CONTENT_SECURITY_POLICY
    assert "script-src 'self'" in csp and "frame-ancestors 'none'" in csp and "default-src 'self'" in csp
    assert "unsafe-eval" not in csp and "script-src 'unsafe-inline'" not in csp


def test_hashed_assets_are_served_immutably(client):
    response = client.get("/assets/app-3f9a.js")
    assert response.status_code == 200 and response.text == "console.log('app')"
    assert "javascript" in response.headers["content-type"]
    assert response.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert client.get("/assets/app-3f9a.css").headers["content-type"].startswith("text/css")


def test_root_files_are_served_and_missing_files_are_404(client):
    assert client.get("/theme-init.js").text == "// theme"
    for path in ("/missing.js", "/assets/missing.js", "/nested/missing.css"):
        assert client.get(path).status_code == 404, path


@pytest.mark.parametrize("path", ["/..%2fsecret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt", "/..%2f..%2f..%2fetc%2fpasswd"])
def test_paths_cannot_escape_the_build_directory(client, path):
    response = client.get(path)
    assert "outside the build directory" not in response.text and "root:" not in response.text
    assert response.status_code in (200, 404) and (response.status_code == 404 or response.text == INDEX)


def test_unknown_api_routes_stay_json_errors_and_real_ones_still_work(client):
    for path in ("/api/nope", "/api"):
        response = client.get(path)
        assert response.status_code == 404 and response.json() == {"detail": "not found"}
    assert client.get("/healthz").json() == {"status": "ok"}
    assert client.get("/api/session").json() == {"authenticated": False}
    assert client.get("/openapi.json").status_code == 200
    assert client.get("/docs").status_code == 200
    assert "content-security-policy" not in client.get("/docs").headers  # Swagger UI needs its CDN scripts
    client.post("/api/login", json={"password": PASSWORD})
    assert client.get("/api/status").json()["databases"] == ["demo"]


def test_every_response_carries_security_headers_and_api_data_is_not_cached(client):
    for path in ("/", "/audit", "/assets/app-3f9a.js", "/healthz", "/api/session", "/api/nope", "/missing.js"):
        headers = client.get(path).headers
        assert headers["x-content-type-options"] == "nosniff", path
        assert headers["x-frame-options"] == "DENY", path
        assert headers["referrer-policy"] == "no-referrer", path
    assert client.get("/api/session").headers["cache-control"] == "no-store"
    assert client.post("/api/login", json={"password": "wrong"}).headers["cache-control"] == "no-store"


def test_nothing_is_served_without_a_usable_build(tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    for static_dir in (None, empty, tmp_path / "missing"):
        with TestClient(create_app(settings(static_dir), FakeStore(), FakeExplorer())) as c:
            assert c.get("/").status_code == 404 and c.get("/audit").status_code == 404
            assert c.get("/healthz").status_code == 200
            assert c.get("/healthz").headers["x-frame-options"] == "DENY"


def test_static_directory_setting(tmp_path):
    config = tmp_path / "config.yaml"
    config.write_text("databases: {d: {writer: {user: u, host: h}}}\naudit: {postgres: {url: x}}\n")
    chosen = tmp_path / "somewhere"
    assert load_settings(config, env={"DASHBOARD_STATIC": str(chosen)}).static_dir == chosen
    assert load_settings(config, env={"DASHBOARD_STATIC": ""}).static_dir is None  # explicitly off
    expected = DEFAULT_STATIC if (DEFAULT_STATIC / "index.html").is_file() else None
    assert load_settings(config, env={}).static_dir == expected  # auto-detected next to the API


def test_head_requests_work_for_pages_and_health_checks(client):
    for path in ("/", "/audit", "/assets/app-3f9a.js", "/healthz"):
        response = client.head(path)
        assert response.status_code == 200 and response.content == b"", path
        assert response.headers["x-frame-options"] == "DENY"
    assert "content-security-policy" in client.head("/").headers
