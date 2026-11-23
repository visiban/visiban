"""BoardViewSet mixin for summary and analytics actions."""

import datetime
import json
import logging
import statistics
from typing import NamedTuple
from types import SimpleNamespace

from django.db.models import Count, Exists, F, OuterRef, Q
from django.utils import timezone
from django.utils.dateparse import parse_date
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import (
    OpenApiParameter, OpenApiResponse, PolymorphicProxySerializer, extend_schema, inline_serializer,
)
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.renderers import JSONRenderer
from rest_framework import serializers, status

from accounts.serializers import BoardUserSerializer

from ..models import Board, BoardExportLog, BoardMembership, Card, CardMovement, CardRelation
from ..serializers import CardMovementSerializer
from .. import hooks
from ..permissions import GROUP_ANCESTOR_SELECT_RELATED, SITE_ADMIN, analytics_extensions_for_role, get_board_roles
from ..services import flow_grouping, flow_metrics
from visiban.exceptions import INVALID_QUERY_PARAM, CodedValidationError
from visiban.request_shape import MAX_DB_INT, OFFSET_QUERY_PARAMETER, parse_offset, query_text
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
                        "Active cards in the swimlane (not archived, not in a done column, "
                        "as active_cards) that are blocked, manually or by an active "
                        "blocking relation (the card's `is_blocked`). Additive (#1149)."
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
                "age_is_warning": serializers.DictField(
                    child=serializers.BooleanField(),
                    help_text=(
                        "Whether the unrounded current-dwell mean is in the warning band: at or above "
                        "stale_warning_pct of the threshold and below the threshold (a threshold of 0 counts as 1 day). Additive (#2306)."
                    ),
                ),
                "throughput_is_warning": serializers.DictField(
                    child=serializers.BooleanField(),
                    help_text=(
                        "Whether the unrounded completed-dwell mean is in the warning band: at or above "
                        "stale_warning_pct of the threshold and below the threshold (a threshold of 0 counts as 1 day). Additive (#2306)."
                    ),
                ),
                "age_heat_level": serializers.DictField(
                    child=serializers.ChoiceField(choices=["ok", "warning", "high"], allow_null=True),
                    help_text=(
                        "The heatmap tier of the unrounded current-dwell mean: `high` at or past the "
                        "threshold, `warning` in the warning band, `ok` below it, null with no mean. A "
                        "threshold of 0 counts as 1 day for every tier. Additive (#2331)."
                    ),
                ),
                "throughput_heat_level": serializers.DictField(
                    child=serializers.ChoiceField(choices=["ok", "warning", "high"], allow_null=True),
                    help_text="The same heatmap tier for the unrounded completed-dwell mean. Additive (#2331).",
                ),
                "throughput_wait_avg_days_per_column": serializers.DictField(
                    child=serializers.FloatField(allow_null=True),
                    help_text=(
                        "Gated stages only (#2360): the mean of the In period visits' time in the stage's "
                        "last sub-column, which #1102 counts as wait time. The rest of "
                        "throughput_avg_days_per_column is work time. A stage with no sub-columns is "
                        "absent. Additive."
                    ),
                ),
                "age_wait_avg_days_per_column": serializers.DictField(
                    child=serializers.FloatField(allow_null=True),
                    help_text="The same wait-time mean for current dwell (Age mode). Additive (#2360).",
                ),
                "deal_velocity_days": serializers.FloatField(allow_null=True),
                "stalled_cards": inline_serializer(
                    name="BoardAnalyticsStalledCard",
                    many=True,
                    fields={
                        "id": serializers.IntegerField(),
                        "uid": serializers.CharField(),
                        "title": serializers.CharField(),
                        "days_since_move": serializers.IntegerField(
                            help_text="Whole days since the card last moved, floored. Kept an integer for compatibility.",
                        ),
                        "days_since_move_exact": serializers.FloatField(
                            help_text="Days since the card last moved, rounded to 0.1 (#2297).",
                        ),
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
                "total": inline_serializer(
                    name="BoardAnalyticsBlockedTotal",
                    help_text="Every block in the window, including blocks in deleted columns.",
                    fields={
                        "days": serializers.FloatField(),
                        "seconds": serializers.IntegerField(),
                        "blocks": serializers.IntegerField(),
                    },
                ),
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
    description=(
        "`days` or `stalled_days` is not an integer or is out of range, or `swimlane_id` or "
        "`label_id` is not a swimlane or label on this board (`code: invalid_query_param`)."
    ),
    response=_BAD_QUERY_PARAM_SERIALIZER,
)

_MOVEMENTS_400 = OpenApiResponse(
    description=(
        "`moved_after` or `moved_before` is not an ISO date, `swimlane_id`, `to_column_id`, "
        "`moved_by_id` or `parent_id` is not an integer, `exclude_type` contains a NUL (0x00) character, or "
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


def _local_day_start(day):
    """Midnight starting ``day`` in the current time zone, as an aware datetime.

    ``moved_at__date__gte/lte`` wraps the column in a time-zone cast that cannot
    use an index on ``moved_at`` (#1961). A half-open range on the raw column
    selects exactly the same rows, because ``__date`` also converts in the
    current time zone. Returns None when the boundary is outside the
    representable range (``date.max`` plus a day); the caller then omits that
    bound, which matches every row anyway.
    """
    try:
        return timezone.make_aware(datetime.datetime.combine(day, datetime.time.min))
    except OverflowError:
        return None


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


# ── Flow metrics (#448, ADR #1532): query validation and response schemas ──

# Bounds a day-loop and the size of a cumulative-flow response.
_MAX_FLOW_RANGE_DAYS = 366
# Far outside any real history, and far enough from date.min and date.max that
# adding or subtracting a range can never overflow into a 500.
_MIN_FLOW_DATE = datetime.date(1970, 1, 1)
_MAX_FLOW_DATE = datetime.date(9000, 1, 1)


class FlowMetricsQuerySerializer(serializers.Serializer):
    """The filters every ``metrics/*`` endpoint accepts, validated at the boundary.

    ``context["board"]`` is required: a swimlane or label id must belong to this
    board, and one that does not gets the same answer as one that does not
    exist, so ids on other boards cannot be probed through it.
    """

    days = serializers.IntegerField(required=False, min_value=1, max_value=365)
    from_date = serializers.DateField(required=False)
    to_date = serializers.DateField(required=False)
    swimlane_id = serializers.IntegerField(required=False, min_value=1, max_value=MAX_DB_INT)
    label_id = serializers.IntegerField(required=False, min_value=1, max_value=MAX_DB_INT)

    def _in_bounds(self, value):
        if not _MIN_FLOW_DATE <= value <= _MAX_FLOW_DATE:
            raise serializers.ValidationError("Date is out of range.")
        return value

    validate_from_date = _in_bounds
    validate_to_date = _in_bounds

    def validate_swimlane_id(self, value):
        if not self.context["board"].swimlanes.filter(pk=value).exists():
            raise serializers.ValidationError("Not a swimlane on this board.")
        return value

    def validate_label_id(self, value):
        if not self.context["board"].labels.filter(pk=value).exists():
            raise serializers.ValidationError("Not a label on this board.")
        return value

    def validate(self, attrs):
        from_date, to_date = attrs.get("from_date"), attrs.get("to_date")
        if "days" in attrs and (from_date or to_date):
            raise serializers.ValidationError("Send either days or from_date/to_date, not both.")
        if from_date or to_date:
            to_date = to_date or timezone.now().date()
            from_date = from_date or to_date - datetime.timedelta(days=flow_metrics.DEFAULT_RANGE_DAYS - 1)
            if from_date > to_date:
                raise serializers.ValidationError("from_date must not be after to_date.")
            if (to_date - from_date).days + 1 > _MAX_FLOW_RANGE_DAYS:
                raise serializers.ValidationError(f"The date range must not exceed {_MAX_FLOW_RANGE_DAYS} days.")
            attrs["from_date"], attrs["to_date"] = from_date, to_date
        return attrs


class GroupedFlowMetricsQuerySerializer(FlowMetricsQuerySerializer):
    """The base filters plus ``group_by`` (#2265), for the four endpoints that break down.

    ``group_by_field_id`` always names a *card* custom field. Every id that is
    not a dropdown or checkbox field on this board, whether it does not exist,
    is on another board, or has another type, gets the same message, so the
    400 says nothing about fields the caller cannot see.
    """

    group_by = serializers.ChoiceField(choices=flow_grouping.GROUP_BY_CHOICES, required=False)
    group_by_field_id = serializers.IntegerField(required=False, min_value=1, max_value=MAX_DB_INT)

    def validate_group_by_field_id(self, value):
        definition = (
            self.context["board"]
            .custom_field_definitions.filter(pk=value, field_type__in=flow_grouping.GROUPABLE_FIELD_TYPES)
            .first()
        )
        if definition is None:
            raise serializers.ValidationError("Not a dropdown or checkbox card field on this board.")
        return definition

    def validate(self, attrs):
        attrs = super().validate(attrs)
        # The field validator returned the definition: hand it on, not refetched.
        definition = attrs.pop("group_by_field_id", None)
        by = attrs.get("group_by")
        if definition is not None and by != flow_grouping.CUSTOM_FIELD:
            raise serializers.ValidationError({"group_by_field_id": "Only with group_by=custom_field."})
        if by == flow_grouping.CUSTOM_FIELD and definition is None:
            raise serializers.ValidationError({"group_by_field_id": "Required with group_by=custom_field."})
        attrs["group_by_field"] = definition
        return attrs


class AnalyticsFilterQuerySerializer(serializers.Serializer):
    """The optional ``swimlane_id`` / ``label_id`` filters of ``analytics`` (#2280).

    Validated exactly as on ``metrics/*`` (reusing its validators) so an id on
    another board gets the same 400 as one that does not exist.
    """

    swimlane_id = serializers.IntegerField(required=False, min_value=1, max_value=MAX_DB_INT)
    label_id = serializers.IntegerField(required=False, min_value=1, max_value=MAX_DB_INT)

    validate_swimlane_id = FlowMetricsQuerySerializer.validate_swimlane_id
    validate_label_id = FlowMetricsQuerySerializer.validate_label_id


class SwimlaneComparisonQuerySerializer(FlowMetricsQuerySerializer):
    """The period and label filters plus ``group_by_field_id`` for ``metrics/swimlanes`` (#2266).

    It compares swimlanes, so it takes no ``swimlane_id``: the field is removed
    and a stray one is ignored like any unknown parameter. ``group_by_field_id``
    names a *swimlane* custom field ("Group lanes by"); every id that is not a
    dropdown or checkbox swimlane field on this board gets the same message.
    """

    swimlane_id = None
    group_by_field_id = serializers.IntegerField(required=False, min_value=1, max_value=MAX_DB_INT)

    def validate_group_by_field_id(self, value):
        fields = self.context["board"].swimlane_custom_field_definitions.filter(
            pk=value, field_type__in=flow_grouping.GROUPABLE_FIELD_TYPES,
        )
        # An admin-only field's values are hidden from every other role by the
        # swimlane serializers; grouping by one would hand them out as `group`.
        # Same message as a missing field so its existence is not revealed.
        if self.context["role"] not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            fields = fields.filter(is_admin_only=False)
        definition = fields.first()
        if definition is None:
            raise serializers.ValidationError("Not a dropdown or checkbox swimlane field on this board.")
        return definition


class ThroughputQuerySerializer(GroupedFlowMetricsQuerySerializer):
    period = serializers.ChoiceField(choices=["day", "week"], required=False, default="week")


class FlowOverviewQuerySerializer(ThroughputQuerySerializer):
    """``metrics/overview`` (#2426): the filters, ``group_by`` and throughput's ``period``.

    No cumulative-flow ``date``: that drill-down reads the whole history and
    stays on its own endpoint; a stray one is ignored like any unknown parameter.
    """


class CumulativeFlowQuerySerializer(FlowMetricsQuerySerializer):
    date = serializers.DateField(required=False)

    validate_date = FlowMetricsQuerySerializer._in_bounds


class _HeatmapCard(NamedTuple):
    """One card's part of the ``analytics`` heatmap, derived as the flow load analyzes it (#2427, #2451)."""

    id: int
    swimlane_id: int
    position: int
    # ``(column name, clamped days)`` per stay, in the order the frozen
    # avg_days_per_column has always appended them.
    dwells: list
    velocity: float | None
    stalled: dict | None


def _heatmap_card(card, rows, *, now, days, period_cutoff, buffer_cutoff, stall_cutoff, col_id_to_name, done_col_ids):
    """The heatmap's frozen per-card figures from the card's whole history (#2451).

    ``rows`` is every movement of the card in ``(moved_at, id)`` order, from
    the flow service's load. Before #2451 the view read the same rows a
    second time: four per-card SQL annotations (last move, its destination,
    first move, the destination before the buffer) and the movements inside
    a 2x-window buffer. Each is read here off ``rows`` instead, with the same
    order and the same columns (``to_column_id``, the FK, NULL once a column
    is deleted), so every number is unchanged (``analytics_2427_pinned.json``).
    """
    last_moved_at = rows[-1].moved_at if rows else None
    last_col_id = rows[-1].to_column_id if rows else None
    first_moved_at = rows[0].moved_at if rows else None
    # The column the card was in when the movement buffer opens (its last
    # movement before the buffer). Seeds the frozen clamped dwell for a column
    # entered before the buffer (#2295). None when it had no earlier movement.
    pre_buffer_col_id = None
    first_in_buffer = len(rows)
    for index, mv in enumerate(rows):
        if mv.moved_at >= buffer_cutoff:
            first_in_buffer = index
            break
        pre_buffer_col_id = mv.to_column_id
    # The 2x analysis-window buffer: all the frozen clamped-dwell logic reads
    # (movements entering just before period_cutoff). Stall detection and
    # velocity use the whole-history figures above.
    movements = rows[first_in_buffer:]
    dwells = []

    # ── Clamped dwell (the frozen avg_days_per_column) ──────────────
    # A column entered before the buffer has no buffered movement of its own:
    # seed it with a leading stand-in dated at the buffer start, whose clamp to
    # period_cutoff gives the in-window dwell. It also covers an archived card
    # with no buffered movements. An active card with none is the
    # long-dwelling case below.
    dwell_moves = movements
    if pre_buffer_col_id is not None and (movements or card.archived_at is not None):
        stand_in = SimpleNamespace(to_column_id=pre_buffer_col_id, moved_at=buffer_cutoff)
        # Leading in-buffer movements into the same column (swimlane-only
        # moves, archived/unarchived rows) continue the stay the stand-in
        # already carries; keeping any would split one visit into several
        # dwell entries. Skip every leading one, not just the first.
        first_other = 0
        while first_other < len(movements) and movements[first_other].to_column_id == pre_buffer_col_id:
            first_other += 1
        dwell_moves = [stand_in, *movements[first_other:]]
    for i, mv in enumerate(dwell_moves):
        col_name = col_id_to_name.get(mv.to_column_id)
        if not col_name:
            continue
        # Done columns are terminal — dwell is not tracked here. The card's
        # clock stops at entry into a done column; counting time spent there
        # would inflate the heatmap with post-completion idle time.
        if mv.to_column_id in done_col_ids:
            continue
        # For archived cards use archived_at as the terminal timestamp so
        # dwell time covers only the active period, not time since archiving.
        exit_ = dwell_moves[i + 1].moved_at if i + 1 < len(dwell_moves) else (card.archived_at or now)
        # Skip movements that ended entirely before the analysis window.
        if exit_ <= period_cutoff:
            continue
        effective_entry_clamped = max(mv.moved_at, period_cutoff)
        dwells.append((col_name, (exit_ - effective_entry_clamped).total_seconds() / 86400))

    # ── Long-dwelling cards (no movements in the 2× buffer) ──────────
    # Cards sitting in their current column since before the buffer start
    # still contribute to the deprecated avg_days_per_column: their clamped
    # dwell is exactly ``days`` (entry clamped to period_cutoff, exit = now).
    # The ``last_moved_at is not None`` guard excludes never-moved cards.
    if (
        not movements
        and last_moved_at is not None
        and card.archived_at is None
        and card.column_id not in done_col_ids
    ):
        stale_col_name = col_id_to_name.get(card.column_id)
        if stale_col_name:
            dwells.append((stale_col_name, float(days)))

    # ── Velocity ──────────────────────────────────────────────────────
    # Only cards whose last movement fell at or after period_cutoff, measured
    # from the card's first-ever movement. A card whose only movement is its
    # creation row has not moved yet: its 0.0 days is no cycle (#2297).
    # Creation is always a card's first movement, so the last one is a
    # creation row only when it is the only one, and it is then also the
    # card's first-ever movement. from_column_id is not a usable test: it
    # goes NULL when a column is deleted, which would drop a real move out.
    velocity = None
    if (
        movements
        and movements[-1].moved_at >= period_cutoff
        and first_moved_at is not None
        and not (len(movements) == 1 and movements[0].moved_at == first_moved_at)
    ):
        velocity = (movements[-1].moved_at - first_moved_at).total_seconds() / 86400

    # ── Stalled detection ────────────────────────────────────────────
    # Cards in done columns are excluded — they have completed the workflow.
    # The last movement's destination and time cover all-time history, so
    # cards stalled before the buffer are still detected correctly.
    stalled = None
    if card.archived_at is None:
        last_col_is_done = last_col_id in done_col_ids or card.column_id in done_col_ids
        # A card with no movement counts from created_at, matching
        # is_stale on the card serializer and Needs attention (#2291).
        last_moved = last_moved_at or card.created_at
        if not last_col_is_done and last_moved is not None and last_moved < stall_cutoff:
            stalled = {
                "id": card.id,
                "uid": card.uid,
                "title": card.title,
                "days_since_move": (now - last_moved).days,
                # The floor above shows a card 7.9 days unmoved as "7" under a
                # 7-day threshold; this one matches Needs attention's
                # unfloored days (#2297).
                "days_since_move_exact": round((now - last_moved).total_seconds() / 86400, 1),
            }
    return _HeatmapCard(card.id, card.swimlane_id, card.position, dwells, velocity, stalled)


def _flow_query(serializer_class, request, board, **context):
    """Validated query params, or a 400 in the API-wide bad-parameter shape (#1825)."""
    serializer = serializer_class(data=request.query_params, context={"board": board, **context})
    if not serializer.is_valid():
        field, errors = next(iter(serializer.errors.items()))
        prefix = "" if field == "non_field_errors" else f"{field}: "
        raise CodedValidationError(INVALID_QUERY_PARAM, f"{prefix}{errors[0]}")
    return serializer.validated_data


def _flow_range(params, now):
    if "from_date" in params:
        return flow_metrics.date_range(params["from_date"], params["to_date"], now=now)
    return flow_metrics.rolling_range(params.get("days", flow_metrics.DEFAULT_RANGE_DAYS), now=now)


def _load_flow(board, params, now):
    """The board's whole history under the filters: only cumulative flow's ``date`` drill-down needs it."""
    return flow_metrics.load_board_flow(
        board, swimlane_id=params.get("swimlane_id"), label_id=params.get("label_id"), now=now,
    )


def _load_range_flow(board, params, now, flow_range):
    """Only the cards that can change a metric inside ``flow_range`` (#2425, see ``can_affect_range``).

    Cost follows the cards live now or active since the range opened, not the
    board's age; the numbers are the same as on ``_load_flow``.
    """
    return flow_metrics.load_range_flow(
        board, flow_range, now=now, swimlane_id=params.get("swimlane_id"), label_id=params.get("label_id"),
    )


def _grouping(board, params, flow):
    """The card group keys for ``group_by``, or None when the request asked for no breakdown."""
    by = params.get("group_by")
    if by is None:
        return None
    return flow_grouping.load_grouping(board, flow, by, params.get("group_by_field"))


_FLOW_FILTER_PARAMETERS = [
    OpenApiParameter(
        name="days", type={"type": "integer", "minimum": 1, "maximum": 365},
        location=OpenApiParameter.QUERY, required=False,
        description=(
            f"Rolling range in days (default {flow_metrics.DEFAULT_RANGE_DAYS}). "
            "Cannot be combined with `from_date` or `to_date`."
        ),
    ),
    OpenApiParameter(
        name="from_date", type=OpenApiTypes.DATE, location=OpenApiParameter.QUERY, required=False,
        description="First UTC day of the range, inclusive (`YYYY-MM-DD`).",
    ),
    OpenApiParameter(
        name="to_date", type=OpenApiTypes.DATE, location=OpenApiParameter.QUERY, required=False,
        description=f"Last UTC day of the range, inclusive. A range holds at most {_MAX_FLOW_RANGE_DAYS} days.",
    ),
    OpenApiParameter(
        name="swimlane_id", type={"type": "integer", "format": "int64", "minimum": 1},
        location=OpenApiParameter.QUERY, required=False,
        description="Only cards now in this swimlane of this board.",
    ),
    OpenApiParameter(
        name="label_id", type={"type": "integer", "format": "int64", "minimum": 1},
        location=OpenApiParameter.QUERY, required=False,
        description="Only cards now carrying this label of this board.",
    ),
]

# Only on cycle-time, throughput, wip-age and dwell: the other metric
# endpoints do not break down, and ignore these like any unknown parameter.
_FLOW_GROUP_PARAMETERS = [
    OpenApiParameter(
        name="group_by", type={"type": "string", "enum": list(flow_grouping.GROUP_BY_CHOICES)},
        location=OpenApiParameter.QUERY, required=False,
        description=(
            "Break the numbers down by swimlane, label, or one card custom field "
            "(`custom_field`, with `group_by_field_id`). Labels and fields are each card's current ones. "
            "A swimlane is the one the card was in when the sample is dated (#2334): its first completion "
            "for cycle time and throughput, the visit's end for dwell, now for wip-age; history in a "
            "deleted swimlane counts in `excluded`. Adds `grouping` to the response and group keys "
            "to the samples; without it the response is unchanged."
        ),
    ),
    OpenApiParameter(
        name="group_by_field_id", type={"type": "integer", "format": "int64", "minimum": 1},
        location=OpenApiParameter.QUERY, required=False,
        description=(
            "A dropdown or checkbox card custom field of this board. Required with "
            "`group_by=custom_field` and refused with any other `group_by`."
        ),
    ),
]

_FLOW_400 = OpenApiResponse(
    description=(
        "A filter is malformed or out of range, names a swimlane or label that is not on "
        "this board, or `group_by_field_id` is not a dropdown or checkbox card field of this "
        "board (`code: invalid_query_param`)."
    ),
    response=_BAD_QUERY_PARAM_SERIALIZER,
)

_PERCENTILES_FIELD = inline_serializer(
    name="FlowPercentiles",
    help_text=(
        "Nearest-rank percentiles in days. A value is null below the sample-size rule: "
        "p50 needs 5 values, p85 needs 7, p95 needs 20."
    ),
    fields={
        "p50": serializers.FloatField(allow_null=True),
        "p85": serializers.FloatField(allow_null=True),
        "p95": serializers.FloatField(allow_null=True),
    },
)

_FLOW_CARD_FIELD = inline_serializer(
    name="FlowCard",
    many=True,
    help_text="Every card the response names by uid: the drill-down's cards and owners.",
    fields={
        "uid": serializers.CharField(),
        "id": serializers.IntegerField(),
        "title": serializers.CharField(),
        "archived": serializers.BooleanField(),
        "assignee": BoardUserSerializer(allow_null=True),
        "swimlane": inline_serializer(
            name="FlowCardSwimlane",
            help_text="The card's current swimlane (added in 1.3, #2283).",
            fields={"id": serializers.IntegerField(), "name": serializers.CharField()},
        ),
    },
)

def _grouping_field(prefix, aggregates):
    """The ``grouping`` envelope of one endpoint (#2265); present only with ``group_by``."""
    return inline_serializer(
        name=f"{prefix}Grouping",
        required=False,
        help_text=(
            "Only with `group_by`. Groups are ranked by their cards active in the range, at most five "
            "named ones; the rest collapse into one last group with key and name null. A group's index "
            "is its chart color."
        ),
        fields={
            "by": serializers.ChoiceField(choices=list(flow_grouping.GROUP_BY_CHOICES)),
            "field_id": serializers.IntegerField(allow_null=True),
            "excluded": serializers.IntegerField(
                help_text="Counted in this endpoint's unit: what belongs to no group (no value, or a stale one).",
            ),
            "overlapping": serializers.BooleanField(
                help_text=(
                    "True when at least one of the cards active in the range counts in two or more "
                    "groups (label grouping), so group sizes can add up to more than an endpoint's "
                    "ungrouped total. It reflects label overlap across the cards active in the range, not per endpoint."
                ),
            ),
            "groups": inline_serializer(
                name=f"{prefix}Group",
                many=True,
                fields={
                    "key": serializers.CharField(
                        allow_null=True,
                        help_text=(
                            "Swimlane or label id as a string, the dropdown choice, or \"true\"/\"false\". "
                            "Null for Other."
                        ),
                    ),
                    "name": serializers.CharField(allow_null=True),
                    "member_keys": serializers.ListField(child=serializers.CharField()),
                    **aggregates,
                },
            ),
        },
    )


_GROUP_KEYS_FIELD = serializers.ListField(
    child=serializers.CharField(),
    required=False,
    help_text="Only with `group_by`: the card's group keys (see `grouping.groups[].member_keys`).",
)

_CYCLE_TIME_RESPONSE = inline_serializer(
    name="FlowCycleTime",
    fields={
        "definition": serializers.CharField(),
        "sample_size": serializers.IntegerField(),
        "excluded_incomplete_history": serializers.IntegerField(),
        "percentiles": _PERCENTILES_FIELD,
        "samples": inline_serializer(
            name="FlowCycleTimeSample",
            many=True,
            fields={
                "card_uid": serializers.CharField(),
                "value_days": serializers.FloatField(),
                "start": serializers.DateTimeField(),
                "end": serializers.DateTimeField(),
                "reopened": serializers.BooleanField(),
                "group_keys": _GROUP_KEYS_FIELD,
                "wait_days": serializers.FloatField(
                    allow_null=True,
                    help_text="Days of the cycle in gated stages' last sub-columns (#2360); 0 when none. Additive.",
                ),
                "work_days": serializers.FloatField(
                    allow_null=True, help_text="`value_days` minus `wait_days` (#2360). Additive.",
                ),
            },
        ),
        "cards": _FLOW_CARD_FIELD,
        "grouping": _grouping_field("FlowCycleTime", {
            "sample_size": serializers.IntegerField(),
            "percentiles": _PERCENTILES_FIELD,
        }),
    },
)

_SWIMLANE_COMPARISON_RESPONSE = inline_serializer(
    name="FlowSwimlaneComparison",
    fields={
        "definition": serializers.CharField(),
        "board": inline_serializer(
            name="FlowSwimlaneBoard",
            fields={
                "finished": serializers.IntegerField(),
                "median_days": serializers.FloatField(allow_null=True),
                "p85_days": serializers.FloatField(allow_null=True),
            },
        ),
        "status_threshold_pct": serializers.IntegerField(),
        "status_min_finished": serializers.IntegerField(),
        "swimlanes": inline_serializer(
            name="FlowSwimlaneRow",
            many=True,
            fields={
                "id": serializers.IntegerField(),
                "name": serializers.CharField(),
                "position": serializers.IntegerField(),
                "group": serializers.CharField(allow_null=True),
                "finished": serializers.IntegerField(),
                "in_progress": serializers.IntegerField(),
                "median_days": serializers.FloatField(allow_null=True),
                "p85_days": serializers.FloatField(allow_null=True),
                "blocked_share": serializers.FloatField(allow_null=True),
                "rolling_median": inline_serializer(
                    name="FlowSwimlaneRollingPoint",
                    many=True,
                    fields={
                        "at": serializers.DateTimeField(),
                        "median_days": serializers.FloatField(allow_null=True),
                        "sample_size": serializers.IntegerField(),
                    },
                ),
                "status": serializers.ChoiceField(choices=["slower", "in_line", "faster"], allow_null=True),
                "trend": inline_serializer(
                    name="FlowSwimlaneTrend",
                    allow_null=True,
                    fields={
                        "direction": serializers.ChoiceField(choices=["slower", "steady", "faster"]),
                        "first_days": serializers.FloatField(),
                        "last_days": serializers.FloatField(),
                    },
                ),
            },
        ),
        "grouping": inline_serializer(
            name="FlowSwimlaneGrouping",
            allow_null=True,
            fields={
                "field_id": serializers.IntegerField(),
                "field_name": serializers.CharField(),
                "field_type": serializers.CharField(),
                "groups": inline_serializer(
                    name="FlowSwimlaneGroup",
                    many=True,
                    fields={"key": serializers.CharField(), "name": serializers.CharField(allow_null=True)},
                ),
            },
        ),
    },
)

_THROUGHPUT_RESPONSE = inline_serializer(
    name="FlowThroughput",
    fields={
        "definition": serializers.CharField(),
        "period": serializers.ChoiceField(choices=["day", "week"]),
        "total": serializers.IntegerField(
            help_text="Completions in the whole periods only: a partial week at either end of the range is left out.",
        ),
        "completed_in_range": serializers.IntegerField(
            help_text=(
                "First completions anywhere in the range, the window the cycle-time sample uses (#2288). "
                "Differs from `total` when the range does not start on a Monday and end on a Sunday."
            ),
        ),
        "median": serializers.IntegerField(
            allow_null=True, help_text="Nearest-rank p50 of the period counts; null under five whole periods.",
        ),
        "samples": inline_serializer(
            name="FlowThroughputSample",
            many=True,
            fields={
                "start": serializers.DateField(),
                "count": serializers.IntegerField(),
                "card_uids": serializers.ListField(child=serializers.CharField()),
                "started": serializers.IntegerField(
                    help_text=(
                        "Cards whose cycle started in the period (#2260). A reopen is not a start, and "
                        "a card with no creation movement never starts."
                    ),
                ),
                "by_group": inline_serializer(
                    name="FlowThroughputGroupCount",
                    many=True,
                    required=False,
                    help_text="Only with `group_by`: one entry per `grouping.groups` entry, in order, zeros included.",
                    fields={
                        "key": serializers.CharField(allow_null=True),
                        "count": serializers.IntegerField(),
                        "card_uids": serializers.ListField(child=serializers.CharField()),
                    },
                ),
            },
        ),
        "cards": _FLOW_CARD_FIELD,
        "grouping": _grouping_field("FlowThroughput", {
            "total": serializers.IntegerField(),
            "median": serializers.IntegerField(allow_null=True),
        }),
    },
)

_CUMULATIVE_FLOW_RESPONSE = inline_serializer(
    name="FlowCumulativeFlow",
    fields={
        "definition": serializers.CharField(),
        "columns": inline_serializer(
            name="FlowCumulativeFlowColumn",
            many=True,
            help_text="Position order; the last entry, column_uid null, is every deleted column.",
            fields={
                "column_uid": serializers.CharField(allow_null=True),
                "column_name": serializers.CharField(allow_null=True),
                "is_done": serializers.BooleanField(),
                # Additive (#2260): the column's flow across the window.
                "start_count": serializers.IntegerField(
                    allow_null=True, help_text="Cards at the end of the first day; null with no whole day.",
                ),
                "end_count": serializers.IntegerField(
                    allow_null=True, help_text="Cards at the end of the last day; null with no whole day.",
                ),
                "entered": serializers.IntegerField(
                    help_text="Cards that entered after the first day, up to the end of the last.",
                ),
                "left": serializers.IntegerField(
                    help_text="Cards that left in the same window; end_count - start_count == entered - left.",
                ),
                "entered_per_week": serializers.FloatField(
                    allow_null=True, help_text="entered × 7 ÷ (days − 1); null under two whole days.",
                ),
                "left_per_week": serializers.FloatField(
                    allow_null=True, help_text="left × 7 ÷ (days − 1); null under two whole days.",
                ),
            },
        ),
        "days": inline_serializer(
            name="FlowCumulativeFlowDay",
            many=True,
            fields={
                "date": serializers.DateField(),
                "counts": serializers.DictField(
                    child=serializers.IntegerField(),
                    help_text='Cards per column_uid; the deleted-columns band is under the key "null".',
                ),
            },
        ),
        "bottleneck_column_uid": serializers.CharField(allow_null=True),
        "completed": serializers.IntegerField(
            help_text="First completions after the first day, up to the end of the last (#2307).",
        ),
        "completed_per_week": serializers.FloatField(
            allow_null=True, help_text="completed × 7 ÷ (days − 1); null under two whole days.",
        ),
    },
)

_CUMULATIVE_FLOW_DAY_RESPONSE = inline_serializer(
    name="FlowCumulativeFlowCards",
    fields={
        "definition": serializers.CharField(),
        "date": serializers.DateField(),
        "columns": inline_serializer(
            name="FlowCumulativeFlowCardsColumn",
            many=True,
            fields={
                "column_uid": serializers.CharField(allow_null=True),
                "card_uids": serializers.ListField(child=serializers.CharField()),
            },
        ),
        "cards": _FLOW_CARD_FIELD,
    },
)

_WIP_AGE_RESPONSE = inline_serializer(
    name="FlowWipAge",
    fields={
        "definition": serializers.CharField(),
        "sample_size": serializers.IntegerField(),
        "excluded_incomplete_history": serializers.IntegerField(),
        "cycle_time_percentiles": _PERCENTILES_FIELD,
        "columns": inline_serializer(
            name="FlowWipAgeColumn",
            many=True,
            help_text="The columns that are not done, in position order.",
            fields={
                "column_uid": serializers.CharField(),
                "column_name": serializers.CharField(),
                "wip_count": serializers.IntegerField(
                    help_text=(
                        "Cards not archived in the column now, the count its WIP limit applies to (#2287). "
                        "Includes cards that have not started and cards with incomplete history, which "
                        "have no sample."
                    ),
                ),
            },
        ),
        "samples": inline_serializer(
            name="FlowWipAgeSample",
            many=True,
            fields={
                "card_uid": serializers.CharField(),
                "column_uid": serializers.CharField(),
                "value_days": serializers.FloatField(),
                "start": serializers.DateTimeField(),
                "dwell_by_column": inline_serializer(
                    name="FlowWipAgeDwell",
                    many=True,
                    fields={
                        "column_uid": serializers.CharField(allow_null=True),
                        "value_days": serializers.FloatField(),
                    },
                ),
                "is_blocked": serializers.BooleanField(),
                "blocked_days": serializers.FloatField(),
                "group_keys": _GROUP_KEYS_FIELD,
            },
        ),
        "cards": _FLOW_CARD_FIELD,
        "grouping": _grouping_field("FlowWipAge", {"sample_size": serializers.IntegerField()}),
    },
)

_DWELL_COLUMN_FIELD = inline_serializer(
    name="FlowDwellColumn",
    many=True,
    help_text="The columns that are not done, in position order.",
    fields={
        "column_uid": serializers.CharField(),
        "column_name": serializers.CharField(),
        "sample_size": serializers.IntegerField(),
        "percentiles": _PERCENTILES_FIELD,
        "work_percentiles": serializers.DictField(
            child=serializers.FloatField(allow_null=True), allow_null=True,
            help_text=(
                "Gated stages only (#2360): `{p50, p85, p95}` of the visits' work time (sub-columns "
                "before the last). Null for a stage with no sub-columns. Additive."
            ),
        ),
        "wait_percentiles": serializers.DictField(
            child=serializers.FloatField(allow_null=True), allow_null=True,
            help_text="The same for wait time (the last sub-column), null for a stage with no sub-columns. Additive (#2360).",
        ),
    },
)

_DWELL_RESPONSE = inline_serializer(
    name="FlowDwell",
    fields={
        "definition": serializers.CharField(),
        "sample_size": serializers.IntegerField(),
        "excluded_incomplete_history": serializers.IntegerField(),
        "columns": _DWELL_COLUMN_FIELD,
        "grouping": _grouping_field("FlowDwell", {
            "sample_size": serializers.IntegerField(help_text="Visits, as the top-level sample_size."),
            "columns": _DWELL_COLUMN_FIELD,
        }),
    },
)

_BLOCKED_RESPONSE = inline_serializer(
    name="FlowBlocked",
    fields={
        "definition": serializers.CharField(),
        "total": inline_serializer(
            name="FlowBlockedTotal",
            help_text="Every block in the range, including those in deleted columns.",
            fields={"days": serializers.FloatField(), "blocks": serializers.IntegerField()},
        ),
        "blocked_now": serializers.IntegerField(
            help_text="Cards not archived and not in a done column that are blocked now.",
        ),
        "columns": inline_serializer(
            name="FlowBlockedColumn",
            many=True,
            help_text="Every current column, in position order, by the column the card was in when blocked.",
            fields={
                "column_uid": serializers.CharField(),
                "column_name": serializers.CharField(),
                "days": serializers.FloatField(),
                "blocks": serializers.IntegerField(),
            },
        ),
        "reasons": inline_serializer(
            name="FlowBlockedReason",
            many=True,
            help_text=f"The top {flow_metrics.TOP_BLOCK_REASONS} reasons by days, then blocks, then reason.",
            fields={
                "reason": serializers.CharField(),
                "days": serializers.FloatField(),
                "blocks": serializers.IntegerField(),
            },
        ),
        "reason_count": serializers.IntegerField(help_text="Distinct reasons before the cap."),
    },
)

_ATTENTION_RESPONSE = inline_serializer(
    name="FlowAttention",
    fields={
        "definition": serializers.CharField(),
        "stalled_threshold_days": serializers.IntegerField(),
        "cycle_time_percentiles": _PERCENTILES_FIELD,
        "items": inline_serializer(
            name="FlowAttentionItem",
            many=True,
            help_text="Oldest first by age, then by time unmoved (nulls last), then card id.",
            fields={
                "card_uid": serializers.CharField(),
                "column_uid": serializers.CharField(),
                "swimlane_id": serializers.IntegerField(),
                "age_days": serializers.FloatField(
                    allow_null=True, help_text="Days in progress; null when the card is not in progress.",
                ),
                "unmoved_days": serializers.FloatField(
                    allow_null=True, help_text="Days since the card last moved, or since it was created when it has no movement.",
                ),
                "reasons": serializers.ListField(
                    child=serializers.ChoiceField(choices=list(flow_metrics.ATTENTION_REASONS)),
                    help_text="Never empty, in the order blocked, past_p85, stalled.",
                ),
                "block_reason": serializers.CharField(
                    allow_null=True,
                    help_text=(
                        "The manual block's reason, trimmed, when reasons include blocked. Null when the "
                        "card is not blocked, is blocked only by a relation, or its block has no reason."
                    ),
                ),
            },
        ),
        "cards": _FLOW_CARD_FIELD,
    },
)

_OVERVIEW_RESPONSE = inline_serializer(
    name="FlowOverview",
    help_text=(
        "Each section is exactly what its own `metrics/*` endpoint returns for the same query (#2426): "
        "`group_by` breaks down cycle_time, throughput, wip_age and dwell, and `period` buckets throughput."
    ),
    fields={
        "cycle_time": _CYCLE_TIME_RESPONSE,
        "throughput": _THROUGHPUT_RESPONSE,
        "cumulative_flow": _CUMULATIVE_FLOW_RESPONSE,
        "wip_age": _WIP_AGE_RESPONSE,
        "dwell": _DWELL_RESPONSE,
        "blocked": _BLOCKED_RESPONSE,
        "attention": _ATTENTION_RESPONSE,
    },
)


def _cycle_time_payload(flow, flow_range, grouping):
    payload = flow_metrics.cycle_time(flow, flow_range)
    if grouping is not None:
        flow_grouping.group_cycle_time(payload, flow, flow_range, grouping)
    payload["cards"] = flow_metrics.card_directory(flow, (s["card_uid"] for s in payload["samples"]))
    return payload


def _throughput_payload(flow, flow_range, period, grouping):
    payload = flow_metrics.throughput(flow, flow_range, period)
    if grouping is not None:
        flow_grouping.group_throughput(payload, flow, flow_range, grouping, period)
    payload["cards"] = flow_metrics.card_directory(
        flow, (uid for sample in payload["samples"] for uid in sample["card_uids"]),
    )
    return payload


def _wip_age_payload(flow, flow_range, grouping):
    payload = flow_metrics.age(flow, flow_range)
    if grouping is not None:
        flow_grouping.group_wip_age(payload, flow, flow_range, grouping)
    payload["cards"] = flow_metrics.card_directory(flow, (s["card_uid"] for s in payload["samples"]))
    return payload


def _dwell_payload(flow, flow_range, grouping):
    payload = flow_metrics.column_dwell(flow, flow_range)
    if grouping is not None:
        flow_grouping.group_dwell(payload, flow, flow_range, grouping)
    return payload


def _attention_payload(board, flow, flow_range):
    payload = flow_metrics.needs_attention(flow, flow_range, stalled_days=board.staleness_threshold_days)
    payload["cards"] = flow_metrics.card_directory(flow, (item["card_uid"] for item in payload["items"]))
    return payload


class BoardAnalyticsMixin:
    """Mixin providing summary and analytics @action methods for BoardViewSet."""

    @extend_schema(responses={200: _BOARD_SUMMARY_RESPONSE})
    @action(detail=True, methods=["get"])
    def summary(self, request, pk=None):
        """Per-swimlane card counts, stage distribution, velocity, and cycle-time metrics.

        A fixed number of queries, never one per swimlane or cell.

        Velocity, done_30d and avg_cycle_days come from the flow service (#448):
        counts are cards by first completion, and avg_cycle_days is the mean cycle
        time of the cards completed in the last 30 days, as the flow metric record
        (ADR #1532) defines them. That takes a replay in Python, but only of the
        cards that entered a done column in those 30 days.
        """
        # ``slim=True`` skips favorites/labels/memberships prefetches that this
        # aggregate endpoint never reads (#928).
        board, role = get_board_for_user(pk, request.user, slim=True)
        now = timezone.now()

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

        # Queries 2-3: velocity, done_30d and avg_cycle_days, by first completion,
        # from the flow service (ADR #1532, #448). A card that bounces between
        # done columns counts once and stays counted after it is archived.
        rollup = flow_metrics.swimlane_completion_rollup(
            flow_metrics.load_recent_completions(board, flow_metrics.rolling_range(30, now=now), columns=columns)
        )

        # Blocked active cards per swimlane (#1149), manual or
        # relation, the same union as CardSerializer.is_blocked. "Active" as
        # in active_cards: not archived and not in a done column, so
        # blocked_cards never exceeds active_cards.
        relation_blocked = Exists(CardRelation.objects.filter(
            to_card=OuterRef("pk"),
            relation_type=CardRelation.Type.BLOCKS,
            from_card__archived_at__isnull=True,
            # Same-board only; see _active_blockers_prefetch (#2229).
            from_card__board_id=F("to_card__board_id"),
        ))
        blocked_by_swimlane = dict(
            board.cards.filter(archived_at__isnull=True)
            .exclude(column_id__in=done_column_ids)
            .filter(Q(blocked_at__isnull=False) | Q(relation_blocked))
            .values("swimlane_id")
            .annotate(cnt=Count("id"))
            .values_list("swimlane_id", "cnt")
        )

        result = []
        for swimlane in swimlanes:
            col_counts = counts.get(swimlane.id, {})
            completions = rollup.get(swimlane.id, {})
            done_card_count = sum(col_counts.get(cid, 0) for cid in done_column_ids)
            active_cards = sum(col_counts.values()) - done_card_count
            result.append({
                "id": swimlane.id,
                "name": swimlane.name,
                "color": swimlane.color,
                "total_cards": sum(col_counts.values()),
                "stage_distribution": {col.name: col_counts.get(col.id, 0) for col in columns},
                "velocity_7d": completions.get("velocity_7d", 0),
                "velocity_30d": completions.get("velocity_30d", 0),
                "active_cards": active_cards,
                "done_30d": completions.get("velocity_30d", 0),
                "avg_cycle_days": completions.get("avg_cycle_days"),
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
            OpenApiParameter(
                name="swimlane_id", type={"type": "integer", "minimum": 1},
                location=OpenApiParameter.QUERY, required=False,
                description="Only cards currently in this swimlane, as on `metrics/*`.",
            ),
            OpenApiParameter(
                name="label_id", type={"type": "integer", "minimum": 1},
                location=OpenApiParameter.QUERY, required=False,
                description="Only cards currently carrying this label, as on `metrics/*`.",
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
          - ``swimlane_id`` / ``label_id`` (int, optional, #2280): narrow every section
            (dwell, velocity, stalled cards, blocked time) to the cards the flow service's
            ``_base_cards`` selects, so the filter means what it does on ``metrics/*``.
            An id from another board gets the same 400 as a nonexistent one.

        ``age_avg_days_per_column`` (current dwell) and
        ``throughput_avg_days_per_column`` (completed dwell) are visits from the
        flow service (#448, ADR #1532). The frozen ``avg_days_per_column`` is still
        the gap between consecutive movements, with ``effective_entry =
        max(mv.moved_at, period_cutoff)`` so a card that entered a column before
        the window contributes only its in-window portion.

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
        filters = _flow_query(AnalyticsFilterQuerySerializer, request, board)
        swimlane_filter = filters.get("swimlane_id")
        label_filter = filters.get("label_id")
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
        if swimlane_filter is not None:
            swimlanes = [sw for sw in swimlanes if sw.id == swimlane_filter]
        # Partition columns into active (dwell tracked) and done (terminal — clock stops
        # on entry). Columns match by identity, never by name (ADR #1532): a column
        # deleted and recreated under the same name is a different column, so it does
        # not inherit the old column's visits or done flag.
        done_col_ids = {c.id for c in columns if c.is_done}
        active_columns = [c for c in columns if not c.is_done]
        col_id_to_name = {c.id: c.name for c in columns}
        # Current and completed dwell come from the flow service (#448), so the
        # heatmap's Current and In period modes agree with the flow charts.
        flow_range = flow_metrics.rolling_range(days, now=now)
        # The heatmap's own frozen figures (avg_days_per_column, velocity,
        # stalled cards) read the same cards' movements, so they are derived
        # from the flow service's one history load, card by card as it is
        # analyzed, instead of a second read of the window (#2451). The load
        # also takes every live card (a live done card is no dwell sample, so
        # the dwell answers do not move), which with the archived-in-window
        # cards it already reads is the heatmap's card set.
        buffer_cutoff = period_cutoff - datetime.timedelta(days=days)
        heatmap_cards: list[_HeatmapCard] = []

        def heatmap_card(card, rows):
            # The heatmap reads live cards and cards archived within the
            # period; cards archived earlier would inflate past-column counts
            # without adding value to the selected view. The flow load also
            # holds archived cards with a movement in the range, which the
            # heatmap never read.
            if card.archived_at is not None and card.archived_at < period_cutoff:
                return
            heatmap_cards.append(_heatmap_card(
                card, rows, now=now, days=days, period_cutoff=period_cutoff, buffer_cutoff=buffer_cutoff,
                stall_cutoff=stall_cutoff, col_id_to_name=col_id_to_name, done_col_ids=done_col_ids,
            ))

        flow = flow_metrics.load_recent_dwell(
            board, flow_range, columns=columns, swimlane_id=swimlane_filter, label_id=label_filter,
            also_matching=Q(archived_at__isnull=True), on_card_rows=heatmap_card,
        )
        current_dwell = flow_metrics.current_dwell_by_swimlane(flow)
        completed_dwell = flow_metrics.completed_dwell_by_swimlane(flow, flow_range)
        current_wait = flow_metrics.current_wait_by_swimlane(flow)
        completed_wait = flow_metrics.completed_wait_by_swimlane(flow, flow_range)
        gated_columns = [col for col in active_columns if col.uid in flow.gate_last]
        blocked = flow_metrics.blocked_time(flow, flow_range)
        # Everything read from the flow service is now in the dicts above.
        del flow

        swimlane_results = []
        all_col_dwells: dict[str, list[float]] = {c.name: [] for c in active_columns}

        # The order the heatmap always read its cards in (swimlane, then card
        # position; id breaks the ties the database used to break arbitrarily),
        # so the dwell lists, and the stalled list, fill in the same order.
        heatmap_cards.sort(key=lambda c: (c.swimlane_id, c.position, c.id))
        cards_by_swimlane: dict[int, list] = {}
        for _c in heatmap_cards:
            cards_by_swimlane.setdefault(_c.swimlane_id, []).append(_c)

        # swimlane id -> unrounded (avg, age, throughput) means, for the outlier flags.
        raw_means: dict[int, tuple] = {}
        for swimlane in swimlanes:
            cards = cards_by_swimlane.get(swimlane.id, [])
            # col_dwells: period-filtered, clamped entry — feeds avg_days_per_column (deprecated).
            col_dwells: dict[str, list[float]] = {c.name: [] for c in active_columns}
            # Measured visits from the flow service, by column uid.
            throughput_dwells = completed_dwell.get(swimlane.id, {})
            age_dwells = current_dwell.get(swimlane.id, {})
            stalled_cards = []
            deal_velocity_days = []

            for card in cards:
                for col_name, dwell in card.dwells:
                    col_dwells[col_name].append(dwell)
                    all_col_dwells[col_name].append(dwell)
                if card.velocity is not None:
                    deal_velocity_days.append(card.velocity)
                if card.stalled is not None:
                    stalled_cards.append(card.stalled)

            def _mean(vals: list[float]) -> float | None:
                return sum(vals) / len(vals) if vals else None

            def _rounded(means: dict) -> dict:
                return {k: (round(v, 1) if v is not None else None) for k, v in means.items()}

            # Outliers compare the unrounded means: a rounded 6.96 reads 7.0 and
            # would flag against a 7-day threshold it never reached (#2297).
            raw_avg = {col.name: _mean(col_dwells[col.name]) for col in active_columns}
            raw_throughput = {col.name: _mean(throughput_dwells.get(col.uid, [])) for col in active_columns}
            raw_age = {col.name: _mean(age_dwells.get(col.uid, [])) for col in active_columns}
            avg_days = _rounded(raw_avg)
            throughput_avg = _rounded(raw_throughput)
            throughput_count = {col.name: len(throughput_dwells.get(col.uid, [])) for col in active_columns}
            age_avg = _rounded(raw_age)
            raw_means[swimlane.id] = (raw_avg, raw_age, raw_throughput)

            swimlane_results.append({
                "id": swimlane.id,
                "name": swimlane.name,
                # Deprecated field — kept for backward compatibility; use throughput_avg_days_per_column.
                "avg_days_per_column": avg_days,
                "is_outlier": {},  # populated below
                # Age mode: current dwell, not age, whatever the field name says (ADR #1532).
                "age_avg_days_per_column": age_avg,
                "age_is_outlier": {},  # populated below
                # In period mode (UI name; the field keeps its throughput_ name): completed dwell, visits that closed in the period.
                "throughput_avg_days_per_column": throughput_avg,
                "throughput_card_count_per_column": throughput_count,
                "throughput_is_outlier": {},  # populated below
                "age_is_warning": {},  # populated below (#2306)
                "throughput_is_warning": {},  # populated below (#2306)
                "age_heat_level": {},  # populated below (#2331)
                "throughput_heat_level": {},  # populated below (#2331)
                # Additive (#2360): the wait part of the two dwell means above,
                # keyed only by gated stages so a plain stage reads unchanged.
                "throughput_wait_avg_days_per_column": _rounded({
                    col.name: _mean(completed_wait.get(swimlane.id, {}).get(col.uid, [])) for col in gated_columns
                }),
                "age_wait_avg_days_per_column": _rounded({
                    col.name: _mean(current_wait.get(swimlane.id, {}).get(col.uid, [])) for col in gated_columns
                }),
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
        def _flags(means: dict) -> dict:
            return {col.name: means[col.name] is not None and means[col.name] >= threshold for col in active_columns}

        # The warning band is the card aging tint's rule, not a second one: the
        # single source of truth is ``warningFraction``/``agingStage`` in
        # frontend/src/utils/agingTint.ts (#1841), mirrored here exactly —
        # ``stale_warning_pct`` is the share of the threshold used before the
        # warning starts, 0 turns the band off, 100 leaves it empty, and the ratio
        # divides by max(1, threshold) as the heatmap does. It is served because
        # the client only sees the rounded mean, and a rounded 3.46 reads 3.5 and
        # would turn yellow against a 3.5-day boundary it never reached (#2306).
        pct = board.stale_warning_pct
        warn_fraction = min(100, pct) / 100 if pct > 0 else None

        def _warnings(means: dict) -> dict:
            # ratio < 1 (not "not an outlier"): at threshold 0 every cell is an outlier
            # (mean >= 0) yet a 0.3-day cell is still under the 1-day floor the ratio uses.
            return {
                col.name: (
                    warn_fraction is not None
                    and means[col.name] is not None
                    and warn_fraction <= means[col.name] / max(1, threshold) < 1
                )
                for col in active_columns
            }

        def _heat_levels(means: dict) -> dict:
            # The whole tier from the unrounded mean, with the 1-day floor on every
            # tier (#2331). ``is_outlier`` keeps its documented ``mean >= threshold``
            # rule, which at threshold 0 is true for every cell; the heatmap needs the
            # floored comparison the warning band already uses, so it is served here
            # rather than rebuilt in the browser from a rounded value.
            levels = {}
            for col in active_columns:
                mean = means[col.name]
                if mean is None:
                    levels[col.name] = None
                    continue
                ratio = mean / max(1, threshold)
                if ratio >= 1:
                    levels[col.name] = "high"
                elif warn_fraction is not None and ratio >= warn_fraction:
                    levels[col.name] = "warning"
                else:
                    levels[col.name] = "ok"
            return levels

        for sw in swimlane_results:
            raw_avg, raw_age, raw_throughput = raw_means[sw["id"]]
            sw["is_outlier"] = _flags(raw_avg)
            sw["age_is_outlier"] = _flags(raw_age)
            sw["throughput_is_outlier"] = _flags(raw_throughput)
            sw["age_is_warning"] = _warnings(raw_age)
            sw["throughput_is_warning"] = _warnings(raw_throughput)
            sw["age_heat_level"] = _heat_levels(raw_age)
            sw["throughput_heat_level"] = _heat_levels(raw_throughput)

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
            "blocked": blocked,
        })

    @extend_schema(
        summary="Cycle time per completed card, with percentiles",
        parameters=[*_FLOW_FILTER_PARAMETERS, *_FLOW_GROUP_PARAMETERS],
        responses={200: _CYCLE_TIME_RESPONSE, 400: _FLOW_400},
    )
    @action(detail=True, methods=["get"], url_path="metrics/cycle-time")
    def metrics_cycle_time(self, request, pk=None):
        """Cycle time of the cards whose first completion falls in the range."""
        board, _ = get_board_for_user(pk, request.user, slim=True)
        params = _flow_query(GroupedFlowMetricsQuerySerializer, request, board)
        now = timezone.now()
        flow_range = _flow_range(params, now)
        flow = _load_range_flow(board, params, now, flow_range)
        return Response(_cycle_time_payload(flow, flow_range, _grouping(board, params, flow)))

    @extend_schema(
        summary="Per-swimlane cycle time, trend, blocked share and status against the board",
        description=(
            "A card counts under the swimlane it was in at the time (#2334): finished cards, their "
            "median, 85th percentile and rolling median under the swimlane of their first completion, "
            "`in_progress` under the current swimlane, and blocked share split across the swimlanes a "
            "card was in while in progress. A completion in a deleted swimlane is in `board` only."
        ),
        parameters=[
            *(p for p in _FLOW_FILTER_PARAMETERS if p.name != "swimlane_id"),
            OpenApiParameter(
                name="group_by_field_id", type={"type": "integer", "format": "int64", "minimum": 1},
                location=OpenApiParameter.QUERY, required=False,
                description=(
                    "A dropdown or checkbox swimlane custom field of this board (an admin-only field only for board admins). Adds `grouping` and "
                    "each swimlane's `group`."
                ),
            ),
        ],
        responses={200: _SWIMLANE_COMPARISON_RESPONSE, 400: _FLOW_400},
    )
    @action(detail=True, methods=["get"], url_path="metrics/swimlanes")
    def metrics_swimlanes(self, request, pk=None):
        """One row per swimlane for the Swimlanes tab, with the board median (#2266)."""
        board, role = get_board_for_user(pk, request.user, slim=True)
        params = _flow_query(SwimlaneComparisonQuerySerializer, request, board, role=role)
        now = timezone.now()
        flow_range = _flow_range(params, now)
        flow = _load_range_flow(board, params, now, flow_range)
        lanes = list(board.swimlanes.order_by("position", "id"))
        return Response(flow_metrics.swimlane_comparison(
            flow, flow_range, lanes, params.get("group_by_field_id"),
        ))

    @extend_schema(
        summary="Cards completed per whole ISO week or UTC day",
        parameters=[
            *_FLOW_FILTER_PARAMETERS,
            *_FLOW_GROUP_PARAMETERS,
            OpenApiParameter(
                name="period", type={"type": "string", "enum": ["day", "week"]},
                location=OpenApiParameter.QUERY, required=False,
                description="Bucket size (default `week`). Only whole periods inside the range are reported.",
            ),
        ],
        responses={200: _THROUGHPUT_RESPONSE, 400: _FLOW_400},
    )
    @action(detail=True, methods=["get"], url_path="metrics/throughput")
    def metrics_throughput(self, request, pk=None):
        """Completed cards per whole period, with the median of the period counts."""
        board, _ = get_board_for_user(pk, request.user, slim=True)
        params = _flow_query(ThroughputQuerySerializer, request, board)
        now = timezone.now()
        flow_range = _flow_range(params, now)
        flow = _load_range_flow(board, params, now, flow_range)
        return Response(_throughput_payload(flow, flow_range, params["period"], _grouping(board, params, flow)))

    @extend_schema(
        summary="Cards per column at the end of each UTC day, or the cards behind one day",
        parameters=[
            *_FLOW_FILTER_PARAMETERS,
            OpenApiParameter(
                name="date", type=OpenApiTypes.DATE, location=OpenApiParameter.QUERY, required=False,
                description=(
                    "Return the cards behind this day's counts instead of the diagram. "
                    "Must be a whole UTC day before today."
                ),
            ),
        ],
        responses={200: PolymorphicProxySerializer(
            component_name="FlowCumulativeFlowResponse",
            serializers=[_CUMULATIVE_FLOW_RESPONSE, _CUMULATIVE_FLOW_DAY_RESPONSE],
            resource_type_field_name=None,
        ), 400: _FLOW_400},
    )
    @action(detail=True, methods=["get"], url_path="metrics/cumulative-flow")
    def metrics_cumulative_flow(self, request, pk=None):
        """The cumulative flow diagram and its bottleneck, or one day's cards with ``date``."""
        board, _ = get_board_for_user(pk, request.user, slim=True)
        params = _flow_query(CumulativeFlowQuerySerializer, request, board)
        now = timezone.now()
        day = params.get("date")
        if day is not None and day >= now.date():
            # Today is still running, so it is never a bucket (ADR "Whole days").
            raise CodedValidationError(INVALID_QUERY_PARAM, "date must be a whole UTC day before today.")
        if day is None:
            flow_range = _flow_range(params, now)
            flow = flow_metrics.load_cumulative_flow(
                board, flow_range, now=now, swimlane_id=params.get("swimlane_id"), label_id=params.get("label_id"),
            )
            return Response(flow_metrics.cumulative_flow(flow, flow_range))
        # One day's card list names every card resting in each band that day,
        # finished work from any year included, so it reads the whole history.
        flow = _load_flow(board, params, now)
        payload = flow_metrics.cumulative_flow_cards(flow, day)
        payload["cards"] = flow_metrics.card_directory(
            flow, (uid for column in payload["columns"] for uid in column["card_uids"]),
        )
        return Response(payload)

    @extend_schema(
        summary="Age of the cards in progress, with the cycle-time percentiles for the aging zones",
        parameters=[*_FLOW_FILTER_PARAMETERS, *_FLOW_GROUP_PARAMETERS],
        responses={200: _WIP_AGE_RESPONSE, 400: _FLOW_400},
    )
    @action(detail=True, methods=["get"], url_path="metrics/wip-age")
    def metrics_wip_age(self, request, pk=None):
        """WIP age. A snapshot: the range moves only ``cycle_time_percentiles``."""
        board, _ = get_board_for_user(pk, request.user, slim=True)
        params = _flow_query(GroupedFlowMetricsQuerySerializer, request, board)
        now = timezone.now()
        flow_range = _flow_range(params, now)
        flow = _load_range_flow(board, params, now, flow_range)
        return Response(_wip_age_payload(flow, flow_range, _grouping(board, params, flow)))

    @extend_schema(
        summary="Completed dwell time per column, with percentiles",
        parameters=[*_FLOW_FILTER_PARAMETERS, *_FLOW_GROUP_PARAMETERS],
        responses={200: _DWELL_RESPONSE, 400: _FLOW_400},
    )
    @action(detail=True, methods=["get"], url_path="metrics/dwell")
    def metrics_dwell(self, request, pk=None):
        """Per-column percentiles of the visits that closed in the range (#2260)."""
        board, _ = get_board_for_user(pk, request.user, slim=True)
        params = _flow_query(GroupedFlowMetricsQuerySerializer, request, board)
        now = timezone.now()
        flow_range = _flow_range(params, now)
        flow = _load_range_flow(board, params, now, flow_range)
        return Response(_dwell_payload(flow, flow_range, _grouping(board, params, flow)))

    @extend_schema(
        summary="Blocked time per column and reason, and the cards blocked now",
        parameters=_FLOW_FILTER_PARAMETERS,
        responses={200: _BLOCKED_RESPONSE, 400: _FLOW_400},
    )
    @action(detail=True, methods=["get"], url_path="metrics/blocked")
    def metrics_blocked(self, request, pk=None):
        """Blocked time inside the range, under the same filters as the other metrics (#2260)."""
        board, _ = get_board_for_user(pk, request.user, slim=True)
        params = _flow_query(FlowMetricsQuerySerializer, request, board)
        now = timezone.now()
        # Only live not-done cards: the block rows are their own query, and
        # blocked_now counts only those cards (see load_live_wip).
        flow = flow_metrics.load_live_wip(
            board, swimlane_id=params.get("swimlane_id"), label_id=params.get("label_id"), now=now,
        )
        return Response(flow_metrics.blocked_summary(flow, _flow_range(params, now)))

    @extend_schema(
        summary="Cards that need attention: blocked, past the cycle-time p85, or stalled",
        parameters=_FLOW_FILTER_PARAMETERS,
        responses={200: _ATTENTION_RESPONSE, 400: _FLOW_400},
    )
    @action(detail=True, methods=["get"], url_path="metrics/attention")
    def metrics_attention(self, request, pk=None):
        """A snapshot: the range moves only the cycle-time p85 (#2260)."""
        board, _ = get_board_for_user(pk, request.user, slim=True)
        params = _flow_query(FlowMetricsQuerySerializer, request, board)
        now = timezone.now()
        flow_range = _flow_range(params, now)
        flow = _load_range_flow(board, params, now, flow_range)
        return Response(_attention_payload(board, flow, flow_range))

    @extend_schema(
        summary="Every Analytics overview chart from one history load",
        description=(
            "Added in 1.3 (#2426). The cycle-time, throughput, cumulative-flow, wip-age, dwell, blocked and "
            "attention responses for one query, each exactly what its own endpoint returns, computed from "
            "one load of the board's history instead of seven. The cumulative-flow `date` drill-down and "
            "`metrics/swimlanes` stay on their own endpoints."
        ),
        parameters=[
            *_FLOW_FILTER_PARAMETERS,
            *_FLOW_GROUP_PARAMETERS,
            OpenApiParameter(
                name="period", type={"type": "string", "enum": ["day", "week"]},
                location=OpenApiParameter.QUERY, required=False,
                description="Bucket size of the `throughput` section (default `week`).",
            ),
        ],
        responses={200: _OVERVIEW_RESPONSE, 400: _FLOW_400},
    )
    @action(detail=True, methods=["get"], url_path="metrics/overview")
    def metrics_overview(self, request, pk=None):
        """The overview's seven sections from one range load (#2426).

        WHY one load serves all seven: ``load_cumulative_flow`` is
        ``load_range_flow`` plus the settled cumulative-flow bands, which only
        ``cumulative_flow`` reads, so cycle time, throughput, WIP age, dwell
        and attention see exactly the snapshot their endpoints load. Blocked
        reads its block rows by its own query and counts ``blocked_now`` over
        the live not-done cards, which every range load keeps (``can_affect_range``
        keeps every live card), so it matches ``load_live_wip`` too. The
        metric functions only read the snapshot, so sharing it cannot leak one
        section into another; ``FlowOverviewTests`` pins every section against
        its own endpoint.
        """
        board, _ = get_board_for_user(pk, request.user, slim=True)
        params = _flow_query(FlowOverviewQuerySerializer, request, board)
        now = timezone.now()
        flow_range = _flow_range(params, now)
        flow = flow_metrics.load_cumulative_flow(
            board, flow_range, now=now, swimlane_id=params.get("swimlane_id"), label_id=params.get("label_id"),
        )
        grouping = _grouping(board, params, flow)
        return Response({
            "cycle_time": _cycle_time_payload(flow, flow_range, grouping),
            "throughput": _throughput_payload(flow, flow_range, params["period"], grouping),
            "cumulative_flow": flow_metrics.cumulative_flow(flow, flow_range),
            "wip_age": _wip_age_payload(flow, flow_range, grouping),
            "dwell": _dwell_payload(flow, flow_range, grouping),
            "blocked": flow_metrics.blocked_summary(flow, flow_range),
            "attention": _attention_payload(board, flow, flow_range),
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
                    ("parent_id", (
                        "Since 1.3 (#2209): only movements of cards whose parent is this card. A parent "
                        "the caller cannot open, or a missing one, returns an empty page."
                    )),
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
          - ``parent_id`` (int, since 1.3, #2209): only movements of cards whose
            parent is this card ("Movement history of these children").
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
        # snapshot. Served by movement_board_moved_id_idx. Rows an older release
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
            # "-id" is the tie-break (#2400): offset pages are only stable over a
            # total order, and bulk moves and imports write many rows at the
            # same instant. Served by movement_board_moved_id_idx, which carries
            # the tie-break, so the plan stays a plain index scan with its early
            # exit (docs/development/nightly-load-test.md, "Movements history
            # plans"). The enterprise export hook below receives this queryset.
            .order_by("-moved_at", "-id")
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
            after_start = _local_day_start(after_date)
            if after_start is not None:
                qs = qs.filter(moved_at__gte=after_start)
        if moved_before:
            before_date = _parse_iso_date(moved_before)
            if before_date is None:
                return _invalid_query_param("moved_before must be a valid ISO date.")
            # Inclusive end date: strictly before the next local midnight.
            before_end = (
                _local_day_start(before_date + datetime.timedelta(days=1))
                if before_date < datetime.date.max else None
            )
            if before_end is not None:
                qs = qs.filter(moved_at__lt=before_end)

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

        # Parent filter (#2209, #2499): the children of one parent card. Only a
        # parent the caller can open filters. Any other id (missing, or on a
        # board the caller cannot open) yields the same empty page as a parent
        # with no children here, so the param never confirms that a hidden
        # parent exists, has children on this board, or how many (#1104 rule:
        # an unopenable parent is never disclosed by id or count).
        raw_parent = request.query_params.get("parent_id")
        if raw_parent:
            parent_pk = _parse_id(raw_parent)
            if parent_pk is None:
                return _invalid_query_param("parent_id must be a positive integer.")
            parent_board_id = Card.objects.filter(pk=parent_pk).values_list("board_id", flat=True).first()
            parent_board = (
                Board.objects.select_related(GROUP_ANCESTOR_SELECT_RELATED).filter(pk=parent_board_id).first()
                if parent_board_id is not None else None
            )
            if parent_board is not None and get_board_roles(request.user, [parent_board])[parent_board.pk] is not None:
                qs = qs.filter(card__parent_link__parent_id=parent_pk)
            else:
                qs = qs.none()

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
            # Live cards only by default (#1469): the hook's queryset has always
            # held only rows with a card, and a backend written against that may
            # read ``mv.card.title`` (an AttributeError, so a 500, on a retained
            # row). A backend that handles ``card=None`` opts in to the retained
            # history of hard-deleted cards (#1796) with
            # ``accepts_deleted_cards = True``: widening the shape in place
            # would break backends this repo cannot see. ``is True``, so only an
            # explicit True opts in (fail closed, as ANALYTICS_EXTENSIONS'
            # min_role does).
            if getattr(backend, "accepts_deleted_cards", False) is True:
                export_qs = qs
            else:
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

        # Page fetched without a window function (#1961): Window(Count) is
        # evaluated over every matching row before OFFSET/LIMIT, so each page
        # read the board's whole history. A short page already tells us the
        # total; otherwise a bare COUNT(*) runs (Django drops select_related and
        # ordering from count(), so it touches only the board filter's index).
        page = list(qs[offset: offset + PAGE_SIZE])
        if page and len(page) < PAGE_SIZE:
            total = offset + len(page)
        else:
            total = qs.count()

        serializer = CardMovementSerializer(page, many=True, context={"request": request})
        return Response({
            "count": total,
            "offset": offset,
            "page_size": PAGE_SIZE,
            "results": serializer.data,
        })
