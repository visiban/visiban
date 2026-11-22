"""#2536: the CI Postgres activity watcher's pure threshold and report logic."""

import importlib.util
from pathlib import Path

from django.test import SimpleTestCase

_PATH = Path(__file__).resolve().parents[3] / "scripts" / "pg-activity-watch.py"
_spec = importlib.util.spec_from_file_location("pg_activity_watch", _PATH)
watch = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(watch)


def _row(**kw):
    base = {
        "pid": 10, "datname": "test_db", "state": "active", "wait_event_type": None,
        "wait_event": None, "xact_start": "t0", "query_start": "t1",
        "query": "SELECT 1", "query_age": 5.0, "blockers": [],
    }
    return {**base, **kw}


class IsStuckTests(SimpleTestCase):
    def test_fresh_active_query_is_not_stuck(self):
        self.assertFalse(watch.is_stuck(_row()))

    def test_long_running_active_query_is_stuck(self):
        self.assertTrue(watch.is_stuck(_row(query_age=91)))

    def test_idle_backend_is_never_stuck_however_old(self):
        self.assertFalse(watch.is_stuck(_row(state="idle", query_age=9999)))

    def test_idle_in_transaction_over_threshold_is_stuck(self):
        self.assertTrue(watch.is_stuck(_row(state="idle in transaction", query_age=120)))

    def test_lock_wait_threshold_is_sixty_seconds(self):
        self.assertFalse(watch.is_stuck(_row(wait_event_type="Lock", query_age=59)))
        self.assertTrue(watch.is_stuck(_row(wait_event_type="Lock", query_age=61)))

    def test_missing_query_age_is_not_stuck(self):
        self.assertFalse(watch.is_stuck(_row(query_age=None)))


class FormatReportTests(SimpleTestCase):
    def test_report_names_blocker_and_locks(self):
        stuck = _row(wait_event_type="Lock", wait_event="relation", blockers=[77], query_age=100)
        blocker = _row(pid=77, state="idle in transaction", query="UPDATE cards SET x = 1")
        lock = {"pid": 10, "locktype": "relation", "mode": "AccessShareLock", "granted": False, "relname": "cards"}
        text = watch.format_report(stuck, [blocker], [lock])
        self.assertTrue(all(line.startswith("[pg-activity-watch]") for line in text.splitlines()))
        self.assertIn("blocked by pids: [77]", text)
        self.assertIn("pid=77", text)
        self.assertIn("idle in transaction", text)
        self.assertIn("granted=False relation=cards", text)

    def test_query_is_truncated_and_collapsed(self):
        text = watch.describe(_row(query="SELECT\n" + "x" * 2000))
        self.assertLess(len(text), 800)
        self.assertNotIn("\n", text)

    def test_no_blockers_says_not_a_lock_wait(self):
        self.assertIn("not a lock wait", watch.format_report(_row(), [], []))

    def test_maintenance_dsn_swaps_database_keeps_credentials(self):
        out = watch.maintenance_dsn("postgres://u:p@postgres:5432/ci_db")
        self.assertEqual(out, "postgres://u:p@postgres:5432/postgres")
