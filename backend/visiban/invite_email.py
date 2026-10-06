"""Emailed invite links (#731) — build, send, and map failures.

Group admins and site admins can send an invite link straight to an address
instead of copying it into another tool. The views own permissions, caps and
the transaction that mints the link; this module owns everything after the
link exists: whether the feature is usable at all, the message, the send, and
turning a failure into the sanitized ``visiban.mail`` taxonomy.

Why the send is synchronous and after commit
--------------------------------------------
The admin is waiting on the answer ("sent" or "your mail server rejected it"),
and on failure the just-minted link must be revoked so a dead invite does not
sit in the pending list. That rules out the fire-and-forget thread notification
mail uses. It must run *after* the minting transaction commits: the site path
holds the ``SiteSetting`` row lock while it checks the cap, and an SMTP session
inside that lock would serialize every site-admin invite behind a slow relay.

What is never logged
--------------------
The recipient address, the subject, the group name, the raw token or the join
URL. Logs carry the link pk, its display prefix, the actor id and an error code
— nothing else (CLAUDE.md "never log sensitive fields").
"""
import logging

from django.conf import settings
from django.core.mail import EmailMessage, get_connection
from django.template.loader import render_to_string
from rest_framework import serializers
from rest_framework.exceptions import Throttled
from rest_framework.throttling import SimpleRateThrottle, UserRateThrottle

# Mail headers must not contain a newline, and a newline in the body would let a
# group name inject its own "Open this link" line pointing anywhere — reuse the
# notification mailer's flatten/clip helpers so the two senders cannot drift.
from boards.notifications_email import _flatten, _flatten_subject
from visiban.mail import (
    EmailConfigUnusable,
    classify_smtp_error,
    resolve_email_config,
    sender_is_placeholder,
)

logger = logging.getLogger(__name__)

SITE_NAME = "Visiban"
_CONSOLE_BACKEND = "django.core.mail.backends.console.EmailBackend"
_DATABASE_AWARE_BACKEND = "visiban.mail.DatabaseAwareEmailBackend"

# Machine-readable 403 code returned when the feature is switched off
# (INVITE_EMAIL_ENABLED=false, or DEMO_MODE).
CODE_INVITE_EMAIL_DISABLED = "invite_email_disabled"

_NAME_MAX = 100


def invite_email_enabled() -> bool:
    """True when the operator has not switched the feature off.

    DEMO_MODE is re-checked here rather than trusted to the import-time
    ``INVITE_EMAIL_ENABLED and not DEMO_MODE`` in settings: a settings override
    (tests, or a future runtime toggle) must not be able to re-enable sending
    from a public demo.
    """
    return bool(getattr(settings, "INVITE_EMAIL_ENABLED", True)) and not getattr(
        settings, "DEMO_MODE", False
    )


def delivers_to_console() -> bool:
    """True when, under DEBUG, outbound mail goes to the console, not a relay.

    Lets a developer exercise the flow locally; the response says so
    (``"delivery": "console"``) so nobody mistakes a console print for a send.
    """
    if not settings.DEBUG:
        return False
    backend = getattr(settings, "EMAIL_BACKEND", "")
    if backend == _CONSOLE_BACKEND:
        return True
    if backend == _DATABASE_AWARE_BACKEND:
        # DatabaseAwareEmailBackend delegates to the console backend under
        # DEBUG whenever the env source is in effect.
        try:
            return resolve_email_config(need_password=False).source == "env"
        except EmailConfigUnusable:
            return False
    return False


def invite_email_available() -> bool:
    """Whether the SPA should offer "send by email" at all (public site-config).

    True only when the feature is enabled, DEMO_MODE is off, and mail can
    plausibly be sent: the operator pinned ``EMAIL_BACKEND`` (their own
    transport — we cannot inspect it), or the resolved configuration has a real,
    non-placeholder sender. A DEBUG console setup also counts, so the flow can
    be exercised in development. This is a hint for the UI, not a guarantee —
    the send endpoint still reports a relay failure as a 502.
    """
    if not invite_email_enabled():
        return False
    if getattr(settings, "EMAIL_BACKEND_EXPLICIT", False):
        return True
    if delivers_to_console():
        return True
    try:
        config = resolve_email_config(need_password=False)
    except EmailConfigUnusable:
        return False
    return bool(config.from_email) and not sender_is_placeholder(config.from_email)


def join_url(raw_token: str) -> str:
    """Absolute SPA URL for an invite token — the same ``/join/<token>`` route the
    copy-link UI builds for group (``vbng_``), site (``vbnl_``) and board
    (``vbnb_``, #1444) tokens."""
    base = getattr(settings, "FRONTEND_URL", "http://localhost:5173").rstrip("/")
    return f"{base}/join/{raw_token}"


# Bidi overrides/isolates and zero-width characters. Stripped from every
# interpolated name so a group called e.g. "Team\u202Emoc.live" cannot render
# reversed text — a spoofed domain or link — in a message sent from the
# instance's trusted sender address.
_INVISIBLE_CONTROL_CHARS = dict.fromkeys(
    [*range(0x200B, 0x2010), *range(0x202A, 0x202F), *range(0x2066, 0x206A), 0xFEFF]
)


def _strip_invisible(text: str) -> str:
    return (text or "").translate(_INVISIBLE_CONTROL_CHARS)


def _clip(text: str) -> str:
    flat = _flatten(_strip_invisible(text))
    if len(flat) > _NAME_MAX:
        flat = flat[: _NAME_MAX - 1].rstrip() + "…"
    return flat


def _expires_on(expires_at) -> str:
    # Date plus UTC time: the recipient's timezone is unknown, and a bare date
    # would be off by up to a day either side.
    return expires_at.strftime("%B %d, %Y at %H:%M UTC")


def build_group_invite_message(*, group_name, inviter_name, raw_token, expires_at, to):
    context = {
        "group_name": _clip(group_name),
        "inviter_name": _clip(inviter_name) or "A group admin",
        "site_name": _clip(SITE_NAME),
        "join_url": join_url(raw_token),
        "expires_on": _expires_on(expires_at),
    }
    subject = _flatten_subject(render_to_string("groups/email/invite_subject.txt", context))
    body = render_to_string("groups/email/invite_message.txt", context)
    return EmailMessage(subject=subject, body=body, to=[to])


def build_board_invite_message(*, board_name, inviter_name, raw_token, expires_at, to):
    context = {
        "board_name": _clip(board_name),
        "inviter_name": _clip(inviter_name) or "A board admin",
        "site_name": _clip(SITE_NAME),
        "join_url": join_url(raw_token),
        "expires_on": _expires_on(expires_at),
    }
    subject = _flatten_subject(render_to_string("boards/email/invite_subject.txt", context))
    body = render_to_string("boards/email/invite_message.txt", context)
    return EmailMessage(subject=subject, body=body, to=[to])


def build_site_invite_message(*, inviter_name, raw_token, expires_at, to):
    context = {
        "inviter_name": _clip(inviter_name) or "A site admin",
        "site_name": _clip(SITE_NAME),
        "join_url": join_url(raw_token),
        "expires_on": _expires_on(expires_at),
    }
    subject = _flatten_subject(render_to_string("accounts/email/site_invite_subject.txt", context))
    body = render_to_string("accounts/email/site_invite_message.txt", context)
    return EmailMessage(subject=subject, body=body, to=[to])


def send_invite_message(message, *, link_pk, prefix, actor_id, kind):
    """Send one invite message; return ``None`` on success or an error code.

    Never raises: every failure is mapped through ``classify_smtp_error`` so no
    raw smtplib text (which can echo credentials) reaches the client or the log.
    """
    connection = None
    try:
        # A timeout floor so a blackholed relay cannot hang the request worker
        # (DatabaseAwareEmailBackend applies it only when the resolved config has
        # no timeout of its own).
        connection = get_connection(
            fail_silently=False,
            timeout=getattr(settings, "NOTIFICATION_EMAIL_TIMEOUT", 10),
        )
        message.connection = connection
        sent = message.send(fail_silently=False)
        if not sent:
            raise RuntimeError("backend reported zero messages sent")
    except Exception as exc:  # noqa: BLE001 - mapped onto the sanitized taxonomy
        code = classify_smtp_error(exc)
        logger.warning(
            "invite_email.failed kind=%s link_pk=%s prefix=%s actor_id=%s code=%s exc=%s",
            kind, link_pk, prefix, actor_id, code, type(exc).__name__,
        )
        return code
    finally:
        if connection is not None:
            try:
                connection.close()
            except Exception:  # noqa: BLE001 - closing is best-effort
                pass
    logger.info(
        "invite_email.sent kind=%s link_pk=%s prefix=%s actor_id=%s",
        kind, link_pk, prefix, actor_id,
    )
    return None


# ---------------------------------------------------------------------------
# Input validation shared by the group and site serializers
# ---------------------------------------------------------------------------

def normalize_invite_email(value: str) -> str:
    """Canonical form used for comparisons (``already_registered``), matching
    ``accounts.invite_utils._normalize_email_for_dedup``: strip + lowercase."""
    from accounts.invite_utils import _normalize_email_for_dedup
    return _normalize_email_for_dedup(value)


class InviteEmailErrorSerializer(serializers.Serializer):
    """Schema-only: the error body of the send endpoints' 403 and
    delivery-failure 502 (their 400s use ``InviteEmailBadRequestSerializer``).

    ``code`` is optional: it is present on ``invite_email_disabled`` 403s, the
    ``invite_email_cap_reached`` 400 and every 502, but a 403 raised by the
    permission layer (not a group admin / not a site admin) carries only
    ``detail``. Field-validation 400s use DRF's ``{field: [errors]}`` shape.
    """

    code = serializers.CharField(required=False)
    detail = serializers.CharField()


class InviteEmailBadRequestSerializer(serializers.Serializer):
    """Schema-only: the two shapes a send endpoint's 400 can take.

    The cap-reached 400 is ``{detail, code}``; a field-validation 400 is DRF's
    ``{field: [errors]}`` with no ``detail``. Every property is therefore
    optional, otherwise schemathesis flags the validation shape as a schema
    violation (#731).
    """

    code = serializers.CharField(required=False)
    detail = serializers.CharField(required=False)
    email = serializers.ListField(child=serializers.CharField(), required=False)
    role = serializers.ListField(child=serializers.CharField(), required=False)
    expiry_days = serializers.ListField(child=serializers.CharField(), required=False)
    expires_in_days = serializers.ListField(child=serializers.CharField(), required=False)


_FORBIDDEN_ADDRESS_CHARS = frozenset('",;<>')


class InviteEmailField(serializers.EmailField):
    """The ``email`` field both send serializers declare.

    Rejects CR/LF on the *raw* value: DRF's default ``trim_whitespace`` would
    otherwise strip a trailing line break before validation and silently accept
    it. A line break in an address is never legitimate and is the classic
    header-injection shape. Ordinary surrounding spaces are still stripped.
    The value is returned as entered (stripped, case preserved) because that is
    what gets addressed and echoed back as ``sent_to``; comparisons use
    ``normalize_invite_email``.
    """

    def __init__(self, **kwargs):
        kwargs.setdefault("max_length", 254)
        super().__init__(**kwargs)

    def to_internal_value(self, data):
        if isinstance(data, str) and any(ch in data for ch in "\r\n"):
            raise serializers.ValidationError("Enter a valid email address.")
        value = super().to_internal_value(data)
        # Django's validator accepts quoted local parts ("a,b"@example.org),
        # which can carry list separators and display-name syntax into the To
        # header. A plain mailbox never needs any of these, so refuse them.
        if any(ch in value for ch in _FORBIDDEN_ADDRESS_CHARS) or any(ch.isspace() for ch in value):
            raise serializers.ValidationError("Enter a valid email address.")
        return value


# ---------------------------------------------------------------------------
# Throttles
# ---------------------------------------------------------------------------

class InviteEmailUserThrottle(UserRateThrottle):
    """Per sending user (``invite_email_user``)."""

    scope = "invite_email_user"


class InviteEmailGroupThrottle(SimpleRateThrottle):
    """Per group (``invite_email_group``), keyed on the group id so every admin
    of one group draws from the same budget — several admins (or one admin's
    several accounts) cannot multiply a group's outbound volume."""

    scope = "invite_email_group"

    def __init__(self, group_id):
        super().__init__()
        self.group_id = group_id

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": f"group-{self.group_id}"}


class InviteEmailBoardThrottle(SimpleRateThrottle):
    """Per board (``invite_email_board``), keyed on the board id so every admin
    of one board draws from the same budget (#1444) — the board counterpart of
    ``InviteEmailGroupThrottle``."""

    scope = "invite_email_board"

    def __init__(self, board_id):
        super().__init__()
        self.board_id = board_id

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": f"board-{self.board_id}"}


class InviteEmailGlobalThrottle(SimpleRateThrottle):
    """Instance-wide ceiling on *group and board* invite emails
    (``invite_email_global``) across every sender, so a handful of admin
    accounts cannot turn the instance into a relay. Board sends (#1444) share
    it: any user can create a board, exactly as any user can create a group,
    so both belong on the non-site budget."""

    scope = "invite_email_global"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": "all"}


class InviteEmailGlobalSiteThrottle(InviteEmailGlobalThrottle):
    """Instance-wide ceiling on *site-admin* invite emails
    (``invite_email_global_site``).

    Separate from the group ceiling on purpose: any self-registered user can
    create a group and become its admin, so if both endpoints shared one
    budget, a single group admin could exhaust it and make every site-admin
    invite 429 — a cheap denial of the instance's own onboarding path.
    """

    scope = "invite_email_global_site"


def _would_allow(throttle, request, view) -> bool:
    """``SimpleRateThrottle.allow_request`` without recording the request."""
    if throttle.rate is None:
        return True
    throttle.key = throttle.get_cache_key(request, view)
    if throttle.key is None:
        return True
    throttle.history = throttle.cache.get(throttle.key, [])
    throttle.now = throttle.timer()
    while throttle.history and throttle.history[-1] <= throttle.now - throttle.duration:
        throttle.history.pop()
    return len(throttle.history) < throttle.num_requests


def check_send_throttles(request, view, *, group_id=None, board_id=None, site=False) -> list:
    """Apply every send throttle at once; raise ``Throttled`` if any is spent.

    Returns the throttles that recorded this request, for
    ``refund_send_throttles`` should the send then fail.

    Called by the views after the permission check, input validation and cap
    check rather than via ``throttle_classes``: DRF runs class throttles before
    the view body, where the group-admin check lives, so a non-admin (or a
    request refused for any other reason) could otherwise burn a shared budget.
    All throttles are checked before any is recorded, so a request refused by
    one does not consume the others' budgets.
    """
    throttles = [InviteEmailUserThrottle()]
    if group_id is not None:
        throttles.append(InviteEmailGroupThrottle(group_id))
    if board_id is not None:
        throttles.append(InviteEmailBoardThrottle(board_id))
    throttles.append(InviteEmailGlobalSiteThrottle() if site else InviteEmailGlobalThrottle())

    refused = [t for t in throttles if not _would_allow(t, request, view)]
    if refused:
        waits = [w for w in (t.wait() for t in refused) if w is not None]
        raise Throttled(wait=max(waits) if waits else None)
    recorded = []
    for t in throttles:
        if t.rate is not None and t.key is not None:
            t.throttle_success()
            recorded.append(t)
    return recorded


def refund_send_throttles(recorded) -> None:
    """Remove this request's entries again after a failed send.

    A send the mail server refused delivered nothing, so it must not count
    toward anyone's budget — otherwise a misconfigured relay would lock admins
    out of retrying once it is fixed. Re-reads the history (another request may
    have recorded meanwhile) and removes exactly the timestamp this request
    added. Not atomic against a concurrent writer, which is the same
    best-effort guarantee DRF's own throttles give.
    """
    for t in recorded:
        history = list(t.cache.get(t.key, []))
        try:
            history.remove(t.now)
        except ValueError:
            continue
        t.cache.set(t.key, history, t.duration)
