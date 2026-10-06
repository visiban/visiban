"""Board invites (#1444): redemption rules and invite-only registration.

A ``BoardInviteLink`` (``vbnb_``) grants a role on one board. This module owns
the two questions every redemption path asks — "may this invite still be
used?" and "what does redeeming it do to the redeemer's access?" — so the join
endpoint and both registration paths (REST and OAuth) cannot drift apart.

Access rule (the reason this is not a ``get_or_create``)
--------------------------------------------------------
An explicit ``BoardMembership`` *overrides* any group-inherited role in the
role ladder (``boards/permissions.py::_role_before_groups``) — it does not
combine with it. Creating a viewer row for a group admin would therefore
*downgrade* them to viewer on this board. So redemption:

- never touches an existing explicit membership (or the owner, or an
  all-content site admin);
- creates an explicit membership only when the redeemer has no access at all,
  or only an inherited role ranked **below** the invite's role;
- otherwise grants nothing and reports ``created: False``.

A board invite never grants group membership.

Invite-only registration
------------------------
Exact parity with the group rule of #1445 (``groups/invite_registration.py``):
a board invite admits a *new account* on an INVITE_ONLY site only when it was
emailed, is single-use, unused and unexpired, email invites are still enabled,
and its sender is — checked now — an active **site admin** who is still an
admin of the board. A board admin who is not a site admin can invite people who
already have an account, nothing more. CLOSED admits no token; OPEN admits
anyone, so the invite is redeemed by the SPA's follow-up join instead.
"""

import logging

from django.db import transaction
from django.db.models import F
from django.utils import timezone

from accounts.invite_utils import InviteTokenError
from accounts.models import SiteSetting, get_registration_mode

from . import broadcast as _broadcast
from .models import Board, BoardInviteLink, BoardInviteRedemption, BoardMembership
from .permissions import GROUP_ANCESTOR_SELECT_RELATED, SITE_ADMIN, get_board_role

logger = logging.getLogger(__name__)

# Higher grants more. SITE_ADMIN (all-content access) and ADMIN can never be
# granted by an invite, so they only ever appear on the "already has" side.
ROLE_RANK = {
    BoardMembership.Role.VIEWER: 1,
    BoardMembership.Role.COLLABORATOR: 2,
    BoardMembership.Role.MEMBER: 3,
    BoardMembership.Role.ADMIN: 4,
    SITE_ADMIN: 5,
}

NOT_FOR_REGISTRATION_DETAIL = (
    "This invite link can't be used to create an account on this site. "
    "Ask a site admin for an invite."
)

_REFUSAL_DETAILS = {
    "invite_not_for_registration": NOT_FOR_REGISTRATION_DETAIL,
    "invite_invalid": "Invalid or expired invite link.",
    "invite_expired": "This invite link has expired.",
}


def load_board(board_id):
    """The board with its group ancestor chain loaded, so ``get_board_role``
    walks inherited access without a query per level."""
    return Board.objects.select_related("owner", GROUP_ANCESTOR_SELECT_RELATED).get(pk=board_id)


def role_is_grantable(link: BoardInviteLink) -> bool:
    """False for an invite whose stored role is not member/collaborator/viewer.

    Unreachable through ``BoardInviteLink.generate``; checked anyway so a row
    written some other way (raw ORM, a future link type) never grants admin.
    """
    return link.role in BoardInviteLink.GRANTABLE_ROLES


def sender_is_board_admin(link: BoardInviteLink, board=None) -> bool:
    """True when the invite's sender is active and still administers the board.

    Re-checked at every redemption, not only at send: a sender who has since
    been deactivated or lost admin on the board must not keep adding people
    through invites already in flight. (Deactivation also revokes pending
    invites outright — ``AdminUserDeactivateView``.)
    """
    sender = link.created_by
    if sender is None or not sender.is_active:
        return False
    board = board if board is not None else load_board(link.board_id)
    return get_board_role(sender, board) in (BoardMembership.Role.ADMIN, SITE_ADMIN)


def unusable_code(link: BoardInviteLink, *, caller_has_access: bool) -> str | None:
    """Why ``link`` cannot be redeemed (``revoked`` / ``used`` / ``expired``), or None.

    Precedence matches ``BoardInviteLink.status``: revoked > used > expired. A
    consumed single-use invite still answers someone who already has access to
    the board — the person whose registration consumed it lands here on the
    SPA's follow-up join and must not hit a "this invite was used" dead end.
    """
    if link.revoked_at is not None or not role_is_grantable(link):
        return "revoked"
    if link.single_use and link.used_at is not None:
        return None if caller_has_access else "used"
    if link.is_expired:
        return "expired"
    return None


def _would_create_membership(user, board, invite_role) -> bool:
    """Apply the access rule (module docstring) without writing anything."""
    if invite_role not in BoardInviteLink.GRANTABLE_ROLES:
        raise InviteTokenError("invite_invalid", "Invalid or expired invite link.")
    if user.can_access_all_content or board.owner_id == user.id:
        return False
    if BoardMembership.objects.filter(board=board, user=user).exists():
        return False
    current = get_board_role(user, board)
    if current is None:
        return True
    return ROLE_RANK.get(current, 0) < ROLE_RANK[invite_role]


def redeem(link: BoardInviteLink, user, board, *, via: str) -> bool:
    """Redeem ``link`` for ``user``; return whether a membership was created.

    Caller must hold the invite row lock (or, on the OAuth path, have already
    won the conditional ``used_at`` update) and run inside a transaction: the
    membership, the invite's counters, the redemption row and the
    ``member.added`` feed row commit or roll back together.

    Raises ``InviteTokenError("invite_invalid")`` — granting nothing — for an
    invite whose role is not grantable (see ``role_is_grantable``).
    """
    created = _would_create_membership(user, board, link.role)
    membership = None
    if created:
        membership = BoardMembership.objects.create(board=board, user=user, role=link.role)

    updates = {"use_count": F("use_count") + 1}
    if link.single_use and link.used_at is None:
        updates["used_at"] = timezone.now()
    BoardInviteLink.objects.filter(pk=link.pk).update(**updates)
    BoardInviteRedemption.objects.get_or_create(
        invite=link, user=user,
        defaults={"role_granted": link.role, "membership_created": created, "via": via},
    )

    if membership is not None:
        from .serializers import BoardMembershipSerializer

        # Serialized without a request: the stored payload keeps is_moderator /
        # is_site_admin and the consumer and change feed strip them per reader,
        # exactly as for the members endpoint. ``invite`` is additive — it
        # lets an admin's open invite list refetch when its invite is redeemed.
        payload = dict(BoardMembershipSerializer(membership).data)
        payload["invite"] = {"id": link.pk, "created_by_id": link.created_by_id}
        _broadcast.record_board_event(
            board.pk, _broadcast.EVT_MEMBER_ADDED, payload, actor_id=user.pk,
        )
    return created


# ---------------------------------------------------------------------------
# Invite-only registration
# ---------------------------------------------------------------------------

def board_link_registration_refusal(link: BoardInviteLink, *, board=None, admits_memo=None) -> str | None:
    """Why ``link`` cannot authorize registration on an INVITE_ONLY site, or None.

    Pure and lock-free (no writes, no row lock) so the public preview's
    ``can_register`` and the registration validator share one definition.
    Mirrors ``groups.invite_registration.group_link_registration_refusal``.
    """
    if link.revoked_at is not None or not role_is_grantable(link):
        return "invite_invalid"
    if not (link.single_use and link.delivery == BoardInviteLink.Delivery.EMAIL):
        return "invite_not_for_registration"
    sender = link.created_by
    if sender is not None and sender.is_active and not sender.is_site_admin:
        # A board admin's emailed invite: valid for joining, never for sign-up.
        return "invite_not_for_registration"
    if link.used_at is not None:
        return "invite_invalid"
    if link.is_expired:
        return "invite_expired"
    if not _email_invites_enabled() or not _sender_still_admits(link, board=board, memo=admits_memo):
        return "invite_invalid"
    return None


def board_link_can_register(link: BoardInviteLink, *, board=None, admits_memo=None) -> bool:
    """Whether registration would accept ``link`` under the current mode.

    Advisory and racy by design (the sender can lose site admin, the invite can
    be consumed, the mode can change); registration re-checks under a row lock.

    ``board`` (the invite's board, already loaded with its group ancestors) and
    ``admits_memo`` (a dict shared across one request, keyed by sender id) let
    the invite list answer this for every row without re-loading the board and
    re-resolving the sender's role per row.
    """
    mode = get_registration_mode()
    if mode == SiteSetting.RegistrationMode.OPEN:
        return True
    if mode == SiteSetting.RegistrationMode.INVITE_ONLY:
        return board_link_registration_refusal(link, board=board, admits_memo=admits_memo) is None
    return False


def validate_board_registration_token(raw_token: str) -> BoardInviteLink:
    """Return the emailed, single-use board invite for ``raw_token``, row-locked.

    Must run inside ``transaction.atomic()``. Raises ``InviteTokenError`` with
    the same codes as the site and group validators.
    """
    raw_token = (raw_token or "").strip()
    if not raw_token:
        raise InviteTokenError("invite_missing", "An invite link is required to register.")
    try:
        # Lock the bare row: ``created_by`` is a nullable FK, so joining it
        # here would be a LEFT OUTER JOIN, and PostgreSQL refuses FOR UPDATE on
        # the nullable side of one. The sender loads lazily below.
        link = BoardInviteLink.objects.select_for_update().get(
            token_hash=BoardInviteLink._hash_token(raw_token),
            revoked_at__isnull=True,
        )
    except BoardInviteLink.DoesNotExist:
        raise InviteTokenError("invite_invalid", "Invalid or expired invite link.")
    refusal = board_link_registration_refusal(link)
    if refusal is not None:
        raise InviteTokenError(refusal, _REFUSAL_DETAILS[refusal])
    return link


def redeem_board_registration_token(link: BoardInviteLink, user) -> None:
    """Add a just-registered ``user`` to the invite's board and consume it.

    The ``used_at`` stamp is a conditional update, so even the OAuth path —
    which validated in an earlier transaction and holds no lock here — consumes
    the invite at most once. Losing that race raises ``invite_invalid`` and
    grants nothing.
    """
    with transaction.atomic():
        claimed = BoardInviteLink.objects.filter(
            pk=link.pk, used_at__isnull=True, revoked_at__isnull=True,
        ).update(used_at=timezone.now())
        if claimed != 1:
            raise InviteTokenError("invite_invalid", "Invalid or expired invite link.")
        link.refresh_from_db(fields=["used_at", "use_count"])
        redeem(link, user, load_board(link.board_id), via=BoardInviteRedemption.Via.REGISTRATION)
    logger.info(
        "Board invite redeemed at registration. token=%s board_id=%s user_id=%s",
        link.prefix, link.board_id, user.pk,
    )


def _email_invites_enabled() -> bool:
    from visiban.invite_email import invite_email_enabled

    return invite_email_enabled()


def _sender_still_admits(link: BoardInviteLink, *, board=None, memo=None) -> bool:
    """The sender may admit a new account: an active site admin who is still an
    admin of the board, checked now. ``memo`` caches the answer per sender."""
    sender = link.created_by
    if sender is None or not sender.is_active or not sender.is_site_admin:
        return False
    if memo is not None and sender.pk in memo:
        return memo[sender.pk]
    admits = sender_is_board_admin(link, board)
    if memo is not None:
        memo[sender.pk] = admits
    return admits
