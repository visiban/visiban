"""Webhook API serializers (#863).

Read side: the full URL never appears after creation. ``url_display`` is
``scheme://host/…`` and ``url_host`` the bare host; the path can be a
credential (Slack, Zapier), so only the create response carries ``url``, once.

Write side: validation runs here, at the boundary, but its refusals are raised
as ``CodedValidationError`` so the body is ``{"detail", "code"}`` with a string
``code`` (a serializer ``ValidationError`` would wrap the code in a list).
"""

from django.conf import settings
from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from accounts.serializers import BoardUserSerializer
from visiban import egress
from visiban.exceptions import CodedValidationError

from .models import SUBSCRIBABLE_EVENT_TYPES, WebhookSubscription

INVALID_EVENT_TYPES = "invalid_event_types"
LIMIT_REACHED = "limit_reached"

INVALID_URL_DETAIL = (
    "Enter a full https:// URL with no username or password. Ports below 1024 "
    "other than 443 are not allowed."
)
# One neutral message for every "may not send there" outcome: an unresolvable
# name, a private or blocked address, http to a public host. Saying which one
# would let a caller map internal names (security-invariants Rule 15).
URL_NOT_ALLOWED_DETAIL = (
    "Visiban can't send to this address. Private, local and unresolvable "
    "addresses are blocked. To allow one, ask whoever runs this server to add "
    "it to WEBHOOK_ALLOWED_PRIVATE_TARGETS."
)
INVALID_EVENT_TYPES_DETAIL = (
    "event_types must be a list of distinct subscribable event types. Per-user, "
    "admin-only, ping and board.deleted events cannot be subscribed to."
)


def current_allowlist():
    return egress.parse_allowlist(getattr(settings, "WEBHOOK_ALLOWED_PRIVATE_TARGETS", ""))


def validate_destination(url):
    """Return ``(url, host)`` for an acceptable destination, or raise the coded 400."""
    try:
        dest, _ = egress.resolve_destination(url, current_allowlist())
    except egress.EgressError as exc:
        if exc.code == egress.INVALID_URL:
            raise CodedValidationError(egress.INVALID_URL, INVALID_URL_DETAIL) from None
        raise CodedValidationError(egress.URL_NOT_ALLOWED, URL_NOT_ALLOWED_DETAIL) from None
    return url, dest.host


class WebhookWriteSerializer(serializers.Serializer):
    """Body of create (``url`` required) and PATCH (every key optional)."""

    name = serializers.CharField(max_length=200, required=False, allow_blank=True)
    url = serializers.CharField(
        required=False,
        trim_whitespace=True,
        help_text="https:// URL. http, private addresses and low ports need an operator allowlist entry.",
    )
    event_types = serializers.ListField(
        child=serializers.CharField(),
        required=False,
        help_text="Event types to deliver. Empty list (the default) = every subscribable type.",
    )

    def to_internal_value(self, data):
        # event_types of the wrong JSON type is still an event_types error, not
        # a generic field-list 400, so clients can key on one code.
        if isinstance(data, dict) and "event_types" in data:
            value = data.get("event_types")
            if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
                raise CodedValidationError(INVALID_EVENT_TYPES, INVALID_EVENT_TYPES_DETAIL)
        if isinstance(data, dict) and "url" in data and not isinstance(data.get("url"), str):
            raise CodedValidationError(egress.INVALID_URL, INVALID_URL_DETAIL)
        return super().to_internal_value(data)

    def validate_event_types(self, value):
        if len(set(value)) != len(value) or any(v not in SUBSCRIBABLE_EVENT_TYPES for v in value):
            raise CodedValidationError(INVALID_EVENT_TYPES, INVALID_EVENT_TYPES_DETAIL)
        return value

    def validate_url(self, value):
        url, host = validate_destination(value)
        self.context["url_host"] = host
        return url

    def validate(self, attrs):
        if self.context.get("require_url") and "url" not in attrs:
            raise CodedValidationError(egress.INVALID_URL, INVALID_URL_DETAIL)
        return attrs


class WebhookReenableSerializer(serializers.Serializer):
    resume_from = serializers.ChoiceField(
        choices=["cursor", "latest"],
        default="cursor",
        help_text=(
            "`cursor` (default) delivers the events missed while disabled; "
            "`latest` skips to events recorded from now on."
        ),
    )


_DISABLED_REASONS = [c.value for c in WebhookSubscription.DisabledReason if c.value]


class WebhookSubscriptionSerializer(serializers.ModelSerializer):
    url_display = serializers.SerializerMethodField()
    event_types = serializers.ListField(child=serializers.CharField(), read_only=True)
    disabled_reason = serializers.SerializerMethodField()
    created_by = BoardUserSerializer(read_only=True, allow_null=True)
    configured_by = BoardUserSerializer(read_only=True, allow_null=True)
    board = serializers.IntegerField(source="board_id", read_only=True)
    last_delivered_event_id = serializers.IntegerField(
        source="cursor",
        read_only=True,
        help_text="Id of the last change-feed row delivered or skipped by type.",
    )

    class Meta:
        model = WebhookSubscription
        fields = [
            "id",
            "board",
            "name",
            "url_display",
            "url_host",
            "event_types",
            "enabled",
            "disabled_reason",
            "disabled_at",
            "last_delivered_event_id",
            "consecutive_failures",
            "failing_since",
            "next_attempt_at",
            "last_attempt_at",
            "last_success_at",
            "last_error_code",
            "last_status_code",
            "created_by",
            "configured_by",
            "created_at",
            "updated_at",
            "configured_at",
            "secret_rotated_at",
        ]
        read_only_fields = fields

    @extend_schema_field({"type": "string", "enum": _DISABLED_REASONS, "nullable": True})
    def get_disabled_reason(self, obj):
        """Null while enabled; otherwise why it is off."""
        return obj.disabled_reason or None

    @extend_schema_field(serializers.CharField())
    def get_url_display(self, obj):
        """``scheme://host/…``: never the path, query or port.

        Decrypted rather than stored so the scheme is right for an allowlisted
        ``http`` target. A value that no longer decrypts (the key changed)
        falls back to the stored host alone.
        """
        try:
            shown = egress.display_url(obj.get_url())
        except Exception:  # noqa: BLE001 — SecretDecryptionError or a malformed value
            shown = ""
        if shown:
            return shown
        return f"{obj.url_host}/…" if obj.url_host else ""


class WebhookCreatedSerializer(WebhookSubscriptionSerializer):
    """Create response: the subscription plus the URL and secret, shown once."""

    url = serializers.CharField(read_only=True, help_text="Shown once, in this response only.")
    secret = serializers.CharField(read_only=True, help_text="Signing secret. Shown once.")

    class Meta(WebhookSubscriptionSerializer.Meta):
        fields = WebhookSubscriptionSerializer.Meta.fields + ["url", "secret"]
        read_only_fields = fields


class WebhookRotatedSerializer(WebhookSubscriptionSerializer):
    secret = serializers.CharField(read_only=True, help_text="New signing secret. Shown once.")

    class Meta(WebhookSubscriptionSerializer.Meta):
        fields = WebhookSubscriptionSerializer.Meta.fields + ["secret"]
        read_only_fields = fields


class WebhookStatusSerializer(serializers.Serializer):
    enabled = serializers.BooleanField()
    dispatcher_last_run_at = serializers.DateTimeField(allow_null=True)
    dispatcher_stale = serializers.BooleanField()
    subscribable_event_types = serializers.ListField(child=serializers.CharField())


class WebhookTestResultSerializer(serializers.Serializer):
    ok = serializers.BooleanField()
    code = serializers.CharField(allow_null=True, help_text="null on success, else a delivery error code.")
    status_code = serializers.IntegerField(allow_null=True)
