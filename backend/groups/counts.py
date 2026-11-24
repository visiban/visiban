"""Correlated count annotations for ``Group`` querysets (#1766).

``Count("memberships", distinct=True)`` next to ``Count("boards", distinct=True)``
and ``Count("subgroups", distinct=True)`` joins members x boards x subgroups per
group before DISTINCT collapses them, so latency scaled with the product on large
groups while the query count stayed flat. Each count is now an independent
correlated subquery (same approach as ``boards.views._helpers.annotate_board_counts``,
#1723). Field names and types are unchanged: non-negative ints, 0 never null.

Value semantics: the old counts were annotated *before* any filter and the only
filters applied afterwards (``id__in`` access scoping, ``favorites__user``) are
row-preserving for one user, so the old distinct counts were already true totals;
the subquery counts return the same numbers.
"""
from django.db.models import Count, F, IntegerField, OuterRef, Prefetch, Subquery, Window
from django.db.models.functions import Coalesce, RowNumber

#: How many members ``GroupSerializer.member_preview`` carries per group (#2487).
MEMBER_PREVIEW_LIMIT = 5


def _count(rows, key):
    return Coalesce(
        Subquery(
            rows.order_by().values(key).annotate(c=Count("*")).values("c"),
            output_field=IntegerField(),
        ),
        0,
        output_field=IntegerField(),
    )


def annotate_group_counts(qs):
    """Annotate ``_member_count`` / ``_board_count`` / ``_subgroup_count``."""
    from boards.models import Board

    from .models import Group, GroupMembership

    return qs.annotate(
        _member_count=_count(
            GroupMembership.objects.filter(group=OuterRef("pk")), "group"
        ),
        _board_count=_count(Board.objects.filter(group=OuterRef("pk")), "group"),
        _subgroup_count=_count(
            Group.objects.filter(parent=OuterRef("pk")), "parent"
        ),
    )


def prefetch_member_preview(qs):
    """Prefetch the first ``MEMBER_PREVIEW_LIMIT`` direct members of each group (#2487).

    Two queries for the whole list, however many groups it holds: the ranked
    memberships, then their users. A ``ROW_NUMBER()`` window partitioned by
    group keeps at most ``MEMBER_PREVIEW_LIMIT`` rows each, ordered by
    ``joined_at`` then ``id`` so the owner (the first member) normally leads
    and the order is stable.

    Cost (#2557), measured on PostgreSQL 17 with 5,000 members per group: on
    a LIST of several groups the planner reads ``group_member_joined_idx`` on
    ``(group_id, joined_at, id)``, which hands the window its rows already in
    order, and the window walks every direct membership of each listed group
    (a final Sort over the few kept rows remains). On a single-group RETRIEVE
    it may instead read the ``group_id`` index and sort that group's rows;
    PostgreSQL 15+ then stops the window early through a ``Run Condition``,
    but only after the input is read and sorted. Either way the cost still
    grows with the size of the listed groups, only more slowly. The users
    are NOT joined into that statement: a ``select_related("user")`` join
    sits under the window and was paid once per membership. They load
    afterwards, for the kept rows only.
    ``GroupSerializer.get_member_preview`` reads the result from
    ``_member_preview``.
    """
    from .models import GroupMembership

    ranked = (
        GroupMembership.objects.prefetch_related("user")
        .annotate(
            _preview_rank=Window(
                RowNumber(),
                partition_by=[F("group_id")],
                order_by=[F("joined_at").asc(), F("id").asc()],
            )
        )
        .filter(_preview_rank__lte=MEMBER_PREVIEW_LIMIT)
        .order_by("joined_at", "id")
    )
    return qs.prefetch_related(Prefetch("memberships", queryset=ranked, to_attr="_member_preview"))
