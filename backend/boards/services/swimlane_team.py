"""Swimlane default team (#2211): store a lane's team and keep it honest.

The team is stored settings only for now: nothing pre-assigns new cards from
it yet (#2206 decision G, one assignee or several, has no ruling). Two rules
keep what is stored valid:

- **The board decides.** A team member must be an active, non-viewer person
  listed in the lane's board member list when the team is written.
- **Pruned on removal.** Removing a person from the board takes them off its
  lane teams, through the REST endpoint and the Django admin alike.
"""

from boards.models import SwimlaneTeamMember


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
