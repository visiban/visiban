"""Self-service email change under ``EMAIL_VERIFICATION=mandatory`` (#1273).

``PATCH /auth/me/`` (and dj-rest-auth's ``/auth/user/``) keep ``email``
writable — that is part of the 1.0 API contract. But on an install that
requires verified addresses, writing the new value straight to ``User.email``
would let an account adopt an address nobody has proved they own, and then
receive that address's mail (notifications, password resets) and log in with
it. So under ``mandatory`` the change is held as an unverified, non-primary
allauth ``EmailAddress`` row plus allauth's normal confirmation email, and
``User.pending_email_address`` points at that row. ``User.email`` is left
alone until the link is followed.

The pointer is what makes a row a change request. "Unverified and
non-primary" alone is not enough: social signup imports unverified secondary
addresses, and allauth's /accounts/email/ page can add them, and neither is a
change the user asked for here. Only the tracked row is reported, replaced,
or promoted.

Confirmation needs no new endpoint: the link goes through the existing SPA
``/confirm-email/<key>`` route and ``POST /auth/registration/verify-email/``,
i.e. allauth's ``verify_email`` flow. That flow only makes an address primary
when the user has no primary yet (``ACCOUNT_CHANGE_EMAIL`` is off here), so
``apply_confirmed_email_change`` below finishes the switch from allauth's
``email_confirmed`` signal. ``ACCOUNT_CHANGE_EMAIL`` itself is deliberately not
turned on: its ``add_new_email`` treats *any* unverified row as the pending
change and deletes it (the same inference problem as above), which would also delete (and blank ``User.email`` for)
an account whose current primary address simply was never verified.

A pending change can be withdrawn or its link re-sent from Settings (#1293):
``DELETE /auth/me/pending-email/`` and ``POST /auth/me/pending-email/resend/``
call ``cancel_email_change`` and ``resend_email_change`` below. An address
another account has already verified can never be confirmed here
(``ACCOUNT_UNIQUE_EMAIL``); the verify-email endpoint answers that with a 409
to the link holder only (see ``accounts.views.VerifyEmailView``).

Email addresses are personal data: nothing in this module logs one.
"""

from django.conf import settings
from django.db import transaction


def email_verification_mandatory() -> bool:
    return getattr(settings, "ACCOUNT_EMAIL_VERIFICATION", "optional") == "mandatory"


def _set_pending_pointer(user, address) -> None:
    """Point ``user.pending_email_address`` at ``address`` (or clear it), in DB and in memory.

    A queryset update rather than ``user.save()``: allauth's ``set_as_primary``
    saves its own copy of the user, and a full save here from a stale instance
    would race it.
    """
    from django.contrib.auth import get_user_model

    get_user_model().objects.filter(pk=user.pk).update(pending_email_address=address)
    user.pending_email_address = address


def _drop_tracked_row(user, keep_pk=None) -> None:
    """Delete the row this flow is tracking for ``user`` (unless it is ``keep_pk``).

    Only the tracked row is ever deleted — never an unverified secondary address
    that social signup or allauth's /accounts/email/ page created — and only
    while it is still unverified and non-primary, as a guard against a pointer
    that has drifted onto a row that has since been confirmed.
    """
    from allauth.account.models import EmailAddress

    tracked_pk = user.pending_email_address_id
    if tracked_pk is None or tracked_pk == keep_pk:
        return
    EmailAddress.objects.filter(
        pk=tracked_pk, user=user, verified=False, primary=False
    ).delete()


def get_pending_email(user) -> str | None:
    """The address ``user`` asked to change to and has not yet confirmed, or None.

    No query at all for the common case of no change in flight.
    """
    from allauth.account.models import EmailAddress

    if user.pending_email_address_id is None:
        return None
    return (
        # Scoped to the user as well as the pk: if the row were ever reassigned to
        # another account (e.g. by an admin), it must not surface here.
        EmailAddress.objects.filter(
            pk=user.pending_email_address_id, user_id=user.pk, verified=False
        )
        .values_list("email", flat=True)
        .first()
    )


def cancel_email_change(user) -> None:
    """Withdraw ``user``'s pending email change, if any.

    Reached by PATCHing ``email`` back to the current address, or by
    ``DELETE /auth/me/pending-email/`` (#1293): the tracked row is deleted (so
    its link stops working) and the pointer cleared.
    """
    if user.pending_email_address_id is None:
        return
    with transaction.atomic():
        _drop_tracked_row(user)
        _set_pending_pointer(user, None)


def _tracked_row(user):
    """The still-unconfirmed ``EmailAddress`` row ``user``'s pending change tracks, or None.

    Scoped to ``user`` and to unverified, non-primary rows — the same guard as
    ``_drop_tracked_row`` — so a pointer that drifted onto a confirmed row, or
    a row reassigned to another account, is never acted on.
    """
    from allauth.account.models import EmailAddress

    if user.pending_email_address_id is None:
        return None
    return EmailAddress.objects.filter(
        pk=user.pending_email_address_id, user_id=user.pk, verified=False, primary=False
    ).first()


def resend_email_change(request, user) -> bool | None:
    """Send the confirmation link for ``user``'s pending email change again (#1293).

    Returns None when no change is pending, True when a new email was sent,
    and False when allauth's ``confirm_email`` rate limit (one per address per
    ``ACCOUNT_EMAIL_CONFIRMATION_COOLDOWN``, 3 minutes by default) skipped it.
    This goes through allauth's own send, not a separate mailer, so the
    cooldown is shared with the send that ``request_email_change`` made: a
    resend cannot be used to mail an address more often than a change
    request could. The earlier link keeps working either way — HMAC keys are
    not invalidated by a resend.
    """
    from allauth.account.internal.flows.email_verification import (
        send_verification_email_to_address,
    )

    row = _tracked_row(user)
    if row is None:
        return None
    return bool(send_verification_email_to_address(request, row))


def request_email_change(request, user, new_email: str) -> bool:
    """Start a verified change of ``user``'s email to ``new_email``.

    Returns True when the change took effect immediately — only when the
    address is already a verified address of this same account, so there is
    nothing left to prove — and False when it is now pending confirmation.

    Any earlier pending change is replaced: only the most recent request can
    be confirmed, so an old link sent to an address the user abandoned stops
    working. If the account already has an unverified row for exactly this
    address (e.g. imported by a social login), that row is adopted as the
    pending change rather than duplicated — (user, email) is unique.
    """
    from allauth.account.internal.flows.email_verification import (
        send_verification_email_to_address,
    )
    from allauth.account.models import EmailAddress

    new_email = new_email.lower()
    with transaction.atomic():
        existing = EmailAddress.objects.filter(user=user, email=new_email).first()
        if existing is not None and existing.verified:
            # Switching to an address this account has already verified.
            existing.set_as_primary()
            _drop_tracked_row(user, keep_pk=existing.pk)
            _set_pending_pointer(user, None)
            return True
        _drop_tracked_row(user, keep_pk=existing.pk if existing else None)
        if existing is None:
            existing = EmailAddress.objects.create(
                user=user, email=new_email, verified=False, primary=False
            )
        _set_pending_pointer(user, existing)
    # Outside the transaction: the row must be committed before the link in
    # the email can be followed. allauth's own confirm_email rate limit
    # applies here and silently skips a resend that exceeds it — the link in
    # the earlier email still works.
    send_verification_email_to_address(request, existing)
    return False


def confirmation_would_collide(email_address) -> bool:
    """Whether confirming this pending change would clash with another account (#1221).

    ``PATCH /auth/me/`` skips the username/email cross-check under
    ``mandatory`` so the requester gets no "taken" signal before proving
    ownership. But proving ownership of a mailbox only rules out *takeover*:
    another active account can still hold the same address in ``User.email``
    unverified (admin-created, SSO-provisioned, or signed up under
    ``optional``) — allauth's ``can_set_verified`` only looks for *verified*
    rows. Promoting the address then leaves two active accounts sharing it,
    and the login resolver fails closed on that, switching off email login
    for the other account as well. So the check that was deferred at request
    time runs here, at the point the address would reach ``User.email``.

    Only the change this flow tracks is checked; a signup confirmation
    doesn't write ``User.email`` (it was written at signup), so it is left
    to allauth's own rules.
    """
    from django.contrib.auth import get_user_model

    from .validators import email_collides_with_identifier

    is_tracked = get_user_model().objects.filter(
        pk=email_address.user_id, pending_email_address_id=email_address.pk
    ).exists()
    return is_tracked and email_collides_with_identifier(
        email_address.email, exclude_pk=email_address.user_id
    )


def apply_confirmed_email_change(sender, request, email_address, **kwargs):
    """``email_confirmed`` receiver: make the confirmed pending address the account's email.

    Acts only on the row ``User.pending_email_address`` tracks; confirming any
    other address (a signup address, or one added on allauth's own pages)
    keeps allauth's default behavior untouched.

    allauth has already marked the row verified. If the account had no
    primary address it has also made this one primary and synced
    ``User.email``. Otherwise promote it (``set_as_primary`` updates
    ``User.email``) and drop the primary it replaces, so the old address no
    longer counts as a verified address of this account (the notification
    email gate reads verified ``EmailAddress`` rows).
    """
    from allauth.account.models import EmailAddress
    from django.contrib.auth import get_user_model

    User = get_user_model()
    with transaction.atomic():
        user = (
            User.objects.select_for_update()
            .filter(pk=email_address.user_id, pending_email_address_id=email_address.pk)
            .first()
        )
        if user is None:
            return
        # Defense in depth for any confirmation that reaches here without going
        # through VerifyEmailView's 409 (#1221): leave User.email alone. The
        # pointer stays set so the change still reads as pending and can be
        # withdrawn, exactly as a change blocked by the 409 does.
        if not email_address.primary and confirmation_would_collide(email_address):
            return
        if not email_address.primary:
            previous_ids = list(
                EmailAddress.objects.filter(user_id=user.pk, primary=True)
                .exclude(pk=email_address.pk)
                .values_list("pk", flat=True)
            )
            email_address.set_as_primary()
            EmailAddress.objects.filter(pk__in=previous_ids).delete()
        _set_pending_pointer(user, None)
