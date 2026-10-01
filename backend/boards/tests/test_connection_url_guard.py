"""Startup guards for unparseable DATABASE_URL / REDIS_URL / REDIS_CACHE_URL.

docker-compose.prod.yml splices DB_PASSWORD and REDIS_PASSWORD into these URLs
raw, and `openssl rand -base64` (which the install docs used to recommend) puts
a "/" in about half of its outputs. Before the guard, a "/" in DB_PASSWORD
crashed the backend with a ValueError that quoted the start of the password
into the container log, and a "/" in REDIS_PASSWORD booted a backend pointed at
no host at all.

`ConnectionUrlGuardTests` below evaluates settings in a subprocess, as in
test_force_insecure_cookies.py: the guards run at import time, and the Redis
branch is skipped entirely when settings detect a test run. That subprocess
isn't instrumented by `backend/.coveragerc`, so it proves real end-to-end
behavior but doesn't register as coverage. `ConnectionUrlGuardFunctionTests`
calls the same guard logic — factored out of settings.py into
`_validate_redis_url` / `_load_database_url` for this reason — directly and
in-process, so the branches show up in coverage.xml too.
"""

import os
import subprocess
import sys
from urllib.parse import quote

from django.core.exceptions import ImproperlyConfigured
from django.test import SimpleTestCase
from redis.connection import parse_url

from visiban import settings as settings_module

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
# Channels URL on its own line: REDIS_URL_PASSWORD tests assert both.
print("CHANNELS=" + settings.CHANNEL_LAYERS["default"]["CONFIG"]["hosts"][0])
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


    # REDIS_URL_PASSWORD (#1211): the Helm chart's bundled Valkey with
    # valkey.auth.enabled passes the password separately, possibly from an
    # operator-managed Secret the chart cannot encode, and settings.py
    # percent-encodes it into both password-free URLs.
    _AUTH_PASSWORD = f"{_SECRET_FRAGMENT}/@:?#[] %+=\"'"

    def _load_with_auth_password(self, password):
        result = self._load(
            REDIS_URL="redis://valkey:6379/0",
            REDIS_CACHE_URL="redis://valkey:6379/1",
            REDIS_URL_PASSWORD=password,
        )
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        first, channels = result.stdout.strip().splitlines()[-2:]
        cache = first.split()[-1]  # "<db host> <cache LOCATION>"; sqlite has no host
        self.assertTrue(channels.startswith("CHANNELS="), msg=result.stdout)
        return cache, channels.removeprefix("CHANNELS=")

    def test_redis_url_password_is_percent_encoded_into_both_urls(self):
        cache, channels = self._load_with_auth_password(self._AUTH_PASSWORD)
        encoded = quote(self._AUTH_PASSWORD, safe="")
        self.assertEqual(cache, f"redis://:{encoded}@valkey:6379/1")
        self.assertEqual(channels, f"redis://:{encoded}@valkey:6379/0")
        # The URLs redis-py actually connects with yield the original password.
        self.assertEqual(parse_url(cache)["password"], self._AUTH_PASSWORD)
        self.assertEqual(parse_url(channels)["password"], self._AUTH_PASSWORD)

    def test_redis_url_password_with_dollar_signs_is_read_verbatim(self):
        # django-environ's env() treats a leading "$" as a reference to another
        # variable, which silently dropped such a password (completeness-check,
        # #1211). Leading, embedded, and a "$NAME" that IS a set variable.
        for password in (f"${_SECRET_FRAGMENT}/x@y", f"a$b{_SECRET_FRAGMENT}$", "$DEBUG"):
            with self.subTest(password=password):
                cache, channels = self._load_with_auth_password(password)
                self.assertEqual(parse_url(cache)["password"], password)
                self.assertEqual(parse_url(channels)["password"], password)

    def test_redis_url_password_with_credentialed_url_is_refused_without_echoing_it(self):
        result = self._load(REDIS_URL_PASSWORD=self._AUTH_PASSWORD)  # base URLs carry plainpw
        self.assertNotEqual(result.returncode, 0, msg=result.stdout)
        self.assertIn("already carries credentials", result.stderr)
        self.assertNotIn(_SECRET_FRAGMENT, result.stderr)
        self.assertNotIn("plainpw", result.stderr)


class ConnectionUrlGuardFunctionTests(SimpleTestCase):
    """In-process tests of the extracted guard functions themselves.

    See the module docstring: these exist so the branches
    ConnectionUrlGuardTests above only reaches via a subprocess also show up
    in coverage.xml. Password fixtures mirror the subprocess tests' — same
    parser, same expected outcome — so a failure here is not a difference
    in behavior between the two test styles.
    """

    databases = []

    def test_validate_redis_url_accepts_plain_and_hostless_urls(self):
        # Should not raise.
        settings_module._validate_redis_url("REDIS_URL", "redis://:plainpw@valkey:6379/0")
        settings_module._validate_redis_url("REDIS_URL", "redis:///0")

    def test_validate_redis_url_accepts_percent_encoded_password(self):
        encoded = quote(f"{_SECRET_FRAGMENT}/+=", safe="")
        settings_module._validate_redis_url("REDIS_CACHE_URL", f"redis://:{encoded}@valkey:6379/1")

    def test_validate_redis_url_rejects_reserved_chars_without_leaking(self):
        for char in "/?#":
            with self.subTest(char=char):
                url = f"redis://:{_SECRET_FRAGMENT}{char}rest@valkey:6379/0"
                with self.assertRaises(ImproperlyConfigured) as ctx:
                    settings_module._validate_redis_url("REDIS_URL", url)
                self.assertIn("REDIS_URL could not be parsed", str(ctx.exception))
                self.assertNotIn(_SECRET_FRAGMENT, str(ctx.exception))

    def test_validate_redis_url_rejects_brackets_without_leaking(self):
        url = f"redis://:Sek[{_SECRET_FRAGMENT}]x@valkey:6379/0"
        with self.assertRaises(ImproperlyConfigured) as ctx:
            settings_module._validate_redis_url("REDIS_CACHE_URL", url)
        self.assertIn("REDIS_CACHE_URL could not be parsed", str(ctx.exception))
        self.assertNotIn(_SECRET_FRAGMENT, str(ctx.exception))

    def test_load_database_url_accepts_plain_url(self):
        db_config = settings_module._load_database_url("postgres://visiban:plainpw@db:5432/visiban")
        self.assertEqual(db_config["HOST"], "db")
        self.assertTrue(db_config["ENGINE"])

    def test_load_database_url_accepts_percent_encoded_password(self):
        password = f"{_SECRET_FRAGMENT}/+=@:"
        db_config = settings_module._load_database_url(
            f"postgres://visiban:{quote(password, safe='')}@db:5432/visiban"
        )
        self.assertEqual(db_config["HOST"], "db")

    def test_load_database_url_rejects_reserved_chars_without_leaking(self):
        for char in "/?":
            with self.subTest(char=char):
                url = f"postgres://visiban:{_SECRET_FRAGMENT}{char}rest@db:5432/visiban"
                with self.assertRaises(ImproperlyConfigured) as ctx:
                    settings_module._load_database_url(url)
                self.assertIn("DATABASE_URL could not be parsed", str(ctx.exception))
                self.assertNotIn(_SECRET_FRAGMENT, str(ctx.exception))

    def test_load_database_url_rejects_schemeless_url_without_leaking(self):
        # django-environ does not raise here: it warns with the parsed config
        # dict (PASSWORD included) and returns {}. The guard must swallow
        # that warning and refuse the URL itself.
        url = f"//visiban:{_SECRET_FRAGMENT}@db/visiban"
        with self.assertRaises(ImproperlyConfigured) as ctx:
            settings_module._load_database_url(url)
        self.assertIn("DATABASE_URL could not be parsed", str(ctx.exception))
        self.assertNotIn(_SECRET_FRAGMENT, str(ctx.exception))

    def test_apply_redis_password_leaves_url_unchanged_without_a_password(self):
        url = "redis://valkey:6379/0"
        self.assertEqual(settings_module._apply_redis_password("REDIS_URL", url, ""), url)

    def test_apply_redis_password_round_trips_any_password(self):
        # "/" and "@" are the #1229 class: spliced raw, either one moves the
        # host. Every character redis-py's URL parser cares about is covered.
        for password in ("plain", f"{_SECRET_FRAGMENT}/x", "a@b", "/@:?#[] %+=\"'\\", "ü€"):
            with self.subTest(password=password):
                url = settings_module._apply_redis_password(
                    "REDIS_URL", "redis://drill-valkey-primary:6379/0", password
                )
                settings_module._validate_redis_url("REDIS_URL", url)
                parsed = parse_url(url)
                self.assertEqual(parsed["password"], password)
                self.assertEqual(parsed["host"], "drill-valkey-primary")
                self.assertEqual(parsed["port"], 6379)
                self.assertEqual(parsed["db"], 0)

    def test_apply_redis_password_refuses_a_url_with_credentials_without_leaking(self):
        for url in ("redis://:plainpw@valkey:6379/0", "redis://user:plainpw@valkey:6379/0"):
            with self.subTest(url=url):
                with self.assertRaises(ImproperlyConfigured) as ctx:
                    settings_module._apply_redis_password("REDIS_URL", url, _SECRET_FRAGMENT)
                self.assertIn("REDIS_URL already carries credentials", str(ctx.exception))
                self.assertNotIn(_SECRET_FRAGMENT, str(ctx.exception))
                self.assertNotIn("plainpw", str(ctx.exception))

    def test_apply_redis_password_refuses_a_hostless_or_unparseable_url_without_leaking(self):
        for url in ("redis:///0", "unix:///run/valkey.sock", f"redis://Sek[{_SECRET_FRAGMENT}]x:6379/0"):
            with self.subTest(url=url):
                with self.assertRaises(ImproperlyConfigured) as ctx:
                    settings_module._apply_redis_password("REDIS_CACHE_URL", url, "pw")
                self.assertIn("REDIS_CACHE_URL has no host", str(ctx.exception))
                self.assertNotIn(_SECRET_FRAGMENT, str(ctx.exception))
