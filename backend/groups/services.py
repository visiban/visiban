"""Shared group operations that more than one entry point performs.

Keeping the ownership-transfer rules in one function means the REST endpoint
(``GroupViewSet.transfer_ownership``) and the Django admin action
(``groups.admin.GroupAdmin``) cannot drift apart.
"""

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Exists, OuterRef, Q

from .models import Group, GroupMembership


def lock_group_subtree_for_delete(group_id):
    """Lock ``group_id`` and every subgroup under it ``FOR UPDATE``; return ``(owner_id, parent_id)``.

    Returns ``None`` when the group is already gone (a delete that queued
    behind another delete of the same group). Must run inside
    ``transaction.atomic()``, before ``group.delete()``.

    Why (#1638): the delete collector reads the group's memberships, then
    reaches the invite rows at its ``DELETE``, and removes the group row last.
    Without the group row locked first, an invite redemption (join,
    invite-only registration, the confirmation grant) holding an invite row
    made the delete wait there and then commit a membership the collector had
    already read past, so the delete failed its deferred foreign key at COMMIT
    (a 500), or deadlocked against a grant that holds the group row and waits
    on the invite. Every redemption takes the group row ``FOR NO KEY UPDATE``
    (``groups.invite_registration.lock_invite_group``) before the invite row,
    which conflicts with this ``FOR UPDATE``, so a redemption and a delete
    now queue whole in either order.

    The subgroups are locked too because the delete cascades to them, and an
    invite on a subgroup races a parent delete the same way. The first lock
    statement takes every row it found in pk order, the order the
    parent-change writer (``GroupSerializer``) locks a chain in, so it cannot
    deadlock against a single re-parent. A later re-walk round locks
    subgroups found after higher-pk rows are already held, so in theory it
    can still deadlock with a second re-parent of such a subgroup that is in
    flight at that moment (PostgreSQL then aborts one of the two). The
    owner and parent are returned from the locked row: the caller re-checks
    ownership against it (a transfer may have committed while the delete
    queued) and broadcasts to the parent the group actually has.

    Writers that point a board at a group take that group row
    ``FOR KEY SHARE`` before the board row (``lock_group_for_board_placement``),
    the same group -> board order as this delete, whose collector reaches
    the boards (``SET_NULL``) only after these group locks.
    """
    ids = _subtree_ids(group_id)
    for _ in range(_SUBTREE_LOCK_ROUNDS):
        rows = {
            pk: (owner_id, parent_id)
            for pk, owner_id, parent_id in Group.objects.select_for_update()
            .filter(pk__in=ids).order_by("pk").values_list("pk", "owner_id", "parent_id")
        }
        # Walk again under the locks. The first walk is an unlocked read, so a
        # re-parent or subgroup create that committed between it and the lock
        # statement left a subgroup outside ``ids`` that the collector would
        # still cascade, with nothing held on it. Once a group row is locked
        # nothing new can attach under it (a re-parent locks the new parent's
        # chain FOR UPDATE, a subgroup insert takes FOR KEY SHARE on its
        # parent at commit, and both conflict with this lock), so the set
        # grows at most once per level and the loop settles.
        # A group that moved out meanwhile stays locked, which is harmless.
        walked = _subtree_ids(group_id)
        if walked <= ids:
            break
        ids |= walked
    return rows.get(group_id)


# Depth is capped well below this (_GROUP_TRAVERSAL_MAX_DEPTH); the bound only
# guarantees termination.
_SUBTREE_LOCK_ROUNDS = 16


def _subtree_ids(group_id):
    """``group_id`` and the pks of every group under it, one query per level."""
    ids, frontier = {group_id}, [group_id]
    while frontier:
        frontier = list(
            Group.objects.filter(parent_id__in=frontier).exclude(pk__in=ids).values_list("pk", flat=True)
        )
        ids.update(frontier)
    return ids


_GROUP_KEY_SHARE_LOCK_SQL = {
    "postgresql": 'SELECT 1 FROM "groups" WHERE "id" = %s FOR KEY SHARE',
    None: 'SELECT 1 FROM "groups" WHERE "id" = %s',
}


def lock_group_for_board_placement(group_id) -> bool:
    """Hold the group a board is being placed in ``FOR KEY SHARE``; False if it is gone.

    Every writer that points a board at a group calls this before it locks
    or writes the board row: move-group, the board ``PATCH``/``PUT`` that
    changes ``group``, board create with a group, group board create
    (#1638), the board imports into a group and the board admin save
    (#1719). Why: the board's ``group`` foreign key is deferred, so such a
    writer takes ``FOR KEY SHARE`` on the group only at COMMIT. A group
    delete holds its subtree's group rows ``FOR UPDATE`` from the start
    (``lock_group_subtree_for_delete``) and reaches the boards at its
    collector's ``SET_NULL``; a move inside the subtree that held the board
    row and only asked for the group at COMMIT deadlocked against it (a 500),
    and a move into a group being deleted failed its foreign key at COMMIT (a
    500). Taking the group first puts both in the delete's group -> board
    order: a writer behind a delete finds the group gone and answers 404
    (move-group, group board create) or the serializer's unknown-group 400
    (board create, ``PATCH``/``PUT``), and a delete behind a writer waits for it to commit and then clears the
    board's group. ``FOR KEY SHARE`` is the mode the foreign key check takes
    anyway, so it conflicts only with the delete (and other ``FOR UPDATE``
    holders of the group row), not with invite redemptions or other moves.
    On SQLite there is no row lock and only the existence check remains.
    Must run inside ``transaction.atomic()``.
    """
    from django.db import connection

    sql = _GROUP_KEY_SHARE_LOCK_SQL.get(connection.vendor, _GROUP_KEY_SHARE_LOCK_SQL[None])
    with connection.cursor() as cursor:
        cursor.execute(sql, [group_id])
        return cursor.fetchone() is not None


def lock_group_for_child_write(group_id) -> bool:
    """Hold a group ``FOR KEY SHARE`` before writing a row that points at it; False if it is gone.

    The same lock as ``lock_group_for_board_placement``, for the group-owned
    rows other than boards (#1719): group label create and ``PATCH``, group
    star. Each inserts or updates a row whose
    deferred ``group`` foreign key otherwise takes ``FOR KEY SHARE`` only at
    COMMIT, so a writer that raced a group delete failed that check (a 500),
    and an ``UPDATE`` that queued behind the delete's cascade matched no row
    and ``save()`` fell back to an ``INSERT`` under the deleted group (the
    same 500). Taking the group first puts the writer in the delete's
    group -> child order: behind a delete it finds the group gone (the caller
    answers 404), and a delete behind it waits and then cascades what it
    wrote. Must run inside ``transaction.atomic()``.

    Callers (and ``lock_group_row``'s) check the caller's admin standing
    before taking this lock, so a demotion committing in between can still
    let one write through. Accepted: an invite's sender standing is
    re-checked at preview and redemption (#1490), so such a write cannot
    admit anyone the demoted admin could no longer invite.
    """
    return lock_group_for_board_placement(group_id)


def lock_group_row(group_id, *, no_key=True) -> bool:
    """Lock the group row itself (``FOR NO KEY UPDATE``, or ``FOR UPDATE``); False if it is gone.

    For writers that ``UPDATE`` the group row or must serialize against each
    other on it (#1719): the board-defaults ``PATCH``, invite revoke (before
    the invite row, the order redemptions take), and invite link create
    (``FOR NO KEY UPDATE`` conflicts with itself, so two creates serialize
    on the active-link cap without blocking ``FOR KEY SHARE`` writers).
    ``FOR NO KEY UPDATE`` is the mode an
    ``UPDATE`` of a non-key column takes anyway, and it conflicts with the
    group delete's ``FOR UPDATE``, so a writer behind a delete finds the row
    gone instead of updating nothing (a ``save()`` with no ``update_fields``
    would then re-insert the deleted group). Must run inside
    ``transaction.atomic()``.
    """
    return (
        Group.objects.select_for_update(no_key=no_key)
        .filter(pk=group_id).values_list("pk", flat=True).first()
    ) is not None


class GroupTransferError(Exception):
    """A transfer was refused; ``str(exc)`` is the user-facing message."""


class GroupGone(GroupTransferError):
    """The group was deleted before the transfer could lock it (#1719)."""

    def __init__(self):
        super().__init__("This group no longer exists.")


def transfer_group_ownership(
    group_id,
    new_owner_id,
    *,
    expected_owner_id=None,
    require_admin_role=True,
    require_active=False,
):
    """Make ``new_owner_id`` the owner of the group and keep the previous owner as admin.

    Judged under row locks (the new owner's account row, then the group row,
    then the new owner's membership, #1814) so
    the owner and the membership the rules read cannot change between the check
    and the write. ``expected_owner_id`` makes the transfer refuse if the owner
    is no longer who the caller authorized.

    ``require_admin_role=True`` is the owner-initiated rule: the new owner must
    already be an admin of the group. The administrator route passes ``False``
    and ``require_active=True``: a departed owner's group may have no other
    admin, so any active member can be chosen and is made an admin member, which
    keeps the invariant that an owner holds the admin role.

    Returns the updated group. Callers that broadcast must register their
    ``transaction.on_commit`` callback inside their own ``atomic`` block.
    Raises ``GroupGone`` (a ``GroupTransferError``) when the group no longer
    exists, e.g. a transfer that queued on the row lock behind a delete of
    the group (#1719); the REST view answers it with 404.
    """
    with transaction.atomic():
        # The new owner's account row before the group row, the lock order
        # recorded above ``lock_member_accounts`` (#1814). This lookup used
        # to lock that row through the membership join, after the group row,
        # which could deadlock against a member change on the same group: that
        # holds the admins' account rows while it waits for the group row.
        # Holding it also fixes ``is_active`` for the ``require_active`` check.
        # Locks the row; the result is unused (pinned by
        # test_transfer_takes_the_new_owner_account_before_the_group_row).
        get_user_model().objects.select_for_update(no_key=True).filter(
            pk=new_owner_id
        ).values_list("pk", flat=True).first()
        group = Group.objects.select_for_update().filter(pk=group_id).first()
        if group is None:
            raise GroupGone()
        if expected_owner_id is not None and group.owner_id != expected_owner_id:
            raise GroupTransferError("Only the group owner can transfer ownership.")

        try:
            membership = (
                GroupMembership.objects.select_for_update(of=("self",))
                .select_related("user")
                .get(group=group, user_id=new_owner_id)
            )
        except GroupMembership.DoesNotExist:
            raise GroupTransferError(
                "New owner must already be a group member."
            ) from None

        if require_active and not membership.user.is_active:
            raise GroupTransferError("New owner must be an active user.")
        if require_admin_role and membership.role != GroupMembership.Role.ADMIN:
            raise GroupTransferError("New owner must be an admin of this group.")

        previous_owner_id = group.owner_id
        group.owner_id = new_owner_id
        group.save(update_fields=["owner_id"])
        if membership.role != GroupMembership.Role.ADMIN:
            membership.role = GroupMembership.Role.ADMIN
            membership.save(update_fields=["role"])
        # The previous owner stays on the group as an admin member.
        GroupMembership.objects.update_or_create(
            group=group,
            user_id=previous_owner_id,
            defaults={"role": GroupMembership.Role.ADMIN},
        )
        return group


class MembershipChangeRefused(Exception):
    """A membership removal or demotion was refused.

    ``str(exc)`` is the user-facing message and ``exc.code`` the stable,
    machine-readable reason (#1825). Why both: the message is prose that may
    be reworded, so a client that branches on the reason (for example, to offer
    "Transfer ownership" instead of a retry) must compare ``code``, which is
    part of the public ``{detail, code}`` error contract and never changes.
    """

    def __init__(self, message, code):
        super().__init__(message)
        self.code = code


OWNER_MEMBERSHIP_MESSAGE = (
    "The group owner's membership cannot be removed or demoted. "
    "Transfer ownership first."
)
OWNER_MEMBERSHIP_CODE = "group_owner_protected"
LAST_ADMIN_MESSAGE = "A group must keep at least one admin."
LAST_ADMIN_CODE = "group_last_admin"


def counts_toward_admin_minimum(membership):
    """True when ``membership`` is an admin row held by an active account.

    Why: the group's "at least one admin" minimum exists so someone can still act
    for the group. A deactivated account cannot, so its admin row does not count.
    This is the single shared definition of the admin-minimum rule: every code
    path that counts admins toward the minimum must call it rather than
    re-implement it. ``admin_minimum_q`` is its ORM equivalent and the two must
    change together. Side-effect free; reads
    ``membership.user`` (use ``select_related("user")`` to avoid a query).
    """
    return membership.role == GroupMembership.Role.ADMIN and membership.user.is_active


def admin_minimum_q(prefix=""):
    """``Q`` filter matching the rows ``counts_toward_admin_minimum`` accepts.

    ``prefix`` is the relation path to a ``GroupMembership`` from the queried
    model (for example ``"memberships__"``); leave it empty on ``GroupMembership``
    itself. Why: callers that count or lock admins in SQL must apply the same
    "active admin" definition as the Python predicate (the single shared
    definition is ``counts_toward_admin_minimum``). Side-effect free.
    """
    return Q(**{
        f"{prefix}role": GroupMembership.Role.ADMIN,
        f"{prefix}user__is_active": True,
    })


def lock_membership_for_removal_or_demotion(group_id, user_id, new_role=None):
    """Lock and return the membership of ``user_id``, refusing a change that would strand the group.

    ``new_role=None`` means the membership is being removed; otherwise it is the
    role being written. Returns ``None`` when the group or the membership is
    gone. Raises ``MembershipChangeRefused`` when the change would remove or
    demote the group's owner, or remove or demote the group's last active
    admin (deactivated admins do not count toward the minimum).
    Must run inside ``transaction.atomic()``, and the caller must write the
    change in that same transaction.

    Why: an owner holds the admin role, and a group with no active admin can only be
    repaired by its owner (transfer or delete), so both rules protect the
    invariant "the owner is a member and the group has an active admin". The checks
    are judged under locks, not on a read taken before the write:

    1. The account rows of the group's admins and of the target
       (``lock_member_accounts``), ``FOR NO KEY UPDATE`` in pk order. Every
       write of ``User.is_active`` (the admin ``PATCH`` and deactivate
       endpoints, the Django admin user form, a user delete) updates or locks
       that row, so the active flag counted here cannot change until this
       transaction ends (#1814). ``FOR NO KEY UPDATE`` does not block the
       ``FOR KEY SHARE`` a foreign key to the user takes (a card write
       recording its author), so it adds no conflict with ordinary writes.
    2. The group row (``FOR NO KEY UPDATE``), which serializes callers of this
       function with each other and with ``transfer_group_ownership``: without
       it, two requests that each remove a different one of two admins would
       each count two admins, both pass, and leave none.
    3. The admin and target membership rows, in pk order, as defense in depth
       for a writer that changes a membership row without taking the group
       lock first.

    This is the lock order recorded above ``lock_member_accounts``: account
    rows, then the group row, then membership rows. The user delete takes its account
    rows before the group rows too, so the two queue instead of deadlocking.

    The account set is read when statement 1 runs. An admin promoted between
    that statement and the group lock has an account row this call does not
    hold, so that admin is not counted: the result can only be a refusal that
    a retry would not repeat, never a change that leaves no active admin.
    """
    account_ids = lock_member_accounts(group_id, user_id)
    locked_group = (
        Group.objects.select_for_update(no_key=True).filter(pk=group_id)
        .values_list("owner_id", flat=True)
    )
    owner_ids = list(locked_group)
    if not owner_ids:
        return None
    owner_id = owner_ids[0]
    # One statement locks every admin row and the target's row, in pk order.
    # of=("self",): the account rows are already held by statement 1.
    rows = list(
        GroupMembership.objects.select_for_update(of=("self",))
        .select_related("user")
        .filter(Q(role=GroupMembership.Role.ADMIN) | Q(user_id=user_id), group_id=group_id)
        .order_by("pk")
    )
    # Only active admins count toward the minimum: a deactivated admin cannot act.
    # An admin whose account row is not held (promoted after statement 1) is
    # left out, so its active flag, which nothing here locks, cannot decide it.
    active_admin_count = sum(
        1 for m in rows if m.user_id in account_ids and counts_toward_admin_minimum(m)
    )
    membership = next((m for m in rows if m.user_id == user_id), None)
    if membership is None:
        return None
    if user_id == owner_id and new_role != GroupMembership.Role.ADMIN:
        # An owner "demoted" to admin is a no-op, so only a real change is refused.
        raise MembershipChangeRefused(OWNER_MEMBERSHIP_MESSAGE, OWNER_MEMBERSHIP_CODE)
    # Changing a deactivated admin cannot reduce the active-admin count, so only an
    # active admin is held to the minimum.
    is_active_admin = counts_toward_admin_minimum(membership)
    if is_active_admin and new_role != GroupMembership.Role.ADMIN and active_admin_count <= 1:
        raise MembershipChangeRefused(LAST_ADMIN_MESSAGE, LAST_ADMIN_CODE)
    return membership


# Lock order for the group admin minimum (#1814), recorded in Rule 11 of
# docs/development/security-invariants.md. Every path that takes more than one
# of these locks takes them in this order:
#
#   1. account (``User``) rows, in pk order, in one statement
#      (``FOR NO KEY UPDATE`` or stronger);
#   2. group rows (in pk order when there are several);
#   3. group membership rows, in pk order.
#
# ``lock_membership_for_removal_or_demotion``, ``transfer_group_ownership`` and
# the user delete (``accounts.admin.VisibanUserAdmin._lock_and_check_admins``)
# hold an account row while they wait for a group row, so a path that held a
# group row and then waited for an account row could deadlock against them. A
# group writer that needs only ``FOR KEY SHARE`` on an account row (the
# foreign key check of a membership or invite insert) is not affected: no step
# above conflicts with it.


def lock_member_accounts(group_id, *user_ids):
    """Lock the accounts of ``group_id``'s admins and of ``user_ids``, ``FOR NO KEY UPDATE``, in pk order.

    Returns the set of locked account pks. Step 1 of the lock order above:
    call it before the group row. Holding these rows keeps every account's
    ``is_active`` (and its existence: a user delete locks the same rows) fixed
    while the admin minimum is counted. One pk-ordered statement, the order
    the user delete and the Django admin user form lock account rows in, so
    two such statements cannot wait on each other in a cycle. On SQLite there
    is no row lock and only the read remains. Must run inside
    ``transaction.atomic()``.
    """
    admins = GroupMembership.objects.filter(
        group_id=group_id, role=GroupMembership.Role.ADMIN
    ).values("user_id")
    return set(
        get_user_model().objects.select_for_update(no_key=True)
        .filter(Q(pk__in=admins) | Q(pk__in=list(user_ids)))
        .order_by("pk")
        .values_list("pk", flat=True)
    )


# -- The at-least-one-admin minimum, as seen by a user delete ------------------
#
# Kept apart from ``lock_membership_for_removal_or_demotion`` on purpose: that
# function judges one membership change, while a user delete removes every
# membership of a set of accounts at once (the ``GroupMembership.user``
# CASCADE), so it needs a set-wide count rather than a per-row one. It counts
# with the same shared definition, ``admin_minimum_q`` above.


def _groups_administered_by(user_ids):
    return GroupMembership.objects.filter(admin_minimum_q(), user_id__in=user_ids).values("group_id")


def admin_accounts_of_groups_administered_by(user_ids):
    """Subquery: the account pks of every admin of a group ``user_ids`` actively administer.

    The user delete adds these to the account rows its statement 1 locks
    (#1814), so the other admins' active flag, which
    ``groups_left_without_admin`` counts, cannot change before the delete
    commits: a concurrent deactivation of one of them queues behind it.
    Account rows before the group rows (``lock_groups_administered_by``),
    the lock order recorded above ``lock_member_accounts``.
    """
    return GroupMembership.objects.filter(
        role=GroupMembership.Role.ADMIN,
        group_id__in=_groups_administered_by(list(user_ids)),
    ).values("user_id")


def lock_groups_administered_by(user_ids):
    """Lock the rows of every group ``user_ids`` actively administer, ``FOR NO KEY UPDATE``, in pk order.

    Used by the user delete before it judges ``groups_left_without_admin``:
    the group row is the lock every membership removal, demotion and
    ownership transfer takes first (``lock_membership_for_removal_or_demotion``,
    ``transfer_group_ownership``), so holding it keeps those callers from
    changing the locked groups' admin rows between the count and the delete.
    The set is the groups ``user_ids`` actively administer when this runs. A
    later promotion of one of ``user_ids`` (or an ownership transfer to one)
    locks that account row first, which the delete already holds, so it
    queues behind the delete. The admins' active flag is held by the account
    rows the caller locked before this call
    (``admin_accounts_of_groups_administered_by``). ``FOR NO KEY UPDATE``
    leaves the ``FOR KEY SHARE`` writers (board placement, subgroup create)
    unblocked. Must run inside ``transaction.atomic()``.
    """
    return list(
        Group.objects.select_for_update(no_key=True)
        .filter(pk__in=_groups_administered_by(list(user_ids)))
        .order_by("pk")
        .values_list("pk", flat=True)
    )


def groups_left_without_admin(user_ids):
    """Groups that would keep no active admin if every account in ``user_ids`` were deleted.

    A group counts only when one of ``user_ids`` is an active admin of it
    (deleting an inactive admin does not lower the count), and is returned
    when no active admin outside ``user_ids`` remains. Judged as a set, so
    two admins that are each "not the last" are refused when deleted
    together. Direct memberships only, as in
    ``lock_membership_for_removal_or_demotion``. Returns group pks in pk
    order.
    """
    user_ids = list(user_ids)
    others = GroupMembership.objects.filter(
        admin_minimum_q(), group_id=OuterRef("pk")
    ).exclude(user_id__in=user_ids)
    return list(
        Group.objects.filter(pk__in=_groups_administered_by(user_ids))
        .exclude(Exists(others))
        .order_by("pk")
        .values_list("pk", flat=True)
    )
