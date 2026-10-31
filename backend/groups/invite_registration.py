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
from django.db.models import Q
from django.utils import timezone

from accounts.invite_utils import InviteTokenError
from accounts.models import SiteSetting, get_registration_mode
from visiban.invite_recipient import confirmed_address_admits, grant_awaits_verification, require_recipient

from . import broadcast as _group_broadcast
from .models import Group, GroupInviteLink, GroupMembership

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


def group_link_registration_refusal(link: GroupInviteLink, *, reserved_for=None) -> str | None:
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

    A stored role that is not a group membership role is refused
    (``invite_invalid``), so a row written outside ``generate()`` never grants
    an unknown role.

    A reservation (#1704) is not a refusal here: the registration validator
    runs before the account exists, and a sign-up that does not have to wait
    for verification may still take a reserved invite over (see
    ``redeem_group_registration_token``). ``reserved_for`` is passed only by
    the grant at confirmation, which re-applies these rules for that account:
    an invite no longer reserved for it is refused.
    """
    if not link.is_active:
        # Unreachable from the validator (its lookup filters is_active); kept
        # so a caller holding a revoked instance never gets a false "admits".
        return "invite_invalid"
    if not link.role_redeemable:
        # An unknown role, or admin: no invite grants admin (#2006), so an
        # emailed admin invite minted before that is refused, not honored.
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
    if reserved_for is not None and link.reserved_for_id != reserved_for.pk:
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

    token_hash = GroupInviteLink._hash_token(raw_token)
    # Group row first, then the invite row — the order the join view and a
    # group delete take (#1638, see ``lock_invite_group``). The group id is
    # read unlocked; an invite never changes group, and the invite lock below
    # re-checks it.
    group_id = (
        GroupInviteLink.objects.filter(token_hash=token_hash, is_active=True)
        .values_list("group_id", flat=True).first()
    )
    if group_id is None or not lock_invite_group(group_id):
        raise InviteTokenError("invite_invalid", "Invalid or expired invite link.")
    link = GroupInviteLink.objects.select_for_update().filter(
        token_hash=token_hash, group_id=group_id, is_active=True,
    ).first()
    if link is None:
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
    decides what happens to the new account. An invite bound to another
    address (#1678) raises ``invite_recipient_mismatch`` before the stamp.

    Under ``EMAIL_VERIFICATION=mandatory``, when the invited address is not yet
    verified on ``user`` (#1704), the invite is reserved for ``user`` instead:
    no membership, no ``used_at``. ``redeem_reserved_group_invites`` grants it
    when ``user`` confirms the invited address. Only an unreserved invite can
    be reserved; a second sign-up that would also have to wait is refused.

    A sign-up that does not have to wait (``optional`` / ``none``, or the
    provider reported the invited address as verified) claims the invite even
    when another account holds a reservation on it, clearing the reservation
    in the same conditional update. The reserving account is then granted
    nothing at its confirmation, because the invite is used.
    """
    with transaction.atomic():
        # Group row before the claim (#1638). Both callers validated in this
        # same transaction and already hold it, so this is a no-op re-lock
        # there; it keeps the group -> invite order for any caller that did
        # not, and refuses a group deleted since validation.
        if not lock_invite_group(link.group_id):
            raise InviteTokenError("invite_invalid", "Invalid or expired invite link.")
        # Bound to the invited address (#1678): the new account's signup
        # address must match, checked before the stamp so a refusal consumes
        # nothing (the caller rolls the account back).
        require_recipient(link, user, at_registration=True)
        if grant_awaits_verification(link, user):
            # Same conditional claim, on the reservation instead of used_at:
            # of two registrations racing for one invite, exactly one holds it.
            reserved = GroupInviteLink.objects.filter(
                pk=link.pk, used_at__isnull=True, is_active=True, reserved_for__isnull=True,
            ).update(reserved_for=user)
            if reserved != 1:
                raise InviteTokenError("invite_invalid", "Invalid or expired invite link.")
            link.reserved_for = user
            logger.info(
                "Group invite reserved at registration until the address is confirmed. "
                "token=%s group_id=%s user_id=%s",
                link.prefix, link.group_id, user.pk,
            )
            return
        stamped = (
            GroupInviteLink.objects.filter(pk=link.pk, used_at__isnull=True, is_active=True)
            .filter(Q(reserved_for__isnull=True) | ~Q(reserved_for=user))
            .update(used_at=timezone.now(), reserved_for=None)
        )
        if stamped != 1:
            raise InviteTokenError("invite_invalid", "Invalid or expired invite link.")
        _grant_membership(link, user)

    logger.info(
        "Group invite redeemed at registration. token=%s group_id=%s user_id=%s",
        link.prefix, link.group_id, user.pk,
    )


def _grant_membership(link: GroupInviteLink, user) -> None:
    """Join ``user`` to the invite's group with its role; caller has claimed the invite.

    Emits the same ``member.added`` event ``JoinGroupView`` does, deferred to
    commit, so an admin watching GroupDetail sees the new member appear (#998).
    """
    membership, created = GroupMembership.objects.get_or_create(
        group_id=link.group_id, user=user, defaults={"role": link.role},
    )
    if created:
        # As in JoinGroupView: a lower role nearer a board can end a
        # group-derived admin role, and the share links it enabled (#1865).
        from boards.services.share_links import revoke_lapsed_share_links

        revoke_lapsed_share_links(enabler=user)

        from .serializers import GroupMembershipSerializer

        data = dict(GroupMembershipSerializer(membership).data)
        gid = link.group_id

        def _broadcast_member_added():
            from .broadcast import broadcast_group_event
            broadcast_group_event(gid, _group_broadcast.EVT_MEMBER_ADDED, data)

        # robust: the membership is committed by the time this runs; a
        # failure to publish is logged by Django and never undoes the grant
        # or fails the request that made it.
        transaction.on_commit(_broadcast_member_added, robust=True)


def redeem_reserved_group_invites(user, email_address) -> int:
    """Grant the group invites reserved for ``user`` once it confirms the invited address (#1704).

    Called from the ``email_confirmed`` receiver
    (``visiban.invite_recipient.grant_reserved_invites``). Per invite, in its
    own transaction: the group row lock (so a concurrently deleted group is
    skipped, not a failed insert), the invite row lock, the registration rules
    re-applied on the locked row (revoked, used, expired, membership role,
    sender standing, email invites enabled), then the conditional claim on
    ``used_at IS NULL`` and the reservation, checked by row count. A
    concurrent confirmation queues on the row lock and then finds the
    reservation gone; a join or a sign-up that consumed the invite first
    leaves this one nothing to claim. Either way one grant.

    Confirming an address other than the invited one grants nothing and keeps
    the reservation. An invite that can no longer be used is released and
    grants nothing. A failure on one invite is logged and rolled back without
    affecting the others or the confirmation itself (allauth sends the signal
    without isolating receivers). Returns the number of invites granted.
    """
    if user is None or not user.is_active:
        return 0
    granted = 0
    reserved = list(
        GroupInviteLink.objects.filter(reserved_for=user).values_list("pk", "group_id")
    )
    for link_id, group_id in reserved:
        try:
            if _grant_reserved_group_invite(link_id, group_id, user, email_address):
                granted += 1
        except Exception:  # noqa: BLE001 - one invite must not break the confirmation
            logger.exception(
                "Reserved group invite grant failed. invite_id=%s group_id=%s user_id=%s",
                link_id, group_id, user.pk,
            )
    return granted


def lock_invite_group(group_id) -> bool:
    """Lock the invite's group row ``FOR NO KEY UPDATE``; False if it is gone.

    Every group invite redemption takes this before the invite row: the join
    view, invite-only registration (REST and OAuth) and the grant at address
    confirmation (#1638). Group row before the invite row is the order group
    writers that also touch invites take (ownership transfer, admin changes
    that revoke lapsed invites) and the order ``GroupViewSet.destroy`` takes
    (``groups.services.lock_group_subtree_for_delete``): the delete collector
    reaches the invite rows before the group row, so a redemption that held
    the invite row and inserted a membership under it made the delete fail
    its deferred foreign key at COMMIT (a 500), and one that held the group
    row while the delete held the invite deadlocked. ``FOR NO KEY UPDATE``
    conflicts with the delete's ``FOR UPDATE`` but not with the
    ``FOR KEY SHARE`` a membership or invite insert takes on the group, so a
    redemption queued behind a delete finds the group gone and grants
    nothing. Must run inside ``transaction.atomic()``.
    """
    return (
        Group.objects.select_for_update(no_key=True).filter(pk=group_id).values_list("pk", flat=True).first()
    ) is not None


def _grant_reserved_group_invite(link_id, group_id, user, email_address) -> bool:
    """One invite of ``redeem_reserved_group_invites``; True when it granted."""
    with transaction.atomic():
        if not lock_invite_group(group_id):
            return False
        link = GroupInviteLink.objects.select_for_update().filter(pk=link_id, reserved_for=user).first()
        if link is None:
            return False
        if not confirmed_address_admits(link, email_address):
            return False
        refusal = group_link_registration_refusal(link, reserved_for=user)
        if refusal is not None:
            GroupInviteLink.objects.filter(pk=link.pk, reserved_for=user).update(reserved_for=None)
            logger.info(
                "Reserved group invite released at confirmation (code=%s). token=%s group_id=%s user_id=%s",
                refusal, link.prefix, group_id, user.pk,
            )
            return False
        claimed = GroupInviteLink.objects.filter(
            pk=link.pk, reserved_for=user, used_at__isnull=True, is_active=True,
        ).update(used_at=timezone.now(), reserved_for=None)
        if claimed != 1:
            return False
        _grant_membership(link, user)
    logger.info(
        "Reserved group invite redeemed at confirmation. token=%s group_id=%s user_id=%s",
        link.prefix, group_id, user.pk,
    )
    return True
