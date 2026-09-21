"""`python -m dbmesh_dashboard` starts the API with uvicorn."""

from __future__ import annotations

import sys

import uvicorn

from .config import ConfigError, load_settings
from .main import create_app


def main() -> int:
    try:
        settings = load_settings()
    except ConfigError as err:
        print(f"dbmesh-dashboard: {err}", file=sys.stderr)
        return 1
    print(f"DBMesh dashboard API on http://{settings.host}:{settings.port}", flush=True)
    if settings.generated_password:
        print(f"Password: {settings.password}   (generated; set DASHBOARD_PASSWORD to choose your own)", flush=True)
    if settings.host not in ("127.0.0.1", "localhost", "::1"):
        print("WARNING: listening beyond loopback. There is no TLS; put a reverse proxy in front.", file=sys.stderr)
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
