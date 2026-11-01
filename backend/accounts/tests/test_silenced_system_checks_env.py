"""SILENCED_SYSTEM_CHECKS is populated from the environment (#1698).

Settings are evaluated in a subprocess (same pattern as test_proxy_depth.py):
reloading settings in-process would re-evaluate DATABASES and break later tests.
"""

import json
import os
import subprocess
import sys

from django.test import SimpleTestCase

_BASE_ENV = {
    "DEBUG": "true",
    "DJANGO_SECRET_KEY": "test-secret-key-not-change-me-in-production",
    "DATABASE_URL": "sqlite:///dev.db",
}

_SCRIPT = """\
import json, os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "visiban.settings")
import django
django.setup()
from django.conf import settings
print(json.dumps(settings.SILENCED_SYSTEM_CHECKS))
"""


class SilencedSystemChecksEnvTests(SimpleTestCase):
    databases = []

    def _eval(self, extra):
        env = {
            **_BASE_ENV,
            **extra,
            "PATH": os.environ.get("PATH", ""),
            "PYTHONPATH": os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
        }
        result = subprocess.run(
            [sys.executable, "-c", _SCRIPT], env=env, capture_output=True, text=True, timeout=60
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout.strip().splitlines()[-1])

    def test_default_is_empty(self):
        self.assertEqual(self._eval({}), [])

    def test_empty_value_is_empty(self):
        self.assertEqual(self._eval({"SILENCED_SYSTEM_CHECKS": ""}), [])

    def test_comma_separated_ids(self):
        self.assertEqual(
            self._eval({"SILENCED_SYSTEM_CHECKS": "accounts.W001,accounts.W002"}),
            ["accounts.W001", "accounts.W002"],
        )

    def test_whitespace_and_blank_entries_are_dropped(self):
        self.assertEqual(
            self._eval({"SILENCED_SYSTEM_CHECKS": " accounts.W001 , ,accounts.W002,"}),
            ["accounts.W001", "accounts.W002"],
        )
