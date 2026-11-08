"""``/api/v1/boards/{board_pk}/webhooks/`` (#863).

Access, in the order it is checked:

1. Authenticated, no pending credential change (the global default chain).
2. Board access via ``get_board_for_user``: a board the caller cannot see is
   404, never 403, so the endpoint does not confirm a board exists (Rule 7).
3. Board admin or site admin, else 403. Every action, ``status/`` included.
4. ``WEBHOOKS_ENABLED`` (and not demo mode), else 403 ``webhooks_disabled``,
   on every action except ``status/``.
5. An interactive session (owner decision D4) for the actions that choose
   where data goes or who it is signed for: create, a PATCH that changes
   ``url``, ``reenable``, ``rotate`` and ``test``. A Personal Access Token gets
   403 ``session_required`` there. The remaining actions (list, retrieve,
   rename, re-filter events, disable, delete) keep the destination and the
   signing key as they are, and accept a PAT. Re-filtering events can widen
   them; the data stays viewer-redacted either way.
6. Taking over a webhook turned off with ``creator_lost_access`` (``reenable``)
   also re-verifies the caller (1.3 UI spec Part 8): the current password for
   an account with one, else a recent provider sign-in in this session.

Subscriptions are looked up by id *within* the board resolved in step 2, so an
id from another board is a 404 (IDOR).

No WebSocket event is emitted for webhook configuration (``NO_BROADCAST_BY_DESIGN``
in scripts/check-broadcast-deferral.py): the settings are admin-only state with
a URL and a secret in them, and the only reader is the admin's own settings
tab. The audit trail is the ``configured_by`` / ``*_at`` columns plus one
structured log line per change (``dispatch.log_config_event``), ids only.
"""

from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound, PermissionDenied, Throttled
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle

from accounts import password_attempts
from accounts.credentials import (
    RECENT_LOGIN_REQUIRED_CODE,
    request_is_interactive_session,
    session_recently_signed_in_by_provider,
)
from accounts.permissions import TokenHasScope
from boards.models import Board
from boards.views._helpers import get_board_for_user
from visiban import crypto
from visiban.exceptions import CodedValidationError
from visiban.permissions import MustNotHavePendingPasswordChange, MustNotHavePendingUsernameChange
from visiban.request_shape import require_json_object

from . import dispatch
from .models import SUBSCRIBABLE_EVENT_TYPES, WebhookSubscription, generate_secret
from .serializers import (
    LIMIT_REACHED,
    WebhookCreatedSerializer,
    WebhookReenableSerializer,
    WebhookRotatedSerializer,
    WebhookRotateSerializer,
    WebhookStatusSerializer,
    WebhookSubscriptionSerializer,
    WebhookTestResultSerializer,
    WebhookWriteSerializer,
)

# One definition of "may manage webhooks" for the API, the dispatcher's
# standing rule and the notice recipients.
ADMIN_ROLES = dispatch.STANDING_ROLES

WEBHOOKS_DISABLED = "webhooks_disabled"
SESSION_REQUIRED = "session_required"
CURSOR_EXPIRED = "cursor_expired"
SECRET_UNAVAILABLE = "secret_unavailable"
PASSWORD_REQUIRED = "password_required"
PASSWORD_INCORRECT = "password_incorrect"

# `code` is optional in the schema: the coded refusals carry it, but a DRF
# field error (a 201-character name) or a non-object body is the standard 400,
# and a role 403 is the standard {"detail"}. The fuzz job checks every response
# against this schema, so it must admit all of them.
_ERROR = {
    "type": "object",
    "properties": {"detail": {"type": "string"}, "code": {"type": "string"}},
    "additionalProperties": True,
}
_ERRORS = {
    400: OpenApiResponse(
        response=_ERROR,
        description="`invalid_url`, `url_not_allowed`, `invalid_event_types` or `limit_reached`.",
    ),
    403: OpenApiResponse(
        response=_ERROR,
        description="Not a board admin, `webhooks_disabled`, or `session_required` (a token on a session-only action).",
    ),
    404: OpenApiResponse(description="Board or subscription not found, or no access to the board."),
}
_READ_ERRORS = {k: _ERRORS[k] for k in (403, 404)}


class WebhookConfigThrottle(UserRateThrottle):
    scope = "webhook_config"


class WebhookTestThrottle(UserRateThrottle):
    scope = "webhook_test"


class _CodedForbidden(PermissionDenied):
    def __init__(self, code, detail):
        super().__init__(detail={"detail": detail, "code": code})


def _no_store(response):
    response["Cache-Control"] = "no-store"
    return response


def _has_usable_secret(sub) -> bool:
    """False for an empty secret or one under a lost key.

    Rotating is how an admin recovers from either, so it must still succeed, but
    keeping such a value as the previous secret would promise a grace period it
    could never give.
    """
    try:
        return bool(sub.get_secret())
    except crypto.SecretDecryptionError:
        return False


class WebhookSubscriptionViewSet(viewsets.ViewSet):
    permission_classes = [
        IsAuthenticated,
        MustNotHavePendingPasswordChange,
        MustNotHavePendingUsernameChange,
        TokenHasScope,
    ]
    lookup_value_regex = r"\d+"
    pagination_class = None

    # ── access ───────────────────────────────────────────────────────────────

    def _board(self, board_pk):
        board, role = get_board_for_user(board_pk, self.request.user, slim=True)
        if role not in ADMIN_ROLES:
            raise PermissionDenied("Only board admins can manage webhooks.")
        return board

    def _require_enabled(self):
        if not dispatch.webhooks_enabled():
            raise _CodedForbidden(
                WEBHOOKS_DISABLED,
                "Webhooks are turned off on this server. Whoever runs it can turn "
                "them on with the WEBHOOKS_ENABLED setting.",
            )

    def _require_session(self):
        if not request_is_interactive_session(self.request):
            raise _CodedForbidden(
                SESSION_REQUIRED,
                "This change needs a signed-in browser session; access tokens "
                "cannot create, re-point, re-enable, rotate or test webhooks.",
            )

    def _throttle(self, throttle_class):
        throttle = throttle_class()
        if not throttle.allow_request(self.request, self):
            raise Throttled(wait=throttle.wait())

    def _enabled_board(self, board_pk):
        board = self._board(board_pk)
        self._require_enabled()
        return board

    def _subscription(self, board, pk):
        try:
            return WebhookSubscription.objects.select_related("created_by", "configured_by").get(
                pk=int(pk), board_id=board.pk
            )
        except (WebhookSubscription.DoesNotExist, ValueError, TypeError):
            raise NotFound() from None

    def _data(self, instance):
        return WebhookSubscriptionSerializer(instance).data

    # ── status ───────────────────────────────────────────────────────────────

    @extend_schema(
        summary="Webhook feature and dispatcher status for a board",
        responses={200: WebhookStatusSerializer, **_READ_ERRORS},
    )
    @action(detail=False, methods=["get"], url_path="status")
    def status(self, request, board_pk=None):
        """Always 200 for a board admin, whether or not webhooks are enabled."""
        self._board(board_pk)
        last, stale = dispatch.dispatcher_status()
        return Response(
            {
                "enabled": dispatch.webhooks_enabled(),
                "dispatcher_last_run_at": last,
                "dispatcher_stale": stale,
                "subscribable_event_types": list(SUBSCRIBABLE_EVENT_TYPES),
                "disable_after_failures": int(getattr(settings, "WEBHOOK_DISABLE_AFTER_FAILURES", 20)),
                "test_timeout_seconds": float(getattr(settings, "WEBHOOK_TIMEOUT_SECONDS", 10.0)),
            }
        )

    # ── CRUD ─────────────────────────────────────────────────────────────────

    @extend_schema(
        summary="List a board's webhooks",
        responses={200: WebhookSubscriptionSerializer(many=True), **_READ_ERRORS},
    )
    def list(self, request, board_pk=None):
        board = self._enabled_board(board_pk)
        # The annotation keeps last_delivered_event_id at one query for the
        # whole list (#2135); without it each row would read it separately.
        qs = dispatch.with_reported_cursor(
            WebhookSubscription.objects.filter(board_id=board.pk).select_related("created_by", "configured_by")
        )
        return Response(WebhookSubscriptionSerializer(qs, many=True).data)

    @extend_schema(
        summary="Get one webhook",
        responses={200: WebhookSubscriptionSerializer, **_READ_ERRORS},
    )
    def retrieve(self, request, board_pk=None, pk=None):
        board = self._enabled_board(board_pk)
        return Response(self._data(self._subscription(board, pk)))

    @extend_schema(
        summary="Create a webhook",
        description=(
            "Requires an interactive session. The response is the only time the "
            "full `url` and the signing `secret` are returned."
        ),
        request=WebhookWriteSerializer,
        responses={201: WebhookCreatedSerializer, **_ERRORS},
    )
    def create(self, request, board_pk=None):
        board = self._enabled_board(board_pk)
        self._require_session()
        self._throttle(WebhookConfigThrottle)
        ser = WebhookWriteSerializer(data=require_json_object(request), context={"require_url": True})
        ser.is_valid(raise_exception=True)
        attrs = ser.validated_data
        user = request.user
        now = timezone.now()
        secret = generate_secret()
        with transaction.atomic():
            # Serializes creates on this board, so two at once cannot both pass
            # the per-board cap. The per-user and server caps can still be
            # overshot by concurrent creates on different boards, by at most
            # the number of racing requests (throttled to 30/hour per user).
            Board.objects.select_for_update().filter(pk=board.pk).exists()
            self._check_limits(board, user)
            sub = WebhookSubscription(
                board=board,
                name=attrs.get("name", ""),
                event_types=attrs.get("event_types", []),
                # D5: start at the board's newest event; nothing earlier is sent.
                # Stored board-wide; the response reports it on the webhook's
                # own feed (dispatch.reported_cursor, #2135).
                cursor=dispatch.latest_event_id(board.pk),
                created_by=user,
                configured_by=user,
                configured_at=now,
            )
            sub.set_url(attrs["url"], ser.context["url_host"])
            sub.set_secret(secret)
            sub.save()
        dispatch.log_config_event("create", sub, actor_id=user.pk)
        data = dict(WebhookCreatedSerializer(sub).data)
        data["url"] = attrs["url"]
        data["secret"] = secret
        return _no_store(Response(data, status=status.HTTP_201_CREATED))

    def _check_limits(self, board, user):
        caps = (
            (Q(board_id=board.pk), "WEBHOOK_MAX_PER_BOARD", 10, "this board"),
            (Q(configured_by=user), "WEBHOOK_MAX_PER_USER", 25, "your account"),
            (Q(), "WEBHOOK_MAX_TOTAL", 1000, "this server"),
        )
        for scope, name, default, what in caps:
            if WebhookSubscription.objects.filter(scope).count() >= int(getattr(settings, name, default)):
                raise CodedValidationError(
                    LIMIT_REACHED,
                    f"The webhook limit for {what} is reached. Delete an unused webhook to add another.",
                )

    @extend_schema(
        summary="Update a webhook",
        description=(
            "Any of `name`, `event_types`, `url`. Changing `url` requires an "
            "interactive session and makes the caller the webhook's owner "
            "(`configured_by`); the secret is unchanged, and any open secret "
            "overlap ends."
        ),
        request=WebhookWriteSerializer,
        responses={200: WebhookSubscriptionSerializer, **_ERRORS},
    )
    def partial_update(self, request, board_pk=None, pk=None):
        board = self._enabled_board(board_pk)
        sub = self._subscription(board, pk)
        body = require_json_object(request)
        changes_url = "url" in body
        if changes_url:
            self._require_session()
            self._throttle(WebhookConfigThrottle)
        ser = WebhookWriteSerializer(data=body, partial=True)
        ser.is_valid(raise_exception=True)
        attrs = ser.validated_data
        fields = ["updated_at"]
        if "name" in attrs:
            sub.name = attrs["name"]
            fields.append("name")
        if "event_types" in attrs:
            sub.event_types = attrs["event_types"]
            fields.append("event_types")
        if changes_url:
            sub.set_url(attrs["url"], ser.context["url_host"])
            sub.configured_by = request.user
            sub.configured_at = timezone.now()
            # The new host never held the old secret, and signing with it would
            # hand that host requests replayable at the old receiver.
            sub.clear_previous_secret()
            fields += [
                "url_encrypted", "url_host", "configured_by", "configured_at",
                "previous_secret_encrypted", "previous_secret_expires_at",
            ]
        # update_fields: the dispatcher writes this row concurrently (cursor,
        # failure state, lease, disable). A full-row save from this request's
        # earlier read would roll those back.
        sub.save(update_fields=fields)
        dispatch.log_config_event("url_change" if changes_url else "update", sub, actor_id=request.user.pk)
        return Response(self._data(sub))

    @extend_schema(summary="Delete a webhook", responses={204: None, **_READ_ERRORS})
    def destroy(self, request, board_pk=None, pk=None):
        board = self._enabled_board(board_pk)
        sub = self._subscription(board, pk)
        dispatch.log_config_event("delete", sub, actor_id=request.user.pk)
        sub.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    # ── actions ──────────────────────────────────────────────────────────────

    @extend_schema(
        summary="Disable a webhook",
        request=None,
        responses={200: WebhookSubscriptionSerializer, **_READ_ERRORS},
    )
    @action(detail=True, methods=["post"])
    def disable(self, request, board_pk=None, pk=None):
        """Idempotent. Sets ``disabled_reason`` to ``manual``; no notice is sent."""
        board = self._enabled_board(board_pk)
        sub = self._subscription(board, pk)
        dispatch.disable(
            sub.pk, WebhookSubscription.DisabledReason.MANUAL, notify=False, actor_id=request.user.pk
        )
        sub.refresh_from_db()
        return Response(self._data(sub))

    @extend_schema(
        summary="Re-enable a webhook",
        description=(
            "Requires an interactive session and makes the caller the owner. "
            "`resume_from: cursor` (default) delivers what was missed; if an "
            "event after the webhook's position that it would have been sent was "
            "pruned the response is 409 `cursor_expired`, and "
            "`resume_from: latest` skips to new events. Taking over a webhook "
            "turned off with `creator_lost_access` also needs `current_password` "
            "(400 `password_required` / `password_incorrect`), or, for an account "
            "without a password, a recent provider sign-in (403 `recent_login_required`)."
        ),
        request=WebhookReenableSerializer,
        responses={
            200: WebhookSubscriptionSerializer,
            409: OpenApiResponse(response=_ERROR, description="`cursor_expired` or `secret_unavailable`."),
            429: OpenApiResponse(description="Too many wrong passwords on a take-over (the login lockout)."),
            **_ERRORS,
        },
    )
    @action(detail=True, methods=["post"])
    def reenable(self, request, board_pk=None, pk=None):
        board = self._enabled_board(board_pk)
        self._require_session()
        sub = self._subscription(board, pk)
        ser = WebhookReenableSerializer(data=require_json_object(request))
        ser.is_valid(raise_exception=True)
        resume_from = ser.validated_data["resume_from"]
        if not sub.enabled and sub.disabled_reason == WebhookSubscription.DisabledReason.CREATOR_LOST_ACCESS:
            refusal = self._take_over_refusal(request, ser.validated_data.get("current_password"))
            if refusal is not None:
                return refusal
        if not (
            crypto.secret_is_decryptable(sub.url_encrypted, info=crypto.WEBHOOK_URL_INFO)
            and crypto.secret_is_decryptable(sub.secret_encrypted, info=crypto.WEBHOOK_SECRET_INFO)
        ):
            return Response(
                {
                    "detail": "This webhook's stored URL or secret can no longer be read. Delete it and create a new one.",
                    "code": SECRET_UNAVAILABLE,
                },
                status=status.HTTP_409_CONFLICT,
            )
        now = timezone.now()
        with transaction.atomic():
            sub = WebhookSubscription.objects.select_for_update().get(pk=sub.pk)
            if not sub.enabled:
                if resume_from == "latest":
                    sub.cursor = dispatch.latest_event_id(board.pk)
                elif dispatch.cursor_expired(sub):
                    return Response(
                        {
                            "detail": (
                                "Events after the point where this webhook stopped were removed "
                                "by history cleanup. Re-enable with resume_from: latest."
                            ),
                            "code": CURSOR_EXPIRED,
                        },
                        status=status.HTTP_409_CONFLICT,
                    )
            sub.enabled = True
            sub.disabled_reason = ""
            sub.disabled_at = None
            sub.consecutive_failures = 0
            sub.failing_since = None
            sub.next_attempt_at = None
            sub.last_error_code = ""
            sub.configured_by = request.user
            sub.configured_at = now
            sub.save(update_fields=[
                "cursor", "enabled", "disabled_reason", "disabled_at", "consecutive_failures",
                "failing_since", "next_attempt_at", "last_error_code", "configured_by",
                "configured_at", "updated_at",
            ])
        dispatch.log_config_event("reenable", sub, actor_id=request.user.pk, reason=resume_from)
        sub = self._subscription(board, sub.pk)
        return Response(self._data(sub))

    @extend_schema(
        summary="Rotate a webhook's signing secret",
        description=(
            "Requires an interactive session and makes the caller the owner. The "
            "new secret is returned once. With `overlap_seconds` above 0 the old "
            "secret keeps signing beside it until `previous_secret_expires_at`; "
            "without it the old secret stops signing immediately and any open "
            "overlap ends."
        ),
        request=WebhookRotateSerializer,
        responses={
            200: WebhookRotatedSerializer,
            400: OpenApiResponse(
                response=_ERROR,
                description="`overlap_seconds` out of range (a field error), or a body that is not a JSON object.",
            ),
            **_READ_ERRORS,
        },
    )
    @action(detail=True, methods=["post"])
    def rotate(self, request, board_pk=None, pk=None):
        board = self._enabled_board(board_pk)
        self._require_session()
        self._throttle(WebhookConfigThrottle)
        sub = self._subscription(board, pk)
        ser = WebhookRotateSerializer(data=require_json_object(request))
        ser.is_valid(raise_exception=True)
        overlap = ser.validated_data["overlap_seconds"]
        secret = generate_secret()
        now = timezone.now()
        # Read-modify-write: the current secret becomes the previous one. Two
        # rotations at once must not both read the same one, or the first caller's
        # new secret, already on their screen, would vanish with no overlap.
        with transaction.atomic():
            try:
                sub = WebhookSubscription.objects.select_for_update().get(pk=sub.pk)
            except WebhookSubscription.DoesNotExist:
                raise NotFound() from None
            keep_previous = overlap > 0 and _has_usable_secret(sub)
            if keep_previous:
                sub.previous_secret_encrypted = sub.secret_encrypted
                sub.previous_secret_expires_at = now + timedelta(seconds=overlap)
            else:
                sub.clear_previous_secret()
            sub.set_secret(secret)
            sub.secret_rotated_at = now
            sub.configured_by = request.user
            sub.configured_at = now
            sub.save(update_fields=[
                "secret_encrypted", "previous_secret_encrypted", "previous_secret_expires_at",
                "secret_rotated_at", "configured_by", "configured_at", "updated_at",
            ])
        dispatch.log_config_event(
            "rotate", sub, actor_id=request.user.pk, reason=f"overlap={overlap if keep_previous else 0}"
        )
        sub = self._subscription(board, sub.pk)
        data = dict(WebhookRotatedSerializer(sub).data)
        data["secret"] = secret
        return _no_store(Response(data))

    @extend_schema(
        summary="Send a test event to a webhook",
        description=(
            "Requires an interactive session. Sends `webhook.test` (id 0) "
            "synchronously and reports the outcome; the cursor and failure "
            "counters are untouched. A disabled webhook can be tested."
        ),
        request=None,
        responses={200: WebhookTestResultSerializer, **_READ_ERRORS},
    )
    @action(detail=True, methods=["post"])
    def test(self, request, board_pk=None, pk=None):
        board = self._enabled_board(board_pk)
        self._require_session()
        self._throttle(WebhookTestThrottle)
        sub = self._subscription(board, pk)
        ok, code, status_code, latency_ms = dispatch.send_test(sub)
        dispatch.log_config_event("test", sub, actor_id=request.user.pk, reason=code)
        return Response({"ok": ok, "code": code, "status_code": status_code, "latency_ms": latency_ms})

    def _take_over_refusal(self, request, password):
        """Re-verify the caller before they take over a lapsed owner's webhook.

        The take-over makes the caller the owner whose standing keeps it
        delivering, so it gets the same proof as other credential-grade
        changes: the current password (counted against the same failed-attempt
        budget as login, so it cannot be used to guess the password), or, for
        an account without one, a recent provider sign-in recorded in this
        session. Returns a Response to send, or None to proceed.
        """
        user = request.user
        if not user.has_usable_password():
            if session_recently_signed_in_by_provider(request, user):
                return None
            return Response(
                {
                    "detail": "Sign in again with your sign-in provider, then take over this webhook.",
                    "code": RECENT_LOGIN_REQUIRED_CODE,
                },
                status=status.HTTP_403_FORBIDDEN,
            )
        if not isinstance(password, str) or not password:
            return Response(
                {"detail": "Enter your current password to take over this webhook.", "code": PASSWORD_REQUIRED},
                status=status.HTTP_400_BAD_REQUEST,
            )
        attempt = password_attempts.begin_current_password_check(request, user)
        if not user.check_password(password):
            return Response(
                {"detail": "That password isn't right.", "code": PASSWORD_INCORRECT},
                status=status.HTTP_400_BAD_REQUEST,
            )
        password_attempts.current_password_accepted(attempt)
        return None
