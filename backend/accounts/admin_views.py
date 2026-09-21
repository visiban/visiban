"""Admin API views — all endpoints gated by IsSiteAdmin."""
import logging
from datetime import timedelta

from django.conf import settings
from django.contrib.auth import get_user_model, password_validation
from django.core.mail import EmailMessage
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework import serializers as drf_serializers
from rest_framework import status
from rest_framework.throttling import UserRateThrottle
from visiban.pagination import OffsetCountPagination
from rest_framework.response import Response
from rest_framework.views import APIView

from boards.permissions import get_board_role
from visiban.mail import (
    ERROR_BACKEND_PINNED,
    EmailConfigUnusable,
    build_smtp_backend,
    classify_smtp_error,
    env_email_config,
    resolve_email_config,
    sender_is_placeholder,
)
from .models import (
    AdminActionLog,
    InviteLink,
    MAINTENANCE_MESSAGE_MAX_LENGTH,
    MAX_ACTIVE_INVITE_LINKS,
    SiteEmailSetting,
    SiteSetting,
    record_email_settings_changes,
    record_email_test,
    record_site_setting_changes,
    snapshot_email_setting,
    snapshot_site_setting,
)
from .permissions import IsSiteAdmin, TokenHasScope
from .validators import UsernameFormatValidator
from visiban.permissions import (
    MustNotHavePendingPasswordChange,
    MustNotHavePendingUsernameChange,
)

logger = logging.getLogger(__name__)

# Combining these permissions ensures that a site admin with a forced-password-
# reset or forced-username-change flag cannot reach any admin endpoint.
# Declaring permission_classes = [IsSiteAdmin] alone would silently drop the
# global defaults.
#
# MustNotHavePendingUsernameChange was missing here until #1110: every other
# override site in the repo enumerates all three, so a site admin with
# must_change_username=True reached every /api/v1/admin/* route. Found by the
# architect review on #1110 while auditing this list as a scope-enforcement
# site; fixed here rather than deferred because it is a live gap, not a
# quality finding.
_ADMIN_PERMISSIONS = [
    IsSiteAdmin,
    MustNotHavePendingPasswordChange,
    MustNotHavePendingUsernameChange,
    TokenHasScope,
]

User = get_user_model()


# ---------------------------------------------------------------------------
# Serializers
# ---------------------------------------------------------------------------

class SiteSettingSerializer(drf_serializers.Serializer):
    registration_mode = drf_serializers.ChoiceField(
        choices=SiteSetting.RegistrationMode.choices,
    )
    uploads_enabled = drf_serializers.BooleanField(required=False)
    maintenance_mode = drf_serializers.BooleanField(required=False)
    # Validated at the serializer boundary (never in the view or model), per the
    # project's input-validation rule. `allow_blank` is required because blank
    # is a meaningful value here: it means "use the built-in default notice".
    # max_length bounds what an operator can push into every user's banner and
    # into every 503 body on the instance.
    maintenance_message = drf_serializers.CharField(
        required=False,
        allow_blank=True,
        max_length=MAINTENANCE_MESSAGE_MAX_LENGTH,
        trim_whitespace=True,
    )


class SiteEmailSettingSerializer(drf_serializers.Serializer):
    """Read/write payload for DB-backed SMTP configuration (#306).

    A plain ``Serializer`` rather than a ``ModelSerializer``, matching
    ``SiteSettingSerializer`` above — and here it is load-bearing rather than
    stylistic. A ModelSerializer would expose ``password_ciphertext`` by
    default, and "the field that must never be returned is excluded only
    because someone remembered to exclude it" is the wrong default for a
    credential.

    The password is ``write_only``. Reads answer two booleans instead:
    ``password_set`` and ``password_decryptable``. The second is what makes a
    rotated encryption key visible *before* the next send fails.
    """

    config_source = drf_serializers.ChoiceField(
        choices=SiteEmailSetting.ConfigSource.choices,
        required=False,
    )
    host = drf_serializers.CharField(required=False, allow_blank=True, max_length=255,
                                     trim_whitespace=True)
    port = drf_serializers.IntegerField(required=False, min_value=1, max_value=65535)
    username = drf_serializers.CharField(required=False, allow_blank=True, max_length=255,
                                         trim_whitespace=True)
    # Blank is meaningful and distinct from absent: absent leaves the stored
    # password alone, blank clears it. See EmailSettingsView.patch.
    password = drf_serializers.CharField(required=False, allow_blank=True, max_length=1024,
                                         write_only=True, trim_whitespace=False)
    use_tls = drf_serializers.BooleanField(required=False)
    use_ssl = drf_serializers.BooleanField(required=False)
    from_email = drf_serializers.EmailField(required=False, allow_blank=True, max_length=255)
    timeout = drf_serializers.IntegerField(required=False, min_value=1, max_value=300)

    def __init__(self, *args, **kwargs):
        # The existing row, so validate() can reason about the state a partial
        # PATCH would produce rather than only about the submitted fields.
        self.current = kwargs.pop("current", None)
        super().__init__(*args, **kwargs)

    def _merged(self, attrs, field):
        if field in attrs:
            return attrs[field]
        return getattr(self.current, field) if self.current is not None else None

    def validate(self, attrs):
        # Cross-field validation, all against the POST-PATCH state — validating
        # only the submitted fields would let a two-step PATCH walk the row into
        # a combination neither request looked invalid on its own.
        use_tls = self._merged(attrs, "use_tls")
        use_ssl = self._merged(attrs, "use_ssl")
        if use_tls and use_ssl:
            # Django's SMTP backend raises ValueError when both are set, which
            # would surface as a 500 at send time instead of a 400 here.
            raise drf_serializers.ValidationError({
                "use_ssl": "STARTTLS and implicit SSL cannot both be enabled. "
                           "Use STARTTLS on port 587, or implicit SSL on port 465.",
            })

        from_email = self._merged(attrs, "from_email")
        if from_email and sender_is_placeholder(from_email):
            raise drf_serializers.ValidationError({
                "from_email": "Enter your real sending address — example.com is a "
                              "placeholder and mail sent from it will not be deliverable.",
            })

        # Selecting the database as the authoritative source is the moment the
        # row starts routing real mail, so completeness is enforced here rather
        # than at send time. This is what makes the "admin saved host and port,
        # then got interrupted" half-row harmless: it simply never becomes
        # authoritative, and env configuration keeps working untouched.
        if self._merged(attrs, "config_source") == SiteEmailSetting.ConfigSource.DATABASE:
            host = self._merged(attrs, "host")
            username = self._merged(attrs, "username")
            has_password = bool(attrs.get("password")) or bool(
                self.current.password_ciphertext if self.current is not None else ""
            )
            missing = []
            if not host:
                missing.append("host")
            if not from_email:
                missing.append("from_email")
            if username and not has_password:
                missing.append("password")
            if missing:
                raise drf_serializers.ValidationError({
                    "config_source": (
                        "Cannot switch to the stored configuration until it is "
                        f"complete. Missing: {', '.join(missing)}."
                    ),
                })
            if self.current is not None and not self.current.password_decryptable:
                raise drf_serializers.ValidationError({
                    "config_source": (
                        "The stored SMTP password could not be decrypted because the "
                        "instance encryption key changed. Re-enter the password before "
                        "switching to the stored configuration."
                    ),
                })
        return attrs


def _email_settings_payload(cfg) -> dict:
    """Serialize the email settings row plus what is actually in effect.

    The ``effective_*`` block is deliberately computed rather than echoed back:
    an admin looking at this page needs to know which source is live *right
    now*, and the stored row alone cannot answer that — it says nothing about
    an explicit ``EMAIL_BACKEND`` override or about env values.
    """
    data = {
        "config_source": cfg.config_source,
        "host": cfg.host,
        "port": cfg.port,
        "username": cfg.username,
        "use_tls": cfg.use_tls,
        "use_ssl": cfg.use_ssl,
        "from_email": cfg.from_email,
        "timeout": cfg.timeout,
        "password_set": cfg.password_set,
        "password_decryptable": cfg.password_decryptable,
    }

    if getattr(settings, "EMAIL_BACKEND_EXPLICIT", False):
        # The operator pinned EMAIL_BACKEND, so neither env SMTP values nor the
        # stored row are consulted. Reporting "env" here would be a lie.
        effective_source = "env_backend_override"
        effective = env_email_config()
    else:
        try:
            # Reuse the row the caller already fetched, and skip decrypting the
            # password: nothing below reads it, and decrypting a secret only to
            # discard it would put the plaintext in this frame for no reason.
            effective = resolve_email_config(cfg, need_password=False)
            effective_source = effective.source
        except EmailConfigUnusable:
            # The selected configuration cannot be used (incomplete row,
            # undecryptable password, or a placeholder sender). Report the
            # source the operator actually selected — reporting anything else
            # would be a lie, and the UI surfaces the specific fault separately
            # via password_decryptable and the warning panel.
            effective = env_email_config()
            effective_source = cfg.config_source

    data.update({
        "effective_source": effective_source,
        "effective_host": effective.host,
        "effective_port": effective.port,
        "effective_from_email": effective.from_email,
        "effective_use_tls": effective.use_tls,
    })
    return data


class AdminEmailSettingsView(APIView):
    """GET/PATCH the singleton SiteEmailSetting row (#306)."""

    permission_classes = _ADMIN_PERMISSIONS

    def get(self, request):
        return Response(_email_settings_payload(SiteEmailSetting.get()))

    def patch(self, request):
        # Materialize before locking — select_for_update has nothing to lock on
        # a first-boot instance where the row is absent.
        current = SiteEmailSetting.get()
        serializer = SiteEmailSettingSerializer(data=request.data, partial=True, current=current)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        validated = serializer.validated_data

        # Same locked validate-then-audit shape as AdminSettingsView.patch: the
        # lock is what keeps the audit trail truthful under concurrent admin
        # edits, not merely atomic. See that method's comment.
        with transaction.atomic():
            cfg = SiteEmailSetting.objects.select_for_update().get(pk=1)
            before = snapshot_email_setting(cfg)
            update_fields = []

            for field in ("config_source", "host", "port", "username",
                          "use_tls", "use_ssl", "from_email", "timeout"):
                if field in validated:
                    setattr(cfg, field, validated[field])
                    update_fields.append(field)

            # Absent means "keep the stored password"; blank means "clear it".
            # Collapsing the two would make it impossible to edit the host
            # without either re-typing the password or silently wiping it.
            if "password" in validated:
                cfg.set_password(validated["password"])
                update_fields.append("password_ciphertext")

            if update_fields:
                cfg.save(update_fields=update_fields)
                record_email_settings_changes(
                    before=before,
                    after=cfg,
                    actor=request.user,
                    source=AdminActionLog.Source.ADMIN_API,
                )

        return Response(_email_settings_payload(cfg))


class EmailTestThrottle(UserRateThrottle):
    """Bounds outbound SMTP connections opened by the admin test endpoint."""

    scope = "email_test"


class AdminEmailTestView(APIView):
    """POST /api/v1/admin/email-settings/test/ — send a test email (#306).

    The recipient is always ``request.user.email`` and is never taken from the
    request body. An admin-gated endpoint that connects to an arbitrary
    host:port and delivers to an arbitrary address is an open relay, a spam
    vector, an exfiltration channel and a network probe; restricting delivery to
    the caller's own address costs nothing and removes all four.

    Failures return a code from the sanitized taxonomy in ``visiban.mail`` —
    never the raw smtplib error. Some MTAs echo the offending protocol line
    back in their error text, which on an AUTH failure can carry base64-encoded
    credentials, and that text would otherwise reach the client verbatim.
    """

    permission_classes = _ADMIN_PERMISSIONS
    throttle_classes = [EmailTestThrottle]

    def post(self, request):
        recipient = (request.user.email or "").strip()
        if not recipient:
            return Response(
                {
                    "success": False,
                    "code": "no_recipient",
                    "detail": "Your account has no email address, so there is nowhere "
                              "to send the test. Add one in your profile first.",
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        # An operator who pinned EMAIL_BACKEND has opted out of both sources, so
        # opening an SMTP connection to the resolved host:port would test a path
        # that carries no production mail and report a green check for the wrong
        # thing — while still making an outbound connection on an install that
        # deliberately opted out of this feature.
        if getattr(settings, "EMAIL_BACKEND_EXPLICIT", False):
            return Response(
                {
                    "success": False,
                    "code": ERROR_BACKEND_PINNED,
                    "detail": "EMAIL_BACKEND is set on the server, so Visiban cannot test "
                              "the configuration below — it is not what sends mail.",
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            config = resolve_email_config()
            connection = build_smtp_backend(config, fail_silently=False)
            message = EmailMessage(
                subject="Visiban test email",
                body=(
                    "This is a test email from your Visiban instance.\n\n"
                    "If you received it, outbound email is configured correctly."
                ),
                from_email=config.from_email or None,
                to=[recipient],
                connection=connection,
            )
            message.send(fail_silently=False)
        except Exception as exc:  # noqa: BLE001 - mapped onto a sanitized taxonomy
            code = classify_smtp_error(exc)
            # Exception TYPE only — deliberately no exc_info, and never str(exc).
            #
            # For SMTPAuthenticationError the exception message *is* the remote
            # server's reply line, which is remote-controlled and on a rejected
            # AUTH routinely echoes the offending command back — including the
            # base64-encoded credentials. `test_auth_failure_returns_code_without
            # _leaking_the_raw_error` models exactly that payload. Writing it
            # with exc_info=True would hand the log the one value this feature
            # encrypts at rest, excludes from the audit trail, and strips from
            # every response — and log aggregators are a far wider audience than
            # the site admins entitled to the relay credential.
            #
            # `code` already carries the actionable taxonomy, so nothing
            # diagnostic is lost.
            logger.warning(
                "Admin SMTP test failed (code=%s, source=%s, exc=%s)",
                code,
                getattr(locals().get("config"), "source", "unresolved"),
                type(exc).__name__,
            )
            with transaction.atomic():
                record_email_test(
                    success=False,
                    actor=request.user,
                    source=AdminActionLog.Source.ADMIN_API,
                )
            detail = exc.detail if isinstance(exc, EmailConfigUnusable) else None
            return Response(
                {"success": False, "code": code, "detail": detail},
                status=status.HTTP_400_BAD_REQUEST,
            )

        with transaction.atomic():
            record_email_test(
                success=True,
                actor=request.user,
                source=AdminActionLog.Source.ADMIN_API,
            )
        # The recipient is echoed to the caller who supplied it implicitly (it
        # is their own address) but is never logged — CLAUDE.md forbids logging
        # email addresses.
        return Response({"success": True, "code": None, "sent_to": recipient})


class AdminActionLogSerializer(drf_serializers.ModelSerializer):
    """Read-only payload for the admin action log (#1126).

    The actor is rendered flat (``actor_id`` + ``actor_username``) rather than
    as a nested user object, matching ``created_by_username`` on the invite-link
    payload in this same module. Both columns are local, so a page of rows costs
    one query — and a nested object can always be *added* later without breaking
    the 1.x contract, whereas one shipped now could never be removed.

    ``actor_username`` is the username captured when the action happened, not a
    live lookup: it stays correct after a rename and survives deletion of the
    account. ``actor_id`` may therefore point at a user that no longer exists.
    """

    class Meta:
        model = AdminActionLog
        fields = ["id", "action", "actor_id", "actor_username", "source", "metadata", "created_at"]
        read_only_fields = fields


class OwnedBoardSummarySerializer(drf_serializers.Serializer):
    id = drf_serializers.IntegerField()
    uid = drf_serializers.CharField()
    name = drf_serializers.CharField()


class AdminUserSerializer(drf_serializers.ModelSerializer):
    """Full user representation for the admin users list."""

    owned_boards = drf_serializers.SerializerMethodField()

    def get_owned_boards(self, obj):
        # Use the pre-built map injected by AdminUsersView.get() when available.
        # This allows the list endpoint to load owned boards in a single query
        # rather than one query per user. Single-object responses (create, patch,
        # deactivate) do not inject the map and fall back to the live query.
        owned_map = self.context.get("_owned_boards_map")
        if owned_map is not None:
            return owned_map.get(obj.id, [])
        # Deferred import to avoid circular dependency at module load time
        # (boards imports accounts for User; accounts must not import boards at top level).
        from boards.models import Board
        return list(Board.objects.filter(owner=obj).values("id", "uid", "name"))

    class Meta:
        model = User
        fields = [
            "id",
            "username",
            "email",
            "display_name",
            "first_name",
            "last_name",
            "avatar_url",
            "is_active",
            "is_site_admin",
            "can_access_all_content",
            "must_change_password",
            "has_completed_tour",
            "date_joined",
            "owned_boards",
        ]
        read_only_fields = ["id", "date_joined", "owned_boards"]


class AdminCreateUserSerializer(drf_serializers.Serializer):
    """Validates the payload for admin-created accounts."""
    username = drf_serializers.CharField(max_length=150, validators=[UsernameFormatValidator()])
    email = drf_serializers.EmailField()
    password = drf_serializers.CharField(min_length=12, write_only=True)
    force_password_reset = drf_serializers.BooleanField(default=True)

    def validate_username(self, value):
        if User.objects.filter(username__iexact=value).exists():
            raise drf_serializers.ValidationError("A user with that username already exists.")
        return value

    def validate_email(self, value):
        if User.objects.filter(email=value).exists():
            raise drf_serializers.ValidationError("A user with that email already exists.")
        return value

    def validate_password(self, value):
        password_validation.validate_password(value)
        return value


class AdminPatchUserSerializer(drf_serializers.Serializer):
    """Validates partial updates allowed by site admins."""
    is_active = drf_serializers.BooleanField(required=False)
    is_site_admin = drf_serializers.BooleanField(required=False)
    can_access_all_content = drf_serializers.BooleanField(required=False)
    must_change_password = drf_serializers.BooleanField(required=False)
    has_completed_tour = drf_serializers.BooleanField(required=False)


class InviteLinkSerializer(drf_serializers.Serializer):
    """Read-only invite link representation — never returns the raw token."""
    id = drf_serializers.IntegerField(read_only=True)
    prefix = drf_serializers.CharField(read_only=True)
    expires_at = drf_serializers.DateTimeField(read_only=True, allow_null=True)
    single_use = drf_serializers.BooleanField(read_only=True)
    used_at = drf_serializers.DateTimeField(read_only=True, allow_null=True)
    revoked_at = drf_serializers.DateTimeField(read_only=True, allow_null=True)
    created_at = drf_serializers.DateTimeField(read_only=True)
    use_count = drf_serializers.IntegerField(read_only=True)
    status = drf_serializers.SerializerMethodField()
    created_by_username = drf_serializers.SerializerMethodField()

    def get_status(self, obj):
        return obj.status

    def get_created_by_username(self, obj):
        return obj.created_by.username if obj.created_by else None


class InviteLinkCreateResponseSerializer(InviteLinkSerializer):
    """Extends InviteLinkSerializer with the raw token — included once at creation only."""
    raw_token = drf_serializers.CharField(read_only=True)


class InviteLinkCreateSerializer(drf_serializers.Serializer):
    """Validates the payload for invite link creation."""
    expires_in_days = drf_serializers.IntegerField(required=False, allow_null=True)
    single_use = drf_serializers.BooleanField(default=False)

    def validate_expires_in_days(self, value):
        if value is not None and value not in InviteLink.VALID_TTL_DAYS:
            raise drf_serializers.ValidationError(
                f"expires_in_days must be one of {InviteLink.VALID_TTL_DAYS} or null."
            )
        return value


class TransferItemSerializer(drf_serializers.Serializer):
    board_id = drf_serializers.IntegerField()
    transfer_to = drf_serializers.IntegerField()


class DeactivateSerializer(drf_serializers.Serializer):
    """Validates the ownership-transfer payload for user deactivation."""
    transfers = TransferItemSerializer(many=True, default=list)


# ---------------------------------------------------------------------------
# Pagination
# ---------------------------------------------------------------------------

class AdminUserPagination(OffsetCountPagination):
    # Aligns with the project-wide {count, offset, page_size, results} envelope.
    # The frontend (AdminPage) reads page_size/offset/count; next/previous URL links are unused.
    default_limit = 50
    max_limit = 200


class AdminActionLogPagination(OffsetCountPagination):
    # Offset pagination on a log that grows at the head can shift rows between
    # pages while a caller walks it (the reason CardQueryCursorPagination exists
    # for the card feed). Accepted here: this table gains a handful of rows a
    # month, so a page boundary moving under a reader is a theoretical concern
    # rather than an operational one, and the {count, offset, page_size,
    # results} envelope is what every admin list endpoint already returns.
    default_limit = 50
    max_limit = 200


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------

class AdminSettingsView(APIView):
    """GET/PATCH the singleton SiteSetting row."""
    permission_classes = _ADMIN_PERMISSIONS

    def get(self, request):
        setting = SiteSetting.get()
        return Response(SiteSettingSerializer(setting).data)

    def patch(self, request):
        # Validation runs BEFORE the lock below, so a malformed request returns
        # 400 without ever holding a row lock on the singleton.
        serializer = SiteSettingSerializer(data=request.data, partial=True)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        validated = serializer.validated_data
        # Materialize the singleton before locking it — select_for_update has
        # nothing to lock on a first-boot instance where the row is absent.
        SiteSetting.get()

        # Everything from the read through the audit write happens under one
        # locked transaction (#1126).
        #
        # The lock is what makes the audit trail truthful, not just the
        # atomicity. Read the row without it and two admins editing
        # concurrently produce a log that lies: A commits "X"→"Y", B (which
        # read "X" earlier) then commits "Z", and B's row claims "X"→"Z" — a
        # transition that never happened, with A's edit missing entirely.
        # Last-write-wins on the value itself is unchanged and acceptable; a
        # record that is confidently wrong about what changed is not, because
        # that is the single thing this table exists to report. Concurrent
        # admin edits are most likely during an incident, which is exactly when
        # the trail is read. Same select_for_update pattern, same row, same
        # reason as AdminInviteLinkListCreateView.post below.
        #
        # Cache invalidation is deliberately NOT repeated here: SiteSetting.save()
        # owns it. It evicts immediately (which is what makes the new value
        # visible in-process) AND again via transaction.on_commit. The second
        # eviction is the one that matters here — the immediate one lands
        # mid-transaction, where another worker can repopulate the cache from
        # the still-old committed row, so without the post-commit repeat that
        # stale value would survive until the TTL expired.
        with transaction.atomic():
            setting = SiteSetting.objects.select_for_update().get(pk=1)
            # Snapshotted under the lock so the diff compares against what was
            # actually stored, not against a value another request has since
            # replaced.
            before = snapshot_site_setting(setting)
            update_fields = []

            if "registration_mode" in validated:
                setting.registration_mode = validated["registration_mode"]
                update_fields.append("registration_mode")

            if "uploads_enabled" in validated:
                setting.uploads_enabled = validated["uploads_enabled"]
                update_fields.append("uploads_enabled")

            for field in ("maintenance_mode", "maintenance_message"):
                if field in validated:
                    setattr(setting, field, validated[field])
                    update_fields.append(field)

            if update_fields:
                setting.save(update_fields=update_fields)
                record_site_setting_changes(
                    before=before,
                    after=setting,
                    actor=request.user,
                    source=AdminActionLog.Source.ADMIN_API,
                )

        return Response(SiteSettingSerializer(setting).data)


class AdminActionLogView(APIView):
    """GET /api/admin/action-log/ — paginated instance-admin audit trail (#1126).

    Site-admin only, like every other endpoint in this module: an audit trail of
    privileged actions is itself sensitive, since it reveals when the instance
    was unattended and who holds admin rights.

    Read-only by design. There is no write endpoint and no delete endpoint —
    rows are appended by the actions themselves, and an audit log an admin can
    edit is not evidence of anything.
    """

    permission_classes = _ADMIN_PERMISSIONS
    pagination_class = AdminActionLogPagination

    def get(self, request):
        qs = AdminActionLog.objects.all()

        # Validated against the enum at the boundary rather than passed to the
        # ORM as-is: an unknown value is a caller error worth a 400, not a
        # silently empty page that reads like "nothing ever happened".
        action = request.query_params.get("action", "").strip()
        if action:
            if action not in AdminActionLog.Action.values:
                return Response(
                    {"action": [f"'{action}' is not a valid action."]},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            qs = qs.filter(action=action)

        paginator = self.pagination_class()
        page = paginator.paginate_queryset(qs, request)
        return paginator.get_paginated_response(
            AdminActionLogSerializer(page, many=True).data
        )


class AdminUsersView(APIView):
    """
    GET  /api/admin/users/  — paginated list, optional ?search=
    POST /api/admin/users/  — create a new user
    """
    permission_classes = _ADMIN_PERMISSIONS
    pagination_class = AdminUserPagination

    def get(self, request):
        qs = User.objects.all().order_by("username")
        search = request.query_params.get("search", "").strip()
        if search:
            qs = qs.filter(
                Q(display_name__icontains=search)
                | Q(email__icontains=search)
                | Q(username__icontains=search)
            )
        paginator = self.pagination_class()
        page = paginator.paginate_queryset(qs, request)

        # Build owned_boards in a single query across all users on this page,
        # then inject a pre-built map into the serializer context so
        # AdminUserSerializer.get_owned_boards() does not fire one query per user.
        # Deferred import to avoid circular dependency at module load time.
        from boards.models import Board as _Board
        user_ids = [u.id for u in page]
        board_rows = _Board.objects.filter(owner_id__in=user_ids).values("owner_id", "id", "uid", "name")
        owned_map: dict = {}
        for row in board_rows:
            owned_map.setdefault(row["owner_id"], []).append(
                {"id": row["id"], "uid": row["uid"], "name": row["name"]}
            )

        serializer = AdminUserSerializer(page, many=True, context={"_owned_boards_map": owned_map})
        return paginator.get_paginated_response(serializer.data)

    @transaction.atomic
    def post(self, request):
        serializer = AdminCreateUserSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        data = serializer.validated_data
        user = User.objects.create_user(
            username=data["username"],
            email=data["email"],
            password=data["password"],
        )
        user.must_change_password = data.get("force_password_reset", True)
        user.save(update_fields=["must_change_password"])

        return Response(AdminUserSerializer(user).data, status=status.HTTP_201_CREATED)


class AdminUserDetailView(APIView):
    """PATCH /api/admin/users/{id}/ — update is_active, is_site_admin, must_change_password."""
    permission_classes = _ADMIN_PERMISSIONS

    def _get_user_or_404(self, pk):
        try:
            return User.objects.get(pk=pk)
        except User.DoesNotExist:
            return None

    def patch(self, request, pk):
        target = self._get_user_or_404(pk)
        if target is None:
            return Response({"detail": "User not found."}, status=status.HTTP_404_NOT_FOUND)

        serializer = AdminPatchUserSerializer(data=request.data, partial=True)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        validated = serializer.validated_data
        update_fields = []

        # Guard: cannot deactivate yourself.
        if "is_active" in validated and not validated["is_active"]:
            if target.pk == request.user.pk:
                return Response(
                    {"detail": "You cannot deactivate your own account."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            # Guard: deactivating a board-owning user via PATCH is not allowed —
            # use POST /api/admin/users/{id}/deactivate/ to provide ownership transfers.
            from boards.models import Board
            owned = list(Board.objects.filter(owner=target).values("id", "uid", "name"))
            if owned:
                return Response(
                    {
                        "code": "owned_boards",
                        "detail": "User owns boards that must be transferred before deactivation.",
                        "owned_boards": owned,
                    },
                    status=status.HTTP_409_CONFLICT,
                )

        # Guard: cannot remove the last site admin.
        if "is_site_admin" in validated and not validated["is_site_admin"]:
            if target.pk == request.user.pk:
                return Response(
                    {"detail": "You cannot demote yourself from site admin."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            remaining = User.objects.filter(is_site_admin=True, is_active=True).exclude(pk=target.pk).count()
            if remaining == 0:
                return Response(
                    {"detail": "Cannot demote the last active site admin."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        # Apply each validated field to the target user.
        _PATCHABLE_FIELDS = (
            "is_active", "is_site_admin", "can_access_all_content",
            "must_change_password", "has_completed_tour",
        )
        for field in _PATCHABLE_FIELDS:
            if field in validated:
                setattr(target, field, validated[field])
                update_fields.append(field)

        if update_fields:
            target.save(update_fields=update_fields)

        return Response(AdminUserSerializer(target).data)


class AdminInviteLinkListCreateView(APIView):
    """
    GET  /api/admin/invite-links/  — list all invite links
    POST /api/admin/invite-links/  — create a new invite link
    """
    permission_classes = _ADMIN_PERMISSIONS

    def get(self, request):
        links = InviteLink.objects.select_related("created_by").all()
        return Response(InviteLinkSerializer(links, many=True).data)

    @transaction.atomic
    def post(self, request):
        serializer = InviteLinkCreateSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        # Serialize invite link creation through the SiteSetting row lock to
        # prevent two concurrent admin requests from both reading a count below
        # MAX_ACTIVE_INVITE_LINKS and both creating a link, overshooting the cap.
        # get_or_create ensures the singleton exists before acquiring the lock.
        SiteSetting.objects.get_or_create(pk=1)
        SiteSetting.objects.select_for_update().get(pk=1)

        # Soft cap: prevent token flood from a compromised admin account.
        active_count = InviteLink.objects.filter(
            used_at__isnull=True,
            revoked_at__isnull=True,
        ).exclude(expires_at__lt=timezone.now()).count()
        if active_count >= MAX_ACTIVE_INVITE_LINKS:
            return Response(
                {"detail": f"Maximum active invite links ({MAX_ACTIVE_INVITE_LINKS}) reached. Revoke or wait for expiry before creating more."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        data = serializer.validated_data
        expires_in_days = data.get("expires_in_days")
        expires_at = (
            timezone.now() + timedelta(days=expires_in_days)
            if expires_in_days
            else None
        )

        link, raw_token = InviteLink.generate(
            created_by=request.user,
            expires_at=expires_at,
            single_use=data.get("single_use", False),
        )
        logger.info(
            "invite_link.created pk=%d prefix=%s created_by=%d single_use=%s expires_at=%s",
            link.pk, link.prefix, request.user.pk, link.single_use, link.expires_at,
        )
        # Attach raw_token as a transient attribute — the serializer reads it
        # once for the creation response; it is never persisted.
        link.raw_token = raw_token
        return Response(InviteLinkCreateResponseSerializer(link).data, status=status.HTTP_201_CREATED)


class AdminInviteLinkRevokeView(APIView):
    """DELETE /api/admin/invite-links/{pk}/ — revoke an invite link."""
    permission_classes = _ADMIN_PERMISSIONS

    def delete(self, request, pk):
        try:
            link = InviteLink.objects.select_related("created_by").get(pk=pk)
        except InviteLink.DoesNotExist:
            return Response({"detail": "Invite link not found."}, status=status.HTTP_404_NOT_FOUND)

        if link.revoked_at or link.used_at:
            return Response(
                {"detail": "Link is already used or revoked."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        link.revoked_at = timezone.now()
        link.save(update_fields=["revoked_at"])
        logger.info(
            "invite_link.revoked pk=%d prefix=%s revoked_by=%d",
            link.pk, link.prefix, request.user.pk,
        )
        return Response(InviteLinkSerializer(link).data)


class AdminUserDeactivateView(APIView):
    """POST /api/admin/users/{pk}/deactivate/

    Atomically deactivates a user and transfers their board ownership.
    Returns 409 with owned_boards list if the user owns boards and no
    transfers are provided — this is the signal for the UI to show the
    offboarding modal.

    Also revokes all pending invite links created by the departing user.
    """
    permission_classes = _ADMIN_PERMISSIONS

    def _validate_transfers(self, transfers, target, owned_boards):
        """Validate ownership transfer entries. Returns an error Response or None."""
        from boards.models import Board

        owned_ids = {b["id"] for b in owned_boards}
        transferred_ids = {t["board_id"] for t in transfers}
        missing = owned_ids - transferred_ids
        if missing:
            missing_names = [b["name"] for b in owned_boards if b["id"] in missing]
            return Response(
                {"detail": f"Missing transfer target for: {', '.join(missing_names)}."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Bulk-fetch all transfer targets in 2 queries rather than 2 per entry.
        transfer_user_ids = {t["transfer_to"] for t in transfers}
        transfer_board_ids = {t["board_id"] for t in transfers}
        users_by_id = {
            u.pk: u
            for u in User.objects.filter(pk__in=transfer_user_ids, is_active=True)
        }
        boards_by_id = {
            b.id: b for b in Board.objects.filter(pk__in=transfer_board_ids)
        }

        for t in transfers:
            if t["transfer_to"] == target.pk:
                return Response(
                    {"detail": "Cannot transfer board ownership to the user being deactivated."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            to_user = users_by_id.get(t["transfer_to"])
            if to_user is None:
                return Response(
                    {"detail": f"Transfer target {t['transfer_to']} not found or inactive."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            # Use get_board_role to honor group-inherited memberships, not
            # just direct BoardMembership rows.
            board_obj = boards_by_id.get(t["board_id"])
            if board_obj is None or get_board_role(to_user, board_obj) is None:
                board_name = next(
                    (b["name"] for b in owned_boards if b["id"] == t["board_id"]),
                    str(t["board_id"]),
                )
                return Response(
                    {"detail": f"Transfer target is not a member of '{board_name}'."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        # All transfers valid — execute in bulk.
        for t in transfers:
            Board.objects.filter(id=t["board_id"], owner=target).update(
                owner_id=t["transfer_to"]
            )
        return None

    @transaction.atomic
    def post(self, request, pk):
        try:
            target = User.objects.select_for_update().get(pk=pk)
        except User.DoesNotExist:
            return Response({"detail": "User not found."}, status=status.HTTP_404_NOT_FOUND)

        if target.pk == request.user.pk:
            return Response(
                {"detail": "You cannot deactivate your own account."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if not target.is_active:
            return Response(
                {"detail": "User is already inactive."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        from boards.models import Board

        owned_boards = list(Board.objects.filter(owner=target).values("id", "uid", "name"))

        serializer = DeactivateSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        transfers = serializer.validated_data.get("transfers", [])

        if owned_boards and not transfers:
            return Response(
                {
                    "code": "owned_boards",
                    "detail": "User owns boards that must be transferred before deactivation.",
                    "owned_boards": owned_boards,
                },
                status=status.HTTP_409_CONFLICT,
            )

        if owned_boards:
            error = self._validate_transfers(transfers, target, owned_boards)
            if error is not None:
                return error

        target.is_active = False
        target.save(update_fields=["is_active"])

        # Security: revoke all personal access tokens so a deactivated user
        # cannot retain API access via previously issued tokens.
        target.personal_access_tokens.all().delete()

        # Security: a departing admin's unused invite links must not remain valid.
        InviteLink.objects.filter(
            created_by=target,
            used_at__isnull=True,
            revoked_at__isnull=True,
        ).update(revoked_at=timezone.now())

        logger.info(
            "user.deactivated pk=%d deactivated_by=%d transfers=%s",
            target.pk, request.user.pk,
            [(t["board_id"], t["transfer_to"]) for t in transfers],
        )
        return Response(AdminUserSerializer(target).data)
