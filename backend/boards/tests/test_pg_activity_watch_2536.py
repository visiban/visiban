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

    def test_idle_in_transaction_past_both_thresholds_is_not_stuck(self):
        row = _row(state="idle in transaction", query_age=9999, wait_event_type="Lock")
        self.assertFalse(watch.is_stuck(row))

    def test_active_row_past_threshold_is_stuck(self):
        self.assertTrue(watch.is_stuck(_row(state="active", query_age=120)))

    def test_should_report_dedupes_on_pid_and_query_start(self):
        row = _row(query_age=120)
        reported = {(10, "t1")}
        self.assertFalse(watch.should_report(row, reported))
        self.assertTrue(watch.should_report(_row(query_age=120, query_start="t2"), reported))
        self.assertTrue(watch.should_report(row, set()))
        self.assertFalse(watch.should_report(_row(query_age=1), set()))

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


class PlanOnCpuStallTests(SimpleTestCase):
    """The first CI report was active with no wait event and no blockers: not a
    lock. For that case the watcher EXPLAINs the stuck statement (#2536)."""

    def test_cpu_stall_wants_a_plan(self):
        self.assertTrue(watch.wants_plan(_row(query_age=120)))

    def test_lock_wait_does_not_want_a_plan(self):
        self.assertFalse(watch.wants_plan(_row(wait_event_type="Lock", wait_event="relation", blockers=[7])))

    def test_blocked_without_wait_event_does_not_want_a_plan(self):
        self.assertFalse(watch.wants_plan(_row(blockers=[7])))

    def test_idle_backend_does_not_want_a_plan(self):
        self.assertFalse(watch.wants_plan(_row(state="idle in transaction")))

    def test_only_a_single_select_is_explainable(self):
        self.assertEqual(watch.explainable('  SELECT "a"."id" FROM "a" ;'), 'SELECT "a"."id" FROM "a"')
        self.assertIsNone(watch.explainable('UPDATE "a" SET "x" = 1'))
        self.assertIsNone(watch.explainable("SELECT 1; DROP TABLE a"))
        self.assertIsNone(watch.explainable(None))
        self.assertIsNone(watch.explainable("WITH x AS (DELETE FROM a RETURNING 1) SELECT * FROM x"))

    def test_table_names_reads_from_and_join_targets(self):
        sql = (
            'SELECT 1 FROM "card_parent_links" INNER JOIN "cards" ON (1=1) '
            'LEFT OUTER JOIN "groups" ON (1=1) LEFT OUTER JOIN "groups" T9 ON (1=1) '
            'WHERE EXISTS (SELECT 1 FROM "card_movements" U0)'
        )
        self.assertEqual(watch.table_names(sql), ["card_movements", "card_parent_links", "cards", "groups"])

    def test_plan_section_names_time_cost_jit_and_stats(self):
        text = watch.format_plan(
            ["Nested Loop  (cost=0.00..900000.00 rows=1 width=8)"], 0.25,
            {"jit": "on", "above": "100000", "optimize": "500000", "inline": "500000"},
            [{"relname": "cards", "reltuples": 10, "relpages": 1, "curpages": 400, "n_live_tup": 10,
              "n_dead_tup": 9000, "last_autoanalyze": None, "last_analyze": None, "last_autovacuum": None}],
        )
        self.assertIn("EXPLAIN (plan only) took 0.250s", text)
        self.assertIn("plan| Nested Loop  (cost=0.00..900000.00", text)
        self.assertIn("jit=on above_cost=100000", text)
        self.assertIn("stats: cards reltuples=10 relpages=1 curpages=400 live=10 dead=9000", text)
        for line in text.splitlines():
            self.assertTrue(line.startswith(watch.PREFIX), line)

    def test_failed_explain_reports_elapsed_time_and_error_class_only(self):
        text = watch.format_plan([], 60.0, None, [], error="QueryCanceled")
        self.assertEqual(text, f"{watch.PREFIX} plan: EXPLAIN failed after 60.0s: QueryCanceled")

    def test_database_dsn_swaps_only_the_database(self):
        self.assertEqual(
            watch.database_dsn("postgres://u:p@h:5432/visiban", "test_visiban"), "postgres://u:p@h:5432/test_visiban",
        )

    def test_plan_report_skips_a_write_without_connecting(self):
        self.assertIn("skipped", watch.plan_report("postgres://u:p@nowhere.invalid/x", _row(query="DELETE FROM a")))
