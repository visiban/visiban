import re

from rest_framework import serializers

from accounts.serializers import BoardUserSerializer

from .models import LensConnection
from .providers import available_providers

_VALID_COLUMN_DIMS = {"status", "state", "pipeline"}
_VALID_SWIMLANE_DIMS = {"milestone", "assignee", "label"}

# A single repo path segment: must start and end alphanumeric, may contain
# '.', '_', '-' in between. This deliberately rejects "." and ".." segments and
# leading/trailing dots so a crafted repo_slug cannot collapse to a different
# upstream API path (dot-segment normalization SSRF — see security review).
_SEGMENT_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$")


class LensConnectionSerializer(serializers.ModelSerializer):
    # Nested user object to match the FK rendering convention used across the
    # board/card serializers (assignee, created_by, owner are all nested).
    # allow_null=True (#1331): created_by is a SET_NULL FK with null=True — a
    # lens connection whose creator has since been deleted serializes with
    # `created_by: null` (REST and the `lens_connection.configured` WS payload).
    # Same declared-nested-field gap as #1108/#1192: a declared nested
    # serializer does not inherit null=True from the model, so without this
    # drf-spectacular publishes a non-nullable type. Schema-only: read_only, so
    # nothing about request validation changes.
    created_by = BoardUserSerializer(read_only=True, allow_null=True)

    class Meta:
        model = LensConnection
        fields = [
            "id",
            "provider",
            "repo_slug",
            "column_dim",
            "swimlane_dim",
            "created_by",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["id", "created_by", "created_at", "updated_at"]

    def validate_provider(self, value):
        if value not in available_providers():
            raise serializers.ValidationError(
                f"Unsupported provider. Choose one of: {', '.join(available_providers())}."
            )
        return value

    def validate_repo_slug(self, value):
        value = value.strip().strip("/")
        parts = value.split("/")
        if not (2 <= len(parts) <= 6) or not all(_SEGMENT_RE.match(p) for p in parts):
            raise serializers.ValidationError(
                "Enter a public repository as 'owner/repo' (or "
                "'group/subgroup/project' for GitLab). Each segment may contain "
                "only letters, numbers, '.', '_' and '-'."
            )
        return value

    def validate(self, attrs):
        # GitHub repos are exactly owner/repo; reject extra path segments that a
        # loose slug could otherwise smuggle into the upstream API URL.
        provider = attrs.get("provider")
        repo = attrs.get("repo_slug", "")
        if provider == "github" and repo and repo.count("/") != 1:
            raise serializers.ValidationError(
                {"repo_slug": "GitHub repositories must be in 'owner/repo' form."}
            )
        return attrs

    def validate_column_dim(self, value):
        if value not in _VALID_COLUMN_DIMS:
            raise serializers.ValidationError(
                f"column_dim must be one of: {', '.join(sorted(_VALID_COLUMN_DIMS))}."
            )
        return value

    def validate_swimlane_dim(self, value):
        if value not in _VALID_SWIMLANE_DIMS:
            raise serializers.ValidationError(
                f"swimlane_dim must be one of: {', '.join(sorted(_VALID_SWIMLANE_DIMS))}."
            )
        return value


# --- Schema-only components for GET /admin/git-lens/usage/ (#1870) ----------
# The view builds a plain dict from ``metrics.snapshot()`` and ``lens_bounds()``;
# these classes only describe it so the OpenAPI document carries a named
# component instead of an untyped object. ``test_usage_schema_1870`` validates a
# live response against them.


class LensOutboundOutcomesSerializer(serializers.Serializer):
    """Outbound-call counts keyed by outcome (``metrics.OUTBOUND_OUTCOMES``)."""

    ok = serializers.IntegerField()
    not_found = serializers.IntegerField()
    auth_error = serializers.IntegerField()
    rate_limited = serializers.IntegerField()
    http_error = serializers.IntegerField()
    network_error = serializers.IntegerField()


class LensOutboundByKindSerializer(serializers.Serializer):
    """Outbound-call outcomes keyed by upstream resource kind (``metrics.KINDS``)."""

    issues = LensOutboundOutcomesSerializer()
    branches = LensOutboundOutcomesSerializer()
    merge_requests = LensOutboundOutcomesSerializer()
    milestones = LensOutboundOutcomesSerializer()


class LensBoardRequestOutcomesSerializer(serializers.Serializer):
    """Board-request counts keyed by outcome (``metrics.BOARD_OUTCOMES``)."""

    cache_fresh = serializers.IntegerField()
    cache_stale_locked = serializers.IntegerField()
    budget_exhausted_stale = serializers.IntegerField()
    budget_exhausted_429 = serializers.IntegerField()
    fetched = serializers.IntegerField()
    error_stale = serializers.IntegerField()
    error = serializers.IntegerField()


class LensProviderUsageSerializer(serializers.Serializer):
    outbound_calls = serializers.IntegerField()
    outbound_by_kind = LensOutboundByKindSerializer()
    board_requests = LensBoardRequestOutcomesSerializer()


class LensUsageByProviderSerializer(serializers.Serializer):
    github = LensProviderUsageSerializer()
    gitlab = LensProviderUsageSerializer()


class LensHourlyOutboundCallsSerializer(serializers.Serializer):
    github = serializers.IntegerField()
    gitlab = serializers.IntegerField()


class LensHourlyUsageSerializer(serializers.Serializer):
    hour = serializers.DateTimeField(help_text="Start of the hour bucket, UTC.")
    outbound_calls = LensHourlyOutboundCallsSerializer()


class LensBoundsSerializer(serializers.Serializer):
    """The static limits from ``views.lens_bounds()``."""

    fetch_budget_per_user_repo = serializers.IntegerField()
    fetch_budget_per_user = serializers.IntegerField()
    fetch_budget_window_seconds = serializers.IntegerField()
    force_refresh_cooldown_seconds = serializers.IntegerField()
    cache_soft_ttl_seconds = serializers.IntegerField()
    cache_hard_ttl_seconds = serializers.IntegerField()
    cache_filtered_hard_ttl_seconds = serializers.IntegerField()
    max_issue_pages = serializers.IntegerField()
    max_aux_pages = serializers.IntegerField()
    per_page = serializers.IntegerField()
    request_timeout_seconds = serializers.IntegerField()
    max_outbound_calls_per_fetch = serializers.IntegerField()
    max_outbound_calls_per_user_per_window = serializers.IntegerField()


class LensUsageSerializer(serializers.Serializer):
    """``GET /admin/git-lens/usage/`` 200 response."""

    generated_at = serializers.DateTimeField()
    window_hours = serializers.IntegerField()
    bucket_seconds = serializers.IntegerField()
    current_hour = LensUsageByProviderSerializer()
    last_24h = LensUsageByProviderSerializer()
    hourly = LensHourlyUsageSerializer(many=True, help_text="Oldest first.")
    bounds = LensBoundsSerializer()


# --- Rendered lens board (GET /git-lens/board/{board_id}/, #1647) -------------
#
# Schema only: the view serves ``LensData.to_dict()`` (dataclasses in types.py,
# via ``dataclasses.asdict``) and never runs these serializers. They exist so the
# published 200 is a real, typed body rather than ``{}``, which is what lets the
# lens schema-fuzz job's response conformance check and the serializer-ts-parity
# gate catch drift in it. Every field mirrors one dataclass field; keep the two
# in step. ``allow_null`` marks exactly the dataclass fields typed ``X | None``.
# No field is optional: ``asdict`` always emits every key.


class LensAxisSerializer(serializers.Serializer):
    key = serializers.CharField()
    label = serializers.CharField()
    is_current = serializers.BooleanField()


class LensLabelSerializer(serializers.Serializer):
    name = serializers.CharField()
    # Hex WITHOUT the leading '#'; the frontend prepends it.
    color = serializers.CharField()


class LensUserSerializer(serializers.Serializer):
    username = serializers.CharField()
    avatar_url = serializers.CharField(allow_blank=True)


class LensPipelineEvidenceSerializer(serializers.Serializer):
    branch = serializers.CharField(allow_null=True)
    mr_number = serializers.IntegerField(allow_null=True)
    mr_url = serializers.CharField(allow_null=True)
    mr_closes = serializers.BooleanField()


class NormalizedIssueSerializer(serializers.Serializer):
    number = serializers.IntegerField()
    title = serializers.CharField(allow_blank=True)
    url = serializers.CharField(allow_blank=True)
    # Both providers normalize to "open" or "closed" (GitLab's "opened" ->
    # "open"). A plain string, not a ChoiceField: a new choice set on a field
    # named ``state`` collides with the existing ``StateEnum`` component and
    # drf-spectacular would rename that one, a break for generated clients.
    state = serializers.CharField(help_text='"open" or "closed".')
    labels = LensLabelSerializer(many=True)
    assignees = LensUserSerializer(many=True)
    milestone = serializers.CharField(allow_null=True)
    milestone_due = serializers.CharField(allow_null=True)
    milestone_state = serializers.CharField(allow_null=True)
    column_keys = serializers.ListField(child=serializers.CharField())
    swimlane_keys = serializers.ListField(child=serializers.CharField())
    has_branch = serializers.BooleanField()
    has_open_pr = serializers.BooleanField()
    pipeline_evidence = LensPipelineEvidenceSerializer(allow_null=True)


class LensSourceSerializer(serializers.Serializer):
    # A plain string for the same reason as ``NormalizedIssue.state``: a second
    # ``provider`` field with these choices renamed ``LensConnectionProviderEnum``.
    provider = serializers.CharField(help_text='The connection\'s provider: "github" or "gitlab".')
    repo = serializers.CharField()
    url = serializers.CharField()


class LensDataSerializer(serializers.Serializer):
    columns = LensAxisSerializer(many=True)
    swimlanes = LensAxisSerializer(many=True)
    issues = NormalizedIssueSerializer(many=True)
    fetched_at = serializers.CharField(help_text="ISO 8601 time the data was fetched from the provider.")
    source = LensSourceSerializer()
    truncated = serializers.BooleanField()
    total_count = serializers.IntegerField(allow_null=True)
    closed_limit = serializers.IntegerField(allow_null=True)
    closed_truncated = serializers.BooleanField()
    available_milestones = serializers.ListField(child=serializers.CharField())
