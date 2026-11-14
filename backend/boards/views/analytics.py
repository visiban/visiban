"""BoardViewSet mixin for summary and analytics actions."""

import datetime
import json
import logging
import statistics

from django.db.models import Count, Exists, OuterRef, Prefetch, Q, Subquery
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

from ..models import BoardExportLog, CardMovement, CardRelation
from ..serializers import CardMovementSerializer
from .. import hooks
from ..permissions import analytics_extensions_for_role
from ..services import flow_metrics
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


class ThroughputQuerySerializer(FlowMetricsQuerySerializer):
    period = serializers.ChoiceField(choices=["day", "week"], required=False, default="week")


class CumulativeFlowQuerySerializer(FlowMetricsQuerySerializer):
    date = serializers.DateField(required=False)

    validate_date = FlowMetricsQuerySerializer._in_bounds


def _flow_query(serializer_class, request, board):
    """Validated query params, or a 400 in the API-wide bad-parameter shape (#1825)."""
    serializer = serializer_class(data=request.query_params, context={"board": board})
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
    return flow_metrics.load_board_flow(
        board, swimlane_id=params.get("swimlane_id"), label_id=params.get("label_id"), now=now,
    )


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

_FLOW_400 = OpenApiResponse(
    description=(
        "A filter is malformed or out of range, or names a swimlane or label that is not on "
        "this board (`code: invalid_query_param`)."
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
    },
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
            },
        ),
        "cards": _FLOW_CARD_FIELD,
    },
)

_THROUGHPUT_RESPONSE = inline_serializer(
    name="FlowThroughput",
    fields={
        "definition": serializers.CharField(),
        "period": serializers.ChoiceField(choices=["day", "week"]),
        "total": serializers.IntegerField(),
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
            },
        ),
        "cards": _FLOW_CARD_FIELD,
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
            fields={"column_uid": serializers.CharField(), "column_name": serializers.CharField()},
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
            },
        ),
        "cards": _FLOW_CARD_FIELD,
    },
)


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
        # on entry). Columns match by identity, never by name (ADR #1532): a column
        # deleted and recreated under the same name is a different column, so it does
        # not inherit the old column's visits or done flag.
        done_col_ids = {c.id for c in columns if c.is_done}
        active_columns = [c for c in columns if not c.is_done]
        col_id_to_name = {c.id: c.name for c in columns}
        # Current and completed dwell come from the flow service (#448), so the
        # heatmap's Age and Throughput modes agree with the flow charts.
        flow_range = flow_metrics.rolling_range(days, now=now)
        flow = flow_metrics.load_recent_dwell(board, flow_range, columns=columns)
        current_dwell = flow_metrics.current_dwell_by_swimlane(flow)
        completed_dwell = flow_metrics.completed_dwell_by_swimlane(flow, flow_range)

        swimlane_results = []
        all_col_dwells: dict[str, list[float]] = {c.name: [] for c in active_columns}

        # Load cards within the analysis window and their movements in two
        # queries (cards + prefetch), then group by swimlane to avoid
        # O(swimlanes) extra card+movement queries.
        # Include cards archived within the window so their dwell-time data
        # contributes to the heatmap.  Cards archived before the window would
        # inflate past-column counts without adding value to the selected view.
        # Stall detection needs all currently-active (non-archived) cards
        # regardless of the period window, so we load the union.
        #
        # Three per-card movement aggregates are annotated at the SQL level so
        # the movement prefetch can be scoped to a bounded window without losing
        # velocity and stall-detection data that may predate the window. All
        # three are correlated subqueries compiled into the main SELECT — no
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
                # First-ever movement timestamp — used for velocity so cycle time is
                # measured from origin rather than from the window start.
                _first_moved_at=Subquery(
                    _mv_qs.order_by("moved_at").values("moved_at")[:1]
                ),
            )
            .prefetch_related(
                Prefetch(
                    "movements",
                    # Scope the prefetch to a 2× analysis-window buffer: all the frozen
                    # clamped-dwell logic reads (movements entering just before
                    # period_cutoff). This does NOT bound the request's memory, as it
                    # did for #654/#646: load_recent_dwell above holds the whole
                    # history of every card relevant to the window, about 17.6 MB per
                    # 37,500 movements, in memory until the response is built. Accepted
                    # for #448; nightly-load-test measures it under #2110.
                    # Stall detection and velocity use card-level annotations above
                    # instead of the prefetch, so no historical data is lost.
                    # Load only the fields the algorithm reads; order at the DB level so
                    # the per-card Python sort is eliminated.
                    queryset=CardMovement.objects.filter(
                        moved_at__gte=period_cutoff - datetime.timedelta(days=days)
                    ).only(
                        "card_id", "to_column_id", "moved_at"
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
            # Measured visits from the flow service, by column uid.
            throughput_dwells = completed_dwell.get(swimlane.id, {})
            age_dwells = current_dwell.get(swimlane.id, {})
            stalled_cards = []
            deal_velocity_days = []

            for card in cards:
                # .all() reads from the Prefetch cache (already ordered by moved_at at
                # the DB level above); list() materialises it so len() and indexing work.
                # The prefetch is scoped to a 2× window buffer — movements contains
                # only entries from period_cutoff - days onward.
                movements = list(card.movements.all())

                # ── Clamped dwell (the frozen avg_days_per_column) ──────────────
                for i, mv in enumerate(movements):
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
                    exit_ = movements[i + 1].moved_at if i + 1 < len(movements) else (card.archived_at or now)
                    # Skip movements that ended entirely before the analysis window.
                    if exit_ <= period_cutoff:
                        continue
                    effective_entry_clamped = max(mv.moved_at, period_cutoff)
                    col_dwells[col_name].append((exit_ - effective_entry_clamped).total_seconds() / 86400)
                    all_col_dwells[col_name].append((exit_ - effective_entry_clamped).total_seconds() / 86400)

                # ── Long-dwelling cards (no movements in the 2× buffer) ──────────
                # Cards that have been sitting in their current column since before the
                # buffer start have no entries in the prefetch but still need to
                # contribute to col_dwells (deprecated avg_days_per_column).
                # Their clamped dwell equals exactly `days` (entry clamped to
                # period_cutoff, exit = now).  throughput_dwells is
                # not affected — the card hasn't left the column during the period.
                # The `_last_moved_at is not None` guard excludes newly-created cards
                # that have never been moved (no movement record → dwell is not meaningful).
                if (
                    not movements
                    and card._last_moved_at is not None
                    and card.archived_at is None
                    and card.column_id not in done_col_ids
                ):
                    stale_col_name = col_id_to_name.get(card.column_id)
                    if stale_col_name:
                        col_dwells[stale_col_name].append(float(days))
                        all_col_dwells[stale_col_name].append(float(days))

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
                # Uses the _last_col_id annotation (mirrors movements[-1].to_column_id)
                # and _last_moved_at (covers all-time history) so cards stalled before
                # the prefetch window are still detected correctly.
                if card.archived_at is None:
                    last_col_is_done = card._last_col_id in done_col_ids or card.column_id in done_col_ids
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
            throughput_avg = {col.name: _avg(throughput_dwells.get(col.uid, [])) for col in active_columns}
            throughput_count = {col.name: len(throughput_dwells.get(col.uid, [])) for col in active_columns}
            age_avg = {col.name: _avg(age_dwells.get(col.uid, [])) for col in active_columns}

            swimlane_results.append({
                "id": swimlane.id,
                "name": swimlane.name,
                # Deprecated field — kept for backward compatibility; use throughput_avg_days_per_column.
                "avg_days_per_column": avg_days,
                "is_outlier": {},  # populated below
                # Age mode: current dwell, not age, whatever the field name says (ADR #1532).
                "age_avg_days_per_column": age_avg,
                "age_is_outlier": {},  # populated below
                # Throughput mode: completed dwell, visits that closed in the period.
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
            "blocked": flow_metrics.blocked_time(flow, flow_range),
        })

    @extend_schema(
        summary="Cycle time per completed card, with percentiles",
        parameters=_FLOW_FILTER_PARAMETERS,
        responses={200: _CYCLE_TIME_RESPONSE, 400: _FLOW_400},
    )
    @action(detail=True, methods=["get"], url_path="metrics/cycle-time")
    def metrics_cycle_time(self, request, pk=None):
        """Cycle time of the cards whose first completion falls in the range."""
        board, _ = get_board_for_user(pk, request.user, slim=True)
        params = _flow_query(FlowMetricsQuerySerializer, request, board)
        now = timezone.now()
        flow = _load_flow(board, params, now)
        payload = flow_metrics.cycle_time(flow, _flow_range(params, now))
        payload["cards"] = flow_metrics.card_directory(flow, (s["card_uid"] for s in payload["samples"]))
        return Response(payload)

    @extend_schema(
        summary="Cards completed per whole ISO week or UTC day",
        parameters=[
            *_FLOW_FILTER_PARAMETERS,
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
        flow = _load_flow(board, params, now)
        payload = flow_metrics.throughput(flow, _flow_range(params, now), params["period"])
        payload["cards"] = flow_metrics.card_directory(
            flow, (uid for sample in payload["samples"] for uid in sample["card_uids"]),
        )
        return Response(payload)

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
        flow = _load_flow(board, params, now)
        if day is None:
            return Response(flow_metrics.cumulative_flow(flow, _flow_range(params, now)))
        payload = flow_metrics.cumulative_flow_cards(flow, day)
        payload["cards"] = flow_metrics.card_directory(
            flow, (uid for column in payload["columns"] for uid in column["card_uids"]),
        )
        return Response(payload)

    @extend_schema(
        summary="Age of the cards in progress, with the cycle-time percentiles for the aging zones",
        parameters=_FLOW_FILTER_PARAMETERS,
        responses={200: _WIP_AGE_RESPONSE, 400: _FLOW_400},
    )
    @action(detail=True, methods=["get"], url_path="metrics/wip-age")
    def metrics_wip_age(self, request, pk=None):
        """WIP age. A snapshot: the range moves only ``cycle_time_percentiles``."""
        board, _ = get_board_for_user(pk, request.user, slim=True)
        params = _flow_query(FlowMetricsQuerySerializer, request, board)
        now = timezone.now()
        flow = _load_flow(board, params, now)
        payload = flow_metrics.age(flow, _flow_range(params, now))
        payload["cards"] = flow_metrics.card_directory(flow, (s["card_uid"] for s in payload["samples"]))
        return Response(payload)

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
