"""Shared fixtures for the webhooks tests (#863). Not collected (no test_ prefix)."""

import ipaddress
from contextlib import contextmanager
from datetime import timedelta
from io import StringIO
from unittest.mock import patch

from django.core.management import call_command
from django.test import override_settings
from django.utils import timezone

from boards.models import BoardEvent
from boards.tests.conftest import _make_board, _make_membership, _make_user
from visiban import egress
from webhooks.models import WebhookSubscription, generate_secret

PUBLIC_IP = "93.184.216.34"
HOOK_URL = "https://hooks.example.com/services/T000/B000/s3cr3tpath?token=abc"

ENABLED = override_settings(
    WEBHOOKS_ENABLED=True,
    DEMO_MODE=False,
    WEBHOOK_SETTLE_SECONDS=0,
    WEBHOOK_ALLOWED_PRIVATE_TARGETS="",
    # The constant-time refusal floor is pinned by its own test; elsewhere it
    # would only make the suite slow.
    WEBHOOK_REFUSAL_FLOOR_SECONDS=0,
)


@contextmanager
def resolving(*addrs):
    with patch.object(egress, "_resolve", return_value=[ipaddress.ip_address(a) for a in addrs or (PUBLIC_IP,)]):
        yield


def make_subscription(board, user, *, url=HOOK_URL, secret=None, **fields):
    sub = WebhookSubscription(
        board=board,
        created_by=user,
        configured_by=user,
        configured_at=timezone.now(),
        **fields,
    )
    sub.set_url(url, egress.parse_url(url).host)
    sub.set_secret(secret or generate_secret())
    sub.save()
    return sub


def prune(*events):
    """Prune *events* the way retention does (#2058).

    Backdates them past a one-day window and runs ``prune_board_events``, which
    deletes them and raises their board's prune mark in one transaction. A bare
    ``.delete()`` would remove the rows without the record the expiry rule
    reads, which no supported path does.
    """
    BoardEvent.objects.filter(pk__in=[e.pk for e in events]).update(
        created_at=timezone.now() - timedelta(days=3)
    )
    call_command("prune_board_events", days=1, stdout=StringIO())


def admin_and_board(name="Hooks board"):
    admin = _make_user(email=f"{name.replace(' ', '').lower()}-admin@example.com")
    board = _make_board(admin, name=name)
    return admin, board


__all__ = [
    "ENABLED",
    "HOOK_URL",
    "PUBLIC_IP",
    "admin_and_board",
    "make_subscription",
    "prune",
    "resolving",
    "_make_membership",
    "_make_user",
    "_make_board",
]
