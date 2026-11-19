"""Live updates of webhook settings across admin sessions (#2057, 1.3 UI spec Part 9).

Every write to a subscription, from the API or the dispatcher, publishes the
admin-only board event ``webhook.changed``. It is an *invalidation*, not a
copy: the client that receives it refetches the list over REST, which is where
the full row comes from. So the frame carries only what the spec's live row
needs before that refetch lands:

``{id, status, reason_code, consecutive_failures, changed_by, at}``

and never the URL, the host, the URL's last four characters, the label, the
secret, the previous secret or a signature. ``changed_by`` is a user id (null
for the dispatcher), like the config log line.

Admin-only because webhook settings are board-admin only on every other
transport: ``webhook.changed`` is in ``boards.permissions.ADMIN_ONLY_EVENTS``,
so the board consumer forwards it to admin and site-admin sockets only, with
the role re-resolved per subscriber. It is also kept out of
``SUBSCRIBABLE_EVENT_TYPES`` by that set, so no webhook can subscribe to news
about webhooks.

Broadcast-only, never persisted to the change feed: a feed row per
dispatcher failure transition would make every webhook on the board leave its
idle fast path, and the feed is the durable record of *board* changes, which
this is not. A dropped frame costs nothing durable: the client also refetches
on window focus and on socket reconnect.

Deferred with ``transaction.on_commit`` like every board event: a rolled-back
write never announces itself, and outside a transaction (the dispatcher's
autocommit writes) the callback runs at once.
"""

from __future__ import annotations

from django.db import transaction
from django.utils import timezone

from boards import broadcast as board_broadcast
from boards.broadcast import EVT_WEBHOOK_CHANGED

from .models import WebhookSubscription

STATUS_DELETED = "deleted"


def _status(sub: WebhookSubscription) -> str:
    """The list row's status pill, as the frontend derives it (``webhookRowStatus``)."""
    if not sub.enabled:
        return "disabled"
    return "failing" if sub.consecutive_failures > 0 else "active"


def changed_payload(sub: WebhookSubscription | None, sub_id: int, *, changed_by_id=None) -> dict:
    """The frame for *sub* (None when it was deleted). Ids and codes only."""
    payload = {
        "id": sub_id,
        "status": STATUS_DELETED,
        "reason_code": "",
        "consecutive_failures": 0,
        "changed_by": changed_by_id,
        "at": timezone.now().isoformat().replace("+00:00", "Z"),
    }
    if sub is not None:
        payload.update(
            status=_status(sub),
            reason_code=sub.disabled_reason or "",
            consecutive_failures=sub.consecutive_failures,
        )
    return payload


def publish_changed(sub_id: int, board_id: int, *, changed_by_id=None, deleted=False) -> None:
    """Announce a change to *sub_id* on its board's admin sockets, after commit.

    Reads the row now, inside the caller's transaction, so the frame describes
    the write that is about to commit. A row already gone reads as deleted.
    """
    sub = None
    if not deleted:
        sub = (
            WebhookSubscription.objects.filter(pk=sub_id)
            .only("id", "enabled", "disabled_reason", "consecutive_failures")
            .first()
        )
    payload = changed_payload(sub, sub_id, changed_by_id=changed_by_id)

    # Default arguments snapshot the values: no ORM object rides into the callback.
    # Looked up on the module at call time, as record_board_event does, so a
    # test patching boards.broadcast.broadcast_board_event intercepts this too.
    def _send(bid=board_id, pl=payload):
        board_broadcast.broadcast_board_event(bid, EVT_WEBHOOK_CHANGED, pl)

    transaction.on_commit(_send)
