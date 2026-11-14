"""The single creation path for ``Notification`` rows (#356).

Why a funnel exists at all
--------------------------
Before #356 notification rows were created at six independent call sites, three
of them with ``bulk_create``. ``bulk_create`` does not send ``post_save``, so
there was no single point a delivery backend could hook — and the enterprise
repo needs exactly that (enterprise #34 attaches Slack/Teams/webhook delivery
to ``post_notification_created`` without editing an OSS file). Routing every
site through this module is what makes that extension point complete rather
than complete-for-four-of-six-events, which is the kind of hole that gets filed
as a bug against a contract this repo cannot grep.

Every site now calls :func:`create_notifications`, including the ones that
create a single row: one code path is worth more than saving a list literal.

Ordering after commit
---------------------
Work is deferred with ``transaction.on_commit`` so the rows are committed
before anything reads or delivers them. Inside that callback:

1. OSS email delivery runs **first**, batched, over one SMTP connection, with a
   bounded timeout. It runs first so a slow third-party receiver cannot delay
   the delivery this repo is responsible for.
2. ``post_notification_created`` is then sent per row with ``send_robust``, so a
   receiver that raises is logged and dropped rather than failing the request.

Note that ``on_commit`` fires *immediately and synchronously* when no atomic
block is open, which is the case for both notification management commands and
for ``notify_new_mentions`` (itself already called from an on_commit hook). That
is why step 1 owns a timeout — see ``NOTIFICATION_EMAIL_TIMEOUT``.
"""
import logging

from django.db import transaction

from ..models import Notification
from ..signals import post_notification_created

logger = logging.getLogger(__name__)


def card_watcher_ids(card) -> set[int]:
    """Return the ids of the users implicitly watching ``card`` (#1277).

    v1 has no ``CardWatcher`` model: a card is "watched" by its creator and its
    assignee, which is the implicit-watcher definition #229 settled on. There is
    deliberately no auto-watch on comment — commenting once must not subscribe
    somebody to every later reply.

    This is the seam #229 replaces in 1.4 with an explicit watch/unwatch table.
    That migration must backfill a watcher row for every existing card's creator
    (and assignee), or everybody silently stops receiving these notifications on
    upgrade.

    The result is *not* access-checked: a creator can have left the board.
    Callers must intersect it with the board's effective member ids.
    """
    return {card.created_by_id, card.assignee_id} - {None}


_MIN_TITLE_ROOM = 40  # title characters guaranteed before a suffix is clipped


def clip_text(text, limit):
    """Shorten ``text`` to at most ``limit`` characters, ending in an ellipsis."""
    if len(text) <= limit:
        return text
    return text[: max(limit - 1, 0)] + "\u2026"


def quoted_card_verb(lead, title, suffix=""):
    """Return ``f'{lead} "{title}"{suffix}'`` clipped to fit ``Notification.verb``.

    ``Card.title`` and ``Notification.verb`` are both ``max_length=500``, so an
    unclipped title plus any prefix overflows the column — a DataError on
    PostgreSQL that would turn the request behind the notification (comment,
    move, assignment) into a 500, or abort a bulk_create in a management
    command. SQLite does not enforce varchar length, so only PostgreSQL shows it.

    The title is shortened with an ellipsis; ``lead`` and ``suffix`` (e.g.
    ``" to Done"``, ``" is due soon"``) are kept intact when they fit. An empty
    ``lead`` produces no leading space. If ``lead`` + ``suffix`` alone leave
    less than ``_MIN_TITLE_ROOM`` characters for the title, the suffix is
    clipped as a last resort. Precondition: ``lead`` itself must fit the column
    (about 496 characters); callers' leads are short and bounded (a username or a
    fixed phrase), so the result then never exceeds the column.
    """
    max_len = Notification._meta.get_field("verb").max_length
    lead_part = f"{lead} " if lead else ""
    fixed = len(lead_part) + 2  # the two quotes
    suffix_room = max_len - fixed - _MIN_TITLE_ROOM
    suffix = clip_text(suffix, max(suffix_room, 0))
    room = max_len - fixed - len(suffix)
    title = clip_text(title, room)
    return f'{lead_part}"{title}"{suffix}'


def create_notifications(notifications, *, context=None):
    """Persist ``notifications`` and schedule delivery for after the commit.

    ``notifications`` is a list of unsaved ``Notification`` instances that all
    describe the *same* originating event — one comment, one card move, one
    assignment — differing only in recipient. ``context`` is therefore a single
    dict shared by the whole batch; see the ``post_notification_created``
    docblock in ``boards/signals.py`` for the per-``action_type`` keys.

    Returns the created instances. Callers that need nothing back can ignore it.
    """
    if not notifications:
        return []

    # Inactive users are never recipients. Enforced here, in the single funnel,
    # so every producer (present and future) inherits it rather than each
    # re-implementing the check. One bulk query per batch, not per recipient.
    from accounts.models import User

    recipient_ids = {n.recipient_id for n in notifications if n.recipient_id}
    active_ids = set(
        User.objects.filter(pk__in=recipient_ids, is_active=True).values_list("pk", flat=True)
    )
    notifications = [n for n in notifications if n.recipient_id in active_ids]
    if not notifications:
        return []

    created = Notification.objects.bulk_create(notifications)
    # Snapshot the context: the caller may mutate or reuse its dict, and this
    # value is read after the transaction commits.
    payload = dict(context or {})
    # robust=True: on_commit otherwise abandons the remaining callbacks when one
    # raises, and this callback is registered *before* the card-update and
    # card-move broadcasts in boards/services/cards.py (the notification is built
    # where the assignee change is detected, the broadcast at the end of the
    # service). Without robust, a failure delivering an email would silently
    # suppress the WebSocket frame every other client on the board is waiting for.
    transaction.on_commit(
        lambda: dispatch_created_notifications(created, payload), robust=True
    )
    return created


# Room for the checklist item's text in a checklist-assignment verb (#2196).
# The card title gets the rest of ``Notification.verb``; quoted_card_verb clips.
_CHECKLIST_ITEM_VERB_ROOM = 120


def notify_checklist_item_assigned(*, item, card, board, actor, previous_assignee):
    """Notify a checklist item's new assignee that it was assigned to them (#2196).

    The same event as a card assignment, so it uses the card-assignment
    notification and its preferences: ``action_type`` ``assigned``, gated on the
    recipient's ``notif_card_assigned`` (and so, in the email sender,
    ``email_notif_card_assigned``). A second preference pair would make one
    "tell me when I'm given work" decision two toggles that could disagree.

    Sends nothing when the assignee did not change, when the item was
    unassigned, or when the actor assigned themselves. The assignee is already
    limited to the board's assignable members by ``CardChecklistSerializer``,
    and ``create_notifications`` drops inactive recipients.

    Call it inside the write's transaction *after* the ``card.updated``
    broadcast is recorded: on_commit callbacks run in registration order, and
    the board's other clients should not wait behind notification delivery
    (same ordering as ``services.cards.update_card``).
    """
    recipient = item.assignee
    if recipient is None:
        return []
    if previous_assignee is not None and previous_assignee.pk == recipient.pk:
        return []
    if actor is not None and recipient.pk == actor.pk:
        return []
    if not recipient.notif_card_assigned:
        return []
    return create_notifications(
        [
            Notification(
                recipient=recipient,
                actor=actor,
                action_type=Notification.ActionType.ASSIGNED,
                verb=quoted_card_verb(
                    "You were assigned a checklist item on",
                    card.title,
                    f': "{clip_text(item.text, _CHECKLIST_ITEM_VERB_ROOM)}"',
                ),
                card=card,
                board=board,
            )
        ],
        context={
            "previous_assignee_name": previous_assignee.username if previous_assignee else "",
            "checklist_item_id": item.pk,
            "checklist_item_text": item.text,
        },
    )


def dispatch_created_notifications(notifications, context):
    """Deliver ``notifications`` and announce them. Runs after commit.

    Public so tests can exercise the dispatch half without a transaction, and
    so a future digest sender has a seam to reuse.

    Nothing in here may raise. The write it reports on is already committed, so
    an exception escaping this frame would surface as a 500 on a request that
    actually succeeded — and, before ``robust=True`` was added at the
    registration site, would also have swallowed the broadcast queued behind it.
    """
    try:
        _dispatch(notifications, context)
    except Exception:
        # Logged without a traceback: a BadHeaderError message embeds the header
        # value, which for these messages is an address or a subject line.
        logger.error(
            "notification dispatch failed for %s",
            [n.pk for n in notifications],
        )


def _dispatch(notifications, context):
    # bulk_create populates pks on every backend Visiban supports (PostgreSQL in
    # production and CI, SQLite >= 3.35 locally), but a row with no pk cannot be
    # delivered — a receiver would have nothing to fetch — so drop it loudly
    # rather than handing out a half-built object.
    deliverable = [n for n in notifications if n.pk is not None]
    if len(deliverable) != len(notifications):
        logger.error(
            "notification dispatch dropped %d row(s) with no primary key after bulk_create",
            len(notifications) - len(deliverable),
        )
    if not deliverable:
        return

    _prime_user_caches(deliverable)

    # Imported here rather than at module scope: notifications_email imports the
    # mail plumbing, which imports accounts.models, and this module is imported
    # from boards.signals during app loading.
    from ..notifications_email import deliver_notification_emails

    try:
        deliver_notification_emails(deliverable, context)
    except Exception as exc:
        # Delivery already catches its own SMTP failures; this is the backstop
        # for a programming error in the sender. A broken email path must not
        # take the extension point down with it. Logged as a type name rather
        # than a traceback because a BadHeaderError's message contains the
        # offending header value — an address or a subject.
        logger.error(
            "notification email delivery raised %s; continuing to the signal",
            type(exc).__name__,
        )

    for notification in deliverable:
        responses = post_notification_created.send_robust(
            sender=Notification,
            notification=notification,
            recipient=notification.recipient,
            actor=notification.actor,
            context=context,
        )
        for receiver, response in responses:
            if isinstance(response, Exception):
                # Name the receiver: without it an always-throwing third-party
                # delivery backend produces an unattributable log line that
                # nobody can trace back to the add-on that caused it.
                logger.error(
                    "post_notification_created receiver %s.%s failed for notification %s",
                    getattr(receiver, "__module__", "?"),
                    getattr(receiver, "__qualname__", repr(receiver)),
                    notification.pk,
                    exc_info=response,
                )


def _prime_user_caches(notifications):
    """Refetch the ``recipient`` and ``actor`` rows in one query.

    Two purposes, and the second is why this refetches unconditionally rather
    than only filling empty caches:

    1. Two of the six creation sites build rows with ``recipient_id=`` /
       ``actor_id=`` rather than object assignment, so ``notification.recipient``
       there would be a lazy query per row. Both the email sender and every
       signal receiver need it.
    2. The other four sites hand over a User object loaded *earlier in the
       request*, before the commit this callback runs after. Every decision the
       email sender makes — ``is_active``, the per-event preference, the address
       itself — is read off that object, so a stale copy means mailing somebody
       who deactivated, opted out, or changed their address in the meantime.
       One query per batch closes that window.
    """
    from accounts.models import User

    wanted = {n.recipient_id for n in notifications if n.recipient_id}
    wanted |= {n.actor_id for n in notifications if n.actor_id}
    if not wanted:
        return

    by_id = User.objects.in_bulk(wanted)
    for n in notifications:
        if n.recipient_id in by_id:
            n.recipient = by_id[n.recipient_id]
        if n.actor_id in by_id:
            n.actor = by_id[n.actor_id]
