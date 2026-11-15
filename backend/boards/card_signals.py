"""Shared card-signal predicates (#2245): open, overdue, blocked.

One definition per signal so the card filters (``?overdue=``, ``?blocked=``)
and the auto health status (``boards.services.health_compute``) never
disagree about which cards a signal covers. Staleness has its own shared
helper, ``boards.serializers._annotate_is_stale``, which the stale digest
(``notify_stale_cards``) and the card payload already use.

Each function returns a ``Q`` over ``Card`` so callers compose it with their
own scope (a board, a lane, an open-cards filter) in SQL.
"""

from __future__ import annotations

from django.db.models import Exists, OuterRef, Q


def open_cards_q():
    """Cards that are still work in progress: not archived, not in a Done column.

    The same scope ``notify_stale_cards`` uses (#1845): finished work carries
    no overdue, stale or blocked signal.
    """
    return Q(archived_at__isnull=True, column__is_done=False)


def overdue_q(today):
    """Cards whose due date is before ``today`` (a ``datetime.date``).

    ``today`` is the caller's: the card filter keeps the server's local date
    it has always used, and the auto health job passes
    ``timezone.localdate()`` (UTC on a default install; documented, #2245).
    Does not exclude done or archived cards; compose with :func:`open_cards_q`.
    """
    return Q(due_date__lt=today)


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
