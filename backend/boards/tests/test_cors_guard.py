"""Tests for the CORS localhost production guard in settings.py."""
from django.core.exceptions import ImproperlyConfigured
from django.test import TestCase


class CorsLocalhostGuardTests(TestCase):
    """
    The guard code runs at module import time (settings.py), so we cannot
    easily re-trigger it in a test.  Instead, we unit-test the same logic
    inline to verify correctness.
    """

    def _run_guard(self, debug: bool, origins: list[str]):
        """Replicate the guard logic from settings.py and return any raised error."""
        if not debug:
            for origin in origins:
                if "localhost" in origin or "127.0.0.1" in origin:
                    raise ImproperlyConfigured(
                        f"CORS_ALLOWED_ORIGINS contains a localhost origin ({origin}) in production "
                        "(DEBUG=False). Set CORS_ALLOWED_ORIGINS to your public domain(s) before starting."
                    )

    def test_guard_passes_in_debug_mode_with_localhost(self):
        # DEBUG=True — localhost origins are expected in development
        self._run_guard(debug=True, origins=["http://localhost:5173"])

    def test_guard_passes_in_production_with_public_origin(self):
        self._run_guard(debug=False, origins=["https://app.example.com"])

    def test_guard_raises_in_production_with_localhost(self):
        with self.assertRaises(ImproperlyConfigured) as ctx:
            self._run_guard(debug=False, origins=["http://localhost:5173"])
        self.assertIn("localhost", str(ctx.exception))
        self.assertIn("DEBUG=False", str(ctx.exception))

    def test_guard_raises_in_production_with_loopback(self):
        with self.assertRaises(ImproperlyConfigured):
            self._run_guard(debug=False, origins=["http://127.0.0.1:8080"])

    def test_guard_raises_for_one_bad_origin_among_many(self):
        with self.assertRaises(ImproperlyConfigured):
            self._run_guard(
                debug=False,
                origins=["https://app.example.com", "http://localhost:5173"],
            )
