"""Self-service email change under ``EMAIL_VERIFICATION=mandatory`` (#1273).

``PATCH /auth/me/`` (and dj-rest-auth's ``/auth/user/``) keep ``email``
writable — that is part of the 1.0 API contract. But on an install that
requires verified addresses, writing the new value straight to ``User.email``
would let an account adopt an address nobody has proved they own, and then
receive that address's mail (notifications, password resets) and log in with
it. So under ``mandatory`` the change is held as allauth's own "pending"
state: an unverified, non-primary ``EmailAddress`` row plus allauth's normal
confirmation email. ``User.email`` is left alone until the link is followed.

Confirmation needs no new endpoint: the link goes through the existing SPA
``/confirm-email/<key>`` route and ``POST /auth/registration/verify-email/``,
i.e. allauth's ``verify_email`` flow. That flow only makes an address primary
when the user has no primary yet (``ACCOUNT_CHANGE_EMAIL`` is off here), so
``apply_confirmed_email_change`` below finishes the switch from allauth's
``email_confirmed`` signal. ``ACCOUNT_CHANGE_EMAIL`` itself is deliberately not
turned on: its ``add_new_email`` treats *any* unverified row as the pending
change and deletes it, which would also delete (and blank ``User.email`` for)
an account whose current primary address simply was never verified.

Email addresses are personal data: nothing in this module logs one.
"""

from django.conf import settings
from django.db import transaction


def email_verification_mandatory() -> bool:
    return getattr(settings, "ACCOUNT_EMAIL_VERIFICATION", "optional") == "mandatory"


def _pending_queryset(user):
    """Unverified, non-primary addresses: the change(s) awaiting confirmation."""
    from allauth.account.models import EmailAddress

    return EmailAddress.objects.filter(user=user, verified=False, primary=False)


def get_pending_email(user) -> str | None:
    """The address ``user`` asked to change to and has not yet confirmed, or None."""
    current = (user.email or "").lower()
    pending = (
        _pending_queryset(user)
        .exclude(email=current)
        .order_by("-pk")
        .values_list("email", flat=True)
        .first()
    )
    return pending


def request_email_change(request, user, new_email: str) -> bool:
    """Start a verified change of ``user``'s email to ``new_email``.

    Returns True when the change took effect immediately — only when the
    address is already a verified address of this same account, so there is
    nothing left to prove — and False when it is now pending confirmation.

    Any earlier pending change is replaced: only the most recent request can
    be confirmed, so an old link sent to an address the user abandoned stops
    working.
    """
    from allauth.account.internal.flows.email_verification import (
        send_verification_email_to_address,
    )
    from allauth.account.models import EmailAddress

    new_email = new_email.lower()
    with transaction.atomic():
        existing = EmailAddress.objects.filter(user=user, email=new_email).first()
        if existing is not None and existing.verified:
            # Switching back to an address this account already verified.
            existing.set_as_primary()
            _pending_queryset(user).exclude(pk=existing.pk).delete()
            return True
        _pending_queryset(user).exclude(email=new_email).delete()
        if existing is None:
            existing = EmailAddress.objects.create(
                user=user, email=new_email, verified=False, primary=False
            )
    # Outside the transaction: the row must be committed before the link in
    # the email can be followed. allauth's own confirm_email rate limit
    # applies here and silently skips a resend that exceeds it — the link in
    # the earlier email still works.
    send_verification_email_to_address(request, existing)
    return False


def apply_confirmed_email_change(sender, request, email_address, **kwargs):
    """``email_confirmed`` receiver: make a confirmed pending address the account's email.

    allauth has already marked the row verified. If the account had no
    primary address it has also made this one primary and synced
    ``User.email``, and there is nothing to do. Otherwise this row is a
    confirmed change request: promote it (``set_as_primary`` updates
    ``User.email``) and drop the address it replaces, so the old address no
    longer counts as a verified address of this account (the notification
    email gate reads verified ``EmailAddress`` rows).
    """
    from allauth.account.models import EmailAddress

    if email_address.primary:
        return
    with transaction.atomic():
        previous = EmailAddress.objects.filter(
            user_id=email_address.user_id, primary=True
        ).exclude(pk=email_address.pk)
        previous_ids = list(previous.values_list("pk", flat=True))
        email_address.set_as_primary()
        EmailAddress.objects.filter(pk__in=previous_ids).delete()
        # Any other still-pending request is superseded by this confirmation.
        _pending_queryset(email_address.user).exclude(pk=email_address.pk).delete()
