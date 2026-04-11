"""Tests for the FORCE_INSECURE_COOKIES setting.

Verifies that operators can disable secure cookie flags for plain-HTTP
deployments without setting DEBUG=True, and that contradictory
configurations (insecure cookies + HTTPS origins) are blocked.

Each test evaluates settings in a subprocess to avoid corrupting the test
runner's database connection — importlib.reload(settings) in-process would
re-evaluate DATABASES and break all subsequent tests.
"""

import json
import os
import subprocess
import sys

from django.test import SimpleTestCase


# Base env overrides needed to evaluate settings in production mode without
# hitting the CORS localhost guard or missing DJANGO_SECRET_KEY.
_PROD_HTTPS_ENV = {
    "DEBUG": "false",
    "CORS_ALLOWED_ORIGINS": "https://boards.example.com",
    "DJANGO_SECRET_KEY": "test-secret-key-not-change-me-in-production",
    "ALLOWED_HOSTS": "boards.example.com",
    "DATABASE_URL": "sqlite:///dev.db",
}

# Plain-HTTP variant — used when FORCE_INSECURE_COOKIES=true is valid.
_PROD_HTTP_ENV = {
    **_PROD_HTTPS_ENV,
    "CORS_ALLOWED_ORIGINS": "http://boards.example.com",
    "FRONTEND_URL": "http://boards.example.com",
}

# Minimal script that loads Django settings and prints the values we care about.
_SETTINGS_SCRIPT = """\
import json, os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "visiban.settings")
import django
django.setup()
from django.conf import settings
print(json.dumps({
    "SESSION_COOKIE_SECURE": settings.SESSION_COOKIE_SECURE,
    "CSRF_COOKIE_SECURE": settings.CSRF_COOKIE_SECURE,
    "SECURE_HSTS_SECONDS": settings.SECURE_HSTS_SECONDS,
}))
"""


class ForceInsecureCookiesTests(SimpleTestCase):
    """FORCE_INSECURE_COOKIES controls SESSION_COOKIE_SECURE and CSRF_COOKIE_SECURE."""

    databases = []  # No DB access — prevents connection corruption

    def _eval_settings(self, base_env: dict, env_overrides: dict):
        """Evaluate settings in a subprocess and return parsed values or stderr."""
        env = {**base_env, **env_overrides, "PYTHONPATH": os.path.dirname(os.path.dirname(os.path.dirname(__file__)))}
        result = subprocess.run(
            [sys.executable, "-c", _SETTINGS_SCRIPT],
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            return None, result.stderr
        return json.loads(result.stdout.strip()), None

    def test_default_production_cookies_are_secure(self):
        """Without FORCE_INSECURE_COOKIES, production cookies are secure."""
        settings, err = self._eval_settings(
            _PROD_HTTPS_ENV, {"FORCE_INSECURE_COOKIES": ""}
        )
        self.assertIsNone(err, msg=f"Settings failed to load: {err}")
        self.assertTrue(settings["SESSION_COOKIE_SECURE"])
        self.assertTrue(settings["CSRF_COOKIE_SECURE"])
        self.assertGreater(settings["SECURE_HSTS_SECONDS"], 0)

    def test_force_insecure_cookies_disables_secure_flags(self):
        """FORCE_INSECURE_COOKIES=true with HTTP origins disables secure cookie flags."""
        settings, err = self._eval_settings(
            _PROD_HTTP_ENV, {"FORCE_INSECURE_COOKIES": "true"}
        )
        self.assertIsNone(err, msg=f"Settings failed to load: {err}")
        self.assertFalse(settings["SESSION_COOKIE_SECURE"])
        self.assertFalse(settings["CSRF_COOKIE_SECURE"])

    def test_force_insecure_cookies_defaults_hsts_to_zero(self):
        """FORCE_INSECURE_COOKIES=true sets HSTS to 0 by default."""
        settings, err = self._eval_settings(
            _PROD_HTTP_ENV, {"FORCE_INSECURE_COOKIES": "true"}
        )
        self.assertIsNone(err, msg=f"Settings failed to load: {err}")
        self.assertEqual(settings["SECURE_HSTS_SECONDS"], 0)

    def test_explicit_hsts_overrides_force_insecure(self):
        """Operator can still set HSTS explicitly even with FORCE_INSECURE_COOKIES."""
        settings, err = self._eval_settings(
            _PROD_HTTP_ENV,
            {"FORCE_INSECURE_COOKIES": "true", "SECURE_HSTS_SECONDS": "300"},
        )
        self.assertIsNone(err, msg=f"Settings failed to load: {err}")
        self.assertEqual(settings["SECURE_HSTS_SECONDS"], 300)

    def test_debug_mode_always_insecure(self):
        """In DEBUG mode, cookies are always insecure regardless of FORCE_INSECURE_COOKIES."""
        settings, err = self._eval_settings(
            _PROD_HTTPS_ENV, {"DEBUG": "true", "FORCE_INSECURE_COOKIES": ""}
        )
        self.assertIsNone(err, msg=f"Settings failed to load: {err}")
        self.assertFalse(settings["SESSION_COOKIE_SECURE"])
        self.assertFalse(settings["CSRF_COOKIE_SECURE"])

    def test_insecure_cookies_with_https_origins_raises(self):
        """FORCE_INSECURE_COOKIES=true with HTTPS CORS origins is a misconfiguration."""
        settings, err = self._eval_settings(
            _PROD_HTTPS_ENV, {"FORCE_INSECURE_COOKIES": "true"}
        )
        self.assertIsNone(settings, msg="Expected ImproperlyConfigured but settings loaded")
        self.assertIn("FORCE_INSECURE_COOKIES", err)
        self.assertIn("https://boards.example.com", err)

    def test_insecure_cookies_with_http_origins_allowed(self):
        """FORCE_INSECURE_COOKIES=true with HTTP-only origins is valid."""
        settings, err = self._eval_settings(
            _PROD_HTTP_ENV, {"FORCE_INSECURE_COOKIES": "true"}
        )
        self.assertIsNone(err, msg=f"Settings failed to load: {err}")
        self.assertFalse(settings["SESSION_COOKIE_SECURE"])
