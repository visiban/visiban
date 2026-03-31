"""BoardViewSet mixin for summary and analytics actions."""

import datetime
import statistics

from django.db.models import Count, Min, Q
from django.utils import timezone
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework import status

from ..models import CardMovement
from .. import hooks
from ._helpers import get_board_for_user


class BoardAnalyticsMixin:
    """Mixin providing summary and analytics @action methods for BoardViewSet."""

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
        board, _ = get_board_for_user(pk, request.user)
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
            })

        extension_panels = [fn(board, request) for fn in hooks.ANALYTICS_EXTENSIONS]
        return Response({"swimlanes": result, "extension_panels": extension_panels})

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
        board, _ = get_board_for_user(pk, request.user)
        try:
            days = int(request.query_params.get("days", 30))
        except (ValueError, TypeError):
            return Response(
                {"detail": "Query param 'days' must be a positive integer."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if days <= 0:
            return Response(
                {"detail": "Query param 'days' must be a positive integer."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if days > 365:
            return Response(
                {"detail": "Query param 'days' must not exceed 365."},
                status=status.HTTP_400_BAD_REQUEST,
            )
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
                return Response(
                    {"detail": "Query param 'stalled_days' must be a positive integer."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if stalled_days_param <= 0:
                return Response(
                    {"detail": "Query param 'stalled_days' must be a positive integer."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if stalled_days_param > 90:
                return Response(
                    {"detail": "Query param 'stalled_days' must not exceed 90."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            effective_stalled_days = stalled_days_param
        else:
            effective_stalled_days = board.staleness_threshold_days
        stall_cutoff = now - datetime.timedelta(days=effective_stalled_days)
        # The period window controls which dwell-time data feeds the heatmap.
        period_cutoff = now - datetime.timedelta(days=days)

        columns = list(board.columns.order_by("position"))
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

        # Load all cards and their movements in two queries (cards + prefetch),
        # then group by swimlane to avoid O(swimlanes) extra card+movement queries.
        all_cards = list(
            board.cards.prefetch_related("movements").order_by("swimlane_id", "position")
        )
        cards_by_swimlane: dict[int, list] = {}
        for _c in all_cards:
            cards_by_swimlane.setdefault(_c.swimlane_id, []).append(_c)

        for swimlane in board.swimlanes.order_by("position"):
            cards = cards_by_swimlane.get(swimlane.id, [])
            col_dwells: dict[str, list[float]] = {c.name: [] for c in active_columns}
            stalled_cards = []
            deal_velocity_days = []

            for card in cards:
                # Use .all() to read from the prefetch cache; re-sorting in Python
                # avoids an extra ORDER BY query per card.
                movements = sorted(card.movements.all(), key=lambda m: m.moved_at)
                if not movements:
                    continue
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
                    # Clamp the entry to the period cutoff so cards that entered a column
                    # before the window still contribute their in-window dwell time.
                    # Without this, a card sitting in "In Progress" for 60 days would show
                    # no data in the 7d or 30d views — even though it is actively dwelling.
                    effective_entry = max(mv.moved_at, period_cutoff)
                    dwell_days = (exit_ - effective_entry).total_seconds() / 86400
                    col_dwells[col_name].append(dwell_days)
                    all_col_dwells[col_name].append(dwell_days)
                # Velocity: only count cards whose last movement fell within the window,
                # so the metric reflects recent throughput rather than all-time history.
                if len(movements) > 1 and movements[-1].moved_at >= period_cutoff:
                    deal_velocity_days.append(
                        (movements[-1].moved_at - movements[0].moved_at).total_seconds() / 86400
                    )
                # Cards in done columns are excluded from stalled detection — they have
                # completed the workflow. Note: done_col_ids reflects current is_done
                # state, so a column later re-flagged as done retroactively excludes
                # its cards from stalled detection.
                last_mv = movements[-1]
                last_col_is_done = (
                    last_mv.to_column_id in done_col_ids
                    or last_mv.to_column_name in done_col_names
                )
                if card.archived_at is None and not last_col_is_done and last_mv.moved_at < stall_cutoff:
                    stalled_cards.append({
                        "id": card.id,
                        "title": card.title,
                        "days_since_move": (now - movements[-1].moved_at).days,
                    })

            avg_days = {
                col.name: (
                    round(sum(col_dwells[col.name]) / len(col_dwells[col.name]), 1)
                    if col_dwells[col.name] else None
                )
                for col in active_columns
            }
            swimlane_results.append({
                "id": swimlane.id,
                "name": swimlane.name,
                "avg_days_per_column": avg_days,
                "deal_velocity_days": (
                    round(sum(deal_velocity_days) / len(deal_velocity_days), 1)
                    if deal_velocity_days else None
                ),
                "stalled_cards": stalled_cards,
                "is_outlier": {},
            })

        board_medians = {
            col.name: (
                round(statistics.median(all_col_dwells[col.name]), 1)
                if all_col_dwells[col.name] else None
            )
            for col in active_columns
        }
        # is_outlier intentionally uses board.staleness_threshold_days (not effective_stalled_days)
        # so that heatmap cell coloring is always anchored to the board's configured threshold,
        # regardless of any stalled_days query-param override. The override affects only the
        # stalled_cards list — it is an ad-hoc investigation tool, not a permanent display mode.
        # Callers that pass stalled_days should not expect the heatmap colors to shift.
        for sw in swimlane_results:
            sw["is_outlier"] = {
                col.name: (
                    sw["avg_days_per_column"][col.name] is not None
                    and sw["avg_days_per_column"][col.name] >= board.staleness_threshold_days
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
        })

    @action(detail=True, methods=["get"], url_path="movements")
    def movements(self, request, pk=None):
        """Board-level movement history with filtering and offset pagination.

        Returns CardMovement records for the board, newest first, with card
        title and uid denormalized for display. All board members (including
        viewers) may read movement history.

        Query params:
          - ``swimlane_id`` (int): filter by the card's current swimlane.
          - ``to_column_id`` (int): filter by destination column.
          - ``assignee_id`` (int): filter by card assignee.
          - ``moved_after`` (ISO date): include movements on or after this date.
          - ``moved_before`` (ISO date): include movements on or before this date.
          - ``exclude_type`` (comma-separated): movement_type values to exclude
            (e.g. ``archived,unarchived`` hides system events).
          - ``offset`` (int, default 0): pagination offset.

        Defaults to the last 30 days when no date params are provided.
        Page size is fixed at 50.
        """
        board, _ = get_board_for_user(pk, request.user)
        now = timezone.now()
        PAGE_SIZE = 50

        qs = (
            CardMovement.objects
            .filter(card__board=board)
            .select_related("card", "moved_by", "from_column", "to_column", "from_swimlane", "to_swimlane")
            .order_by("-moved_at")
        )

        # Date range — default to last 30 days when neither param is supplied.
        moved_after = request.query_params.get("moved_after")
        moved_before = request.query_params.get("moved_before")
        if not moved_after and not moved_before:
            qs = qs.filter(moved_at__gte=now - datetime.timedelta(days=30))
        else:
            if moved_after:
                try:
                    qs = qs.filter(moved_at__date__gte=moved_after)
                except (ValueError, TypeError):
                    return Response({"detail": "moved_after must be a valid ISO date."}, status=status.HTTP_400_BAD_REQUEST)
            if moved_before:
                try:
                    qs = qs.filter(moved_at__date__lte=moved_before)
                except (ValueError, TypeError):
                    return Response({"detail": "moved_before must be a valid ISO date."}, status=status.HTTP_400_BAD_REQUEST)

        swimlane_id = request.query_params.get("swimlane_id")
        if swimlane_id:
            qs = qs.filter(card__swimlane_id=swimlane_id)

        to_column_id = request.query_params.get("to_column_id")
        if to_column_id:
            qs = qs.filter(to_column_id=to_column_id)

        assignee_id = request.query_params.get("assignee_id")
        if assignee_id:
            qs = qs.filter(card__assignee_id=assignee_id)

        exclude_type = request.query_params.get("exclude_type")
        if exclude_type:
            exclude_types = [t.strip() for t in exclude_type.split(",") if t.strip()]
            qs = qs.exclude(movement_type__in=exclude_types)

        try:
            offset = int(request.query_params.get("offset", 0))
        except (ValueError, TypeError):
            offset = 0

        total = qs.count()
        page = qs[offset: offset + PAGE_SIZE]

        from ..serializers import CardMovementSerializer
        serializer = CardMovementSerializer(page, many=True, context={"request": request})
        return Response({
            "count": total,
            "offset": offset,
            "page_size": PAGE_SIZE,
            "results": serializer.data,
        })
