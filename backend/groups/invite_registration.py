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
  see ``SocialRegistrationAdapter.save_user``);
- sent by someone who is still an active **site admin** (and still able to
  send it — an admin of the group or an ancestor); and
- email invites still enabled (``INVITE_EMAIL_ENABLED``).

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
from accounts.models import SiteSetting, get_registration_mode

from . import broadcast as _group_broadcast
from .models import GroupInviteLink, GroupMembership

logger = logging.getLogger(__name__)

NOT_FOR_REGISTRATION_DETAIL = (
    "This invite link can't be used to create an account on this site. "
    "Ask a site admin for an invite."
)


# Detail text per refusal code, shared by the registration validator so the
# pure predicate below and the raised errors cannot drift apart.
_REFUSAL_DETAILS = {
    "invite_not_for_registration": NOT_FOR_REGISTRATION_DETAIL,
    "invite_invalid": "Invalid or expired invite link.",
    "invite_expired": "This invite link has expired.",
}


def group_link_registration_refusal(link: GroupInviteLink) -> str | None:
    """Why ``link`` cannot authorize registration on an INVITE_ONLY site, or None.

    Pure and lock-free: it reads the link and its sender but never takes a row
    lock or writes, so the public join preview (#1481) can ask the same
    question registration asks without serializing on the invite row. The
    registration validator calls it *after* its ``select_for_update`` lookup
    and maps the code to an ``InviteTokenError``, so there is exactly one
    definition of "this group link admits a new account".

    Checks run in the order registration has always reported them (#1445):
    the link's kind first (a shareable link or a non-site-admin sender's
    invite is ``invite_not_for_registration``), then consumption, expiry,
    the email-invite feature switch, and whether the sender still admits.
    """
    if not link.is_active:
        # Unreachable from the validator (its lookup filters is_active); kept
        # so a caller holding a revoked instance never gets a false "admits".
        return "invite_invalid"
    if not (link.single_use and link.delivery == GroupInviteLink.Delivery.EMAIL):
        return "invite_not_for_registration"
    sender = link.created_by
    # Link-kind classification (which refusal code to report), not the
    # authorization decision: _sender_still_admits below applies the shared
    # visiban.authorization functions (#1517).
    if sender is not None and sender.is_active and not sender.is_site_admin:
        # A group admin's emailed invite: valid for joining, never for sign-up.
        return "invite_not_for_registration"
    if link.used_at is not None:
        return "invite_invalid"
    if link.is_expired:
        return "invite_expired"
    if not _email_invites_enabled() or not _sender_still_admits(link):
        return "invite_invalid"
    return None


def link_can_register(link: GroupInviteLink) -> bool:
    """Whether registration would accept ``link`` under the current registration mode.

    Backs the ``can_register`` field of the public join preview (#1481) so the
    SPA can steer a newcomer to "sign in" before they fill in a sign-up form
    that would 400. OPEN admits any registration; CLOSED admits none;
    INVITE_ONLY admits only what ``group_link_registration_refusal`` admits.

    Advisory and racy by design: the sender can lose site admin, the invite
    can be consumed, or the mode can change between this answer and the
    registration request. Registration re-checks under a row lock and stays
    the enforcer; this never authorizes anything.
    """
    mode = get_registration_mode()
    if mode == SiteSetting.RegistrationMode.OPEN:
        return True
    if mode == SiteSetting.RegistrationMode.INVITE_ONLY:
        return group_link_registration_refusal(link) is None
    return False


def validate_group_registration_token(raw_token: str) -> GroupInviteLink:
    """Return the emailed, single-use group invite for ``raw_token``, row-locked.

    Must be called inside ``transaction.atomic()``. The ``select_for_update``
    serializes two concurrent registrations presenting the same token: the
    second waits for the first to commit, then sees ``used_at`` set.

    Raises ``InviteTokenError`` with the same codes as the site-invite
    validator (``invite_missing`` / ``invite_invalid`` / ``invite_expired``)
    plus ``invite_not_for_registration`` for a live group link that is not an
    emailed single-use invite from a site admin. Telling a token holder their link is shareable
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

    refusal = group_link_registration_refusal(link)
    if refusal is not None:
        raise InviteTokenError(refusal, _REFUSAL_DETAILS[refusal])
    return link


def _email_invites_enabled() -> bool:
    """False once the operator turns email invites off (``INVITE_EMAIL_ENABLED``).

    Switching the feature off must also stop invites already in people's
    inboxes from creating accounts, not just stop new sends.
    """
    from visiban.invite_email import invite_email_enabled

    return invite_email_enabled()


def _sender_still_admits(link: GroupInviteLink) -> bool:
    """True when the invite's sender may admit new accounts, checked *now*.

    Only a **site admin** may admit new people to an invite-only site — the
    same people who can mint site invites (``IsSiteAdmin``). Any user can
    create a group and become its admin, so letting every group admin's
    emailed invite create accounts would turn INVITE_ONLY into "any member can
    invite, transitively". A group admin who is not a site admin keeps the
    pre-#1445 behavior: their emailed invite adds existing accounts only.

    Re-checked at redemption, not at send: a sender who has since been
    deactivated, lost the site-admin flag, or is no longer an admin of the
    group (or an ancestor) must not keep admitting people through invites
    already in flight — the same reason site invites are revoked when their
    creator is deactivated. The plain join path is unchanged.
    """
    from visiban.authorization import invite_creator_is_valid, sender_may_admit_accounts

    # Shared rungs (#1517): the same account-level rule the board kind
    # applies, then the same creator rule the join path applies.
    if not sender_may_admit_accounts(link.created_by):
        return False
    # Memoized on the link, so the preview's own creator check (#1490) and this
    # one share a single ancestor walk.
    return invite_creator_is_valid(link)


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
