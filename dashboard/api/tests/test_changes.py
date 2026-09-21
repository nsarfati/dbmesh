from dbmesh_dashboard.audit import compute_changes, decode_cursor, encode_cursor, InvalidCursor
from datetime import datetime, timezone
import pytest


def test_update_lists_only_changed_fields():
    changes = compute_changes("UPDATE", {"id": 1, "plan": "free", "name": "Ada"}, {"id": 1, "plan": "pro", "name": "Ada"})
    assert changes == [{"field": "plan", "before": "free", "after": "pro"}]


def test_insert_and_delete_list_every_field():
    assert compute_changes("INSERT", None, {"id": 1, "name": "Ada"}) == [
        {"field": "id", "before": None, "after": 1}, {"field": "name", "before": None, "after": "Ada"}]
    assert compute_changes("DELETE", {"id": 1}, None) == [{"field": "id", "before": 1, "after": None}]


def test_update_handles_added_and_removed_keys_and_nested_values():
    changes = compute_changes("UPDATE", {"a": 1, "meta": {"x": 1}}, {"b": 2, "meta": {"x": 2}})
    assert {c["field"] for c in changes} == {"a", "b", "meta"}


def test_cursor_round_trip_and_rejection():
    created = datetime(2026, 9, 21, 20, 24, 30, 123456, tzinfo=timezone.utc)
    assert decode_cursor(encode_cursor(created, "abc")) == (created, "abc")
    for junk in ("", "%%%", "bm9waXBl"):
        with pytest.raises(InvalidCursor):
            decode_cursor(junk)
