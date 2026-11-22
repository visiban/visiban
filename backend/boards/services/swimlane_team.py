"""Swimlane default team (#2211): store a lane's team and keep it honest.

A card has one assignee, so the team pre-assigns its **first** eligible member
(#2206 decision G, 2026-11-22); the others are listed in the create dialog's
caption, not assigned. True multi-assignee is #2510. Two rules keep what is
stored valid:

- **The board decides.** A team member must be an active, non-viewer person
  listed in the lane's board member list when the team is written.
- **Pruned on removal.** Removing a person from the board takes them off its
  lane teams, through the REST endpoint and the Django admin alike.
"""

from django.db.models import Prefetch

from boards.models import SwimlaneTeamMember


def team_prefetch():
    """The ``team_members`` prefetch every lane read uses (#2211).

    Ordered by pk (team order) and joined to the user for ``is_active``, so
    ``default_team`` and ``default_team_members`` cost one query for every lane
    of a read, not one per lane.
    """
    return Prefetch(
        "team_members",
        queryset=SwimlaneTeamMember.objects.select_related("user")
        .only("id", "swimlane_id", "user_id", "user__id", "user__is_active")
        .order_by("pk"),
    )


def eligible_ids(board):
    """The people a lane's default team may hold: active, listed board members.

    A team accepts only people who appear in the board's member list (the
    ``members`` payload of ``/full/``): the owner, explicit non-viewer members
    and non-viewer members inherited from a group. It uses the same ladder as
    ``_get_assignable_member_ids`` with ``site_admin_ids=()`` so people who
    reach the board only through instance-wide access are not
    accepted unless they are also listed; the card ``assignee_id`` rule is not
    changed. Fails closed: with no board there is nobody.
    """
    from accounts.models import User
    from boards.utils import _get_assignable_member_ids

    if board is None:
        return set()
    listed_ids = _get_assignable_member_ids(board, site_admin_ids=())
    return set(User.objects.filter(pk__in=listed_ids, is_active=True).values_list("pk", flat=True))


def team_member_ids(swimlane):
    """The lane's team as user ids, in the order the team was built.

    Reads ``swimlane.team_members.all()`` so a caller's prefetch serves it.
    """
    return [m.user_id for m in swimlane.team_members.all()]


def team_members_payload(swimlane):
    """``default_team_members``: ``[{"id", "is_active"}]`` in team order (#2211).

    ``is_active`` lets Edit swimlane mark a deactivated member, who must be
    removed before the team can be saved (the write refuses them), and keeps
    the create surfaces from offering them.
    """
    return [{"id": m.user_id, "is_active": m.user.is_active} for m in swimlane.team_members.all()]


def default_assignee_id(swimlane, target_board):
    """The person a new card on ``target_board`` gets from ``swimlane``'s team, or None.

    The first team member, in team order, who is active and assignable on
    ``target_board`` (the card ``assignee_id`` rule, Rule 5: active users only).
    ``target_board`` is the lane's own board for a card created in it, and the
    child board for Add child, so a member who can't be assigned there is
    skipped, not refused. Fails closed (#1075): no lane, no board or no team
    gives None, never someone.
    """
    if swimlane is None or target_board is None:
        return None
    team = team_member_ids(swimlane)
    if not team:
        return None
    from accounts.models import User
    from boards.utils import _get_assignable_member_ids

    assignable = set(_get_assignable_member_ids(target_board))
    candidates = [uid for uid in team if uid in assignable]
    if not candidates:
        return None
    active = set(User.objects.filter(pk__in=candidates, is_active=True).values_list("pk", flat=True))
    return next((uid for uid in candidates if uid in active), None)


def team_access(swimlane, viewer):
    """Which team members can't be assigned on the child boards this lane feeds (#2211).

    The child boards are the boards the lane's parent cards already have
    children on, plus the parent board's default child board. A member who
    can't be assigned on one of them is skipped when a child is created there.
    Board names are sent only for boards ``viewer`` can open (shared rule 5);
    the others are counted in ``hidden_count``. Fails closed (#1075): no lane
    or no viewer gives no members.

    Returns ``{"members": [{"id", "boards": [{"id", "name"}], "hidden_count"}]}``
    with one entry per team member who has at least one such board.
    """
    if swimlane is None or viewer is None or not getattr(viewer, "is_authenticated", False):
        return {"members": []}
    from boards.models import Board, CardParentLink
    from boards.permissions import GROUP_ANCESTOR_SELECT_RELATED, get_board_roles
    from boards.utils import _get_assignable_member_ids

    team = team_member_ids(swimlane)
    if not team:
        return {"members": []}
    board_ids = set(
        CardParentLink.objects.filter(parent__swimlane_id=swimlane.pk)
        .values_list("child__board_id", flat=True).distinct()
    )
    default_child = Board.objects.filter(pk=swimlane.board_id).values_list("default_child_board_id", flat=True).first()
    if default_child is not None:
        board_ids.add(default_child)
    boards = list(
        Board.objects.filter(pk__in=board_ids).select_related(GROUP_ANCESTOR_SELECT_RELATED).order_by("name", "pk")
    )
    roles = get_board_roles(viewer, boards) if boards else {}
    missing = {uid: {"id": uid, "boards": [], "hidden_count": 0} for uid in team}
    for board in boards:
        assignable = set(_get_assignable_member_ids(board))
        for uid in team:
            if uid in assignable:
                continue
            if roles.get(board.pk) is None:
                missing[uid]["hidden_count"] += 1
            else:
                missing[uid]["boards"].append({"id": board.pk, "name": board.name})
    return {"members": [m for m in missing.values() if m["boards"] or m["hidden_count"]]}


def set_team(swimlane, user_ids, assignable_ids):
    """Replace the lane's team with ``user_ids`` (already validated), keeping order.

    Rows for people who stay keep their id, so their place in the order is
    kept; new people are appended in the order given. ``assignable_ids`` is
    re-applied under the caller's lock so a member removed while the request
    queued is not written back.
    """
    wanted = [uid for uid in dict.fromkeys(user_ids) if uid in assignable_ids]
    current = set(
        SwimlaneTeamMember.objects.filter(swimlane=swimlane).values_list("user_id", flat=True)
    )
    SwimlaneTeamMember.objects.filter(swimlane=swimlane).exclude(user_id__in=wanted).delete()
    SwimlaneTeamMember.objects.bulk_create(
        [SwimlaneTeamMember(swimlane=swimlane, user_id=uid) for uid in wanted if uid not in current]
    )


def remove_from_board_teams(board_id, user_id):
    """Take a person off every lane team on a board (member removal, #2211).

    Shared by the REST member removal and the Django admin delete so a person
    removed either way does not return to a team silently when re-added.
    """
    SwimlaneTeamMember.objects.filter(swimlane__board_id=board_id, user_id=user_id).delete()
