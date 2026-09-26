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
