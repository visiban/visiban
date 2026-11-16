"""``board.updated`` persist-and-broadcast, shared by the views and the jobs (#2245).

Extracted from ``BoardViewSet._persist_and_broadcast_board_updated`` so a
request-less writer (the auto health job, ``compute_health_status``) sends
the same event sequence a PATCH does: one persisted ``board.updated`` row,
then, on commit, the board-channel frame and the group-channel half
(``_broadcast_board_group_change``).
"""

from __future__ import annotations

from django.db import transaction


def record_board_updated(board_id, board_data, *, old_group_id, new_group_id, actor_id):
    """Persist ``board.updated`` and schedule its board- and group-channel fanout on commit.

    Call inside the write's transaction, after the write. ``actor_id`` is
    ``None`` for a system change; the caller then passes a payload without
    the actor-scoped fields (:func:`system_board_payload`).
    """
    from .. import broadcast as _broadcast
    # Looked up at call time: tests patch boards.views.boards._broadcast_group_event.
    from ..views.boards import _broadcast_board_group_change

    event_id = _broadcast.persist_board_event(
        board_id, _broadcast.EVT_BOARD_UPDATED, board_data, actor_id=actor_id,
    )

    def _broadcast_updated(
        bid=board_id, bd=board_data, og=old_group_id, ng=new_group_id, eid=event_id, aid=actor_id,
    ):
        _broadcast.broadcast_board_event(
            bid, _broadcast.EVT_BOARD_UPDATED, bd, event_id=eid, actor_id=aid,
        )
        _broadcast_board_group_change(bid, bd, og, ng, actor_id=aid)

    transaction.on_commit(_broadcast_updated)
    return board_data


def system_board_payload(board_id):
    """``BoardSerializer`` data for ``board_id`` with no viewer (a system write, #2245).

    Built from the same annotations the board list uses
    (``annotate_board_counts``) so the payload has the list's shape and
    counts. With no request there is no viewer, so the actor-scoped fields
    (``is_starred``) are left out, as ``record_share_state_board_updated``
    does (#2043).
    """
    from ..models import Board
    from ..permissions import without_actor_scoped_fields
    from ..serializers import BoardSerializer
    from ..views._helpers import annotate_board_counts
    from .. import broadcast as _broadcast

    board = annotate_board_counts(
        Board.objects.select_related("owner", "group", "health_status_changed_by")
    ).get(pk=board_id)
    data = BoardSerializer(board, context={}).data
    return without_actor_scoped_fields(_broadcast.EVT_BOARD_UPDATED, data, None, None)
