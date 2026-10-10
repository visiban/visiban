"""Shared invite token validation used by both REST registration and OAuth signup."""

import hashlib

from django.db import IntegrityError
from django.db.models import F
from django.utils import timezone

from visiban.authorization import invite_creator_is_valid, sender_may_admit_accounts

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


def site_invite_creator_admits(link: InviteLink) -> bool:
    """Creator rule for site invites (registry Rule 2).

    A site invite admits a brand-new account, so its creator must still be
    someone who may admit accounts: an active site admin. Registered in
    ``visiban.authorization.INVITE_CREATOR_RULES`` and evaluated at redemption,
    so a link whose creator was demoted, deactivated or deleted (``created_by``
    is ``SET_NULL``) stops admitting people however that change was made —
    admin API, Django admin, a management command, or an extension.
    """
    return sender_may_admit_accounts(link.created_by)


def _creator_admits_cached(link: InviteLink, memo: dict | None) -> bool:
    """The redemption-time creator rule, memoized per creator for lists."""
    if memo is None:
        return invite_creator_is_valid(link)
    key = link.created_by_id
    if key not in memo:
        memo[key] = invite_creator_is_valid(link)
    return memo[key]


def effective_site_invite_status(link: InviteLink, memo: dict | None = None) -> str:
    """The status an admin should see: the model's, except that a pending link
    whose creator may no longer admit accounts reports ``revoked`` — redemption
    already refuses it with ``invite_invalid``. Read only: nothing is written.

    Same shape as ``boards.invites.effective_status``; *memo* caches the
    creator check across a list (few distinct creators, many links).
    """
    current = link.status
    if current == "pending" and not _creator_admits_cached(link, memo):
        return "revoked"
    return current


def live_site_invite_count(*, delivery: str) -> int:
    """Pending site invites of one ``delivery`` kind that hold a cap slot.

    Pending = not revoked, not used, not expired, and the creator still admits
    accounts (the redemption rule), so a link redemption would refuse does not
    occupy a slot. Callers hold the SiteSetting row lock.
    """
    pending = (
        InviteLink.objects.filter(used_at__isnull=True, revoked_at__isnull=True, delivery=delivery)
        .exclude(expires_at__lt=timezone.now())
        .select_related("created_by")
    )
    memo: dict = {}
    return sum(1 for link in pending if _creator_admits_cached(link, memo))


def revoke_site_invite_links(creator) -> int:
    """Revoke every pending site invite *creator* made; return how many.

    Called when the creator is deactivated or loses site admin (admin API and
    ``set_site_admin --revoke``). Redemption re-checks the creator as well
    (:func:`site_invite_creator_admits`), which covers any route that changes
    a user without coming through here.
    """
    return InviteLink.objects.filter(
        created_by=creator,
        used_at__isnull=True,
        revoked_at__isnull=True,
    ).update(revoked_at=timezone.now())


def validate_invite_token(raw_token: str) -> InviteLink:
    """Validate an invite token and return the InviteLink row (locked for update).

    Must be called inside a transaction.atomic() block. The caller is
    responsible for consuming the token (stamping used_at) after successful
    user creation.

    Raises InviteTokenError with a machine-readable code on failure:
      - "invite_missing"  — empty or missing token
      - "invite_invalid"  — no matching token (wrong value, already used, or
        revoked), or its creator may no longer admit accounts
      - "invite_expired"  — token exists but past its expiry
    """
    if not raw_token or not raw_token.strip():
        raise InviteTokenError("invite_missing", "An invite link is required to register.")

    raw_token = raw_token.strip()
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()

    try:
        # of=("self",): lock only the invite row. created_by is a nullable FK,
        # and PostgreSQL refuses FOR UPDATE on the nullable side of the outer
        # join select_related adds for it.
        link = InviteLink.objects.select_for_update(of=("self",)).select_related("created_by").get(
            token_hash=token_hash,
            used_at__isnull=True,
            revoked_at__isnull=True,
        )
    except InviteLink.DoesNotExist:
        raise InviteTokenError("invite_invalid", "Invalid or expired invite link.")

    if link.expires_at and link.expires_at < timezone.now():
        raise InviteTokenError("invite_expired", "This invite link has expired.")

    # Creator standing is re-checked here, under the row lock taken above, not
    # trusted from mint time. Same generic answer as an unknown token: the
    # response says nothing about the creator's account.
    if not invite_creator_is_valid(link):
        raise InviteTokenError("invite_invalid", "Invalid or expired invite link.")

    return link


def consume_invite_token(link: InviteLink, email: str | None = None) -> None:
    """Record consumption of an invite token.

    Always increments ``use_count`` for audit visibility — including multi-use
    links, where this is the only signal operators have for how widely a
    leaked link was used before revocation. For single-use links, additionally
    stamps ``used_at`` so the link cannot be reused.

    Callers run inside the same ``transaction.atomic()`` as ``validate_invite_token``
    and so hold its row lock (REST registration and the OAuth ``save_user``,
    #1489). The single-use stamp is nevertheless conditional on ``used_at IS
    NULL`` as defense in depth, matching the group and board kinds: a lost
    race raises ``InviteTokenError("invite_invalid")`` instead of silently
    double-consuming, and the caller's rollback discards the new account.
    ``F()`` keeps the ``use_count`` increment atomic at the database level.

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
    if link.single_use:
        stamped = InviteLink.objects.filter(pk=link.pk, used_at__isnull=True).update(
            used_at=timezone.now()
        )
        if not stamped:
            raise InviteTokenError("invite_invalid", "Invalid or expired invite link.")
    InviteLink.objects.filter(pk=link.pk).update(use_count=F("use_count") + 1)
    link.refresh_from_db(fields=["use_count", "used_at"])
