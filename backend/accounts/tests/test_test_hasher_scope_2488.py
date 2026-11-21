"""The fast test hasher is pytest-only and real hashing stays testable (#2488)."""

import subprocess
import sys
import unittest
from pathlib import Path

from django.contrib.auth.hashers import make_password
from django.test import SimpleTestCase, override_settings

BACKEND_DIR = Path(__file__).resolve().parents[2]
MD5 = "django.contrib.auth.hashers.MD5PasswordHasher"


class FastHasherScopeTests(SimpleTestCase):
    @unittest.skipUnless("pytest" in sys.modules, "fast hasher is configured by backend/conftest.py, pytest only")
    def test_under_pytest_the_fast_hasher_is_active(self):
        self.assertTrue(make_password("x").startswith("md5$"))

    def test_settings_module_does_not_select_md5_even_with_pytest_imported(self):
        # A production process that imported pytest must still get PBKDF2:
        # the swap lives in conftest.py, never in visiban/settings.py.
        code = (
            "import pytest, django.conf as c;"
            "from django.contrib.auth.hashers import make_password;"
            "import os; os.environ.setdefault('DJANGO_SETTINGS_MODULE','visiban.settings');"
            "h = c.settings.PASSWORD_HASHERS;"
            "assert not h or h[0] != %r, h;"
            "assert make_password('x').startswith('pbkdf2_sha256$')"
        ) % MD5
        result = subprocess.run(  # noqa: S603 - fixed argv, no shell
            [sys.executable, "-c", code],
            cwd=BACKEND_DIR,
            capture_output=True,
            text=True,
            timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    @override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.PBKDF2PasswordHasher"])
    def test_override_settings_restores_the_real_hasher(self):
        self.assertTrue(make_password("x").startswith("pbkdf2_sha256$"))
