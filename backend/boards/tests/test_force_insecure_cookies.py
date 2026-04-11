"""Tests for the FORCE_INSECURE_COOKIES setting.

Verifies that operators can disable secure cookie flags for plain-HTTP
deployments without setting DEBUG=True, and that contradictory
configurations (insecure cookies + HTTPS origins) are blocked.
"""

from unittest.mock import patch

from django.core.exceptions import ImproperlyConfigured
from django.test import TestCase


# Base env overrides needed to reload settings in production mode without
# hitting the CORS localhost guard or missing DJANGO_SECRET_KEY.
_PROD_HTTPS_ENV = {
    "DEBUG": "false",
    "CORS_ALLOWED_ORIGINS": "https://boards.example.com",
    "DJANGO_SECRET_KEY": "test-secret-key-not-change-me-in-production",
    "ALLOWED_HOSTS": "boards.example.com",
}

# Plain-HTTP variant — used when FORCE_INSECURE_COOKIES=true is valid.
_PROD_HTTP_ENV = {
    **_PROD_HTTPS_ENV,
    "CORS_ALLOWED_ORIGINS": "http://boards.example.com",
    "FRONTEND_URL": "http://boards.example.com",
}


class ForceInsecureCookiesTests(TestCase):
    """FORCE_INSECURE_COOKIES controls SESSION_COOKIE_SECURE and CSRF_COOKIE_SECURE."""

    def _reload_settings(self, base_env: dict, env_overrides: dict):
        """Re-import settings with mocked environment variables."""
        import importlib
        import os

        patched_env = {**os.environ, **base_env, **env_overrides}
        with patch.dict(os.environ, patched_env, clear=True):
            import visiban.settings as settings_mod

            importlib.reload(settings_mod)
            return settings_mod

    def test_default_production_cookies_are_secure(self):
        """Without FORCE_INSECURE_COOKIES, production cookies are secure."""
        settings = self._reload_settings(
            _PROD_HTTPS_ENV, {"FORCE_INSECURE_COOKIES": ""}
        )
        self.assertTrue(settings.SESSION_COOKIE_SECURE)
        self.assertTrue(settings.CSRF_COOKIE_SECURE)
        self.assertGreater(settings.SECURE_HSTS_SECONDS, 0)

    def test_force_insecure_cookies_disables_secure_flags(self):
        """FORCE_INSECURE_COOKIES=true with HTTP origins disables secure cookie flags."""
        settings = self._reload_settings(
            _PROD_HTTP_ENV, {"FORCE_INSECURE_COOKIES": "true"}
        )
        self.assertFalse(settings.SESSION_COOKIE_SECURE)
        self.assertFalse(settings.CSRF_COOKIE_SECURE)

    def test_force_insecure_cookies_defaults_hsts_to_zero(self):
        """FORCE_INSECURE_COOKIES=true sets HSTS to 0 by default."""
        settings = self._reload_settings(
            _PROD_HTTP_ENV, {"FORCE_INSECURE_COOKIES": "true"}
        )
        self.assertEqual(settings.SECURE_HSTS_SECONDS, 0)

    def test_explicit_hsts_overrides_force_insecure(self):
        """Operator can still set HSTS explicitly even with FORCE_INSECURE_COOKIES."""
        settings = self._reload_settings(
            _PROD_HTTP_ENV,
            {"FORCE_INSECURE_COOKIES": "true", "SECURE_HSTS_SECONDS": "300"},
        )
        self.assertEqual(settings.SECURE_HSTS_SECONDS, 300)

    def test_debug_mode_always_insecure(self):
        """In DEBUG mode, cookies are always insecure regardless of FORCE_INSECURE_COOKIES."""
        settings = self._reload_settings(
            _PROD_HTTPS_ENV, {"DEBUG": "true", "FORCE_INSECURE_COOKIES": ""}
        )
        self.assertFalse(settings.SESSION_COOKIE_SECURE)
        self.assertFalse(settings.CSRF_COOKIE_SECURE)

    def test_insecure_cookies_with_https_origins_raises(self):
        """FORCE_INSECURE_COOKIES=true with HTTPS CORS origins is a misconfiguration."""
        with self.assertRaises(ImproperlyConfigured) as ctx:
            self._reload_settings(
                _PROD_HTTPS_ENV, {"FORCE_INSECURE_COOKIES": "true"}
            )
        self.assertIn("FORCE_INSECURE_COOKIES", str(ctx.exception))
        self.assertIn("https://boards.example.com", str(ctx.exception))

    def test_insecure_cookies_with_http_origins_allowed(self):
        """FORCE_INSECURE_COOKIES=true with HTTP-only origins is valid."""
        settings = self._reload_settings(
            _PROD_HTTP_ENV, {"FORCE_INSECURE_COOKIES": "true"}
        )
        # Should not raise — just verify settings loaded
        self.assertFalse(settings.SESSION_COOKIE_SECURE)
