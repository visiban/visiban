"""Outbound email delivery for in-app notification events (#356).

Scope
-----
OSS ships SMTP delivery for four events: card assigned, @mention, due date
within 24 hours, and card moved. ``stale`` and ``board_invite`` notifications
are created through the same funnel and do fire
``post_notification_created`` — they simply have no email preference, so this
module skips them. Richer channels (Slack, Teams, webhooks) are enterprise and
attach to the signal instead; nothing here is enterprise-aware.

Why this is called directly instead of being a signal receiver
--------------------------------------------------------------
It would be tidier for OSS email to be just another
``post_notification_created`` receiver — dogfooding the extension point. It
would also be slow in a way that matters. ``DatabaseAwareEmailBackend``
resolves its configuration on every ``send_messages()`` call (#306), which for
the database source means one ``SiteEmailSetting`` query plus one HKDF key
derivation, and each ``EmailMessage.send()`` opens its own SMTP connection with
its own TLS handshake and AUTH. A comment mentioning twenty people would open
twenty connections. ``visiban/mail.py`` says so in as many words: "a digest or
bulk-invite feature should resolve once per batch and reuse the connection, not
call this per message."

So the service layer calls this once per event with the whole batch, and the
per-row signal exists for third parties, who are free to batch or not.

Failure policy
--------------
A mail failure must never break the write that produced the notification. Every
send is wrapped, SMTP errors are mapped through #306's sanitized taxonomy, and
nothing is re-raised. Logs carry notification ids, a count, and an error code —
never an address, a subject, a card title, or any other content, per the
"never log sensitive fields" rule in CLAUDE.md.
"""
import logging
from contextlib import contextmanager

from django.conf import settings
from django.core.mail import EmailMessage, get_connection

from visiban.mail import classify_smtp_error
from .models import Notification

logger = logging.getLogger(__name__)

# action_type -> the User field that opts the recipient in to email for it.
# An action_type absent from this map is never emailed by OSS. All four fields
# default to False: see the model docstring for why an upgrade must not start
# emailing anybody.
EMAIL_PREFERENCE_BY_ACTION = {
    Notification.ActionType.ASSIGNED: "email_notif_card_assigned",
    Notification.ActionType.MENTIONED: "email_notif_mentioned",
    Notification.ActionType.DUE_SOON: "email_notif_due_soon",
    Notification.ActionType.CARD_MOVED: "email_notif_card_moved",
}

# Mail headers must not contain a newline. Django raises BadHeaderError on one,
# which would turn a card title containing CR/LF into a failed send at best and
# a header-injection vector on any less careful mailer at worst. Subjects are
# flattened and clipped rather than trusted.
_SUBJECT_MAX = 200

# Module-level suppression flag. Deliberately not thread-local: its only user is
# ``seed_demo_data``, a single-threaded management command, and a thread-local
# would give a false sense of isolation in a worker process.
_suppressed = False


@contextmanager
def suppress_notification_email():
    """Disable notification email for the duration of the block.

    Exists for ``seed_demo_data``, which creates hundreds of card movements and
    notifications. Those go through the same funnel as real events, so seeding a
    development database against an instance that has working SMTP configured
    would send hundreds of real emails to whatever addresses the seed data
    happens to contain. Seeding is not an event anybody asked to be told about.
    """
    global _suppressed
    previous = _suppressed
    _suppressed = True
    try:
        yield
    finally:
        _suppressed = previous


def _flatten_subject(text):
    """Collapse whitespace and clip, so no user-supplied string reaches a header raw."""
    collapsed = " ".join((text or "").split())
    if len(collapsed) > _SUBJECT_MAX:
        collapsed = collapsed[: _SUBJECT_MAX - 1].rstrip() + "…"
    return collapsed


def _frontend_url():
    return getattr(settings, "FRONTEND_URL", "http://localhost:5173").rstrip("/")


def card_link(notification):
    """Absolute SPA link for a notification.

    Mirrors the deep link the in-app notification dropdown builds
    (``Navbar.tsx``): ``/boards/<id>?card=<id>``, which ``BoardView`` reads and
    uses to open the card detail panel. Keeping the two identical means an email
    and the bell take the reader to the same place.
    """
    base = _frontend_url()
    if notification.board_id is None:
        return base
    if notification.card_id is None:
        return f"{base}/boards/{notification.board_id}"
    return f"{base}/boards/{notification.board_id}?card={notification.card_id}"


def _build_body(notification):
    """Plain text only — no HTML alternative.

    ``verb`` is assembled from system-controlled templates but interpolates
    user-supplied card titles and usernames. In a text/plain part that is inert;
    in an HTML part it would need escaping, and an escaping mistake in an email
    body is not something CI can catch. The in-app feed renders the same string
    as React text content for the same reason.
    """
    lines = [notification.verb, ""]
    board = notification.board
    if board is not None:
        lines.append(f"Board: {board.name}")
    card = notification.card
    if card is not None:
        lines.append(f"Card: {card.title}")
    lines += [
        "",
        "Open it in Visiban:",
        card_link(notification),
        "",
        "--",
        "You are receiving this because you turned on email for this notification.",
        f"Change your notification settings: {_frontend_url()}/settings",
    ]
    return "\n".join(lines)


def _unverified_recipient_ids(recipient_ids):
    """Recipients whose address is not confirmed, when the install requires confirmation.

    Mailing board content — card titles, board names, who said what — to an
    address nobody has proved they own is an information disclosure, not merely
    a deliverability problem. But ``EMAIL_VERIFICATION`` defaults to
    ``optional``, under which unverified addresses are normal and expected, so
    refusing them unconditionally would make the feature look broken on most
    installs. The install's own policy decides: the gate applies only when the
    operator set ``EMAIL_VERIFICATION=mandatory``.
    """
    if getattr(settings, "ACCOUNT_EMAIL_VERIFICATION", "optional") != "mandatory":
        return set()
    from allauth.account.models import EmailAddress
    from accounts.models import User

    verified = {
        (user_id, (address or "").lower())
        for user_id, address in EmailAddress.objects.filter(
            user_id__in=recipient_ids, verified=True
        ).values_list("user_id", "email")
    }
    addresses = dict(
        User.objects.filter(pk__in=recipient_ids).values_list("pk", "email")
    )
    return {
        user_id
        for user_id in recipient_ids
        if (user_id, (addresses.get(user_id) or "").lower()) not in verified
    }


def eligible_recipients(notifications):
    """Filter ``notifications`` down to the ones that should produce an email."""
    candidates = []
    for notification in notifications:
        preference = EMAIL_PREFERENCE_BY_ACTION.get(notification.action_type)
        if preference is None:
            continue
        recipient = notification.recipient
        if recipient is None:
            continue
        # A deactivated account keeps its notification rows (they are history);
        # it must not keep receiving mail about them.
        if not recipient.is_active or not recipient.email:
            continue
        if not getattr(recipient, preference, False):
            continue
        candidates.append(notification)

    if not candidates:
        return []

    unverified = _unverified_recipient_ids({n.recipient_id for n in candidates})
    return [n for n in candidates if n.recipient_id not in unverified]


def deliver_notification_emails(notifications, context=None):
    """Send one email per eligible notification, over a single SMTP connection.

    Returns the number of messages the backend accepted. Never raises for a
    delivery failure — see the module docstring.

    ``context`` is accepted (and currently unused) so this signature matches the
    signal's and a future template can use the structured event detail without a
    change at the call site.
    """
    if _suppressed or not getattr(settings, "NOTIFICATION_EMAIL_ENABLED", True):
        return 0

    targets = eligible_recipients(notifications)
    if not targets:
        return 0

    unsubscribe = f"<{_frontend_url()}/settings>"
    messages = []
    for notification in targets:
        board = notification.board
        prefix = f"[{board.name}] " if board is not None else ""
        messages.append(
            EmailMessage(
                subject=_flatten_subject(f"{prefix}{notification.verb}"),
                body=_build_body(notification),
                to=[notification.recipient.email],
                headers={
                    # RFC 8058 wants a one-click POST target; Visiban has no
                    # unauthenticated unsubscribe endpoint and inventing one
                    # would be a new public surface. A link to the settings page
                    # is the honest version and is enough to keep a brand-new
                    # sending pattern out of spam folders.
                    "List-Unsubscribe": unsubscribe,
                    # Stops vacation auto-responders from replying to a robot.
                    "Auto-Submitted": "auto-generated",
                },
            )
        )

    ids = [n.pk for n in targets]
    connection = None
    try:
        # One connection for the whole batch, with a timeout floor so a
        # blackholed SMTP port cannot hang the caller indefinitely. See
        # NOTIFICATION_EMAIL_TIMEOUT and DatabaseAwareEmailBackend.__init__.
        connection = get_connection(
            timeout=getattr(settings, "NOTIFICATION_EMAIL_TIMEOUT", 10)
        )
        sent = connection.send_messages(messages) or 0
    except Exception as exc:
        # Log the sanitized #306 error code and the notification ids only: no
        # address, no subject, no card or board name.
        logger.error(
            "notification email delivery failed (code=%s) for %d message(s) %s",
            classify_smtp_error(exc),
            len(messages),
            ids,
        )
        return 0
    finally:
        if connection is not None:
            try:
                connection.close()
            except Exception:
                logger.debug("closing notification email connection failed", exc_info=True)

    if sent < len(messages):
        logger.warning(
            "notification email: backend accepted %d of %d message(s) %s",
            sent,
            len(messages),
            ids,
        )
    return sent
