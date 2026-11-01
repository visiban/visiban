"""The change feed's per-reader redaction, in one place (#1114, #863).

A board change-feed row is stored once, as the broadcast payload, and filtered
on every read for the reader's role and identity. The filter has two layers and
both are required:

1. :func:`feed_queryset` excludes whole rows the reader may not see at all:
   per-user rows (``PER_USER_EVENTS``) belonging to someone else, and
   admin-only rows (``ADMIN_ONLY_EVENTS``) for a reader below admin.
2. :func:`serialize_feed_rows` renders the remaining rows through
   ``BoardEventSerializer``, which strips the per-reader fields
   (``is_moderator``, ``is_site_admin``, ``invite``, the actor's
   ``is_starred``, admin-only board fields, admin-only swimlane values).

Every reader of the feed goes through both: the REST feed
(``BoardViewSet.events``), the webhook dispatcher, and any enterprise reader
registered on ``boards.hooks.BOARD_EVENT_HOOKS``. Reading ``BoardEvent.data``
directly skips layer 2 and returns fields the socket never sends
(security-invariants Rules 8 and 10).
"""

from django.db.models import Q

from ..models import BoardEvent
from ..permissions import ADMIN_ONLY_EVENTS, PER_USER_EVENTS, admin_only_event_visible


def feed_queryset(board_id, *, role, reader_id):
    """Rows of *board_id*'s feed that a reader with *role* and *reader_id* may see.

    Ordered by nothing: callers add ``order_by("id")`` and their cursor filter.
    ``reader_id=None`` (an anonymous or external reader such as a webhook)
    matches no per-user row, and an unknown ``role`` sees no admin-only row.
    """
    # Per-user rows are returned only to the user they belong to (#1677),
    # matching the socket, which forwards them only to that user's own
    # sessions. Filtered in the query, not after it, so a page stays `limit`
    # rows long. A row with no actor matches no reader; per-user events must be
    # persisted with actor_id = the owning user.
    qs = BoardEvent.objects.filter(board_id=board_id)
    if reader_id is None:
        qs = qs.exclude(event__in=PER_USER_EVENTS)
    else:
        qs = qs.exclude(Q(event__in=PER_USER_EVENTS) & ~Q(actor_id=reader_id))
    # Admin-only rows (share_link.updated, #1967) reach admin / site_admin
    # readers only, matching the socket.
    if not admin_only_event_visible(role):
        qs = qs.exclude(event__in=ADMIN_ONLY_EVENTS)
    return qs


def serialize_feed_rows(board_id, rows, *, role, reader_id):
    """Render *rows* as the feed's public row shape for this reader.

    One bulk user fetch for the page's actors (#1663) and, only when the page
    holds swimlane rows, one query for the board's shareable swimlane field
    ids (#1677). Returns a list of dicts
    ``{id, event, data, actor_id, actor, created_at}``.
    """
    from ..serializers import BoardEventSerializer

    rows = list(rows)
    return BoardEventSerializer(
        rows,
        many=True,
        context={
            "role": role,
            "reader_id": reader_id,
            "actors": BoardEventSerializer.actor_map(rows),
            "shareable_swimlane_field_ids": (
                BoardEventSerializer.shareable_swimlane_field_ids(board_id, rows)
            ),
        },
    ).data
