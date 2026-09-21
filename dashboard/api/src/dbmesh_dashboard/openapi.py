"""Print the API's OpenAPI document; the dashboard front generates its TypeScript types from it."""

from __future__ import annotations

import json

from .config import Settings
from .main import create_app


def document() -> str:
    # Building the app opens no connection, so placeholder settings are enough.
    settings = Settings(audit_url="postgres://placeholder", proxy_host="localhost", proxy_port=6432,
                        databases=("demo",), password="placeholder")
    return json.dumps(create_app(settings).openapi(), indent=2, sort_keys=True) + "\n"


if __name__ == "__main__":
    print(document(), end="")
