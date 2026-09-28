"""Hosted-demo fence: the rules behind ``DemoModeMiddleware`` (#1179).

The public demo (try.visiban.com) publishes a login on its login page. Anything
that grants authority through the *account* is therefore reachable by the whole
internet, and no seeded role can contain it: ``BoardViewSet.perform_create``
and ``POST /api/v1/groups/{id}/boards/`` both make the caller the ADMIN of the
board they create, so a published credential of *any* role is one request away
from owning something. The guarantee therefore cannot be "the demo account's
role forbids writes" — it has to be "this deployment refuses writes", whoever
asks. This module holds that rule; the middleware only applies it.

Ported from TruePPM ADR-1197 ("read-only is a deployment mode, not a role"),
with one deliberate difference: TruePPM's demo is fully read-only, but
Visiban's differentiator (a move writes the ``CardMovement`` row that History
and analytics show) is server-side, so a small, pinned set of card-content
writes stays open. See ``DEMO_ALLOWED_WRITES``.

Everything here is import-safe from ``visiban.settings``: no model imports and
no settings reads at import time.
"""

from __future__ import annotations

import datetime
import re

from django.core.exceptions import ImproperlyConfigured

#: Stable machine-readable refusal code. The SPA keys its demo affordances on
#: it (``api/client.ts``), and it is documented in docs/administration/demo-data.md.
DEMO_READ_ONLY_CODE = "demo_read_only"

#: Human-readable ``detail`` on every refusal. Shares the SPA's fixed lead
#: clause ("This is a shared demo — ...") so a refusal that reaches the fallback
#: toast reads like the designed affordances rather than a generic error.
DEMO_READ_ONLY_DETAIL = (
    "This is a shared demo — this change can't be saved here. "
    "You can create, edit and move cards; everything else is read-only."
)

#: Methods that cannot change server state by HTTP's own contract. Everything
#: NOT in this set is a write — including TRACE (which the maintenance fence
#: treats as safe) and any made-up verb — so an unrecognized method is refused
#: rather than waved through. Listing the safe set rather than the unsafe one is
#: what makes the fence fail closed.
DEMO_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

#: The complete set of writes permitted while ``DEMO_MODE`` is on, as
#: ``(METHOD, resolver view_name)``.
#:
#: THIS IS THE WHOLE GUARANTEE. One careless addition reopens a write path, so
#: ``accounts/tests/test_demo_mode.py`` pins the exact contents and fails when
#: the set changes. Every entry says why it is here.
#:
#: Matched on the resolved ``view_name`` rather than a path, because card
#: routes carry ids. ``view_name`` is the URL name when the pattern has one
#: (DRF router names derive from the viewset *method* name, hyphenated — e.g.
#: ``checklist_item`` resolves to ``board-card-checklist-item``) and the view's
#: dotted path otherwise (our ``path(...)`` overrides in visiban/urls.py and
#: accounts/urls.py are unnamed).
#:
#: Allowed writes still pass the view's own RBAC: the published visitor account
#: is a MEMBER on the seeded boards, never an ADMIN. The fence only decides
#: which write *shapes* can reach a view at all.
DEMO_ALLOWED_WRITES: frozenset[tuple[str, str]] = frozenset(
    {
        # --- auth ---------------------------------------------------------
        # The visitor has to be able to sign in as the published account.
        # Login writes a session row; there is no read-only way to log in.
        ("POST", "accounts.views.ThrottledLoginView"),
        # Nobody should be trapped in a session they cannot end. Logout only
        # ever destroys the caller's own session.
        ("POST", "rest_logout"),
        # Mints a short-lived WebSocket handshake ticket. Both consumers are
        # server-push only (`receive(): pass`), so a ticket confers no write
        # capability; blocking it would kill live updates, and two visitors
        # watching each other's moves in real time is a good demo.
        ("POST", "accounts.views.WSTicketView"),
        # --- cards: the demo's reason to exist ---------------------------
        # Create a card on a seeded board (MEMBER may; the column's own
        # allow_card_creation still applies).
        ("POST", "board-card-list"),
        # Edit a card's fields, including custom-field values, which ride on
        # the same PATCH. Deliberately PATCH only: the SPA never sends PUT, and
        # a full replace is not a shape the demo needs.
        ("PATCH", "board-card-detail"),
        # THE differentiator: a move writes the CardMovement row that History,
        # the dwell heatmap and analytics are built from.
        ("POST", "board-card-move"),
        # Archive and restore — reversible, card-scoped, and the reset wipes
        # them anyway.
        ("POST", "board-card-archive"),
        ("POST", "board-card-unarchive"),
        # Add a checklist item, and tick / edit / remove one. Card content only.
        ("POST", "board-card-checklist"),
        ("PATCH", "board-card-checklist-item"),
        ("DELETE", "board-card-checklist-item"),
    }
)

#: Default reset cadence: every hour, on the hour. The #1180 CronJob and this
#: value are rendered from the same Helm value, so the countdown cannot drift
#: from the real reset.
DEFAULT_DEMO_RESET_SCHEDULE = "0 * * * *"

_THROTTLE_RATE_RE = re.compile(r"^[1-9][0-9]*/(s|sec|second|m|min|minute|h|hour|d|day)$")

_TRUE_WORDS = frozenset({"true", "1", "yes", "on"})
_FALSE_WORDS = frozenset({"false", "0", "no", "off", ""})

_CRON_ALIASES = {"@hourly": "0 * * * *", "@daily": "0 0 * * *", "@midnight": "0 0 * * *"}


def parse_demo_mode(raw: str | None) -> bool:
    """Parse ``DEMO_MODE`` strictly; refuse to boot on an unrecognized value.

    ``env.bool`` treats every string outside its truthy list as False, so a
    typo such as ``ture`` would silently *disable* the one control the demo's
    safety rests on while the login page still publishes a credential. Here an
    unrecognized value raises instead: an operator who fat-fingers the flag gets
    a process that will not start, not a demo that looks fenced and is not.
    Unset and empty mean off, so a normal install is unaffected.
    """
    if raw is None:
        return False
    word = raw.strip().lower()
    if word in _TRUE_WORDS:
        return True
    if word in _FALSE_WORDS:
        return False
    raise ImproperlyConfigured(
        f"DEMO_MODE={raw!r} is not a recognized boolean. Use true/false (or 1/0, "
        "yes/no, on/off). Refusing to start: a misspelled value would otherwise "
        "leave a public demo writable while looking fenced."
    )


def parse_demo_user_throttle_rate(raw: str | None) -> str | None:
    """Parse ``DEMO_USER_THROTTLE_RATE`` (#1180); None when unset or blank.

    DRF's ``user`` scope counts per ACCOUNT, and on a public demo every visitor
    signs in as the one published account, so the normal 5000/hour becomes a
    single budget the whole internet shares — a handful of visitors polling
    the board exhaust it and everyone gets 429 (TruePPM ADR-1197 D6). The
    Helm chart re-aims it through this variable as a shared-fate ceiling that
    protects the node, not as a per-visitor limit. Parsed strictly: DRF only
    reads the first letter of the period and would take ``100/fortnight`` as
    100 per *day*... after crashing on a malformed number at request time.
    """
    if raw is None or not raw.strip():
        return None
    value = raw.strip()
    if not _THROTTLE_RATE_RE.match(value):
        raise ImproperlyConfigured(
            f"DEMO_USER_THROTTLE_RATE={raw!r} is not a throttle rate. Use <n>/<period> "
            "with period second, minute, hour or day, e.g. '60000/hour'."
        )
    return value


def _parse_cron_field(field: str, low: int, high: int) -> frozenset[int]:
    """Expand one cron field (``*``, ``N``, ``*/N``, ``a-b``, ``a,b``) to its values."""
    values: set[int] = set()
    for part in field.split(","):
        step = 1
        if "/" in part:
            part, step_s = part.split("/", 1)
            step = int(step_s)
            if step < 1:
                raise ValueError("step must be >= 1")
        if part == "*":
            start, end = low, high
        elif "-" in part:
            a, b = part.split("-", 1)
            start, end = int(a), int(b)
        else:
            start = end = int(part)
        if start < low or end > high or start > end:
            raise ValueError(f"{part!r} out of range {low}-{high}")
        values.update(range(start, end + 1, step))
    return frozenset(values)


def parse_demo_reset_schedule(raw: str | None) -> tuple[str, frozenset[int], frozenset[int]]:
    """Parse ``DEMO_RESET_SCHEDULE`` into ``(expression, minutes, hours)``.

    Only minute and hour are evaluated; day-of-month, month and day-of-week
    must be ``*``. That covers every cadence a reset-every-N-hours demo uses
    (``0 * * * *``, ``30 */2 * * *``, ``0 0 * * *``) without a cron dependency.
    Anything else raises: unlike TruePPM, which only displays the cadence,
    Visiban derives ``demo_next_reset_at`` from it and promises visitors a
    countdown — a schedule we cannot evaluate would publish a wrong time.
    ``None`` or blank parses as the hourly default. Note that the *setting*
    layer never passes a blank here: in ``settings.py`` a set-but-empty
    ``DEMO_RESET_SCHEDULE`` means "no reset scheduled" (#1180), and
    ``demo_next_reset_at_iso`` returns None for it before calling this.
    """
    expr = (raw or "").strip() or DEFAULT_DEMO_RESET_SCHEDULE
    expr = _CRON_ALIASES.get(expr, expr)
    fields = expr.split()
    try:
        if len(fields) != 5:
            raise ValueError("expected 5 fields")
        minute, hour, dom, month, dow = fields
        if (dom, month, dow) != ("*", "*", "*"):
            raise ValueError("day-of-month, month and day-of-week must be '*'")
        minutes = _parse_cron_field(minute, 0, 59)
        hours = _parse_cron_field(hour, 0, 23)
    except ValueError as exc:
        raise ImproperlyConfigured(
            f"DEMO_RESET_SCHEDULE={raw!r} is not a supported cron expression ({exc}). "
            "Use a minute/hour schedule such as '0 * * * *'."
        ) from exc
    return expr, minutes, hours


def next_reset_at(
    schedule: tuple[str, frozenset[int], frozenset[int]],
    now: datetime.datetime,
) -> datetime.datetime:
    """Return the first reset instant strictly after ``now`` (UTC, whole minute).

    "Strictly after" is deliberate: at exactly HH:00:00 the reset is already
    running, so the next one the visitor can plan around is the following slot.
    Cron is evaluated in UTC, matching the Kubernetes CronJob default.
    """
    _, minutes, hours = schedule
    now_utc = now.astimezone(datetime.timezone.utc)
    day = now_utc.replace(hour=0, minute=0, second=0, microsecond=0)
    # Two days always contains a slot: minutes and hours are both non-empty.
    for day_offset in (0, 1):
        base = day + datetime.timedelta(days=day_offset)
        for h in sorted(hours):
            for m in sorted(minutes):
                candidate = base.replace(hour=h, minute=m)
                if candidate > now_utc:
                    return candidate
    raise AssertionError("unreachable: a non-empty cron schedule always has a next slot")


def demo_reset_schedule() -> str | None:
    """The reset cron expression visitors are told about, or None.

    None when ``DEMO_MODE`` is off (a stray value on a real install is never
    published) and when the schedule is empty — the Helm chart renders it
    empty when ``demo.reset.enabled`` is false (#1180), and a demo whose reset
    is not running must not promise one (TruePPM ADR-1197 D9).
    """
    from django.conf import settings

    if not settings.DEMO_MODE:
        return None
    return (settings.DEMO_RESET_SCHEDULE or "").strip() or None


def demo_next_reset_at_iso(now: datetime.datetime | None = None) -> str | None:
    """ISO 8601 UTC of the next reset while ``DEMO_MODE`` is on, else None.

    Gated on ``DEMO_MODE`` in code — same shape as
    ``SiteConfigView._demo_login`` — so a stray ``DEMO_RESET_SCHEDULE`` on a
    real install never reaches the anonymous site-config endpoint. Also None
    when no reset is scheduled (empty ``DEMO_RESET_SCHEDULE``, #1180), which
    is what makes the SPA drop the countdown and the "will be erased" copy.
    """
    from django.utils import timezone

    expr = demo_reset_schedule()
    if expr is None:
        return None
    schedule = parse_demo_reset_schedule(expr)
    when = next_reset_at(schedule, now or timezone.now())
    return when.isoformat().replace("+00:00", "Z")
