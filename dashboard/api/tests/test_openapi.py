from pathlib import Path

from dbmesh_dashboard.openapi import document

COMMITTED = Path(__file__).resolve().parents[1] / "openapi.json"


def test_committed_openapi_matches_the_api():
    # The front generates its types from this file. Regenerate it with `make openapi`.
    assert COMMITTED.read_text() == document(), "openapi.json is stale; run `make openapi` in dashboard/api"


def test_document_is_valid_and_builds_without_warnings():
    import json
    import warnings

    with warnings.catch_warnings():
        warnings.simplefilter("error")  # FastAPI warns about duplicate operation IDs
        spec = json.loads(document())
    ids = [op["operationId"] for path in spec["paths"].values() for op in path.values()]
    assert len(ids) == len(set(ids)), "operationIds must be unique"


def test_document_does_not_depend_on_hash_ordering():
    # Sets of methods are ordered by hash; the committed file must not flip between runs.
    import os
    import subprocess
    import sys

    outputs = set()
    for seed in ("1", "2", "3", "4"):
        result = subprocess.run([sys.executable, "-m", "dbmesh_dashboard.openapi"], capture_output=True, text=True,
                                env={**os.environ, "PYTHONHASHSEED": seed}, check=True)
        outputs.add(result.stdout)
    assert len(outputs) == 1
