"""Tests for the FORCE_INSECURE_COOKIES setting.

Verifies that operators can disable secure cookie flags for plain-HTTP
deployments without setting DEBUG=True.
"""

from unittest.mock import patch

from django.test import TestCase, override_settings


# Base env overrides needed to reload settings in production mode without
# hitting the CORS localhost guard or missing DJANGO_SECRET_KEY.
_PROD_ENV = {
    "DEBUG": "false",
    "CORS_ALLOWED_ORIGINS": "https://boards.example.com",
    "DJANGO_SECRET_KEY": "test-secret-key-not-change-me-in-production",
    "ALLOWED_HOSTS": "boards.example.com",
}


class ForceInsecureCookiesTests(TestCase):
    """FORCE_INSECURE_COOKIES controls SESSION_COOKIE_SECURE and CSRF_COOKIE_SECURE."""

    def _reload_settings(self, env_overrides: dict):
        """Re-import settings with mocked environment variables.

        Returns a fresh settings module with the given env overrides applied
        on top of the current os.environ.
        """
        import importlib
        import os

        patched_env = {**os.environ, **_PROD_ENV, **env_overrides}
        with patch.dict(os.environ, patched_env, clear=True):
            import visiban.settings as settings_mod

            importlib.reload(settings_mod)
            return settings_mod

    def test_default_production_cookies_are_secure(self):
        """Without FORCE_INSECURE_COOKIES, production cookies are secure."""
        settings = self._reload_settings({"FORCE_INSECURE_COOKIES": ""})
        self.assertTrue(settings.SESSION_COOKIE_SECURE)
        self.assertTrue(settings.CSRF_COOKIE_SECURE)
        self.assertGreater(settings.SECURE_HSTS_SECONDS, 0)

    def test_force_insecure_cookies_disables_secure_flags(self):
        """FORCE_INSECURE_COOKIES=true disables secure cookie flags."""
        settings = self._reload_settings({"FORCE_INSECURE_COOKIES": "true"})
        self.assertFalse(settings.SESSION_COOKIE_SECURE)
        self.assertFalse(settings.CSRF_COOKIE_SECURE)

    def test_force_insecure_cookies_defaults_hsts_to_zero(self):
        """FORCE_INSECURE_COOKIES=true sets HSTS to 0 by default."""
        settings = self._reload_settings({"FORCE_INSECURE_COOKIES": "true"})
        self.assertEqual(settings.SECURE_HSTS_SECONDS, 0)

    def test_explicit_hsts_overrides_force_insecure(self):
        """Operator can still set HSTS explicitly even with FORCE_INSECURE_COOKIES."""
        settings = self._reload_settings(
            {"FORCE_INSECURE_COOKIES": "true", "SECURE_HSTS_SECONDS": "300"}
        )
        self.assertEqual(settings.SECURE_HSTS_SECONDS, 300)

    def test_debug_mode_always_insecure(self):
        """In DEBUG mode, cookies are always insecure regardless of FORCE_INSECURE_COOKIES."""
        settings = self._reload_settings(
            {"DEBUG": "true", "FORCE_INSECURE_COOKIES": ""}
        )
        self.assertFalse(settings.SESSION_COOKIE_SECURE)
        self.assertFalse(settings.CSRF_COOKIE_SECURE)
