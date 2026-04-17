"""Shared invite token validation used by both REST registration and OAuth signup."""

import hashlib

from django.db.models import F
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
    """Record consumption of an invite token.

    Always increments ``use_count`` for audit visibility — including multi-use
    links, where this is the only signal operators have for how widely a
    leaked link was used before revocation. For single-use links, additionally
    stamps ``used_at`` so the link cannot be reused.

    Uses ``F()`` expressions so the increment is atomic at the database level
    even when the caller does not hold a row lock — the OAuth ``save_user``
    path (RegistrationAdapter) is one such caller.
    """
    InviteLink.objects.filter(pk=link.pk).update(use_count=F("use_count") + 1)
    if link.single_use:
        InviteLink.objects.filter(pk=link.pk).update(used_at=timezone.now())
    link.refresh_from_db(fields=["use_count", "used_at"])
