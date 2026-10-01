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
        self.assertEqual(len(rows), 3, f"expected 3 benchmark rows, got: {output}")
        for endpoint, count in rows:
            self.assertGreater(int(count), 0, f"{endpoint} reported 0 queries — likely rejected before querying")

    @override_settings(DEBUG=True, ALLOWED_HOSTS=["localhost"])
    def test_restrictive_allowed_hosts_unmodified_after_command_runs(self):
        """The ALLOWED_HOSTS override inside the command must be scoped to
        its own requests, not leak "testserver" into the real setting."""
        from django.conf import settings

        call_command("benchmark", stdout=StringIO(), stderr=StringIO())
        self.assertEqual(list(settings.ALLOWED_HOSTS), ["localhost"])
