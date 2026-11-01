"""BoardViewSet mixin for summary and analytics actions."""

import datetime
import json
import logging
import statistics

from django.db.models import Count, Exists, Min, OuterRef, Prefetch, Q, Subquery, Window
from django.utils import timezone
from django.utils.dateparse import parse_date
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema, inline_serializer
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.renderers import JSONRenderer
from rest_framework import serializers, status

from ..models import BoardExportLog, CardBlock, CardMovement, CardRelation
from ..serializers import CardMovementSerializer
from .. import hooks
from ..permissions import analytics_extensions_for_role
from visiban.request_shape import OFFSET_QUERY_PARAMETER, parse_offset, query_text
from ._helpers import get_board_for_user

_logger = logging.getLogger(__name__)


# Response schemas for summary/ and analytics/ (#1783). Both actions return a
# hand-built dict, so without these the schema showed the viewset's Board
# serializer, a shape neither has ever returned. Schema only: each mirrors the
# dict the view builds below, field for field, and changes nothing at runtime.
# Per-column maps are keyed by column name.
_BOARD_SUMMARY_RESPONSE = inline_serializer(
    name="BoardSummary",
    fields={
        "swimlanes": inline_serializer(
            name="BoardSummarySwimlane",
            many=True,
            fields={
                "id": serializers.IntegerField(),
                "name": serializers.CharField(),
                "color": serializers.CharField(),
                "total_cards": serializers.IntegerField(),
                "stage_distribution": serializers.DictField(
                    child=serializers.IntegerField(),
                    help_text="Active card count per column, keyed by column name (every column, zeros included).",
                ),
                "velocity_7d": serializers.IntegerField(),
                "velocity_30d": serializers.IntegerField(),
                "active_cards": serializers.IntegerField(),
                "done_30d": serializers.IntegerField(),
                "avg_cycle_days": serializers.FloatField(allow_null=True),
                "blocked_cards": serializers.IntegerField(
                    help_text=(
                        "Active cards in the swimlane that are blocked, manually or by an "
                        "active blocking relation (the card's `is_blocked`). Additive (#1149)."
                    ),
                ),
            },
        ),
        "extension_panels": serializers.ListField(
            child=serializers.DictField(),
            help_text="Panels from the ANALYTICS_EXTENSIONS hook; empty in OSS.",
        ),
    },
)

_BOARD_ANALYTICS_RESPONSE = inline_serializer(
    name="BoardAnalytics",
    fields={
        "days": serializers.IntegerField(),
        "columns": serializers.ListField(child=serializers.CharField()),
        "done_columns": serializers.ListField(child=serializers.CharField()),
        "board_medians": serializers.DictField(
            child=serializers.FloatField(allow_null=True),
            help_text="Median dwell days per active column, keyed by column name. Kept for backward compatibility.",
        ),
        "swimlanes": inline_serializer(
            name="BoardAnalyticsSwimlane",
            many=True,
            fields={
                "id": serializers.IntegerField(),
                "name": serializers.CharField(),
                "avg_days_per_column": serializers.DictField(
                    child=serializers.FloatField(allow_null=True),
                    help_text="Deprecated: use throughput_avg_days_per_column.",
                ),
                "is_outlier": serializers.DictField(child=serializers.BooleanField()),
                "age_avg_days_per_column": serializers.DictField(child=serializers.FloatField(allow_null=True)),
                "age_is_outlier": serializers.DictField(child=serializers.BooleanField()),
                "throughput_avg_days_per_column": serializers.DictField(
                    child=serializers.FloatField(allow_null=True),
                ),
                "throughput_card_count_per_column": serializers.DictField(child=serializers.IntegerField()),
                "throughput_is_outlier": serializers.DictField(child=serializers.BooleanField()),
                "deal_velocity_days": serializers.FloatField(allow_null=True),
                "stalled_cards": inline_serializer(
                    name="BoardAnalyticsStalledCard",
                    many=True,
                    fields={
                        "id": serializers.IntegerField(),
                        "uid": serializers.CharField(),
                        "title": serializers.CharField(),
                        "days_since_move": serializers.IntegerField(),
                    },
                ),
            },
        ),
        "stalled_threshold_days": serializers.IntegerField(),
        "staleness_threshold_days": serializers.IntegerField(),
        "stale_warning_pct": serializers.IntegerField(),
        "blocked": inline_serializer(
            name="BoardAnalyticsBlocked",
            help_text=(
                "Manual blocked time in the `days` window (#1149), by the column each "
                "block started in. Additive."
            ),
            fields={
                "days_per_column": serializers.DictField(
                    child=serializers.FloatField(),
                    help_text="Blocked days inside the window per column, keyed by column name (every column, zeros included).",
                ),
                "seconds_per_column": serializers.DictField(
                    child=serializers.IntegerField(),
                    help_text="The same blocked time in whole seconds, for sub-day display.",
                ),
                "blocks_per_column": serializers.DictField(
                    child=serializers.IntegerField(),
                    help_text="Blocks overlapping the window per column, keyed by column name.",
                ),
                "top_reasons": inline_serializer(
                    name="BoardAnalyticsBlockedReason",
                    many=True,
                    fields={
                        "reason": serializers.CharField(),
                        "count": serializers.IntegerField(),
                        "total_days": serializers.FloatField(),
                        "total_seconds": serializers.IntegerField(),
                    },
                ),
            },
        ),
    },
)

# How many reasons the analytics "top reasons" list returns (#1149).
_TOP_BLOCK_REASONS = 10


def _blocked_time_summary(board, columns, period_cutoff, now):
    """Blocked time per column and the most common reasons, inside the window (#1149).

    One query over ``CardBlock`` (indexed by board). A block counts for the
    part of it that falls inside ``[period_cutoff, now]``; an open block runs
    to now, or to ``archived_at`` when its card was archived while blocked.
    An open block whose card was hard-deleted has no end anyone can observe,
    so it is left out rather than accruing time forever.

    Time is attributed to the column the card was in when it was blocked
    (``CardBlock.column``), falling back to the stored name for a column that
    was deleted and recreated, like the dwell-time heatmap. A block in a
    column that no longer exists still counts toward ``top_reasons``.

    Reasons are grouped case- and whitespace-insensitively, since the same
    cause typed twice ("Waiting on customer" / "waiting on customer ") is one
    cluster; the newest spelling is the one shown.

    Every end is clipped to now: an imported block can carry a future
    timestamp, and it must not inflate anyone's numbers.

    Rows are summed in Python rather than in SQL because of the reason
    clustering. The row count is the blocks overlapping the window on one
    board (indexed by board), which stays small next to the movement rows the
    heatmap above already loads for the same window.
    """
    col_id_to_name = {c.id: c.name for c in columns}
    col_names = set(col_id_to_name.values())
    seconds_per_column = {c.name: 0.0 for c in columns}
    blocks_per_column = {c.name: 0 for c in columns}
    reasons: dict[str, dict] = {}
    rows = (
        CardBlock.objects.filter(board=board, blocked_at__lte=now)
        .filter(Q(unblocked_at__isnull=True) | Q(unblocked_at__gte=period_cutoff))
        .exclude(card__isnull=True, unblocked_at__isnull=True)
        .order_by("-blocked_at", "-id")
        .values("column_id", "column_name", "reason", "blocked_at", "unblocked_at", "card__archived_at")
    )
    for row in rows:
        end = min(row["unblocked_at"] or row["card__archived_at"] or now, now)
        start = max(row["blocked_at"], period_cutoff)
        if end <= start:
            continue
        seconds = (end - start).total_seconds()
        name = col_id_to_name.get(row["column_id"])
        if name is None and row["column_name"] in col_names:
            name = row["column_name"]
        if name is not None:
            seconds_per_column[name] += seconds
            blocks_per_column[name] += 1
        key = " ".join(row["reason"].split()).casefold()
        bucket = reasons.setdefault(key, {"reason": row["reason"].strip(), "count": 0, "seconds": 0.0})
        bucket["count"] += 1
        bucket["seconds"] += seconds
    top = sorted(reasons.values(), key=lambda r: (-r["count"], -r["seconds"], r["reason"]))
    return {
        "days_per_column": {k: round(v / 86400, 1) for k, v in seconds_per_column.items()},
        "seconds_per_column": {k: int(v) for k, v in seconds_per_column.items()},
        "blocks_per_column": blocks_per_column,
        "top_reasons": [
            {
                "reason": r["reason"], "count": r["count"],
                "total_days": round(r["seconds"] / 86400, 1), "total_seconds": int(r["seconds"]),
            }
            for r in top[:_TOP_BLOCK_REASONS]
        ],
    }

# A bad query parameter answers ``{detail, code}`` with this code (#1825): the
# one 400 shape for bad query parameters across the API (docs/api/index.md,
# "Error responses"), so a client tells "fix your parameter" apart from other
# 400s without parsing the prose in ``detail``.
_INVALID_QUERY_PARAM = "invalid_query_param"

_BAD_QUERY_PARAM_SERIALIZER = inline_serializer(
    name="BoardAnalyticsBadRequest",
    fields={
        "detail": serializers.CharField(),
        "code": serializers.CharField(help_text="Always `invalid_query_param`."),
    },
)

_ANALYTICS_400 = OpenApiResponse(
    description="`days` or `stalled_days` is not an integer or is out of range (`code: invalid_query_param`).",
    response=_BAD_QUERY_PARAM_SERIALIZER,
)

_MOVEMENTS_400 = OpenApiResponse(
    description=(
        "`moved_after` or `moved_before` is not an ISO date, `swimlane_id`, `to_column_id` or "
        "`moved_by_id` is not an integer, `exclude_type` contains a NUL (0x00) character, or "
        "`offset` is above 2^62 (`code: invalid_query_param`)."
    ),
    response=_BAD_QUERY_PARAM_SERIALIZER,
)

# Signed 64-bit range. An id outside it can never match a row; before this it
# matched nothing or errored, depending on the database, and it is now refused
# as a bad parameter. Ids inside it, including 0 and negatives, were always
# accepted (matching nothing) and stay accepted.
_MIN_ID = -(2**63)
_MAX_ID = 2**63 - 1


def _invalid_query_param(detail):
    return Response({"detail": detail, "code": _INVALID_QUERY_PARAM}, status=status.HTTP_400_BAD_REQUEST)


def _parse_iso_date(value):
    """Return a ``date`` for a ``YYYY-MM-DD`` string, or None if it is not one.

    Uses ``parse_date`` because it is what ``DateField.to_python`` used when the
    raw string went straight to the ORM, so the accepted set (for example
    non-padded ``2026-1-1``) is unchanged. It returns None on a format mismatch
    and raises ValueError for an impossible date such as 2026-02-30.
    """
    try:
        return parse_date(value)
    except ValueError:
        return None


def _parse_id(value):
    """Return an int in the signed 64-bit range for an id query param, or None if it is not one."""
    try:
        parsed = int(value)
    except ValueError:
        return None
    return parsed if _MIN_ID <= parsed <= _MAX_ID else None


class BoardAnalyticsMixin:
    """Mixin providing summary and analytics @action methods for BoardViewSet."""

    @extend_schema(responses={200: _BOARD_SUMMARY_RESPONSE})
    @action(detail=True, methods=["get"])
    def summary(self, request, pk=None):
        """Per-swimlane card counts, stage distribution, velocity, and cycle-time metrics.

        Uses aggregate queries regardless of board size instead of the
        previous S×(C+4) loop (one filter per swimlane×column cell).

        New in #342: active_cards, done_30d, and avg_cycle_days are computed
        with SQL aggregates keyed on swimlane, using Column.is_done to identify
        completion columns. avg_cycle_days measures the time from a card's first
        movement to its first entry into a done column.
        """
        # ``slim=True`` skips favorites/labels/memberships prefetches that this
        # aggregate endpoint never reads (#928).
        board, role = get_board_for_user(pk, request.user, slim=True)
        now = timezone.now()
        cutoff_7d = now - datetime.timedelta(days=7)
        cutoff_30d = now - datetime.timedelta(days=30)

        columns = list(board.columns.order_by("position"))
        swimlanes = list(board.swimlanes.order_by("position"))
        done_column_ids = {col.id for col in columns if col.is_done}

        # Query 1: card count per (swimlane, column) in one shot.
        raw_counts = (
            board.cards.filter(archived_at__isnull=True)
            .values("swimlane_id", "column_id")
            .annotate(cnt=Count("id"))
        )
        counts: dict[int, dict[int, int]] = {}
        for row in raw_counts:
            counts.setdefault(row["swimlane_id"], {})[row["column_id"]] = row["cnt"]

        # Query 2: velocity + done_30d per swimlane using is_done columns.
        vel_by_swimlane: dict[int, dict] = {}
        if done_column_ids:
            vel_qs = (
                CardMovement.objects
                .filter(card__board=board, card__archived_at__isnull=True, to_column_id__in=done_column_ids, movement_type=CardMovement.MovementType.MOVE)
                .values("card__swimlane_id")
                .annotate(
                    vel_7d=Count("id", filter=Q(moved_at__gte=cutoff_7d)),
                    vel_30d=Count("id", filter=Q(moved_at__gte=cutoff_30d)),
                )
            )
            vel_by_swimlane = {r["card__swimlane_id"]: r for r in vel_qs}

        # Query 2b: blocked active cards per swimlane (#1149), manual or
        # relation, the same union as CardSerializer.is_blocked.
        relation_blocked = Exists(CardRelation.objects.filter(
            to_card=OuterRef("pk"),
            relation_type=CardRelation.Type.BLOCKS,
            from_card__archived_at__isnull=True,
        ))
        blocked_by_swimlane = dict(
            board.cards.filter(archived_at__isnull=True)
            .filter(Q(blocked_at__isnull=False) | Q(relation_blocked))
            .values("swimlane_id")
            .annotate(cnt=Count("id"))
            .values_list("swimlane_id", "cnt")
        )

        # Query 3: avg cycle time per swimlane — time from first movement to first
        # done-column entry, averaged across cards completed in the last 30d.
        avg_cycle_by_swimlane: dict[int, float | None] = {}
        if done_column_ids:
            # 3a: first done-column entry per card in the last 30d.
            done_entries = {
                r["card_id"]: r
                for r in CardMovement.objects
                .filter(
                    card__board=board,
                    card__archived_at__isnull=True,
                    to_column_id__in=done_column_ids,
                    moved_at__gte=cutoff_30d,
                )
                .values("card_id", "card__swimlane_id")
                .annotate(done_at=Min("moved_at"))
            }
            if done_entries:
                # 3b: first movement per card (proxy for work-start) — single query.
                start_by_card = {
                    r["card_id"]: r["start_at"]
                    for r in CardMovement.objects
                    .filter(card_id__in=done_entries.keys())
                    .values("card_id")
                    .annotate(start_at=Min("moved_at"))
                }
                buckets: dict[int, list[float]] = {}
                for card_id, entry in done_entries.items():
                    start = start_by_card.get(card_id)
                    done_at = entry["done_at"]
                    if start and done_at and done_at > start:
                        days = (done_at - start).total_seconds() / 86400
                        buckets.setdefault(entry["card__swimlane_id"], []).append(days)
                avg_cycle_by_swimlane = {
                    k: round(sum(v) / len(v), 1) for k, v in buckets.items()
                }

        result = []
        for swimlane in swimlanes:
            col_counts = counts.get(swimlane.id, {})
            vel = vel_by_swimlane.get(swimlane.id, {})
            done_card_count = sum(col_counts.get(cid, 0) for cid in done_column_ids)
            active_cards = sum(col_counts.values()) - done_card_count
            result.append({
                "id": swimlane.id,
                "name": swimlane.name,
                "color": swimlane.color,
                "total_cards": sum(col_counts.values()),
                "stage_distribution": {col.name: col_counts.get(col.id, 0) for col in columns},
                "velocity_7d": vel.get("vel_7d", 0),
                "velocity_30d": vel.get("vel_30d", 0),
                "active_cards": active_cards,
                "done_30d": vel.get("vel_30d", 0),
                "avg_cycle_days": avg_cycle_by_swimlane.get(swimlane.id),
                "blocked_cards": blocked_by_swimlane.get(swimlane.id, 0),
            })

        extension_panels = []
        # Filtered on the caller's role BEFORE any panel runs (#1826): a panel
        # whose min_role is above it is never called, so it cannot leak data to
        # a viewer by forgetting its own role check. The role is the one
        # get_board_for_user authorized this request with.
        for _fn in analytics_extensions_for_role(role):
            try:
                _panel = _fn(board, request)
                # Validate here, not in the renderer: a NaN/inf or non-serializable
                # value makes DRF's JSONRenderer raise after the view returns, which
                # would 500 the whole summary and lose the swimlane data. The panel
                # is rendered with DRF's own JSONRenderer (same encoder, strict NaN
                # handling and UTF-8 encoding, so a lone surrogate fails here too)
                # and the result parsed back, so it matches what the renderer would
                # emit and a one-shot iterable is not exhausted by validation.
                if not isinstance(_panel, dict):
                    raise TypeError("panel must be a dict")
                extension_panels.append(
                    json.loads(JSONRenderer().render(_panel))
                )
            except Exception as exc:
                # Log the callable's name and the exception type only: never the
                # panel contents or exception text, which may carry sensitive data.
                _logger.warning(
                    "ANALYTICS_EXTENSIONS callable %s.%s dropped (%s)",
                    getattr(_fn, "__module__", "?"),
                    getattr(_fn, "__qualname__", type(_fn).__name__),
                    type(exc).__name__,
                )
        return Response({"swimlanes": result, "extension_panels": extension_panels})

    @extend_schema(
        parameters=[
            OpenApiParameter(
                name="days", type={"type": "integer", "minimum": 1, "maximum": 365},
                location=OpenApiParameter.QUERY, required=False,
                description="Analysis window in days, 1-365 (default 30).",
            ),
            OpenApiParameter(
                name="stalled_days", type={"type": "integer", "minimum": 1, "maximum": 90},
                location=OpenApiParameter.QUERY, required=False,
                description=(
                    "Stalled-card threshold in days, 1-90, for this request only. "
                    "Omit to use the board's staleness_threshold_days."
                ),
            ),
        ],
        responses={200: _BOARD_ANALYTICS_RESPONSE, 400: _ANALYTICS_400},
    )
    @action(detail=True, methods=["get"])
    def analytics(self, request, pk=None):
        """Time-in-stage heatmap with outlier detection and stalled cards.

        Query params:
          - ``days`` (int, default 30): window for dwell-time and velocity calculations.
          - ``stalled_days`` (int, optional): overrides ``board.staleness_threshold_days``
            for this request when explicitly provided; omit to use the board setting.

        Dwell time is measured as the number of days a card spent in each column:
        the gap between consecutive movement timestamps (or "now" for the current
        position). Period-cutoff math uses ``effective_entry = max(mv.moved_at,
        period_cutoff)`` so cards that entered a column before the selected window
        correctly contribute only the in-window portion of their dwell time rather
        than showing zero.

        ``is_outlier`` is ``True`` when a swimlane/column cell's average dwell time
        meets or exceeds ``staleness_threshold_days`` (previously used a 2x board
        median heuristic — changed to an absolute threshold in this fix).
        ``board_medians`` is retained in the response for backward compatibility.
        """
        # ``slim=True`` skips favorites/labels/memberships prefetches that this
        # aggregate endpoint never reads (#928).
        board, _ = get_board_for_user(pk, request.user, slim=True)
        try:
            days = int(request.query_params.get("days", 30))
        except (ValueError, TypeError):
            return _invalid_query_param("Query param 'days' must be a positive integer.")
        if days <= 0:
            return _invalid_query_param("Query param 'days' must be a positive integer.")
        if days > 365:
            return _invalid_query_param("Query param 'days' must not exceed 365.")
        now = timezone.now()
        # Stall threshold is a board-level setting, independent of the period selector.
        # The period controls the dwell-time analysis window; staleness is how long a
        # card must sit unmoved before it is considered stuck — these are separate concepts.
        # The stalled_days query param overrides the board setting for this request when
        # explicitly provided; omit it to use board.staleness_threshold_days.
        if "stalled_days" in request.query_params:
            try:
                stalled_days_param = int(request.query_params["stalled_days"])
            except (ValueError, TypeError):
                return _invalid_query_param("Query param 'stalled_days' must be a positive integer.")
            if stalled_days_param <= 0:
                return _invalid_query_param("Query param 'stalled_days' must be a positive integer.")
            if stalled_days_param > 90:
                return _invalid_query_param("Query param 'stalled_days' must not exceed 90.")
            effective_stalled_days = stalled_days_param
        else:
            effective_stalled_days = board.staleness_threshold_days
        stall_cutoff = now - datetime.timedelta(days=effective_stalled_days)
        # The period window controls which dwell-time data feeds the heatmap.
        period_cutoff = now - datetime.timedelta(days=days)

        columns = list(board.columns.order_by("position"))
        # Load swimlanes into a list here so the loop at the bottom of this method
        # iterates a Python list rather than issuing a fresh queryset.  Calling
        # board.swimlanes.order_by() inside the for-statement bypasses Django's
        # prefetch cache because order_by() always creates a new queryset.
        swimlanes = list(board.swimlanes.order_by("position"))
        # Partition columns into active (dwell tracked) and done (terminal — clock stops
        # on entry). col_id_to_name and col_name_set are built from ALL columns so the
        # denormalized-name fallback for deleted/recreated columns continues to work.
        done_col_ids = {c.id for c in columns if c.is_done}
        done_col_names = {c.name for c in columns if c.is_done}
        active_columns = [c for c in columns if not c.is_done]
        col_id_to_name = {c.id: c.name for c in columns}
        # Set of current column names for the denormalized-name fallback below.
        col_name_set = {c.name for c in columns}

        swimlane_results = []
        all_col_dwells: dict[str, list[float]] = {c.name: [] for c in active_columns}
        # Age aggregator: dwell for cards currently occupying each active column (all swimlanes).
        all_age_dwells: dict[str, list[float]] = {c.name: [] for c in active_columns}

        # Load cards within the analysis window and their movements in two
        # queries (cards + prefetch), then group by swimlane to avoid
        # O(swimlanes) extra card+movement queries.
        # Include cards archived within the window so their dwell-time data
        # contributes to the heatmap.  Cards archived before the window would
        # inflate past-column counts without adding value to the selected view.
        # Age mode needs all currently-active (non-archived) cards regardless of
        # the period window, so we load the union.
        #
        # Five per-card movement aggregates are annotated at the SQL level so
        # the movement prefetch can be scoped to a bounded window without losing
        # age-mode, velocity, and stall-detection data that may predate the window.
        # All five are correlated subqueries compiled into the main SELECT — no
        # extra round-trips to the database (still 2 queries: cards + prefetch).
        _mv_qs = CardMovement.objects.filter(card=OuterRef("pk"))
        _last_mv_qs = _mv_qs.order_by("-moved_at")
        all_cards = list(
            board.cards.filter(
                Q(archived_at__isnull=True) | Q(archived_at__gte=period_cutoff)
            )
            .annotate(
                # Most-recent movement timestamp — used for stall detection.
                _last_moved_at=Subquery(_last_mv_qs.values("moved_at")[:1]),
                # Most-recent movement destination — mirrors movements[-1].to_column_id
                # so stall detection works even for cards stalled before the prefetch window.
                _last_col_id=Subquery(_last_mv_qs.values("to_column_id")[:1]),
                # Denormalized column name fallback for deleted/recreated columns.
                _last_col_name=Subquery(_last_mv_qs.values("to_column_name")[:1]),
                # Most-recent entry into the card's *current* column — used for age mode
                # so cards that entered their column before the window are still represented.
                _last_col_entry_at=Subquery(
                    _mv_qs.filter(to_column_id=OuterRef("column_id"))
                    .order_by("-moved_at")
                    .values("moved_at")[:1]
                ),
                # First-ever movement timestamp — used for velocity so cycle time is
                # measured from origin rather than from the window start.
                _first_moved_at=Subquery(
                    _mv_qs.order_by("moved_at").values("moved_at")[:1]
                ),
            )
            .prefetch_related(
                Prefetch(
                    "movements",
                    # Scope the prefetch to a 2× analysis-window buffer so the
                    # clamped-dwell logic (movements entering just before period_cutoff)
                    # still has its data, while eliminating the O(cards × all-time
                    # movements) memory spike from loading full movement history (#654/#646).
                    # Age mode, stall detection, and velocity use card-level annotations
                    # above instead of the prefetch, so no historical data is lost.
                    # Load only the fields the algorithm reads; order at the DB level so
                    # the per-card Python sort is eliminated.
                    queryset=CardMovement.objects.filter(
                        moved_at__gte=period_cutoff - datetime.timedelta(days=days)
                    ).only(
                        "card_id", "to_column_id", "to_column_name", "moved_at"
                    ).order_by("moved_at"),
                )
            )
            .order_by("swimlane_id", "position")
        )
        cards_by_swimlane: dict[int, list] = {}
        for _c in all_cards:
            cards_by_swimlane.setdefault(_c.swimlane_id, []).append(_c)

        for swimlane in swimlanes:
            cards = cards_by_swimlane.get(swimlane.id, [])
            # col_dwells: period-filtered, clamped entry — feeds avg_days_per_column (deprecated).
            col_dwells: dict[str, list[float]] = {c.name: [] for c in active_columns}
            # throughput_dwells: period-filtered, actual entry — feeds throughput_avg_days_per_column.
            throughput_dwells: dict[str, list[float]] = {c.name: [] for c in active_columns}
            # age_dwells: current dwell for non-archived, non-done cards — feeds age_avg_days_per_column.
            age_dwells: dict[str, list[float]] = {c.name: [] for c in active_columns}
            stalled_cards = []
            deal_velocity_days = []

            for card in cards:
                # .all() reads from the Prefetch cache (already ordered by moved_at at
                # the DB level above); list() materialises it so len() and indexing work.
                # The prefetch is scoped to a 2× window buffer — movements contains
                # only entries from period_cutoff - days onward.
                movements = list(card.movements.all())

                # ── Throughput pass (period-filtered transitions) ───────────────
                for i, mv in enumerate(movements):
                    col_name = col_id_to_name.get(mv.to_column_id)
                    # Fall back to the denormalized name field when the FK no longer
                    # resolves — this happens when a column was deleted and recreated
                    # with a new PK while the name stayed the same.
                    # Guard: only trigger when to_column_id is genuinely absent from
                    # this board's column set (not just a None FK). If two active
                    # columns share the same name the fallback is ambiguous and will
                    # attribute dwell to whichever name appears in col_name_set; this
                    # is a known limitation accepted because duplicate column names on
                    # a single board are rare in practice.
                    if mv.to_column_id not in col_id_to_name and mv.to_column_name in col_name_set:
                        col_name = mv.to_column_name
                    if not col_name:
                        continue
                    # Done columns are terminal — dwell is not tracked here. The card's
                    # clock stops at entry into a done column; counting time spent there
                    # would inflate the heatmap with post-completion idle time.
                    if mv.to_column_id in done_col_ids or col_name in done_col_names:
                        continue
                    # For archived cards use archived_at as the terminal timestamp so
                    # dwell time covers only the active period, not time since archiving.
                    exit_ = movements[i + 1].moved_at if i + 1 < len(movements) else (card.archived_at or now)
                    # Skip movements that ended entirely before the analysis window.
                    if exit_ <= period_cutoff:
                        continue
                    # avg_days_per_column (deprecated): clamped entry for backward compat.
                    effective_entry_clamped = max(mv.moved_at, period_cutoff)
                    col_dwells[col_name].append((exit_ - effective_entry_clamped).total_seconds() / 86400)
                    all_col_dwells[col_name].append((exit_ - effective_entry_clamped).total_seconds() / 86400)
                    # throughput_avg_days_per_column: only cards that actually exited this
                    # column during the period (next movement exists, or card was archived).
                    # Currently-dwelling cards (exit_ == now, no next movement) are excluded —
                    # they haven't left yet, so counting them would make throughput identical
                    # to age mode and inflate averages with in-progress dwell time.
                    card_exited = i + 1 < len(movements) or card.archived_at is not None
                    if card_exited:
                        throughput_dwells[col_name].append((exit_ - mv.moved_at).total_seconds() / 86400)

                # ── Long-dwelling cards (no movements in the 2× buffer) ──────────
                # Cards that have been sitting in their current column since before the
                # buffer start have no entries in the prefetch but still need to
                # contribute to col_dwells (deprecated avg_days_per_column).
                # Their clamped dwell equals exactly `days` (entry clamped to
                # period_cutoff, exit = now).  throughput_dwells is intentionally
                # excluded — the card hasn't left the column during the period.
                # The `_last_moved_at is not None` guard excludes newly-created cards
                # that have never been moved (no movement record → dwell is not meaningful).
                if (
                    not movements
                    and card._last_moved_at is not None
                    and card.archived_at is None
                    and card.column_id not in done_col_ids
                ):
                    stale_col_name = col_id_to_name.get(card.column_id)
                    if stale_col_name and stale_col_name not in done_col_names:
                        col_dwells[stale_col_name].append(float(days))
                        all_col_dwells[stale_col_name].append(float(days))

                # ── Age pass (currently-dwelling cards, snapshot of "now") ────────
                # Only for non-archived cards in non-done columns.
                # Uses _last_col_entry_at annotation (compiled into the main card SELECT)
                # so cards that entered their column before the analysis window are still
                # represented without requiring all-time movement history in the prefetch.
                if card.archived_at is None and card.column_id not in done_col_ids:
                    current_col_name = col_id_to_name.get(card.column_id)
                    if current_col_name and current_col_name not in done_col_names:
                        last_col_entry_at = card._last_col_entry_at
                        if last_col_entry_at is not None:
                            age_days = (now - last_col_entry_at).total_seconds() / 86400
                            age_dwells[current_col_name].append(age_days)
                            all_age_dwells[current_col_name].append(age_days)

                # ── Velocity ──────────────────────────────────────────────────────
                # Only count cards whose last movement in the window fell at or after
                # period_cutoff, so the metric reflects recent throughput.
                # _first_moved_at annotation gives the card's true first-ever movement
                # so cycle time is measured from origin — important for cards older than
                # the 2× prefetch buffer where movements[0] is not the true start.
                if (
                    movements
                    and movements[-1].moved_at >= period_cutoff
                    and card._first_moved_at is not None
                ):
                    deal_velocity_days.append(
                        (movements[-1].moved_at - card._first_moved_at).total_seconds() / 86400
                    )

                # ── Stalled detection ────────────────────────────────────────────
                # Cards in done columns are excluded — they have completed the workflow.
                # Uses _last_col_id / _last_col_name annotations (mirrors the original
                # movements[-1].to_column_id / to_column_name logic) and _last_moved_at
                # (covers all-time history) so cards stalled before the prefetch window
                # are still detected correctly.
                if card.archived_at is None:
                    last_col_is_done = (
                        card._last_col_id in done_col_ids
                        or card._last_col_name in done_col_names
                    )
                    last_moved_at = card._last_moved_at
                    if not last_col_is_done and last_moved_at is not None and last_moved_at < stall_cutoff:
                        stalled_cards.append({
                            "id": card.id,
                            "uid": card.uid,
                            "title": card.title,
                            "days_since_move": (now - last_moved_at).days,
                        })

            def _avg(vals: list[float]) -> float | None:
                return round(sum(vals) / len(vals), 1) if vals else None

            avg_days = {col.name: _avg(col_dwells[col.name]) for col in active_columns}
            throughput_avg = {col.name: _avg(throughput_dwells[col.name]) for col in active_columns}
            throughput_count = {col.name: len(throughput_dwells[col.name]) for col in active_columns}
            age_avg = {col.name: _avg(age_dwells[col.name]) for col in active_columns}

            swimlane_results.append({
                "id": swimlane.id,
                "name": swimlane.name,
                # Deprecated field — kept for backward compatibility; use throughput_avg_days_per_column.
                "avg_days_per_column": avg_days,
                "is_outlier": {},  # populated below
                # Age mode: current dwell snapshot (cards presently in each column).
                "age_avg_days_per_column": age_avg,
                "age_is_outlier": {},  # populated below
                # Throughput mode: dwell for cards that exited each column in the period.
                "throughput_avg_days_per_column": throughput_avg,
                "throughput_card_count_per_column": throughput_count,
                "throughput_is_outlier": {},  # populated below
                "deal_velocity_days": (
                    round(sum(deal_velocity_days) / len(deal_velocity_days), 1)
                    if deal_velocity_days else None
                ),
                "stalled_cards": stalled_cards,
            })

        board_medians = {
            col.name: (
                round(statistics.median(all_col_dwells[col.name]), 1)
                if all_col_dwells[col.name] else None
            )
            for col in active_columns
        }
        # is_outlier / age_is_outlier / throughput_is_outlier all use board.staleness_threshold_days
        # (not effective_stalled_days) so heatmap cell coloring is anchored to the board's
        # configured threshold regardless of any stalled_days query-param override.
        threshold = board.staleness_threshold_days
        for sw in swimlane_results:
            sw["is_outlier"] = {
                col.name: (
                    sw["avg_days_per_column"][col.name] is not None
                    and sw["avg_days_per_column"][col.name] >= threshold
                )
                for col in active_columns
            }
            sw["age_is_outlier"] = {
                col.name: (
                    sw["age_avg_days_per_column"][col.name] is not None
                    and sw["age_avg_days_per_column"][col.name] >= threshold
                )
                for col in active_columns
            }
            sw["throughput_is_outlier"] = {
                col.name: (
                    sw["throughput_avg_days_per_column"][col.name] is not None
                    and sw["throughput_avg_days_per_column"][col.name] >= threshold
                )
                for col in active_columns
            }

        return Response({
            "days": days,
            "columns": [c.name for c in columns],
            "done_columns": [c.name for c in columns if c.is_done],
            "board_medians": board_medians,  # kept for backward compat
            "swimlanes": swimlane_results,
            "stalled_threshold_days": effective_stalled_days,
            "staleness_threshold_days": board.staleness_threshold_days,
            "stale_warning_pct": board.stale_warning_pct,
            # Additive (#1149): blocked time per column and top reasons.
            "blocked": _blocked_time_summary(board, columns, period_cutoff, now),
        })

    @extend_schema(
        summary="List board-level movement history with filtering and offset pagination",
        # Every filter is parsed by hand in movements() below (#1975).
        parameters=[
            *(
                OpenApiParameter(
                    name=name, type={"type": "integer", "format": "int64"},
                    location=OpenApiParameter.QUERY, required=False, description=description,
                )
                for name, description in (
                    ("swimlane_id", "Filter by the card's current swimlane ID."),
                    ("to_column_id", "Filter by destination column ID."),
                    ("moved_by_id", "Filter by the ID of the user who performed the move."),
                )
            ),
            OpenApiParameter(
                name="moved_after", type=OpenApiTypes.DATE,
                location=OpenApiParameter.QUERY, required=False,
                description="Include movements on or after this date (`YYYY-MM-DD`).",
            ),
            OpenApiParameter(
                name="moved_before", type=OpenApiTypes.DATE,
                location=OpenApiParameter.QUERY, required=False,
                description="Include movements on or before this date (`YYYY-MM-DD`).",
            ),
            OpenApiParameter(
                name="exclude_type", type={"type": "array", "items": {"type": "string"}},
                location=OpenApiParameter.QUERY, required=False, style="form", explode=False,
                description=(
                    "Comma-separated `movement_type` values to exclude (`move`, `archived`, "
                    "`unarchived`); `archived,unarchived` hides system events."
                ),
            ),
            OFFSET_QUERY_PARAMETER,
        ],
        responses={
            200: inline_serializer(
                name="BoardMovementsPage",
                fields={
                    "count": serializers.IntegerField(),
                    "offset": serializers.IntegerField(),
                    "page_size": serializers.IntegerField(),
                    "results": CardMovementSerializer(many=True),
                },
            ),
            400: _MOVEMENTS_400,
        },
    )
    @action(detail=True, methods=["get"], url_path="movements")
    def movements(self, request, pk=None):
        """Board-level movement history with filtering and offset pagination.

        Returns CardMovement records for the board, newest first, with card
        title and uid denormalized for display. All board members (including
        viewers) may read movement history.

        Query params:
          - ``swimlane_id`` (int): filter by the card's current swimlane.
          - ``to_column_id`` (int): filter by destination column.
          - ``moved_by_id`` (int): filter by the user who performed the move.
          - ``moved_after`` (ISO date): include movements on or after this date.
          - ``moved_before`` (ISO date): include movements on or before this date.
          - ``exclude_type`` (comma-separated): movement_type values to exclude
            (e.g. ``archived,unarchived`` hides system events).
          - ``offset`` (int, default 0): pagination offset.

        Returns all history when no date params are provided. Page size is fixed at 50.
        """
        board, role = get_board_for_user(pk, request.user)
        PAGE_SIZE = 50

        # Read by the movement's own board (#1469), not card__board: a
        # hard-deleted card's retained history (card NULL) still belongs to
        # this board's History. For live cards the two select the same rows:
        # the API never moves a card between boards, and the Django admin,
        # which can, re-points the card's movements (CardAdmin.save_model).
        # select_related on the nullable card FK is a LEFT JOIN, so retained
        # rows are kept and serialize from their card_uid / card_title
        # snapshot. Served by movement_board_moved_idx. Rows an older release
        # wrote during a rolling upgrade, after the 0080 backfill, carry no
        # board; the second branch finds them through their card so they are
        # never missing from History, whether or not
        # backfill_card_movement_snapshots has run. (If their card is deleted
        # first, set_null_keeping_board fills the board.)
        # The card-join branch defeats the (board, -moved_at) index's early
        # exit (about 100x slower on a 10k-row board), so it is added only
        # while rollout rows with no board exist; the probe is an index scan on
        # the same index and the common, backfilled case keeps the fast plan.
        on_board = Q(board=board)
        if CardMovement.objects.filter(board__isnull=True, card__isnull=False).exists():
            on_board |= Q(board__isnull=True, card__board=board)
        qs = (
            CardMovement.objects
            .filter(on_board)
            .select_related("card", "moved_by", "from_column", "to_column", "from_swimlane", "to_swimlane")
            .order_by("-moved_at")
        )

        # Date range — no default cutoff; all history is shown when neither
        # param is supplied. Results are always paginated (PAGE_SIZE=50) so the
        # absence of a default window does not cause runaway queries.
        moved_after = request.query_params.get("moved_after")
        moved_before = request.query_params.get("moved_before")
        if moved_after:
            after_date = _parse_iso_date(moved_after)
            if after_date is None:
                return _invalid_query_param("moved_after must be a valid ISO date.")
            qs = qs.filter(moved_at__date__gte=after_date)
        if moved_before:
            before_date = _parse_iso_date(moved_before)
            if before_date is None:
                return _invalid_query_param("moved_before must be a valid ISO date.")
            qs = qs.filter(moved_at__date__lte=before_date)

        # Validated before filtering: a non-integer would raise ValueError
        # inside the ORM and surface as a 500.
        for param, lookup in (
            ("swimlane_id", "card__swimlane_id"),
            ("to_column_id", "to_column_id"),
            ("moved_by_id", "moved_by_id"),
        ):
            raw = request.query_params.get(param)
            if raw:
                parsed = _parse_id(raw)
                if parsed is None:
                    return _invalid_query_param(f"{param} must be a positive integer.")
                qs = qs.filter(**{lookup: parsed})

        # NUL-checked (#1887): movement_type__in with a NUL is a DataError (500).
        exclude_type = query_text(request, "exclude_type")
        if exclude_type:
            exclude_types = [t.strip() for t in exclude_type.split(",") if t.strip()]
            qs = qs.exclude(movement_type__in=exclude_types)

        offset = parse_offset(request)

        # Enterprise delivery-report export hook — dispatched when a registered
        # backend is present AND the request includes ?export=<format> (e.g.
        # ?export=csv or ?export=xlsx). OSS always skips this block (empty list).
        # Enterprise registers a callable with signature (board, queryset, request)
        # -> HttpResponse into MOVEMENT_EXPORT_BACKENDS; the first registered
        # backend handles the request.
        export_format = request.query_params.get("export", "").strip()
        if export_format and hooks.MOVEMENT_EXPORT_BACKENDS:
            # Imported here, not at module level, to keep the two view modules
            # decoupled at import time.
            from .import_export import (
                BoardExportThrottle, _can_export_at_min_role, _effective_export_min_role,
                _role_at_export,
            )

            # Same 20/hour export budget as the board export endpoint. Applied
            # only in this branch so ordinary JSON reads are not throttled.
            throttle = BoardExportThrottle()
            if not throttle.allow_request(request, self):
                self.throttled(request, throttle.wait())

            # Apply the same per-board export threshold and audit trail as the
            # board export endpoint (#843, #842) before handing off, so every
            # registered backend inherits them rather than re-implementing them.
            if not _can_export_at_min_role(board, request.user, role):
                return Response(
                    {
                        "detail": "Export is restricted on this board.",
                        "code": "export_restricted",
                        "min_role": _effective_export_min_role(board),
                    },
                    status=status.HTTP_403_FORBIDDEN,
                )
            backend = hooks.MOVEMENT_EXPORT_BACKENDS[0]
            # Live cards only (#1469): the hook's queryset has always held only
            # rows with a card, and a backend may read ``mv.card``. Retained
            # history of hard-deleted cards is not handed to it until the
            # extension-point contract says rows may have ``card=None`` (#1796).
            export_qs = qs.filter(card__isnull=False)
            response = backend(board, export_qs, request)
            # Audit only exports that actually produced data (like the board
            # export, which logs after the body is assembled); a failed or
            # rejected backend call is not an export.
            if getattr(response, "status_code", 500) < 400:
                BoardExportLog.objects.create(
                    board=board,
                    actor=request.user,
                    role_at_export=_role_at_export(board, request.user, role),
                    # export_format is capped at 20 chars; the value is user input.
                    export_format=f"movements_{export_format.lower()}"[:20],
                    row_count=export_qs.count(),
                )
            return response

        # Annotate `_total` via window function so the page fetch returns the
        # full count alongside each row — saves a second `COUNT(*)` round-trip
        # on boards with long movement history (#798).
        page = list(
            qs.annotate(_total=Window(Count("id")))[offset: offset + PAGE_SIZE]
        )
        total = page[0]._total if page else qs.count()

        serializer = CardMovementSerializer(page, many=True, context={"request": request})
        return Response({
            "count": total,
            "offset": offset,
            "page_size": PAGE_SIZE,
            "results": serializer.data,
        })
