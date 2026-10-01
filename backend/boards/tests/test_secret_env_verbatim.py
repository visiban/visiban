"""A `$`-leading secret reaches its setting unchanged (#1362).

django-environ's `env()` treats a value starting with `$` as a reference to
another variable. Each test evaluates settings in a subprocess (reloading
settings in-process would break the test runner's DB connection).
"""

import json
import os
import subprocess
import sys

from django.test import SimpleTestCase

_BASE_ENV = {
    "DEBUG": "false",
    "CORS_ALLOWED_ORIGINS": "https://boards.example.com",
    "DJANGO_SECRET_KEY": "test-secret-key-not-change-me-in-production",
    "ALLOWED_HOSTS": "boards.example.com",
    "DATABASE_URL": "sqlite:///dev.db",
    "DEFAULT_FROM_EMAIL": "noreply@visiban.test",
}

_SCRIPT = """\
import json, os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "visiban.settings")
import django
django.setup()
from django.conf import settings
p = settings.SOCIALACCOUNT_PROVIDERS
print(json.dumps({
    "SECRET_KEY": settings.SECRET_KEY,
    "EMAIL_HOST_PASSWORD": settings.EMAIL_HOST_PASSWORD,
    "DEMO_ADMIN_PASSWORD": settings.DEMO_ADMIN_PASSWORD,
    "DEMO_MEMBER_PASSWORD": settings.DEMO_MEMBER_PASSWORD,
    "GOOGLE_CLIENT_ID": p["google"]["APP"]["client_id"],
    "GOOGLE_CLIENT_SECRET": p["google"]["APP"]["secret"],
    "GITHUB_CLIENT_ID": p["github"]["APP"]["client_id"],
    "GITHUB_CLIENT_SECRET": p["github"]["APP"]["secret"],
    "GITLAB_CLIENT_ID": p["gitlab"]["APP"]["client_id"],
    "GITLAB_CLIENT_SECRET": p["gitlab"]["APP"]["secret"],
    "OIDC_CLIENT_ID": p["openid_connect"]["APPS"][0]["client_id"],
    "OIDC_CLIENT_SECRET": p["openid_connect"]["APPS"][0]["secret"],
}))
"""

_SECRET_VARS = [
    "DJANGO_SECRET_KEY",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "GITLAB_CLIENT_ID",
    "GITLAB_CLIENT_SECRET",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
    "EMAIL_HOST_PASSWORD",
    "DEMO_ADMIN_PASSWORD",
    "DEMO_MEMBER_PASSWORD",
]


class SecretEnvVerbatimTests(SimpleTestCase):
    databases = []

    def _eval(self, overrides):
        env = {
            **_BASE_ENV,
            **overrides,
            "PYTHONPATH": os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
        }
        return subprocess.run(
            [sys.executable, "-c", _SCRIPT],
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )

    def test_dollar_leading_secrets_are_used_verbatim(self):
        # A "$NAME" value would be proxied to os.environ["NAME"] (or "") by env().
        values = {name: f"$verbatim-{name}" for name in _SECRET_VARS}
        values["OIDC_SERVER_URL"] = "https://idp.example.com/realms/test"
        result = self._eval(values)
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        got = json.loads(result.stdout.strip())
        for name in _SECRET_VARS:
            key = "SECRET_KEY" if name == "DJANGO_SECRET_KEY" else name
            self.assertEqual(got[key], values[name], msg=name)

    def test_dollar_value_naming_a_set_variable_is_not_proxied(self):
        # "$GOOGLE_CLIENT_ID" must not resolve to the other variable's value.
        result = self._eval(
            {
                "GOOGLE_CLIENT_ID": "real-id",
                "GOOGLE_CLIENT_SECRET": "$GOOGLE_CLIENT_ID",
                "OIDC_CLIENT_ID": "x",
                "OIDC_CLIENT_SECRET": "y",
                "OIDC_SERVER_URL": "https://idp.example.com/realms/test",
            }
        )
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        got = json.loads(result.stdout.strip())
        self.assertEqual(got["GOOGLE_CLIENT_SECRET"], "$GOOGLE_CLIENT_ID")

    def test_defaults_preserved_when_unset(self):
        script = _SCRIPT.replace(
            'p["openid_connect"]["APPS"][0]["client_id"]', '"n/a"'
        ).replace('p["openid_connect"]["APPS"][0]["secret"]', '"n/a"')
        env = {
            **_BASE_ENV,
            "PYTHONPATH": os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
        }
        result = subprocess.run(
            [sys.executable, "-c", script],
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        got = json.loads(result.stdout.strip())
        for key in ("EMAIL_HOST_PASSWORD", "DEMO_ADMIN_PASSWORD", "GOOGLE_CLIENT_SECRET"):
            self.assertEqual(got[key], "", msg=key)

    def test_missing_secret_key_still_raises(self):
        env = {k: v for k, v in _BASE_ENV.items() if k != "DJANGO_SECRET_KEY"}
        env["PYTHONPATH"] = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
        result = subprocess.run(
            [sys.executable, "-c", _SCRIPT],
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("DJANGO_SECRET_KEY", result.stderr)
