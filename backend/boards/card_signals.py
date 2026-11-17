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
cases from ``boards/tests/fixtures/overdue_rule_cases.json``. Every overdue
*signal* (auto health counts, card badges, borders, Show chips, lane status)
applies the whole rule; the ``?overdue=`` card filter applies only the date
half, as it always has, so an API caller composes it with the column and
archive filters (changing it would break that public filter's contract).
"""

from __future__ import annotations

import datetime
import zoneinfo

from django.conf import settings
from django.db.models import Exists, OuterRef, Q
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
    return Q(due_date__lt=today)


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
    ))
    return Q(blocked_at__isnull=False) | Q(relation_blocked)
