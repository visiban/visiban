"""Registration through an emailed group invite on invite-only sites (#1445).

On an INVITE_ONLY site, a site invite link (``vbnl_``) has always been the only
thing that authorizes creating an account. A group admin's emailed invite
(#731) reached a brand-new person who then dead-ended at sign-up. This module
lets exactly one kind of group invite stand in for a site invite:

- ``delivery=email`` — minted by the send-invite endpoint and delivered to one
  address, never copied around by an admin;
- ``single_use=True`` — consumed by the first registration, so one email
  authorizes at most one account (strictly on password registration, which
  holds the row lock; best-effort on OAuth, exactly like site invites there —
  see ``SocialRegistrationAdapter.save_user``); and
- sent by someone who is still an active admin of the group.

A shareable group link (``delivery=link``, single-use or not) is refused: it is
built to be pasted into chat, and letting it register accounts would let any
group admin open an invite-only site to whoever the link reaches. CLOSED mode
is untouched — the caller only reaches this module in INVITE_ONLY mode.

The registration both authorizes the account and redeems the invite (joins the
group with the link's role and stamps ``used_at``) in the caller's transaction.
Redeeming at registration — instead of leaving the join for the SPA's
follow-up ``POST /groups/join/<token>/`` — is what keeps the token from
authorizing a second account between the two requests.
"""

import logging

from django.db import transaction
from django.utils import timezone

from accounts.invite_utils import InviteTokenError

from . import broadcast as _group_broadcast
from .models import GroupInviteLink, GroupMembership

logger = logging.getLogger(__name__)

NOT_FOR_REGISTRATION_DETAIL = (
    "This invite link can't be used to create an account. "
    "Ask a group admin to send an invite to your email address."
)


def is_group_invite_token(raw_token: str) -> bool:
    """True when ``raw_token`` has the group-invite prefix (``vbng_``)."""
    return (raw_token or "").strip().startswith(GroupInviteLink.GROUP_INVITE_PREFIX)


def validate_group_registration_token(raw_token: str) -> GroupInviteLink:
    """Return the emailed, single-use group invite for ``raw_token``, row-locked.

    Must be called inside ``transaction.atomic()``. The ``select_for_update``
    serializes two concurrent registrations presenting the same token: the
    second waits for the first to commit, then sees ``used_at`` set.

    Raises ``InviteTokenError`` with the same codes as the site-invite
    validator (``invite_missing`` / ``invite_invalid`` / ``invite_expired``)
    plus ``invite_not_for_registration`` for a live group link that is not an
    emailed single-use invite. Telling a token holder their link is shareable
    discloses nothing: they already hold it, and the public join preview
    accepts it.
    """
    raw_token = (raw_token or "").strip()
    if not raw_token:
        raise InviteTokenError("invite_missing", "An invite link is required to register.")

    try:
        link = GroupInviteLink.objects.select_for_update().get(
            token_hash=GroupInviteLink._hash_token(raw_token),
            is_active=True,
        )
    except GroupInviteLink.DoesNotExist:
        raise InviteTokenError("invite_invalid", "Invalid or expired invite link.")

    if not (link.single_use and link.delivery == GroupInviteLink.Delivery.EMAIL):
        raise InviteTokenError("invite_not_for_registration", NOT_FOR_REGISTRATION_DETAIL)
    if link.used_at is not None:
        raise InviteTokenError("invite_invalid", "Invalid or expired invite link.")
    if link.is_expired:
        raise InviteTokenError("invite_expired", "This invite link has expired.")
    if not _sender_still_admits(link):
        raise InviteTokenError("invite_invalid", "Invalid or expired invite link.")
    return link


def _sender_still_admits(link: GroupInviteLink) -> bool:
    """True when whoever sent the invite could still send it now.

    Before #1445 an emailed group invite could only add an *existing* account
    to a group; now it creates accounts. A sender who has since been
    deactivated, or is no longer an admin of the group (or an ancestor), must
    not keep admitting new people through invites already in flight — the
    same reason site invites are revoked when their creator is deactivated.
    The plain join path is unchanged: it never created accounts.
    """
    from rest_framework.exceptions import PermissionDenied

    from .views import _require_group_admin

    sender = link.created_by
    if sender is None or not sender.is_active:
        return False
    try:
        _require_group_admin(sender, link.group)
    except PermissionDenied:
        return False
    return True


def redeem_group_registration_token(link: GroupInviteLink, user) -> None:
    """Join ``user`` to the invite's group with its role and consume the invite.

    The ``used_at`` stamp is a conditional update (``used_at IS NULL``), so even
    a caller that did not hold the row lock — the OAuth ``save_user`` path —
    can consume the invite at most once. Losing that race raises
    ``invite_invalid`` and creates no membership; the caller's transaction
    decides what happens to the new account.
    """
    with transaction.atomic():
        stamped = GroupInviteLink.objects.filter(
            pk=link.pk, used_at__isnull=True, is_active=True,
        ).update(used_at=timezone.now())
        if stamped != 1:
            raise InviteTokenError("invite_invalid", "Invalid or expired invite link.")

        membership, created = GroupMembership.objects.get_or_create(
            group_id=link.group_id, user=user, defaults={"role": link.role},
        )
        if created:
            # Same member.added event JoinGroupView emits, so an admin watching
            # GroupDetail sees the new member appear (#998).
            from .serializers import GroupMembershipSerializer

            data = GroupMembershipSerializer(membership).data
            gid = link.group_id

            def _broadcast_member_added():
                from .broadcast import broadcast_group_event
                broadcast_group_event(gid, _group_broadcast.EVT_MEMBER_ADDED, data)

            transaction.on_commit(_broadcast_member_added)

    logger.info(
        "Group invite redeemed at registration. token=%s group_id=%s user_id=%s",
        link.prefix, link.group_id, user.pk,
    )
