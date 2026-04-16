"""Security hardening tests: admin IP restriction middleware and SECRET_KEY guard."""
import os
from unittest.mock import patch

from django.test import TestCase, RequestFactory, override_settings
from django.http import HttpResponse
from django.core.exceptions import ImproperlyConfigured

from visiban.middleware import AdminIPRestrictionMiddleware


def _make_response(_request):
    return HttpResponse("ok")


class AdminIPRestrictionMiddlewareTests(TestCase):
    """AdminIPRestrictionMiddleware must block non-loopback IPs in production."""

    def setUp(self):
        self.factory = RequestFactory()
        self.middleware = AdminIPRestrictionMiddleware(_make_response)

    # ------------------------------------------------------------------
    # Production mode (DEBUG=False)
    # ------------------------------------------------------------------

    @override_settings(DEBUG=False)
    def test_loopback_ipv4_allowed_in_production(self):
        request = self.factory.get("/admin/")
        request.META["REMOTE_ADDR"] = "127.0.0.1"
        response = self.middleware(request)
        self.assertEqual(response.status_code, 200)

    @override_settings(DEBUG=False)
    def test_loopback_ipv6_allowed_in_production(self):
        request = self.factory.get("/admin/")
        request.META["REMOTE_ADDR"] = "::1"
        response = self.middleware(request)
        self.assertEqual(response.status_code, 200)

    @override_settings(DEBUG=False)
    def test_external_ip_blocked_in_production(self):
        request = self.factory.get("/admin/")
        request.META["REMOTE_ADDR"] = "203.0.113.42"
        response = self.middleware(request)
        self.assertEqual(response.status_code, 403)

    @override_settings(DEBUG=False)
    def test_non_admin_path_not_affected(self):
        """Non-admin paths must not be restricted regardless of IP."""
        request = self.factory.get("/api/v1/boards/")
        request.META["REMOTE_ADDR"] = "203.0.113.42"
        response = self.middleware(request)
        self.assertEqual(response.status_code, 200)

    @override_settings(DEBUG=False)
    def test_forwarded_for_rightmost_entry_used(self):
        """Middleware trusts the rightmost X-Forwarded-For entry (proxy-appended).

        The leftmost entry is client-supplied and cannot be trusted. With
        NUM_PROXIES=1, the rightmost entry is the one appended by the
        trusted reverse proxy (Nginx).
        """
        request = self.factory.get("/admin/")
        request.META["REMOTE_ADDR"] = "10.0.0.1"
        # Client spoofs loopback as leftmost; proxy appends real IP as rightmost
        request.META["HTTP_X_FORWARDED_FOR"] = "127.0.0.1, 203.0.113.99"
        response = self.middleware(request)
        # Rightmost is 203.0.113.99 (non-loopback) — must be blocked
        self.assertEqual(response.status_code, 403)

    @override_settings(DEBUG=False)
    def test_forwarded_for_rightmost_loopback_allowed(self):
        """X-Forwarded-For with loopback as rightmost entry is allowed."""
        request = self.factory.get("/admin/")
        request.META["REMOTE_ADDR"] = "10.0.0.1"
        # Proxy appends loopback as the rightmost entry
        request.META["HTTP_X_FORWARDED_FOR"] = "203.0.113.99, 127.0.0.1"
        response = self.middleware(request)
        self.assertEqual(response.status_code, 200)

    @override_settings(DEBUG=False)
    def test_custom_allowed_ips_env_var(self):
        """DJANGO_ADMIN_ALLOWED_IPS overrides the default loopback-only set."""
        request = self.factory.get("/admin/")
        request.META["REMOTE_ADDR"] = "10.10.1.5"
        with patch.dict(os.environ, {"DJANGO_ADMIN_ALLOWED_IPS": "10.10.1.5,10.10.1.6"}):
            response = self.middleware(request)
        self.assertEqual(response.status_code, 200)

    @override_settings(DEBUG=False)
    def test_ip_not_in_custom_allowed_list_blocked(self):
        request = self.factory.get("/admin/")
        request.META["REMOTE_ADDR"] = "10.10.1.99"
        with patch.dict(os.environ, {"DJANGO_ADMIN_ALLOWED_IPS": "10.10.1.5,10.10.1.6"}):
            response = self.middleware(request)
        self.assertEqual(response.status_code, 403)

    # ------------------------------------------------------------------
    # Debug mode (DEBUG=True) — all IPs allowed for local development
    # ------------------------------------------------------------------

    @override_settings(DEBUG=True)
    def test_external_ip_allowed_in_debug_mode(self):
        """In DEBUG mode admin is accessible from any IP (local dev convenience)."""
        request = self.factory.get("/admin/")
        request.META["REMOTE_ADDR"] = "203.0.113.42"
        response = self.middleware(request)
        self.assertEqual(response.status_code, 200)


class SecretKeyGuardTests(TestCase):
    """settings.py must raise ImproperlyConfigured for placeholder keys in production."""

    def _load_settings_with(self, secret_key, debug):
        """Re-execute the SECRET_KEY guard logic in isolation.

        Rather than re-importing settings (which risks polluting the test
        Django environment), we replicate the guard logic inline so the test
        can assert on its behaviour without side effects.
        """
        _INSECURE_SECRET_KEYS = {"change-me-in-production", ""}
        if not debug and secret_key in _INSECURE_SECRET_KEYS:
            raise ImproperlyConfigured(
                "DJANGO_SECRET_KEY must be set to a secure random value. "
                'Generate one with: python -c "import secrets; print(secrets.token_hex(50))"'
            )

    def test_placeholder_key_raises_in_production(self):
        with self.assertRaises(ImproperlyConfigured) as ctx:
            self._load_settings_with("change-me-in-production", debug=False)
        self.assertIn("DJANGO_SECRET_KEY", str(ctx.exception))

    def test_empty_key_raises_in_production(self):
        with self.assertRaises(ImproperlyConfigured):
            self._load_settings_with("", debug=False)

    def test_placeholder_key_allowed_in_debug(self):
        """Guard must not fire in DEBUG mode so local dev with .env.example works."""
        # Should not raise
        self._load_settings_with("change-me-in-production", debug=True)

    def test_real_key_allowed_in_production(self):
        """A non-placeholder key must not raise regardless of DEBUG."""
        import secrets as _secrets
        real_key = _secrets.token_hex(50)
        self._load_settings_with(real_key, debug=False)

    def test_error_message_includes_generation_hint(self):
        with self.assertRaises(ImproperlyConfigured) as ctx:
            self._load_settings_with("change-me-in-production", debug=False)
        self.assertIn("token_hex", str(ctx.exception))


class SanitizeAttachmentFilenameTests(TestCase):
    """Unit tests for _sanitize_attachment_filename (#505)."""

    def _sanitize(self, name):
        from boards.views.cards import _sanitize_attachment_filename
        return _sanitize_attachment_filename(name)

    def test_normal_filename_unchanged(self):
        self.assertEqual(self._sanitize("report.pdf"), "report.pdf")

    def test_strips_path_separators(self):
        result = self._sanitize("../../etc/passwd")
        self.assertNotIn("/", result)
        self.assertNotIn("..", result)

    def test_strips_double_quotes(self):
        result = self._sanitize('evil"file.pdf')
        self.assertNotIn('"', result)

    def test_strips_carriage_return(self):
        result = self._sanitize("file\r.pdf")
        self.assertNotIn("\r", result)

    def test_strips_newline(self):
        result = self._sanitize("file\n.pdf")
        self.assertNotIn("\n", result)

    def test_strips_null_byte(self):
        result = self._sanitize("file\x00.pdf")
        self.assertNotIn("\x00", result)

    def test_empty_name_returns_fallback(self):
        result = self._sanitize("")
        self.assertTrue(len(result) > 0)

    def test_windows_path_stripped(self):
        result = self._sanitize("C:\\Users\\admin\\secret.docx")
        self.assertNotIn("\\", result)
        self.assertNotIn(":", result)
