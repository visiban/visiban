"""Shared card-signal predicates (#2245): open, overdue, blocked.

One definition per signal so the card filters (``?overdue=``, ``?blocked=``)
and the auto health status (``boards.services.health_compute``) never
disagree about which cards a signal covers. Staleness has its own shared
helper, ``boards.serializers._annotate_is_stale``, which the stale digest
(``notify_stale_cards``) and the card payload already use.

Each function returns a ``Q`` over ``Card`` so callers compose it with their
own scope (a board, a lane, an open-cards filter) in SQL.

The overdue rule (#2313), the one the browser's ``utils/cardUrgency.ts``
applies too: a card is overdue when it has a due date, that date is before
today's date in ``INSTANCE_TIMEZONE`` (:func:`signal_today`), and the card is
open (:func:`open_cards_q`: not archived, not in a Done column). A card due
today is not overdue until the instance's midnight. Both sides pin the same
cases from ``boards/tests/fixtures/overdue_rule_cases.json``. The surfaces that apply the
whole rule are the auto health counts, the card face's Overdue status line and
border, the Show chips, the lane status and the Overdue filter. Still on the
user's personal time zone, pending #871: the standalone due pill's tone and glyph (shown only when no Overdue or Due soon status carries the date), and the "Due today" / "Due this week" filters. The
``?overdue=`` card filter applies only the date half, as it always has, so an
API caller composes it with the column and archive filters (changing it would
break that public filter's contract).
"""

from __future__ import annotations

import datetime
import zoneinfo

from django.conf import settings
from django.db.models import Exists, F, OuterRef, Q, Subquery
from django.utils import timezone


def signal_today() -> datetime.date:
    """Today's date in ``settings.INSTANCE_TIMEZONE`` (#2312).

    The one clock for every date-based card signal: overdue, due soon and auto
    health. Due dates are plain dates, so "today" needs a zone; UTC (the
    default) reproduces the pre-#2312 behavior exactly. Read at call time so a
    settings override takes effect, and independent of Django's ``TIME_ZONE``.
    """
    return timezone.now().astimezone(_instance_zone()).date()


def _instance_zone() -> zoneinfo.ZoneInfo:
    return zoneinfo.ZoneInfo(getattr(settings, "INSTANCE_TIMEZONE", "UTC"))


def signal_midnight(day: datetime.date) -> datetime.datetime:
    """Aware datetime of the start of ``day`` in the instance zone (#2312).

    Anchors timestamp comparisons (notify_due_soon's once-per-card rule) to the
    same day boundary :func:`signal_today` uses. Mixing in UTC midnight would
    make east-of-UTC installs re-notify on the second daily run.
    """
    return datetime.datetime.combine(day, datetime.time.min, tzinfo=_instance_zone())


def open_cards_q():
    """Cards that are still work in progress: not archived, not in a Done column.

    The same scope ``notify_stale_cards`` uses (#1845): finished work carries
    no overdue, stale or blocked signal.
    """
    return Q(archived_at__isnull=True, column__is_done=False)


def overdue_q(today):
    """Cards whose due date is before ``today`` (a ``datetime.date``).

    Callers pass :func:`signal_today` so the card filter, the due-soon job and
    auto health all share one definition of "today" (#2312).
    The date half of the overdue rule (see the module docstring). Does not
    exclude done or archived cards; compose with :func:`open_cards_q`, or use
    :func:`overdue_signal_q`, which does.
    """
    return Q(due_date__lt=today) & not_planned_q()


def planned_link_exists():
    """EXISTS a planned link for the outer ``Card`` (#2371): THE planned predicate.

    A planned child has ``needed_at_column`` set and ``planned_released_at``
    NULL. Boolean only and keyed on ``child_id``: it selects no parent id, no
    column and no board, so a surface with no viewer (share link, export, MCP,
    the digests) can apply it without learning anything about the parent
    (Rule 19). EXISTS, not a join through the reverse one-to-one, so a negated
    lookup cannot drop cards with no link at all.
    """
    from .models import CardParentLink

    return Exists(CardParentLink.objects.filter(
        child_id=OuterRef("pk"), needed_at_column__isnull=False, planned_released_at__isnull=True,
    ))


def planned_released_at():
    """When the outer ``Card``'s planned link was released, else NULL (#2371).

    The Stale clock of a released child restarts here: it is stale only when
    both its last move and this release predate the cutoff. The value is the
    child's own link timestamp, never parent data. Not keyed on
    ``needed_at_column``: the release outlives that field, which a column
    delete (``SET_NULL``) or a later "Needed: Now" clears, and the restarted
    clock must survive both.
    """
    from .models import CardParentLink

    return Subquery(CardParentLink.objects.filter(
        child_id=OuterRef("pk"), planned_released_at__isnull=False,
    ).values("planned_released_at")[:1])


def not_planned_q():
    """Cards whose due date counts: every card except a planned child (#2371).

    A planned child's date is stored but inactive until it is released, so it
    is never Overdue or Due soon (and never Stale, see
    ``serializers._annotate_is_stale``). Every other card, To do included,
    keeps its date exactly as before.
    """
    return ~planned_link_exists()


def overdue_signal_q(today):
    """The whole overdue rule (#2313): past due *and* open."""
    return overdue_q(today) & open_cards_q()


def blocked_q():
    """Cards blocked manually or by an active ``blocks`` relation (#1149).

    The same union ``CardSerializer.is_blocked`` reports: a manual block, or a
    ``blocks`` relation whose blocking card is still on the board (the
    ``_active_blockers_prefetch`` rule, #449). EXISTS rather than a join so a
    card with several blockers counts once.
    """
    from .models import CardRelation

    relation_blocked = Exists(CardRelation.objects.filter(
        to_card=OuterRef("pk"),
        relation_type=CardRelation.Type.BLOCKS,
        from_card__archived_at__isnull=True,
        # Only same-board relation rows count (#2229).
        from_card__board_id=F("to_card__board_id"),
    ))
    return Q(blocked_at__isnull=False) | Q(relation_blocked)
