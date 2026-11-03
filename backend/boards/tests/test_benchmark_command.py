"""Tests for the ``benchmark`` management command (#1330).

Covers the two failure modes that previously let the command silently report
a false "✅ OK": a non-2xx response from the endpoint under test, and a
restrictive ``ALLOWED_HOSTS`` rejecting the test client's default
``Host: testserver`` header before any query ran.
"""
import re
from io import StringIO
from unittest import mock

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase, override_settings


@override_settings(DEBUG=True)
class BenchmarkCommandHardFailureTests(TestCase):
    """A non-2xx response must hard-fail, not report "0 queries ✅ OK"."""

    def test_non_2xx_response_raises_command_error(self):
        fake_response = mock.Mock(
            status_code=400,
            content=b'{"detail": "Invalid HTTP_HOST header"}',
        )
        with mock.patch("rest_framework.test.APIClient.get", return_value=fake_response):
            with self.assertRaises(CommandError):
                call_command("benchmark", stdout=StringIO(), stderr=StringIO())

    def test_non_2xx_response_never_reported_as_ok(self):
        """Even if CommandError weren't raised, confirm the failing request
        never reaches the "✅ OK" row — belt-and-suspenders on the regression
        this issue describes (budget verdict printed from a bogus 0 count)."""
        fake_response = mock.Mock(status_code=400, content=b"bad request")
        out, err = StringIO(), StringIO()
        with mock.patch("rest_framework.test.APIClient.get", return_value=fake_response):
            with self.assertRaises(CommandError):
                call_command("benchmark", stdout=out, stderr=err)
        # The command must never have printed a success row for full/ or
        # summary/ before raising.
        self.assertNotIn("full/: 0 queries", out.getvalue())
        self.assertNotIn("✅  GET /api/boards/{id}/full/", out.getvalue())


class BenchmarkUserActionLogExceptionTests(TestCase):
    """#1801: documented exception to the admin action log.

    ``benchmark`` requires DEBUG and creates a throwaway ``bench_user`` with a
    random password that is never shown, so it writes no ``user.password_set``
    entry. See the "Benchmark user password" row of
    docs/development/security-invariants.md.
    """

    @override_settings(DEBUG=True)
    def test_bench_user_password_set_is_not_in_the_admin_action_log(self):
        from accounts.models import AdminActionLog

        call_command("benchmark", stdout=StringIO(), stderr=StringIO())
        self.assertFalse(
            AdminActionLog.objects.filter(
                action=AdminActionLog.Action.USER_PASSWORD_SET
            ).exists()
        )


class BenchmarkCommandAllowedHostsTests(TestCase):
    """The command must work under a restrictive ALLOWED_HOSTS, matching the
    dev container's ``ALLOWED_HOSTS=localhost,127.0.0.1`` (no "testserver")."""

    @override_settings(DEBUG=True, ALLOWED_HOSTS=["localhost"])
    def test_succeeds_with_restrictive_allowed_hosts(self):
        out, err = StringIO(), StringIO()
        call_command("benchmark", stdout=out, stderr=err)

        output = out.getvalue()
        self.assertNotIn("DisallowedHost", err.getvalue())
        self.assertNotIn("DisallowedHost", output)

        # Every endpoint row must report a real (non-zero) query count —
        # this is the exact false-pass the issue describes: a rejected
        # request reports "0 queries ✅ OK" instead of running the view.
        rows = re.findall(r"(GET /api/boards/\{id\}/\S+): (\d+) queries", output)
        self.assertEqual(len(rows), 8, f"expected 8 benchmark rows, got: {output}")
        for endpoint, count in rows:
            self.assertGreater(int(count), 0, f"{endpoint} reported 0 queries — likely rejected before querying")

    @override_settings(DEBUG=True, ALLOWED_HOSTS=["localhost"])
    def test_restrictive_allowed_hosts_unmodified_after_command_runs(self):
        """The ALLOWED_HOSTS override inside the command must be scoped to
        its own requests, not leak "testserver" into the real setting."""
        from django.conf import settings

        call_command("benchmark", stdout=StringIO(), stderr=StringIO())
        self.assertEqual(list(settings.ALLOWED_HOSTS), ["localhost"])


class BenchmarkCommandCiGateTests(TestCase):
    """The ``backend-benchmark`` CI job relies on these exit behaviors (#1341)."""

    @override_settings(DEBUG=False)
    def test_debug_off_hard_fails_instead_of_silent_pass(self):
        with self.assertRaises(CommandError):
            call_command("benchmark", "--fail-on-budget", stdout=StringIO(), stderr=StringIO())

    @override_settings(DEBUG=True, ALLOWED_HOSTS=["localhost"])
    def test_budget_overrun_exits_nonzero_with_fail_on_budget(self):
        from boards.management.commands import benchmark as bm

        real = bm.Command._bench_cards

        def over(self_, factory, user, board):
            name, _count, budget = real(self_, factory, user, board)
            return name, budget + 1, budget

        with mock.patch.object(bm.Command, "_bench_cards", over):
            with self.assertRaises(SystemExit) as ctx:
                call_command("benchmark", "--fail-on-budget", stdout=StringIO(), stderr=StringIO())
        self.assertEqual(ctx.exception.code, 1)

    @override_settings(DEBUG=True, ALLOWED_HOSTS=["localhost"])
    def test_within_budget_passes_with_fail_on_budget(self):
        call_command("benchmark", "--fail-on-budget", stdout=StringIO(), stderr=StringIO())

    @override_settings(DEBUG=True, ALLOWED_HOSTS=["localhost"])
    def test_non_2xx_hard_fails_with_fail_on_budget(self):
        """The exact CI invocation must still raise, not exit 0, on a 4xx."""
        fake = mock.Mock(status_code=403, content=b"forbidden")
        with mock.patch("rest_framework.test.APIClient.get", return_value=fake):
            with self.assertRaises(CommandError):
                call_command("benchmark", "--fail-on-budget", stdout=StringIO(), stderr=StringIO())


class BenchmarkFixtureTests(TestCase):
    """The replay endpoints can only be guarded on a fixture with real history (#448)."""

    def test_fixture_gives_the_replay_completions_work_in_progress_and_reopens(self):
        from boards.management.commands.benchmark import Command
        from boards.services import flow_metrics as fm

        command = Command(stdout=StringIO())
        _user, board = command._seed()
        flow = fm.load_board_flow(board)
        self.assertEqual(len(flow.cards), 100)
        self.assertTrue(all(card.complete_history for card in flow.cards))
        self.assertGreater(sum(1 for card in flow.cards if card.completion_at), 0)
        self.assertGreater(sum(1 for card in flow.cards if card.cycle_start), 0)
        self.assertGreater(sum(1 for card in flow.cards if card.reopens), 0)
        self.assertGreater(sum(1 for card in flow.cards if card.is_in_progress(flow.done_uids)), 0)
