"""Tests for DB-backed SMTP configuration in the admin UI (issue #306).

A note on what these cover, because there was no baseline at all: before this
issue no backend test in the repo touched ``mail.outbox`` or
``override_settings(EMAIL_*)``. The cases below therefore establish the
contract from scratch rather than extending an existing suite — in particular
the precedence rule (all-or-nothing per source, never a field-level merge), the
encryption-key-rotation path, and the guarantee that a raw SMTP error never
reaches the client.
"""
import smtplib
import socket
from unittest import mock

from django.core import mail
from django.db import connection
from django.test import TestCase, override_settings
from django.test.utils import CaptureQueriesContext
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import AdminActionLog, SiteEmailSetting, User
from visiban.crypto import (
    SecretDecryptionError,
    decrypt_secret,
    encrypt_secret,
    secret_is_decryptable,
)
from visiban.mail import (
    EmailConfigUnusable,
    classify_smtp_error,
    resolve_email_config,
)

SETTINGS_URL = "/api/v1/admin/email-settings/"
TEST_URL = "/api/v1/admin/email-settings/test/"


class CryptoTests(TestCase):
    """The encryption helper, including the rotation behavior #306 depends on."""

    def test_round_trip(self):
        self.assertEqual(decrypt_secret(encrypt_secret("hunter2")), "hunter2")

    def test_empty_string_is_not_encrypted(self):
        # "No secret stored" must stay distinguishable from a ciphertext that
        # happens to decrypt to "".
        self.assertEqual(encrypt_secret(""), "")
        self.assertEqual(decrypt_secret(""), "")

    def test_ciphertext_does_not_contain_plaintext(self):
        self.assertNotIn("hunter2", encrypt_secret("hunter2"))

    def test_stored_value_carries_version_and_fingerprint(self):
        stored = encrypt_secret("hunter2")
        version, fingerprint, _token = stored.split(":", 2)
        self.assertEqual(version, "v1")
        self.assertEqual(len(fingerprint), 8)

    def test_key_change_is_detected_without_decrypting(self):
        stored = encrypt_secret("hunter2")
        self.assertTrue(secret_is_decryptable(stored))
        with override_settings(SECRET_KEY="a-completely-different-secret-key"):
            self.assertFalse(secret_is_decryptable(stored))

    def test_key_change_raises_the_dedicated_error(self):
        # The whole point: a rotated key must not surface as a generic auth
        # failure, because the remedy is completely different.
        stored = encrypt_secret("hunter2")
        with override_settings(SECRET_KEY="a-completely-different-secret-key"):
            with self.assertRaises(SecretDecryptionError):
                decrypt_secret(stored)

    def test_malformed_value_raises_rather_than_returning_garbage(self):
        with self.assertRaises(SecretDecryptionError):
            decrypt_secret("not-a-valid-stored-secret")

    def test_dedicated_key_overrides_secret_key(self):
        import base64
        import os

        dedicated = base64.urlsafe_b64encode(os.urandom(32)).decode()
        with override_settings(SECRET_ENCRYPTION_KEY=dedicated):
            stored = encrypt_secret("hunter2")
            self.assertEqual(decrypt_secret(stored), "hunter2")
            # Rotating SECRET_KEY must NOT affect a value encrypted under the
            # dedicated key — that is the entire reason the escape hatch exists.
            with override_settings(SECRET_KEY="rotated", SECRET_ENCRYPTION_KEY=dedicated):
                self.assertEqual(decrypt_secret(stored), "hunter2")


class EmailConfigResolutionTests(TestCase):
    """The precedence rule: all-or-nothing per source, never a merge."""

    @override_settings(EMAIL_HOST="env.example.org", EMAIL_PORT=2525,
                       DEFAULT_FROM_EMAIL="env@visiban.test")
    def test_defaults_to_env_when_no_db_config(self):
        config = resolve_email_config()
        self.assertEqual(config.source, "env")
        self.assertEqual(config.host, "env.example.org")
        self.assertEqual(config.port, 2525)

    @override_settings(EMAIL_HOST="env.example.org", DEFAULT_FROM_EMAIL="env@visiban.test")
    def test_partial_db_row_does_not_override_env(self):
        # The realistic half-row: an admin saved a host and got interrupted.
        # config_source stays 'env', so env config keeps working untouched.
        cfg = SiteEmailSetting.get()
        cfg.host = "half.example.org"
        cfg.save()

        config = resolve_email_config()
        self.assertEqual(config.source, "env")
        self.assertEqual(config.host, "env.example.org")

    @override_settings(EMAIL_HOST="env.example.org", EMAIL_HOST_PASSWORD="env-password")
    def test_database_source_never_merges_env_fields(self):
        cfg = SiteEmailSetting.get()
        cfg.host = "db.example.org"
        cfg.from_email = "db@visiban.test"
        cfg.config_source = SiteEmailSetting.ConfigSource.DATABASE
        cfg.save()

        config = resolve_email_config()
        self.assertEqual(config.source, "database")
        self.assertEqual(config.host, "db.example.org")
        # No username is set, so no password — the env password must NOT leak in.
        self.assertEqual(config.password, "")

    def test_incomplete_database_source_raises_rather_than_falling_back(self):
        # Reachable only by a raw ORM write; the serializer refuses it. Falling
        # back would re-route mail through a server the admin did not choose.
        cfg = SiteEmailSetting.get()
        cfg.config_source = SiteEmailSetting.ConfigSource.DATABASE
        cfg.save()
        with self.assertRaises(EmailConfigUnusable):
            resolve_email_config()

    def test_undecryptable_password_raises_rather_than_falling_back(self):
        cfg = SiteEmailSetting.get()
        cfg.host = "db.example.org"
        cfg.from_email = "db@visiban.test"
        cfg.username = "mailer"
        cfg.set_password("hunter2")
        cfg.config_source = SiteEmailSetting.ConfigSource.DATABASE
        cfg.save()

        with override_settings(SECRET_KEY="rotated-key-value"):
            with self.assertRaises(EmailConfigUnusable):
                resolve_email_config()

    def test_unauthenticated_relay_is_a_complete_config(self):
        # A local Postfix or an SES VPC endpoint needs no credentials; demanding
        # a password there would reject a valid deployment.
        cfg = SiteEmailSetting.get()
        cfg.host = "localhost"
        cfg.from_email = "db@visiban.test"
        cfg.config_source = SiteEmailSetting.ConfigSource.DATABASE
        cfg.save()
        self.assertTrue(cfg.db_config_is_complete())
        self.assertEqual(resolve_email_config().source, "database")


class ErrorClassificationTests(TestCase):
    """The sanitized taxonomy never leaks the underlying error text."""

    def test_auth_failure(self):
        exc = smtplib.SMTPAuthenticationError(535, b"5.7.8 Username and Password not accepted")
        self.assertEqual(classify_smtp_error(exc), "auth_failed")

    def test_dns_failure(self):
        self.assertEqual(classify_smtp_error(socket.gaierror("no such host")), "dns_failure")

    def test_connection_refused(self):
        self.assertEqual(classify_smtp_error(ConnectionRefusedError()), "connection_refused")

    def test_timeout(self):
        self.assertEqual(classify_smtp_error(TimeoutError()), "timeout")

    def test_unknown_falls_through(self):
        self.assertEqual(classify_smtp_error(ValueError("something else")), "unknown")


class AdminEmailSettingsAPITests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(
            username="admin", email="admin@visiban.test", password="pw", is_site_admin=True
        )
        self.member = User.objects.create_user(
            username="member", email="member@visiban.test", password="pw"
        )
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    # --- permissions ----------------------------------------------------

    def test_non_admin_cannot_read(self):
        self.client.force_authenticate(self.member)
        self.assertEqual(self.client.get(SETTINGS_URL).status_code, status.HTTP_403_FORBIDDEN)

    def test_non_admin_cannot_patch(self):
        self.client.force_authenticate(self.member)
        response = self.client.patch(SETTINGS_URL, {"host": "evil.example.org"}, format="json")
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_anonymous_cannot_read(self):
        self.client.force_authenticate(None)
        self.assertIn(
            self.client.get(SETTINGS_URL).status_code,
            (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN),
        )

    def test_anonymous_cannot_patch(self):
        # IsSiteAdmin gates on is_authenticated for every method, so this is
        # already covered by the same code path as the GET above — asserted
        # separately because a write path losing its gate is the expensive
        # failure, and a reader should not have to derive that it is safe.
        self.client.force_authenticate(None)
        response = self.client.patch(SETTINGS_URL, {"host": "evil.example.org"}, format="json")
        self.assertIn(
            response.status_code,
            (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN),
        )
        self.assertEqual(SiteEmailSetting.get().host, "")

    def test_non_admin_cannot_send_test(self):
        self.client.force_authenticate(self.member)
        self.assertEqual(self.client.post(TEST_URL).status_code, status.HTTP_403_FORBIDDEN)

    # --- read payload ---------------------------------------------------

    def test_get_never_returns_the_password(self):
        cfg = SiteEmailSetting.get()
        cfg.set_password("hunter2")
        cfg.save()

        response = self.client.get(SETTINGS_URL)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        body = response.json()
        self.assertNotIn("password", body)
        self.assertNotIn("password_ciphertext", body)
        self.assertNotIn("hunter2", response.content.decode())
        self.assertTrue(body["password_set"])
        self.assertTrue(body["password_decryptable"])

    def test_get_does_not_decrypt_the_password(self):
        """Reading the settings page must never materialize the plaintext.

        `_email_settings_payload` reports which configuration is in effect; it
        has no use for the credential. Decrypting one only to discard it would
        put it in a local variable, and therefore in any traceback captured
        from that frame.
        """
        cfg = SiteEmailSetting.get()
        cfg.host = "smtp.visiban.test"
        cfg.from_email = "db@visiban.test"
        cfg.username = "mailer"
        cfg.set_password("hunter2")
        cfg.config_source = SiteEmailSetting.ConfigSource.DATABASE
        cfg.save()

        with mock.patch("visiban.crypto.decrypt_secret") as decrypt:
            response = self.client.get(SETTINGS_URL)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        decrypt.assert_not_called()
        # The fingerprint check still answers the question a read needs.
        self.assertTrue(response.json()["password_decryptable"])

    def test_get_issues_one_query_for_the_settings_row(self):
        SiteEmailSetting.get()  # materialize so the count excludes the create
        with CaptureQueriesContext(connection) as ctx:
            self.client.get(SETTINGS_URL)
        row_queries = [
            q for q in ctx.captured_queries if "site_email_settings" in q["sql"]
        ]
        self.assertEqual(
            len(row_queries), 1,
            f"expected exactly 1 site_email_settings query, got {len(row_queries)}",
        )

    def test_get_reports_undecryptable_password(self):
        cfg = SiteEmailSetting.get()
        cfg.set_password("hunter2")
        cfg.save()
        with override_settings(SECRET_KEY="rotated-key-value"):
            body = self.client.get(SETTINGS_URL).json()
        self.assertTrue(body["password_set"])
        self.assertFalse(body["password_decryptable"])

    @override_settings(EMAIL_HOST="env.example.org", EMAIL_PORT=2525,
                       DEFAULT_FROM_EMAIL="env@visiban.test", EMAIL_BACKEND_EXPLICIT=False)
    def test_get_reports_effective_env_source(self):
        body = self.client.get(SETTINGS_URL).json()
        self.assertEqual(body["effective_source"], "env")
        self.assertEqual(body["effective_host"], "env.example.org")
        self.assertEqual(body["effective_port"], 2525)

    @override_settings(EMAIL_BACKEND_EXPLICIT=True)
    def test_get_reports_backend_override(self):
        # An operator who pinned EMAIL_BACKEND has bypassed both sources;
        # reporting "env" here would be a lie.
        body = self.client.get(SETTINGS_URL).json()
        self.assertEqual(body["effective_source"], "env_backend_override")

    # --- validation -----------------------------------------------------

    def test_tls_and_ssl_are_mutually_exclusive(self):
        response = self.client.patch(
            SETTINGS_URL, {"use_tls": True, "use_ssl": True}, format="json"
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("use_ssl", response.json())

    def test_mutual_exclusion_is_checked_against_post_patch_state(self):
        # use_tls defaults True, so submitting only use_ssl must still fail —
        # validating just the submitted field would let a two-step PATCH walk
        # the row into an invalid combination.
        response = self.client.patch(SETTINGS_URL, {"use_ssl": True}, format="json")
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_placeholder_sender_is_rejected(self):
        response = self.client.patch(
            SETTINGS_URL, {"from_email": "noreply@example.com"}, format="json"
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("from_email", response.json())

    def test_cannot_switch_to_database_when_incomplete(self):
        response = self.client.patch(
            SETTINGS_URL, {"config_source": "database"}, format="json"
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("config_source", response.json())
        self.assertEqual(
            SiteEmailSetting.get().config_source, SiteEmailSetting.ConfigSource.ENV
        )

    def test_cannot_switch_to_database_when_username_has_no_password(self):
        response = self.client.patch(
            SETTINGS_URL,
            {
                "config_source": "database",
                "host": "smtp.visiban.test",
                "from_email": "db@visiban.test",
                "username": "mailer",
            },
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_cannot_switch_to_database_with_undecryptable_password(self):
        cfg = SiteEmailSetting.get()
        cfg.host = "smtp.visiban.test"
        cfg.from_email = "db@visiban.test"
        cfg.username = "mailer"
        cfg.set_password("hunter2")
        cfg.save()
        with override_settings(SECRET_KEY="rotated-key-value"):
            response = self.client.patch(
                SETTINGS_URL, {"config_source": "database"}, format="json"
            )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_can_switch_to_database_when_complete(self):
        response = self.client.patch(
            SETTINGS_URL,
            {
                "config_source": "database",
                "host": "smtp.visiban.test",
                "from_email": "db@visiban.test",
            },
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.json()["config_source"], "database")

    def test_port_is_bounded(self):
        self.assertEqual(
            self.client.patch(SETTINGS_URL, {"port": 0}, format="json").status_code,
            status.HTTP_400_BAD_REQUEST,
        )
        self.assertEqual(
            self.client.patch(SETTINGS_URL, {"port": 70000}, format="json").status_code,
            status.HTTP_400_BAD_REQUEST,
        )

    # --- password write semantics ---------------------------------------

    def test_password_is_stored_encrypted(self):
        self.client.patch(SETTINGS_URL, {"password": "hunter2"}, format="json")
        cfg = SiteEmailSetting.get()
        self.assertNotIn("hunter2", cfg.password_ciphertext)
        self.assertEqual(cfg.get_password(), "hunter2")

    def test_omitting_password_keeps_the_stored_one(self):
        self.client.patch(SETTINGS_URL, {"password": "hunter2"}, format="json")
        self.client.patch(SETTINGS_URL, {"host": "smtp.visiban.test"}, format="json")
        self.assertEqual(SiteEmailSetting.get().get_password(), "hunter2")

    def test_blank_password_clears_it(self):
        # Blank and absent must stay distinct, or editing the host would either
        # require re-typing the password or silently wipe it.
        self.client.patch(SETTINGS_URL, {"password": "hunter2"}, format="json")
        self.client.patch(SETTINGS_URL, {"password": ""}, format="json")
        self.assertFalse(SiteEmailSetting.get().password_set)

    # --- audit trail ----------------------------------------------------

    def test_server_change_is_audited_with_transition(self):
        self.client.patch(
            SETTINGS_URL, {"host": "smtp.visiban.test", "port": 465, "use_tls": False,
                           "use_ssl": True}, format="json"
        )
        row = AdminActionLog.objects.get(action=AdminActionLog.Action.EMAIL_SERVER_CHANGED)
        self.assertEqual(row.actor_username, "admin")
        self.assertIn("smtp.visiban.test:465", row.metadata["to"])
        self.assertIn("ssl", row.metadata["to"])

    def test_password_change_is_audited_without_any_value(self):
        self.client.patch(SETTINGS_URL, {"password": "hunter2"}, format="json")
        row = AdminActionLog.objects.get(action=AdminActionLog.Action.EMAIL_PASSWORD_CHANGED)
        self.assertEqual(row.metadata, {})
        self.assertNotIn("hunter2", str(row.metadata))

    def test_username_change_is_audited_without_the_value(self):
        # SMTP usernames are routinely email addresses, which must not be logged.
        self.client.patch(SETTINGS_URL, {"username": "mailer@visiban.test"}, format="json")
        row = AdminActionLog.objects.get(action=AdminActionLog.Action.EMAIL_USERNAME_CHANGED)
        self.assertEqual(row.metadata, {})

    def test_unchanged_value_writes_no_audit_row(self):
        # "Only real transitions are recorded" — a log padded with non-events
        # makes a retrospective unreadable.
        self.client.patch(SETTINGS_URL, {"host": "smtp.visiban.test"}, format="json")
        AdminActionLog.objects.all().delete()
        self.client.patch(SETTINGS_URL, {"host": "smtp.visiban.test"}, format="json")
        self.assertEqual(AdminActionLog.objects.count(), 0)

    def test_source_change_is_audited(self):
        self.client.patch(
            SETTINGS_URL,
            {"config_source": "database", "host": "smtp.visiban.test",
             "from_email": "db@visiban.test"},
            format="json",
        )
        row = AdminActionLog.objects.get(action=AdminActionLog.Action.EMAIL_SOURCE_CHANGED)
        self.assertEqual(row.metadata, {"from": "env", "to": "database"})


class PlaceholderSenderTests(TestCase):
    """The guard demoted from import time must still hold at send time.

    The realistic case is a partial env config: a real relay configured via
    EMAIL_HOST/EMAIL_HOST_USER but DEFAULT_FROM_EMAIL left at the shipped
    placeholder. Sending from a domain the operator does not control fails
    SPF/DMARC and silently breaks account recovery.
    """

    @override_settings(EMAIL_HOST="smtp.real.test", DEFAULT_FROM_EMAIL="noreply@example.com")
    def test_env_path_refuses_a_placeholder_sender(self):
        with self.assertRaises(EmailConfigUnusable):
            resolve_email_config()

    @override_settings(DEFAULT_FROM_EMAIL="noreply@example.com")
    def test_database_path_refuses_a_placeholder_sender(self):
        cfg = SiteEmailSetting.get()
        cfg.host = "smtp.real.test"
        cfg.from_email = "noreply@example.com"
        cfg.config_source = SiteEmailSetting.ConfigSource.DATABASE
        cfg.save()
        with self.assertRaises(EmailConfigUnusable):
            resolve_email_config()

    @override_settings(EMAIL_HOST="smtp.real.test", DEFAULT_FROM_EMAIL="noreply@visiban.test")
    def test_a_real_sender_resolves(self):
        self.assertEqual(resolve_email_config().from_email, "noreply@visiban.test")


# A real sender: the placeholder guard in resolve_email_config would otherwise
# (correctly) refuse every send here, since the test settings leave
# DEFAULT_FROM_EMAIL at the shipped noreply@example.com default.
@override_settings(DEFAULT_FROM_EMAIL="noreply@visiban.test")
class AdminEmailTestEndpointTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(
            username="admin", email="admin@visiban.test", password="pw", is_site_admin=True
        )
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    @override_settings(EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend")
    def test_success_sends_to_the_requesting_admin_only(self):
        with mock.patch("accounts.admin_views.build_smtp_backend") as build:
            build.return_value = mail.get_connection(
                "django.core.mail.backends.locmem.EmailBackend"
            )
            response = self.client.post(TEST_URL)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertTrue(response.json()["success"])
        self.assertEqual(len(mail.outbox), 1)
        # Never a body-supplied recipient — that would make this an open relay.
        self.assertEqual(mail.outbox[0].to, ["admin@visiban.test"])

    @override_settings(EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend")
    def test_body_supplied_recipient_is_ignored(self):
        with mock.patch("accounts.admin_views.build_smtp_backend") as build:
            build.return_value = mail.get_connection(
                "django.core.mail.backends.locmem.EmailBackend"
            )
            self.client.post(TEST_URL, {"to": "victim@elsewhere.test"}, format="json")

        self.assertEqual(mail.outbox[0].to, ["admin@visiban.test"])

    def test_auth_failure_returns_code_without_leaking_the_raw_error(self):
        # Some MTAs echo the offending protocol line back, which on an AUTH
        # failure can carry base64-encoded credentials. It must never reach the
        # client.
        secret_bearing = b"5.7.8 rejected AUTH PLAIN AGFkbWluAGh1bnRlcjI="
        with mock.patch("accounts.admin_views.build_smtp_backend") as build:
            build.return_value.send_messages.side_effect = smtplib.SMTPAuthenticationError(
                535, secret_bearing
            )
            response = self.client.post(TEST_URL)

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(response.json()["code"], "auth_failed")
        body = response.content.decode()
        self.assertNotIn("AUTH PLAIN", body)
        self.assertNotIn("AGFkbWluAGh1bnRlcjI=", body)

    def test_auth_failure_does_not_leak_the_raw_error_into_the_log(self):
        """The log sink gets the same protection as the response body.

        For SMTPAuthenticationError the exception message *is* the remote
        server's reply line, which on a rejected AUTH routinely echoes the
        offending command back — including base64 credentials. Logging it with
        exc_info=True would defeat the encryption-at-rest design for exactly
        the value it protects, and log aggregators are a far wider audience
        than the admins entitled to the relay credential.
        """
        secret_bearing = b"5.7.8 rejected AUTH PLAIN AGFkbWluAGh1bnRlcjI="
        with mock.patch("accounts.admin_views.build_smtp_backend") as build:
            build.return_value.send_messages.side_effect = smtplib.SMTPAuthenticationError(
                535, secret_bearing
            )
            with self.assertLogs("accounts.admin_views", level="WARNING") as captured:
                self.client.post(TEST_URL)

        logged = "\n".join(captured.output)
        self.assertNotIn("AGFkbWluAGh1bnRlcjI=", logged)
        self.assertNotIn("AUTH PLAIN", logged)
        self.assertNotIn("hunter2", logged)
        # The actionable taxonomy is still recorded.
        self.assertIn("auth_failed", logged)

    def test_backend_pin_refuses_the_test_instead_of_reporting_success(self):
        # With EMAIL_BACKEND pinned, neither source sends mail — testing the
        # resolved host would give a green check for a path production never
        # uses, and open an outbound connection on an install that opted out.
        with override_settings(EMAIL_BACKEND_EXPLICIT=True):
            with mock.patch("accounts.admin_views.build_smtp_backend") as build:
                response = self.client.post(TEST_URL)
            build.assert_not_called()

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(response.json()["code"], "backend_pinned")

    def test_connection_refused_is_classified(self):
        with mock.patch("accounts.admin_views.build_smtp_backend") as build:
            build.return_value.send_messages.side_effect = ConnectionRefusedError()
            response = self.client.post(TEST_URL)
        self.assertEqual(response.json()["code"], "connection_refused")

    def test_unusable_config_is_reported(self):
        cfg = SiteEmailSetting.get()
        cfg.config_source = SiteEmailSetting.ConfigSource.DATABASE
        cfg.save()
        response = self.client.post(TEST_URL)
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(response.json()["code"], "config_unusable")

    def test_admin_without_email_gets_actionable_error(self):
        self.admin.email = ""
        self.admin.save()
        response = self.client.post(TEST_URL)
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(response.json()["code"], "no_recipient")

    @override_settings(EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend")
    def test_outcome_is_audited_without_the_recipient(self):
        with mock.patch("accounts.admin_views.build_smtp_backend") as build:
            build.return_value = mail.get_connection(
                "django.core.mail.backends.locmem.EmailBackend"
            )
            self.client.post(TEST_URL)

        row = AdminActionLog.objects.get(action=AdminActionLog.Action.EMAIL_TEST_SENT)
        self.assertEqual(row.metadata, {"result": "success"})
        self.assertNotIn("admin@visiban.test", str(row.metadata))

    def test_test_endpoint_is_rate_limited(self):
        """The endpoint opens an outbound connection to an operator-supplied
        host, so the ceiling bounds both relay abuse and use as a network probe.
        Pinned here because the scope being wired is not self-evident from the
        view — dropping `throttle_classes` would silently remove it.

        The rate is patched rather than overridden through settings: DRF caches
        DEFAULT_THROTTLE_RATES on its own APISettings object, so
        override_settings(REST_FRAMEWORK=...) does not reach it.
        """
        from accounts.admin_views import EmailTestThrottle

        EmailTestThrottle().cache.clear()
        with mock.patch.object(EmailTestThrottle, "get_rate", return_value="2/hour"):
            with mock.patch("accounts.admin_views.build_smtp_backend") as build:
                build.return_value.send_messages.side_effect = ConnectionRefusedError()
                first = self.client.post(TEST_URL)
                second = self.client.post(TEST_URL)
                third = self.client.post(TEST_URL)

        self.assertEqual(first.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(second.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(third.status_code, status.HTTP_429_TOO_MANY_REQUESTS)
        EmailTestThrottle().cache.clear()

    def test_failure_is_audited(self):
        with mock.patch("accounts.admin_views.build_smtp_backend") as build:
            build.return_value.send_messages.side_effect = ConnectionRefusedError()
            self.client.post(TEST_URL)
        row = AdminActionLog.objects.get(action=AdminActionLog.Action.EMAIL_TEST_SENT)
        self.assertEqual(row.metadata, {"result": "failure"})
