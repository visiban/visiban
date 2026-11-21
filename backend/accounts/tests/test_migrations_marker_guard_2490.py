"""Fail-closed guard for @pytest.mark.migrations under --nomigrations (#2490)."""

from types import SimpleNamespace

from conftest import migrations_guard_error


def _item(nodeid, marked):
    return SimpleNamespace(
        nodeid=nodeid,
        get_closest_marker=lambda name: object() if marked and name == "migrations" else None,
    )


def test_guard_errors_when_marked_test_runs_without_migrations():
    msg = migrations_guard_error([_item("a::t", True), _item("b::t", False)], True)
    assert msg is not None and "a::t" in msg and "b::t" not in msg


def test_guard_silent_when_migrations_enabled():
    assert migrations_guard_error([_item("a::t", True)], False) is None


def test_guard_silent_when_marked_tests_deselected():
    assert migrations_guard_error([_item("b::t", False)], True) is None


def test_guard_truncates_long_lists():
    msg = migrations_guard_error([_item(f"n{i}", True) for i in range(5)], True)
    assert "5 test(s)" in msg and " ..." in msg
