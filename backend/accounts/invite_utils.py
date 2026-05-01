"""Shared invite token validation used by both REST registration and OAuth signup."""

import hashlib

from django.db import IntegrityError
from django.db.models import F
from django.utils import timezone

from .models import InviteLink, InviteLinkRedemption


class InviteTokenError(Exception):
    """Raised when an invite token is invalid, expired, used, or revoked."""

    def __init__(self, code: str, detail: str):
        self.code = code
        self.detail = detail
        super().__init__(detail)


def _normalize_email_for_dedup(email: str) -> str:
    """Canonical normalisation used everywhere a redemption is checked or
    written.  The unique constraint on InviteLinkRedemption depends on this
    being identical across call sites — inconsistent normalisation silently
    defeats the dedup (#925).

    Only lowercase + strip.  Gmail's dot/plus collapsing is intentionally not
    applied: ``alice+work@example.com`` and ``alice@example.com`` are different
    legitimate addresses and collapsing them would falsely reject one of them.
    """
    return (email or "").strip().lower()


def _email_hash_for_dedup(email: str) -> str:
    """SHA-256 of the normalised email; used as the InviteLinkRedemption key."""
    return hashlib.sha256(_normalize_email_for_dedup(email).encode()).hexdigest()


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


def consume_invite_token(link: InviteLink, email: str | None = None) -> None:
    """Record consumption of an invite token.

    Always increments ``use_count`` for audit visibility — including multi-use
    links, where this is the only signal operators have for how widely a
    leaked link was used before revocation. For single-use links, additionally
    stamps ``used_at`` so the link cannot be reused.

    Uses ``F()`` expressions so the increment is atomic at the database level
    even when the caller does not hold a row lock — the OAuth ``save_user``
    path (RegistrationAdapter) is one such caller.

    When ``email`` is provided AND the link is multi-use, a row is also written
    to ``InviteLinkRedemption`` so the same email cannot redeem the same link
    twice (#925).  A duplicate redemption raises
    ``InviteTokenError("invite_already_redeemed", ...)`` — the caller's atomic
    block must roll back any in-flight user creation.  Single-use links are
    already gated by ``used_at`` and do not write a redemption row.
    """
    if email and not link.single_use:
        try:
            InviteLinkRedemption.objects.create(
                invite_link=link,
                email_hash=_email_hash_for_dedup(email),
            )
        except IntegrityError:
            # The unique constraint on (invite_link, email_hash) caught a
            # repeat redemption — could be a sequential reuse or a concurrent
            # race.  Surface as a clean InviteTokenError so the caller can
            # convert to 409 and the surrounding atomic block rolls back.
            raise InviteTokenError(
                "invite_already_redeemed",
                "This invite link has already been redeemed with that email address.",
            )
    InviteLink.objects.filter(pk=link.pk).update(use_count=F("use_count") + 1)
    if link.single_use:
        InviteLink.objects.filter(pk=link.pk).update(used_at=timezone.now())
    link.refresh_from_db(fields=["use_count", "used_at"])
