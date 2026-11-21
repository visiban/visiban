"""Swimlane default team (#2211): store a lane's team and pick who a new card gets.

The team is applied at creation only. Two rules keep it from assigning anyone
who should not be assigned:

- **The card's own board decides.** A team member is a candidate only while
  they are an assignable member (not a viewer) of the board the new card is on.
  For a child created on another board (Add child), that is the child board,
  not the parent's: a team member who cannot open the child board is skipped,
  never refused and never given membership (the #1104 threat model, architect
  item 7; recorded on the MR for the owner to confirm).
- **Re-checked when applied.** The serializer checks the team when it is
  written, but a member can lose access afterwards through a group or role
  change that never touches the team row, so the stored team is filtered again
  here every time.

``Card.assignee`` is one person, so the earliest-added eligible member is the
one assigned (#2206 decision G, option (b), pending the owner's ruling).
"""

from boards.models import SwimlaneTeamMember


def eligible_ids(board, assignable_ids=None):
    """The board's assignable members who are active: who a team may hold or assign.

    The same set the card serializer's ``assignee_id`` accepts (assignable
    member, ``is_active``), so a team never names someone a card could not be
    given by hand. Pass ``assignable_ids`` when the caller already has it.
    """
    from accounts.models import User
    from boards.utils import _get_assignable_member_ids

    if assignable_ids is None:
        assignable_ids = _get_assignable_member_ids(board)
    return set(
        User.objects.filter(pk__in=assignable_ids, is_active=True).values_list("pk", flat=True)
    )


def team_member_ids(swimlane):
    """The lane's team as user ids, in the order the team was built.

    Reads ``swimlane.team_members.all()`` so a caller's prefetch serves it.
    """
    return [m.user_id for m in swimlane.team_members.all()]


def default_assignee_id(swimlane, eligible):
    """The first team member who may be assigned on the card's board, or ``None``.

    ``eligible`` returns the target board's eligible set (``eligible_ids``);
    it is a callable so a lane with no team, the common case, costs only the
    team read. It is required: with no set, no member can be shown to belong
    to the board, so nobody is assigned.
    """
    if swimlane is None:
        return None
    team = team_member_ids(swimlane)
    if not team:
        return None
    allowed = eligible() if eligible is not None else None
    if not allowed:
        return None
    for uid in team:
        if uid in allowed:
            return uid
    return None


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


def remove_from_board_teams(board, user_id):
    """Take a person off every lane team on ``board`` (member removal, #2211)."""
    SwimlaneTeamMember.objects.filter(swimlane__board=board, user_id=user_id).delete()
