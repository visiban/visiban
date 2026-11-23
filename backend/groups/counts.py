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

    One query for the whole list, bounded per group: a ``ROW_NUMBER()`` window
    partitioned by group returns at most ``MEMBER_PREVIEW_LIMIT`` rows each. The
    database still ranks every membership of each listed group (no index covers
    ``joined_at``), so a very large group is a latency cost the query count does
    not show; only five rows per group reach Python. Ordered by
    ``joined_at`` then ``id`` so the owner (the first member) normally leads and
    the order is stable. ``GroupSerializer.get_member_preview`` reads the result
    from ``_member_preview``.
    """
    from .models import GroupMembership

    ranked = (
        GroupMembership.objects.select_related("user")
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
