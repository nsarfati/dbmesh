import pytest

from dbmesh_dashboard.config import ConfigError, load_settings

VALID = """
listen: ":6432"
databases:
  demo:
    writer: {user: u, pwd: p, host: "localhost:55432"}
    reader: {user: u, pwd: p, host: ["localhost:55433", "localhost:55434"]}
  analytics:
    writer: {user: u, pwd: p, host: "localhost:55442"}
audit:
  sinks: [postgres]
  postgres:
    url: "postgres://audit@localhost:55435/audit"
"""


def write(tmp_path, text):
    path = tmp_path / "config.yaml"
    path.write_text(text)
    return path


def test_reads_dbmesh_config(tmp_path):
    s = load_settings(write(tmp_path, VALID), env={})
    assert s.audit_url == "postgres://audit@localhost:55435/audit"
    assert (s.proxy_host, s.proxy_port) == ("localhost", 6432)
    assert s.databases == ("demo", "analytics")
    assert (s.host, s.port) == ("127.0.0.1", 8000)


@pytest.mark.parametrize(
    "listen, want",
    [(":6432", ("localhost", 6432)), ("0.0.0.0:7000", ("localhost", 7000)),
     ("10.1.2.3:7000", ("10.1.2.3", 7000)), ("[::]:7000", ("localhost", 7000))],
)
def test_proxy_address_from_listen(tmp_path, listen, want):
    s = load_settings(write(tmp_path, VALID.replace(':6432', listen, 1).replace('":' + listen + '"', f'"{listen}"')), env={})
    assert (s.proxy_host, s.proxy_port) == want


def test_dashboard_proxy_addr_overrides_listen(tmp_path):
    s = load_settings(write(tmp_path, "dashboard_proxy_addr: \"dbmesh-proxy.railway.internal:6432\"\n" + VALID), env={})
    assert (s.proxy_host, s.proxy_port) == ("dbmesh-proxy.railway.internal", 6432)


def test_password_from_env_or_generated(tmp_path):
    path = write(tmp_path, VALID)
    chosen = load_settings(path, env={"DASHBOARD_PASSWORD": "hunter2"})
    assert chosen.password == "hunter2" and not chosen.generated_password
    generated = load_settings(path, env={})
    assert generated.generated_password and len(generated.password) >= 12
    assert load_settings(path, env={}).password != generated.password


def test_env_overrides(tmp_path):
    s = load_settings(write(tmp_path, VALID), env={"DASHBOARD_HOST": "0.0.0.0", "DASHBOARD_PORT": "9000"})
    assert (s.host, s.port) == ("0.0.0.0", 9000)


def test_path_from_dbmesh_config_env(tmp_path):
    path = write(tmp_path, VALID)
    assert load_settings(env={"DBMESH_CONFIG": str(path)}).databases == ("demo", "analytics")


@pytest.mark.parametrize(
    "text, message",
    [
        ("databases: {d: {writer: {user: u, host: h}}}", "audit.postgres.url"),
        ("audit: {postgres: {url: x}}", "databases"),
        ("- just\n- a list", "mapping"),
        (VALID.replace('listen: ":6432"', 'listen: "nonsense"'), "listen"),
        ("key: [unclosed", "valid YAML"),
    ],
)
def test_invalid_config(tmp_path, text, message):
    with pytest.raises(ConfigError, match=message):
        load_settings(write(tmp_path, text), env={})


def test_missing_file(tmp_path):
    with pytest.raises(ConfigError, match="cannot read"):
        load_settings(tmp_path / "nope.yaml", env={})


def test_bad_port(tmp_path):
    with pytest.raises(ConfigError, match="DASHBOARD_PORT"):
        load_settings(write(tmp_path, VALID), env={"DASHBOARD_PORT": "eighty"})
