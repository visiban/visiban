"""Fail-closed guard for @pytest.mark.migrations under --nomigrations (#2490)."""

import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

from django.test import SimpleTestCase

from conftest import migrations_guard_error

BACKEND_DIR = Path(__file__).resolve().parents[2]


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


class GuardWiringTests(SimpleTestCase):
    """The conftest hook really calls the guard (a renamed hook or option would fail here)."""

    MARKED_FILE = "boards/tests/test_migration_0043_dedupe_1986.py"

    def _run(self, marker_expr):
        # Keep DATABASE_URL: settings.py requires it at import, and CI has no backend/.env to
        # fall back on. No test runs in either case (usage error / all deselected), so no DB is touched.
        env = dict(os.environ)
        return subprocess.run(  # noqa: S603 - fixed argv, no shell
            [sys.executable, "-m", "pytest", self.MARKED_FILE, "--nomigrations", "-m", marker_expr,
             "-p", "no:cacheprovider", "-q", "--no-header"],
            cwd=BACKEND_DIR, env=env, capture_output=True, text=True, timeout=240,
        )

    def test_nomigrations_with_marked_tests_is_a_usage_error(self):
        result = self._run("migrations")
        output = result.stdout + result.stderr
        self.assertEqual(result.returncode, 4, output)
        self.assertIn("migrations", output)
        self.assertIn("test_migration_0043_dedupe_1986", output)

    def test_nomigrations_with_marked_tests_deselected_passes_the_guard(self):
        result = self._run("not migrations")
        output = result.stdout + result.stderr
        self.assertNotEqual(result.returncode, 4, output)
        self.assertNotIn("test_migration_0043_dedupe_1986.py::", output)
