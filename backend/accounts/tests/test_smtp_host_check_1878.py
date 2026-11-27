"""Mail host check for the admin-UI SMTP settings (#1878).

Covers the save boundary, the send/test path, the operator opt-out and the
unchanged environment configuration.
"""
import io
import socket
import ssl
from unittest import mock

from django.core.mail.backends.smtp import EmailBackend as SMTPEmailBackend
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from accounts.models import SiteEmailSetting, User
from visiban import mail as visiban_mail
from visiban.mail import (
    EmailConfigUnusable, build_smtp_backend, env_email_config, resolve_email_config,
    smtp_host_refused,
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


class _ScriptedSocket:
    """Stands in for a connected socket: replays server lines, ignores writes."""

    def __init__(self, script):
        self._file = io.BytesIO(script)

    def makefile(self, *args, **kwargs):
        return self._file

    def sendall(self, data):
        pass

    def close(self):
        pass


class SmtpSendTargetTests(TestCase):
    """The send path connects to the addresses it checked (#1878)."""

    HOST = "relay.visiban.test"

    def setUp(self):
        cfg = SiteEmailSetting.get()
        cfg.host = self.HOST
        cfg.port = 587
        cfg.from_email = "db@visiban.test"
        cfg.config_source = SiteEmailSetting.ConfigSource.DATABASE
        cfg.save()

    def _backend(self, **fields):
        if fields:
            SiteEmailSetting.objects.filter(pk=SiteEmailSetting.get().pk).update(**fields)
        return build_smtp_backend(resolve_email_config(), fail_silently=False)

    def _loopback_lookup(self):
        # Any later lookup of the name answers loopback.
        return mock.patch.object(
            socket, "getaddrinfo",
            return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 587))],
        )

    def test_connect_goes_to_the_checked_addresses_in_order(self):
        targets = []

        def refuse(address, *args, **kwargs):
            targets.append(address)
            raise ConnectionRefusedError()

        with _addrs("93.184.216.34", "93.184.216.35"):
            backend = self._backend()
        with self._loopback_lookup(), mock.patch.object(socket, "create_connection", side_effect=refuse):
            with self.assertRaises(ConnectionRefusedError):
                backend.open()
        self.assertEqual(targets, [("93.184.216.34", 587), ("93.184.216.35", 587)])

    def test_tls_checks_the_host_name(self):
        greeting = b"220 relay ready\r\n250-relay\r\n250 STARTTLS\r\n220 go ahead\r\n"
        for fields in ({"use_tls": True, "use_ssl": False}, {"use_tls": False, "use_ssl": True}):
            with self.subTest(**fields):
                targets = []

                def connect(address, *args, **kwargs):
                    targets.append(address)
                    return _ScriptedSocket(greeting)

                with _addrs("93.184.216.34"):
                    backend = self._backend(**fields)
                with self._loopback_lookup(), \
                        mock.patch.object(socket, "create_connection", side_effect=connect), \
                        mock.patch.object(ssl.SSLContext, "wrap_socket", autospec=True,
                                          side_effect=ssl.SSLError("stop")) as wrap:
                    with self.assertRaises(ssl.SSLError):
                        backend.open()
                self.assertEqual(targets, [("93.184.216.34", 587)])
                self.assertEqual(wrap.call_args.kwargs["server_hostname"], self.HOST)
                context = wrap.call_args.args[0]
                self.assertTrue(context.check_hostname)
                self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)

    def test_unresolved_host_fails_as_a_lookup_failure(self):
        with _addrs():
            backend = self._backend()
        with self._loopback_lookup(), mock.patch.object(socket, "create_connection") as connect:
            with self.assertRaises(socket.gaierror):
                backend.open()
        connect.assert_not_called()
        self.assertEqual(visiban_mail.classify_smtp_error(socket.gaierror()), "dns_failure")

    @override_settings(SMTP_ALLOW_PRIVATE_HOSTS=True)
    def test_operator_opt_out_builds_the_plain_backend(self):
        self.assertIs(type(self._backend()), SMTPEmailBackend)

    @override_settings(EMAIL_HOST="localhost", DEFAULT_FROM_EMAIL="ops@visiban.test")
    def test_env_config_builds_the_plain_backend(self):
        self.assertIs(type(build_smtp_backend(env_email_config())), SMTPEmailBackend)
