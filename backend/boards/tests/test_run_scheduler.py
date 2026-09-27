"""Tests for the run_scheduler management command (#1157).

The Compose `scheduler` service runs this; Helm uses native CronJobs. Covered:
1. Env parsing — defaults, HH:MM, 'off', invalid values fail loudly
2. Scheduler.tick — runs a job once per day at/after its time, no catch-up on
   start, next-day rerun
3. A failing job is logged and does not stop the other jobs
4. Connections are recycled around every job (long-lived process)
5. handle() — refuses an all-off config, runs the loop until stopped
"""

import datetime
from io import StringIO
from unittest import mock

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import SimpleTestCase

from boards.management.commands import run_scheduler
from boards.management.commands.run_scheduler import Job, Scheduler, load_jobs

UTC = datetime.timezone.utc


def _at(day, hh, mm=0):
    return datetime.datetime(2026, 9, day, hh, mm, tzinfo=UTC)


class LoadJobsTest(SimpleTestCase):
    def test_defaults_enable_only_the_notify_jobs(self):
        jobs = load_jobs({})
        self.assertEqual(
            [(j.command, j.at) for j in jobs],
            [
                ("notify_due_soon", datetime.time(7, 0)),
                ("notify_stale_cards", datetime.time(8, 0)),
            ],
        )

    def test_prune_jobs_are_opt_in(self):
        jobs = load_jobs({"SCHEDULE_PRUNE_NOTIFICATIONS": "03:30"})
        self.assertIn(("prune_notifications", datetime.time(3, 30)), [(j.command, j.at) for j in jobs])
        self.assertNotIn("prune_board_events", [j.command for j in jobs])

    def test_off_disables_a_default_job(self):
        for value in ("off", "OFF", "", " false "):
            with self.subTest(value=value):
                jobs = load_jobs({"SCHEDULE_NOTIFY_DUE_SOON": value})
                self.assertNotIn("notify_due_soon", [j.command for j in jobs])

    def test_invalid_time_fails_loudly(self):
        for value in ("7am", "25:00", "07:61", "07"):
            with self.subTest(value=value):
                with self.assertRaisesMessage(CommandError, "SCHEDULE_NOTIFY_DUE_SOON"):
                    load_jobs({"SCHEDULE_NOTIFY_DUE_SOON": value})


class SchedulerTickTest(SimpleTestCase):
    def setUp(self):
        self.ran = []
        self.jobs = [Job("a", datetime.time(7, 0)), Job("b", datetime.time(8, 0))]

    def _scheduler(self, start):
        return Scheduler(self.jobs, start, lambda job: self.ran.append(job.command))

    def test_runs_each_job_once_at_its_time(self):
        s = self._scheduler(_at(1, 6))
        s.tick(_at(1, 6, 59))
        self.assertEqual(self.ran, [])
        s.tick(_at(1, 7, 0))
        s.tick(_at(1, 7, 30))
        self.assertEqual(self.ran, ["a"])
        s.tick(_at(1, 8, 1))
        self.assertEqual(self.ran, ["a", "b"])

    def test_no_catch_up_for_times_already_passed_at_start(self):
        s = self._scheduler(_at(1, 7, 30))
        s.tick(_at(1, 7, 31))
        s.tick(_at(1, 8, 0))
        self.assertEqual(self.ran, ["b"])  # 'a' waits for tomorrow

    def test_runs_again_the_next_day(self):
        s = self._scheduler(_at(1, 9))
        s.tick(_at(1, 23, 59))
        self.assertEqual(self.ran, [])
        s.tick(_at(2, 7, 0))
        s.tick(_at(2, 8, 0))
        self.assertEqual(self.ran, ["a", "b"])

    def test_late_tick_still_runs_the_job_that_day(self):
        # A poll that oversleeps past the minute (host suspend, GC pause) must
        # not skip the day — the job runs on the first tick at or after its time.
        s = self._scheduler(_at(1, 6))
        s.tick(_at(1, 10))
        self.assertEqual(self.ran, ["a", "b"])


class RunJobTest(SimpleTestCase):
    def test_failing_job_is_reported_and_others_still_run(self):
        cmd = run_scheduler.Command(stdout=StringIO(), stderr=StringIO())
        calls = []

        def fake_call(name, **kwargs):
            calls.append(name)
            if name == "a":
                raise RuntimeError("boom")

        with mock.patch.object(run_scheduler, "call_command", side_effect=fake_call), \
                mock.patch.object(run_scheduler, "close_old_connections") as close:
            s = Scheduler(
                [Job("a", datetime.time(7)), Job("b", datetime.time(7))],
                _at(1, 6),
                cmd._run_job,
            )
            s.tick(_at(1, 7))

        self.assertEqual(calls, ["a", "b"])
        self.assertIn("scheduled job a FAILED", cmd.stderr._out.getvalue())
        self.assertIn("boom", cmd.stderr._out.getvalue())
        self.assertIn("finished b", cmd.stdout._out.getvalue())
        # Before and after each of the two jobs, including the failed one.
        self.assertEqual(close.call_count, 4)


class _StopAfter:
    """Stands in for threading.Event: wait() reports 'stopped' after N polls."""

    def __init__(self, polls):
        self.polls = polls

    def set(self):
        self.polls = 0

    def wait(self, timeout):
        self.polls -= 1
        return self.polls <= 0


class HandleTest(SimpleTestCase):
    def test_all_jobs_off_is_refused(self):
        env = {
            "SCHEDULE_NOTIFY_DUE_SOON": "off",
            "SCHEDULE_NOTIFY_STALE_CARDS": "off",
        }
        with mock.patch.dict("os.environ", env):
            with self.assertRaisesMessage(CommandError, "switched off"):
                call_command("run_scheduler", stdout=StringIO())

    def test_poll_seconds_must_be_positive(self):
        with self.assertRaisesMessage(CommandError, "--poll-seconds"):
            call_command("run_scheduler", "--poll-seconds", "0", stdout=StringIO())

    def test_loop_ticks_until_stopped_and_runs_due_jobs(self):
        env = {"SCHEDULE_NOTIFY_DUE_SOON": "07:00", "SCHEDULE_NOTIFY_STALE_CARDS": "off"}
        # First _now() builds the scheduler at 06:00; the three ticks straddle
        # 07:00, and the job must fire exactly once across them.
        times = iter([_at(1, 6), _at(1, 6, 59), _at(1, 7), _at(1, 7, 1)])
        out = StringIO()
        with mock.patch.dict("os.environ", env), \
                mock.patch.object(run_scheduler.threading, "Event", return_value=_StopAfter(3)), \
                mock.patch.object(run_scheduler.signal, "signal"), \
                mock.patch.object(run_scheduler.Command, "_now", side_effect=lambda: next(times)), \
                mock.patch.object(run_scheduler, "call_command") as call, \
                mock.patch.object(run_scheduler, "close_old_connections"):
            call_command("run_scheduler", stdout=out)

        self.assertEqual([c.args[0] for c in call.call_args_list], ["notify_due_soon"])
        self.assertIn("scheduled notify_due_soon daily at 07:00 UTC", out.getvalue())
        self.assertIn("scheduler stopped", out.getvalue())
