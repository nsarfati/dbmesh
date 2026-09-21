from pathlib import Path

from dbmesh_dashboard.openapi import document

COMMITTED = Path(__file__).resolve().parents[1] / "openapi.json"


def test_committed_openapi_matches_the_api():
    # The front generates its types from this file. Regenerate it with `make openapi`.
    assert COMMITTED.read_text() == document(), "openapi.json is stale; run `make openapi` in dashboard/api"
