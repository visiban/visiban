"""Two-tier card-link rules (#2208, prerequisite for #1104).

Cards link parent -> child across boards, and the hierarchy is two-tier by
design: a board is either a parent tier (``cards_can_have_children`` is True)
or a child tier (False), never both. Making the tier a property of the board
rather than of each card keeps the rule structural: an admin decides once what
a board is for, and a card can never end up as both a grandparent and a child.
The per-card check in the card-link write path (a later MR) is defense in
depth on top of this predicate, not a substitute for it.

No link model exists yet, so :func:`links_blocking_flag_flip` has nothing to
refuse today. It is wired into the board write path now so the card-link MR
only has to fill in its query.
"""

from rest_framework.exceptions import ValidationError


def link_allowed(parent_board, child_board) -> bool:
    """True when a link from ``parent_board``'s card to ``child_board``'s card is allowed.

    Requires the parent board to be a parent tier and the child board to be a
    child tier. The same board on both sides fails the second condition.
    """
    return (
        parent_board.cards_can_have_children is True
        and child_board.cards_can_have_children is False
    )


def links_blocking_flag_flip(board, new_value: bool) -> int:
    """Count the existing links that flipping ``board`` to ``new_value`` would invalidate.

    Hook for the card-link MR (#1104): once links exist, turning the flag off
    on a board that has child links as a parent, or on for a board that is
    already a child, would leave links the predicate refuses. Until then there
    are no links, so this returns 0.
    """
    return 0


def check_flag_flip(board, new_value: bool) -> None:
    """Raise a 400 when changing the flag to ``new_value`` would break existing links.

    A no-op when the value is unchanged.
    """
    if new_value == board.cards_can_have_children:
        return
    blocking = links_blocking_flag_flip(board, new_value)
    if blocking:
        raise ValidationError({
            "cards_can_have_children": [
                f"Cannot change this setting while {blocking} card link(s) depend on it. "
                "Remove those links first."
            ]
        })
