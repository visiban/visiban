"""Mail host check for the admin-UI SMTP settings (#1878).

Covers the save boundary, the send/test path, the operator opt-out and the
unchanged environment configuration.
"""
from unittest import mock

from django.core.mail import EmailMessage
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from accounts.models import SiteEmailSetting, User
from visiban import mail as visiban_mail
from visiban.mail import (
    EmailConfigUnusable, build_smtp_backend, env_email_config, smtp_host_refused,
)

SETTINGS_URL = "/api/v1/admin/email-settings/"
TEST_URL = "/api/v1/admin/email-settings/test/"


def _addrs(*values):
    import ipaddress
    return mock.patch.object(
        visiban_mail, "_resolve_host_addresses",
        return_value=[ipaddress.ip_address(v) for v in values],
    )


class SmtpHostRefusedTests(TestCase):
    def test_refused_classes(self):
        for addr in ("127.0.0.1", "127.9.9.9", "::1", "169.254.1.1", "fe80::1",
                     "169.254.169.254", "fd00:ec2::254", "0.0.0.0"):
            with self.subTest(addr=addr), _addrs(addr):
                self.assertTrue(smtp_host_refused("relay.test"))

    def test_private_and_public_allowed(self):
        for addr in ("10.1.2.3", "192.168.1.5", "172.16.0.9", "93.184.216.34"):
            with self.subTest(addr=addr), _addrs(addr):
                self.assertFalse(smtp_host_refused("relay.test"))

    def test_any_bad_record_refuses(self):
        with _addrs("93.184.216.34", "127.0.0.1"):
            self.assertTrue(smtp_host_refused("relay.test"))

    def test_literals_and_localhost_name(self):
        self.assertTrue(smtp_host_refused("127.0.0.1"))
        self.assertTrue(smtp_host_refused("[::1]"))
        self.assertTrue(smtp_host_refused("localhost"))

    def test_absent_or_unresolvable_input_is_not_refused(self):
        # Nothing to judge: an incomplete config is rejected elsewhere and a
        # name that does not resolve fails honestly as dns_failure.
        self.assertFalse(smtp_host_refused(""))
        self.assertFalse(smtp_host_refused(None))
        with _addrs():
            self.assertFalse(smtp_host_refused("nope.invalid"))

    @override_settings(SMTP_ALLOW_PRIVATE_HOSTS=True)
    def test_operator_opt_out(self):
        self.assertFalse(smtp_host_refused("127.0.0.1"))


class SmtpHostSettingsTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(
            username="admin", email="admin@visiban.test", password="pw",
            is_site_admin=True, is_superuser=True,
        )
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def test_save_refuses_loopback_host(self):
        response = self.client.patch(SETTINGS_URL, {"host": "127.0.0.1"}, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertIn("host", response.json())
        self.assertEqual(SiteEmailSetting.get().host, "")

    def test_save_accepts_public_host(self):
        with _addrs("93.184.216.34"):
            response = self.client.patch(SETTINGS_URL, {"host": "smtp.visiban.test"}, format="json")
        self.assertEqual(response.status_code, 200)

    @override_settings(SMTP_ALLOW_PRIVATE_HOSTS=True)
    def test_save_allows_loopback_with_opt_out(self):
        response = self.client.patch(SETTINGS_URL, {"host": "127.0.0.1"}, format="json")
        self.assertEqual(response.status_code, 200)

    def test_save_without_host_is_unaffected_by_a_stored_host(self):
        cfg = SiteEmailSetting.get()
        cfg.host = "127.0.0.1"
        cfg.save()
        response = self.client.patch(SETTINGS_URL, {"timeout": 20}, format="json")
        self.assertEqual(response.status_code, 200)

    def test_test_send_refuses_stored_internal_host_without_connecting(self):
        cfg = SiteEmailSetting.get()
        cfg.host = "127.0.0.1"
        cfg.port = 25
        cfg.from_email = "db@visiban.test"
        cfg.config_source = SiteEmailSetting.ConfigSource.DATABASE
        cfg.save()
        with mock.patch("django.core.mail.backends.smtp.EmailBackend.open") as opened:
            response = self.client.post(TEST_URL)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "config_unusable")
        opened.assert_not_called()

    def test_send_path_rechecks_when_dns_changes(self):
        cfg = SiteEmailSetting.get()
        cfg.host = "relay.visiban.test"
        cfg.from_email = "db@visiban.test"
        cfg.config_source = SiteEmailSetting.ConfigSource.DATABASE
        cfg.save()
        from visiban.mail import resolve_email_config
        with _addrs("127.0.0.1"), self.assertRaises(EmailConfigUnusable):
            build_smtp_backend(resolve_email_config())


class EnvConfigUnchangedTests(TestCase):
    @override_settings(EMAIL_HOST="localhost", DEFAULT_FROM_EMAIL="ops@visiban.test")
    def test_env_host_on_localhost_still_builds(self):
        config = env_email_config()
        self.assertEqual(config.source, "env")
        backend = build_smtp_backend(config)
        self.assertEqual(backend.host, "localhost")
