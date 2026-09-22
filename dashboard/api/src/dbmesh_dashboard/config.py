"""Settings taken from DBMesh's own config.yaml plus a few environment variables."""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping

import yaml


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Settings:
    audit_url: str
    proxy_host: str
    proxy_port: int
    databases: tuple[str, ...]
    password: str
    readers: Mapping[str, int] = field(default_factory=dict)  # configured readers per database
    generated_password: bool = False
    secret: bytes = field(default_factory=lambda: secrets.token_bytes(32), repr=False)
    host: str = "127.0.0.1"
    port: int = 8000
    static_dir: Path | None = None  # a built front end to serve, when there is one
    prometheus_url: str = "http://127.0.0.1:9090"


# dashboard/front/dist, next to this package's dashboard/api, when the front end has been built.
DEFAULT_STATIC = Path(__file__).resolve().parents[3] / "front" / "dist"


def _static_dir(env: Mapping[str, str]) -> Path | None:
    """DASHBOARD_STATIC picks the directory; set but empty it turns serving off."""
    if "DASHBOARD_STATIC" in env:
        return Path(env["DASHBOARD_STATIC"]) if env["DASHBOARD_STATIC"] else None
    return DEFAULT_STATIC if (DEFAULT_STATIC / "index.html").is_file() else None


def _proxy_address(listen: str) -> tuple[str, int]:
    """Turn DBMesh's `listen` value into an address a local client can dial."""
    host, sep, port = listen.rpartition(":")
    if not sep or not port.isdigit():
        raise ConfigError(f"listen must look like host:port or :port, got {listen!r}")
    if host in ("", "0.0.0.0", "::", "[::]"):
        host = "localhost"
    return host.strip("[]"), int(port)


def load_settings(path: str | os.PathLike[str] | None = None, env: Mapping[str, str] | None = None) -> Settings:
    """Read DBMesh's config.yaml and the DASHBOARD_* environment variables."""
    env = os.environ if env is None else env
    path = Path(path or env.get("DBMESH_CONFIG") or "config.yaml")
    try:
        raw = yaml.safe_load(path.read_text()) or {}
    except OSError as err:
        raise ConfigError(f"cannot read {path}: {err.strerror or err}") from err
    except yaml.YAMLError as err:
        raise ConfigError(f"{path} is not valid YAML: {err}") from err
    if not isinstance(raw, dict):
        raise ConfigError(f"{path} must contain a YAML mapping")

    audit = raw.get("audit") or {}
    url = ((audit.get("postgres") or {}).get("url")) if isinstance(audit, dict) else None
    if not url:
        raise ConfigError(f"{path}: audit.postgres.url is required by the dashboard")
    databases = raw.get("databases") or {}
    if not isinstance(databases, dict) or not databases:
        raise ConfigError(f"{path}: databases must list at least one database")
    # dashboard_proxy_addr overrides `listen` when the dashboard and DBMesh run as
    # separate services (e.g. two Railway services) and can't both dial "localhost".
    proxy_addr = raw.get("dashboard_proxy_addr") or raw.get("listen") or ":6432"
    proxy_host, proxy_port = _proxy_address(str(proxy_addr))
    readers = {}
    for name, entry in databases.items():
        hosts = ((entry or {}).get("reader") or {}).get("host") if isinstance(entry, dict) else None
        readers[str(name)] = len(hosts) if isinstance(hosts, list) else 0

    password = env.get("DASHBOARD_PASSWORD", "")
    generated = not password
    if generated:
        password = secrets.token_urlsafe(9)
    port = env.get("DASHBOARD_PORT", "8000")
    if not port.isdigit():
        raise ConfigError("DASHBOARD_PORT must be a number")
    secret = env.get("DASHBOARD_SECRET", "")
    return Settings(
        audit_url=url,
        proxy_host=proxy_host,
        proxy_port=proxy_port,
        databases=tuple(databases),
        readers=readers,
        password=password,
        generated_password=generated,
        secret=secret.encode() if secret else secrets.token_bytes(32),
        host=env.get("DASHBOARD_HOST", "127.0.0.1"),
        port=int(port),
        static_dir=_static_dir(env),
        prometheus_url=env.get("DASHBOARD_PROMETHEUS_URL", "http://127.0.0.1:9090"),
    )
