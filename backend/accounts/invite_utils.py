"""Shared invite token validation used by both REST registration and OAuth signup."""

import hashlib

from django.db import transaction
from django.utils import timezone

from .models import InviteLink


class InviteTokenError(Exception):
    """Raised when an invite token is invalid, expired, used, or revoked."""

    def __init__(self, code: str, detail: str):
        self.code = code
        self.detail = detail
        super().__init__(detail)


def validate_invite_token(raw_token: str) -> InviteLink:
    """Validate an invite token and return the InviteLink row (locked for update).

    Must be called inside a transaction.atomic() block. The caller is
    responsible for consuming the token (stamping used_at) after successful
    user creation.

    Raises InviteTokenError with a machine-readable code on failure:
      - "invite_missing"  — empty or missing token
      - "invite_invalid"  — no matching token (wrong value, already used, or revoked)
      - "invite_expired"  — token exists but past its expiry
    """
    if not raw_token or not raw_token.strip():
        raise InviteTokenError("invite_missing", "An invite link is required to register.")

    raw_token = raw_token.strip()
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()

    try:
        link = InviteLink.objects.select_for_update().get(
            token_hash=token_hash,
            used_at__isnull=True,
            revoked_at__isnull=True,
        )
    except InviteLink.DoesNotExist:
        raise InviteTokenError("invite_invalid", "Invalid or expired invite link.")

    if link.expires_at and link.expires_at < timezone.now():
        raise InviteTokenError("invite_expired", "This invite link has expired.")

    return link


def consume_invite_token(link: InviteLink) -> None:
    """Mark a single-use invite token as consumed. No-op for multi-use tokens."""
    if link.single_use:
        link.used_at = timezone.now()
        link.save(update_fields=["used_at"])
