"""VISIBAN_DISABLE_THROTTLING: the CI-only schema-fuzz throttle switch (#1569).

Settings are evaluated in a subprocess (same pattern as test_proxy_depth.py):
reloading settings in-process would re-evaluate DATABASES.
"""

import json
import os
import subprocess
import sys

from django.test import SimpleTestCase

_BASE_ENV = {
    "DJANGO_SECRET_KEY": "test-secret-key-not-change-me-in-production",
    "DATABASE_URL": "sqlite:///dev.db",
}

_SCRIPT = """\
import json, os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "visiban.settings")
import django
django.setup()
from django.conf import settings
print(json.dumps({
    "RATES": settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"],
    "CLASSES": settings.REST_FRAMEWORK["DEFAULT_THROTTLE_CLASSES"],
    "ACCOUNT_RATE_LIMITS": settings.ACCOUNT_RATE_LIMITS,
}))
"""


class DisableThrottlingSettingsTests(SimpleTestCase):
    databases = []

    def _eval(self, **overrides):
        env = {
            **_BASE_ENV,
            **overrides,
            "PATH": os.environ.get("PATH", ""),
            "PYTHONPATH": os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
        }
        result = subprocess.run(
            [sys.executable, "-c", _SCRIPT], env=env, capture_output=True, text=True, timeout=60
        )
        if result.returncode != 0:
            return None, result.stderr
        return json.loads(result.stdout.strip().splitlines()[-1]), None

    def test_production_defaults_unchanged_when_unset(self):
        values, err = self._eval(DEBUG="false", ALLOWED_HOSTS="localhost", CORS_ALLOWED_ORIGINS="https://x.example")
        self.assertIsNone(err, err)
        self.assertEqual(values["RATES"]["anon"], "300/hour")
        self.assertEqual(values["RATES"]["user"], "5000/hour")
        self.assertEqual(values["RATES"]["share_link"], "120/hour")
        self.assertEqual(values["RATES"]["login"], "20/hour")
        self.assertEqual(values["ACCOUNT_RATE_LIMITS"], {"login_failed": "10/m/ip,5/300s/key"})

    def test_debug_without_override_keeps_share_link_limits(self):
        values, err = self._eval(DEBUG="true")
        self.assertIsNone(err, err)
        self.assertEqual(values["RATES"]["user"], "9999/hour")
        self.assertEqual(values["RATES"]["share_link"], "120/hour")

    def test_override_lifts_every_scope_with_debug(self):
        values, err = self._eval(DEBUG="true", VISIBAN_DISABLE_THROTTLING="true")
        self.assertIsNone(err, err)
        self.assertTrue(values["RATES"])
        for scope, rate in values["RATES"].items():
            self.assertEqual(rate, "1000000/second", scope)
        self.assertEqual(values["ACCOUNT_RATE_LIMITS"], {"login_failed": False})
        # Throttle classes stay wired; only the rates change.
        self.assertEqual(len(values["CLASSES"]), 2)

    def test_override_refuses_to_boot_without_debug(self):
        values, err = self._eval(
            DEBUG="false",
            VISIBAN_DISABLE_THROTTLING="true",
            ALLOWED_HOSTS="localhost",
            CORS_ALLOWED_ORIGINS="https://x.example",
        )
        self.assertIsNone(values)
        self.assertIn("VISIBAN_DISABLE_THROTTLING", err)
