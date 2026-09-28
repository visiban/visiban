"""Startup guards for unparseable DATABASE_URL / REDIS_URL / REDIS_CACHE_URL.

docker-compose.prod.yml splices DB_PASSWORD and REDIS_PASSWORD into these URLs
raw, and `openssl rand -base64` (which the install docs used to recommend) puts
a "/" in about half of its outputs. Before the guard, a "/" in DB_PASSWORD
crashed the backend with a ValueError that quoted the start of the password
into the container log, and a "/" in REDIS_PASSWORD booted a backend pointed at
no host at all.

Settings are evaluated in a subprocess, as in test_force_insecure_cookies.py:
the guards run at import time, and the Redis branch is skipped entirely when
settings detect a test run.
"""

import os
import subprocess
import sys
from urllib.parse import quote

from django.test import SimpleTestCase

_SECRET_FRAGMENT = "Sekrit9"

_BASE_ENV = {
    "DEBUG": "false",
    "CORS_ALLOWED_ORIGINS": "https://boards.example.com",
    "DJANGO_SECRET_KEY": "test-secret-key-not-change-me-in-production",
    "ALLOWED_HOSTS": "boards.example.com",
    "DATABASE_URL": "sqlite:///dev.db",
    "DEFAULT_FROM_EMAIL": "noreply@visiban.test",
    "REDIS_URL": "redis://:plainpw@valkey:6379/0",
    "REDIS_CACHE_URL": "redis://:plainpw@valkey:6379/1",
}

_SETTINGS_SCRIPT = """\
import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "visiban.settings")
import django
django.setup()
from django.conf import settings
print(settings.DATABASES["default"]["HOST"], settings.CACHES["default"]["LOCATION"])
"""


class ConnectionUrlGuardTests(SimpleTestCase):
    databases = []

    def _load(self, **overrides):
        backend_dir = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
        env = {**_BASE_ENV, **overrides, "PYTHONPATH": backend_dir}
        return subprocess.run(
            [sys.executable, "-c", _SETTINGS_SCRIPT],
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )

    def _assert_refused_without_leak(self, result, name):
        self.assertNotEqual(result.returncode, 0, msg=result.stdout)
        self.assertIn("ImproperlyConfigured", result.stderr)
        self.assertIn(f"{name} could not be parsed", result.stderr)
        self.assertNotIn(_SECRET_FRAGMENT, result.stderr)

    def test_reserved_chars_in_database_password_never_echo_it(self):
        for char in "/@:?#":
            with self.subTest(char=char):
                result = self._load(
                    DATABASE_URL=f"postgres://visiban:{_SECRET_FRAGMENT}{char}rest@db:5432/visiban"
                )
                if char in "/?":
                    self._assert_refused_without_leak(result, "DATABASE_URL")
                else:
                    # These do not break the port parse (":" and "@" even
                    # round-trip, since the parser splits on the first ":" and
                    # the last "@"). Whether one fails at import or at connect
                    # time, the password must never reach the log.
                    self.assertNotIn(_SECRET_FRAGMENT, result.stderr)

    def test_brackets_in_database_password_never_echo_it(self):
        result = self._load(
            DATABASE_URL=f"postgres://visiban:Sek[{_SECRET_FRAGMENT}]x@db:5432/visiban"
        )
        self.assertNotIn(_SECRET_FRAGMENT, result.stderr)

    def test_schemeless_database_url_is_refused_without_echoing_config(self):
        # django-environ does not raise here: it warns with the parsed config
        # dict (PASSWORD included) and returns {}. The guard must swallow that
        # warning and refuse the URL itself.
        result = self._load(DATABASE_URL=f"//visiban:{_SECRET_FRAGMENT}@db/visiban")
        self._assert_refused_without_leak(result, "DATABASE_URL")

    def test_percent_encoded_database_password_is_accepted(self):
        password = f"{_SECRET_FRAGMENT}/+=@:"
        result = self._load(
            DATABASE_URL=f"postgres://visiban:{quote(password, safe='')}@db:5432/visiban"
        )
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertTrue(result.stdout.startswith("db "), msg=result.stdout)

    def test_reserved_chars_in_redis_password_fail_closed_without_echoing_it(self):
        passwords = {
            "/": f"{_SECRET_FRAGMENT}/rest",
            "?": f"{_SECRET_FRAGMENT}?rest",
            "#": f"{_SECRET_FRAGMENT}#rest",
            # urlparse validates "[...]" as an IPv6 literal and its ValueError
            # quotes the bracketed text.
            "[]": f"Sek[{_SECRET_FRAGMENT}]x",
        }
        for name in ("REDIS_URL", "REDIS_CACHE_URL"):
            for label, password in passwords.items():
                with self.subTest(name=name, char=label):
                    result = self._load(**{name: f"redis://:{password}@valkey:6379/0"})
                    self._assert_refused_without_leak(result, name)

    def test_percent_encoded_redis_password_is_accepted(self):
        encoded = quote(f"{_SECRET_FRAGMENT}/+=", safe="")
        result = self._load(REDIS_CACHE_URL=f"redis://:{encoded}@valkey:6379/1")
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn("@valkey:6379/1", result.stdout)

    def test_hostless_redis_url_still_loads(self):
        # redis-py treats a missing host as localhost; the guard must not
        # reject a URL that booted before it existed.
        result = self._load(REDIS_URL="redis:///0", REDIS_CACHE_URL="redis:///1")
        self.assertEqual(result.returncode, 0, msg=result.stderr)

    def test_plain_urls_still_load(self):
        result = self._load()
        self.assertEqual(result.returncode, 0, msg=result.stderr)
