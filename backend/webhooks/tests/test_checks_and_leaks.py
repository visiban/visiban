"""System checks, and the places a URL or secret must never appear (#863)."""

from datetime import timedelta

from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from visiban import crypto
from webhooks.checks import check_allowed_private_targets, check_webhooks_not_in_demo_mode
from webhooks.models import WebhookSubscription
from webhooks.serializers import (
    WebhookCreatedSerializer,
    WebhookRotatedSerializer,
    WebhookSubscriptionSerializer,
)

from .base import ENABLED, admin_and_board, make_subscription


class SystemCheckTests(TestCase):
    @override_settings(WEBHOOKS_ENABLED=True, DEMO_MODE=True)
    def test_enabled_in_demo_mode_is_an_error(self):
        errors = check_webhooks_not_in_demo_mode(None)
        self.assertEqual([e.id for e in errors], ["webhooks.E001"])

    @override_settings(WEBHOOKS_ENABLED=True, DEMO_MODE=False)
    def test_enabled_outside_demo_is_fine(self):
        self.assertEqual(check_webhooks_not_in_demo_mode(None), [])

    def test_bad_allowlist_entries_are_errors(self):
        for value in ("0.0.0.0/0", "8.8.8.0/24", "10.0.0.0/7", "224.0.0.1"):
            with self.subTest(value=value), override_settings(WEBHOOK_ALLOWED_PRIVATE_TARGETS=value):
                self.assertEqual([e.id for e in check_allowed_private_targets(None)], ["webhooks.E002"])

    @override_settings(WEBHOOK_ALLOWED_PRIVATE_TARGETS="n8n.lan,10.0.0.0/8,127.0.0.1")
    def test_good_allowlist_is_fine(self):
        self.assertEqual(check_allowed_private_targets(None), [])


@ENABLED
class NoLeakTests(TestCase):
    def setUp(self):
        self.admin, self.board = admin_and_board()
        self.sub = make_subscription(self.board, self.admin, secret="whsec_leakcheck")
        self.previous = crypto.encrypt_secret("whsec_previous", info=crypto.WEBHOOK_SECRET_INFO)
        WebhookSubscription.objects.filter(pk=self.sub.pk).update(
            previous_secret_encrypted=self.previous,
            previous_secret_expires_at=timezone.now() + timedelta(hours=1),
        )
        self.sub.refresh_from_db()

    def test_no_serializer_carries_the_previous_secret(self):
        for serializer in (WebhookSubscriptionSerializer, WebhookCreatedSerializer, WebhookRotatedSerializer):
            with self.subTest(serializer=serializer.__name__):
                self.assertNotIn("previous_secret_encrypted", serializer().fields)
                data = serializer(self.sub).data
                self.assertNotIn("previous_secret_encrypted", data)
                self.assertIsNotNone(data["previous_secret_expires_at"])
                self.assertNotIn(self.previous, str(data))
                self.assertNotIn("whsec_previous", str(data))

    def test_board_export_carries_no_subscription(self):
        c = APIClient()
        c.force_login(self.admin)
        for fmt in ("json", "csv"):
            with self.subTest(fmt=fmt):
                r = c.get(f"/api/v1/boards/{self.board.pk}/export/?format={fmt}")
                self.assertEqual(r.status_code, 200)
                body = b"".join(r.streaming_content) if getattr(r, "streaming", False) else r.content
                self.assertNotIn(b"hooks.example.com", body)
                self.assertNotIn(b"whsec_", body)
                self.assertNotIn(b"webhook", body.lower())
                self.assertNotIn(self.previous.encode(), body)

    def test_str_and_repr_never_show_the_url(self):
        for text in (str(self.sub), repr(self.sub)):
            self.assertNotIn("s3cr3tpath", text)
            self.assertNotIn("whsec_", text)
            self.assertNotIn(self.previous, text)

    def test_not_registered_in_django_admin(self):
        from django.contrib import admin

        self.assertNotIn(WebhookSubscription, admin.site._registry)
