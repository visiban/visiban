"""Admin API views — all endpoints gated by IsSiteAdmin."""
import logging
from typing import NamedTuple
from datetime import timedelta

from django.conf import settings
from django.contrib.auth import get_user_model, password_validation
from django.core.mail import EmailMessage
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema, extend_schema_field, inline_serializer
from rest_framework import serializers as drf_serializers
from rest_framework import status
from rest_framework.throttling import UserRateThrottle
from visiban.exceptions import INVALID_QUERY_PARAM, INVALID_QUERY_PARAM_SCHEMA, CodedValidationError
from visiban.pagination import OffsetCountPagination
from visiban.request_shape import query_text
from rest_framework.response import Response
from rest_framework.views import APIView

from boards.permissions import get_board_role
from boards.serializers import AdminBoardInviteLinkSerializer
from visiban.invite_email import (
    InviteEmailBadRequestSerializer,
    InviteEmailErrorSerializer,
    InviteEmailField,
)
from .adapter import clear_login_lockout
from visiban.mail import (
    ERROR_AUTH_FAILED,
    ERROR_BACKEND_PINNED,
    ERROR_CONFIG_UNUSABLE,
    ERROR_CONNECTION_REFUSED,
    ERROR_DNS_FAILURE,
    ERROR_TIMEOUT,
    ERROR_TLS_FAILURE,
    ERROR_UNKNOWN,
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
    MAX_PENDING_EMAILED_INVITE_LINKS,
    SiteEmailSetting,
    SiteSetting,
    get_registration_mode,
    record_access_flag_changes,
    record_email_settings_changes,
    record_email_test,
    record_site_setting_changes,
    snapshot_email_setting,
    snapshot_site_setting,
)
from .invite_utils import effective_site_invite_status, live_site_invite_count, revoke_site_invite_links
from .permissions import IsSiteAdmin, IsSiteAdminReadOrSuperuserWrite, TokenHasScope
from .validators import (
    UsernameFormatValidator,
    email_collides_with_identifier,
    username_collides_with_email,
)
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


class SiteEmailSettingsResponseSerializer(drf_serializers.Serializer):
    """Read-only response shape for GET/PATCH /api/admin/email-settings/ (#1294).

    Documents exactly what ``_email_settings_payload()`` above returns — the
    writable SMTP fields plus what mail delivery is actually resolving to
    right now. Never instantiated at runtime; it exists purely so
    drf-spectacular can describe this endpoint's response instead of falling
    back to "unable to guess serializer" (``SiteEmailSettingSerializer`` above
    documents the PATCH request body, but its own ``.data`` is never what this
    view returns).
    """

    config_source = drf_serializers.ChoiceField(choices=SiteEmailSetting.ConfigSource.choices)
    host = drf_serializers.CharField()
    port = drf_serializers.IntegerField()
    username = drf_serializers.CharField()
    use_tls = drf_serializers.BooleanField()
    use_ssl = drf_serializers.BooleanField()
    from_email = drf_serializers.EmailField()
    timeout = drf_serializers.IntegerField()
    password_set = drf_serializers.BooleanField()
    password_decryptable = drf_serializers.BooleanField()
    effective_source = drf_serializers.ChoiceField(
        choices=list(SiteEmailSetting.ConfigSource.choices)
        + [("env_backend_override", "Explicit EMAIL_BACKEND override")]
    )
    effective_host = drf_serializers.CharField()
    effective_port = drf_serializers.IntegerField()
    effective_from_email = drf_serializers.CharField()
    effective_use_tls = drf_serializers.BooleanField()


class AdminEmailSettingsView(APIView):
    """GET/PATCH the singleton SiteEmailSetting row (#306).

    Reading is open to any site admin; changing it is superuser-only (#2090).
    The settings choose which server outbound mail leaves through, so a change
    is a higher-trust action than the rest of the admin surface.
    """

    permission_classes = [
        IsSiteAdminReadOrSuperuserWrite,
        MustNotHavePendingPasswordChange,
        MustNotHavePendingUsernameChange,
        TokenHasScope,
    ]

    @extend_schema(responses=SiteEmailSettingsResponseSerializer)
    def get(self, request):
        return Response(_email_settings_payload(SiteEmailSetting.get()))

    @extend_schema(request=SiteEmailSettingSerializer, responses=SiteEmailSettingsResponseSerializer)
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


ERROR_NO_RECIPIENT = "no_recipient"

# Fixed, neutral `detail` for every failure `code` the test endpoint returns
# (#1682). The response follows the 1.1 machine-error shape — a string `code`
# plus an always-present string `detail` — so `detail` is never null. It is
# deliberately constant per code rather than derived from the exception:
# smtplib error text is remote-controlled and on a rejected AUTH can echo
# base64-encoded credentials back, so nothing from the exception may reach the
# response. The single exception is `config_unusable`, whose EmailConfigUnusable
# carries one of a few fixed literals from visiban.mail (never interpolated
# from config or an exception); the entry here is its fallback.
EMAIL_TEST_ERROR_DETAILS: dict[str, str] = {
    ERROR_DNS_FAILURE: "The mail server's hostname could not be resolved. Check the host name.",
    ERROR_CONNECTION_REFUSED: "Nothing accepted a connection on the configured host and port. "
                              "Check the host, the port, and any firewall in between.",
    ERROR_TLS_FAILURE: "The secure connection to the mail server could not be established. "
                       "Check that STARTTLS or SSL matches the port.",
    ERROR_AUTH_FAILED: "The mail server rejected the username or password.",
    ERROR_TIMEOUT: "The mail server did not respond within the configured timeout.",
    ERROR_CONFIG_UNUSABLE: "The selected email configuration cannot be used to send mail. "
                           "Review Admin → Settings → Email.",
    ERROR_NO_RECIPIENT: "Your account has no email address, so there is nowhere "
                        "to send the test. Add one in your profile first.",
    ERROR_BACKEND_PINNED: "EMAIL_BACKEND is set on the server, so Visiban cannot test "
                          "the configuration below — it is not what sends mail.",
    ERROR_UNKNOWN: "The test email could not be sent. The error type is recorded in the "
                   "server log.",
}


def _email_test_failure(code: str, detail: str | None = None) -> Response:
    """Build the 400 failure envelope: ``{success: false, code, detail}``.

    ``detail`` falls back to the fixed per-code message, and an unrecognized
    code falls back to the ``unknown`` message, so ``detail`` is always a
    non-empty string and never exception text.
    """
    if not detail:
        detail = EMAIL_TEST_ERROR_DETAILS.get(code, EMAIL_TEST_ERROR_DETAILS[ERROR_UNKNOWN])
    return Response(
        {"success": False, "code": code, "detail": detail},
        status=status.HTTP_400_BAD_REQUEST,
    )


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

    # `code` is a CharField, not an enum: the taxonomy may grow in any minor
    # release and clients are told to treat an unrecognized code as `unknown`,
    # so an enum would make a new code a schema violation (#1682).
    @extend_schema(
        request=None,
        responses={
            200: inline_serializer(
                name="AdminEmailTestSuccess",
                fields={
                    "success": drf_serializers.BooleanField(),
                    "code": drf_serializers.CharField(allow_null=True),
                    "sent_to": drf_serializers.CharField(),
                },
            ),
            400: inline_serializer(
                name="AdminEmailTestFailure",
                fields={
                    "success": drf_serializers.BooleanField(),
                    "code": drf_serializers.CharField(
                        help_text="One of: " + ", ".join(EMAIL_TEST_ERROR_DETAILS) + ". "
                                  "Treat an unrecognized value as `unknown`.",
                    ),
                    "detail": drf_serializers.CharField(
                        help_text="Fixed, neutral message for the code; never SMTP error text.",
                    ),
                },
            ),
        },
    )
    def post(self, request):
        recipient = (request.user.email or "").strip()
        if not recipient:
            return _email_test_failure(ERROR_NO_RECIPIENT)

        # An operator who pinned EMAIL_BACKEND has opted out of both sources, so
        # opening an SMTP connection to the resolved host:port would test a path
        # that carries no production mail and report a green check for the wrong
        # thing — while still making an outbound connection on an install that
        # deliberately opted out of this feature.
        if getattr(settings, "EMAIL_BACKEND_EXPLICIT", False):
            return _email_test_failure(ERROR_BACKEND_PINNED)

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
            # EmailConfigUnusable.detail is always one of visiban.mail's fixed
            # operator-facing literals; every other exception gets the fixed
            # per-code message and its text is discarded.
            detail = exc.detail if isinstance(exc, EmailConfigUnusable) else None
            return _email_test_failure(code, detail)

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

    @extend_schema_field(OwnedBoardSummarySerializer(many=True))
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
            "is_superuser",
            "must_change_password",
            "has_completed_tour",
            "date_joined",
            "owned_boards",
        ]
        # ``is_superuser`` is exposed read-only so the admin users page can
        # leave out actions the API refuses for a superuser (clearing
        # ``is_site_admin`` or ``can_access_all_content``, both implied by
        # superuser status). It is changed only through the Django admin.
        read_only_fields = ["id", "is_superuser", "date_joined", "owned_boards"]


class AdminCreateUserSerializer(drf_serializers.Serializer):
    """Validates the payload for admin-created accounts."""
    username = drf_serializers.CharField(max_length=150, validators=[UsernameFormatValidator()])
    email = drf_serializers.EmailField()
    password = drf_serializers.CharField(min_length=settings.PASSWORD_MIN_LENGTH, write_only=True)
    force_password_reset = drf_serializers.BooleanField(default=True)

    # #1221: admin-created accounts get the same username/email cross-check as
    # self-service signup. A site admin is trusted, so this isn't about abuse —
    # it stops an operator from accidentally creating an account that switches
    # off an existing user's email login (see accounts.validators). Unlike the
    # self-service paths, the messages say what clashed: site admins can
    # already list every account's username and email, so there is nothing
    # to hide from them, and a precise message saves a support round trip.

    def validate_username(self, value):
        if User.objects.filter(username__iexact=value).exists():
            raise drf_serializers.ValidationError("A user with that username already exists.")
        if username_collides_with_email(value):
            raise drf_serializers.ValidationError("That username is another user's email address.")
        return value

    def validate_email(self, value):
        if User.objects.filter(email=value).exists():
            raise drf_serializers.ValidationError("A user with that email already exists.")
        if email_collides_with_identifier(value):
            raise drf_serializers.ValidationError(
                "That email address is already another user's username or email."
            )
        return value

    def validate_password(self, value):
        password_validation.validate_password(value)
        return value


SUPERUSER_SITE_ADMIN_MESSAGE = (
    "Cannot remove site admin from a superuser; remove superuser status first."
)

SUPERUSER_ALL_CONTENT_MESSAGE = (
    "Cannot remove all-content access from a superuser; remove superuser status first."
)


ALL_CONTENT_GRANT_MESSAGE = "Only a superuser can grant all-content access."


class AdminPatchUserSerializer(drf_serializers.Serializer):
    """Validates partial updates allowed by site admins."""
    is_active = drf_serializers.BooleanField(required=False)
    is_site_admin = drf_serializers.BooleanField(required=False)
    can_access_all_content = drf_serializers.BooleanField(required=False)
    must_change_password = drf_serializers.BooleanField(required=False)
    has_completed_tour = drf_serializers.BooleanField(required=False)

    def validate_is_site_admin(self, value):
        """Refuse to clear site admin on a superuser (#1597).

        Superuser status implies site admin (``accounts/signals.py``
        ``ensure_superuser_is_site_admin``), so the flag cannot be cleared
        while ``is_superuser`` is set. The view passes the target in context.
        """
        target = self.context.get("target")
        if not value and target is not None and target.is_superuser:
            raise drf_serializers.ValidationError(SUPERUSER_SITE_ADMIN_MESSAGE)
        return value

    def validate_can_access_all_content(self, value):
        """Refuse to clear all-content access on a superuser (#1614).

        Superuser status implies this flag as well as site admin
        (``accounts/signals.py`` ``ensure_superuser_is_site_admin``), so it
        cannot be cleared while ``is_superuser`` is set; the same rule and
        context as ``validate_is_site_admin`` (#1597).
        """
        target = self.context.get("target")
        if not value and target is not None and target.is_superuser:
            raise drf_serializers.ValidationError(SUPERUSER_ALL_CONTENT_MESSAGE)
        return value


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
    # "link" (copied and shared by an admin) or "email" (sent by the send
    # endpoint, #731). Additive.
    delivery = drf_serializers.CharField(read_only=True)

    def get_status(self, obj) -> str:
        # The value redemption would act on: a pending link whose creator may
        # no longer admit accounts reports "revoked" (no new status value).
        return effective_site_invite_status(obj, self.context.get("creator_memo"))

    def get_created_by_username(self, obj) -> str | None:
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


class InviteLinkEmailSerializer(drf_serializers.Serializer):
    """Validates the payload for emailing a site invite link (#731).

    ``expires_in_days`` takes the same choices as link creation minus "never":
    an emailed link is a live credential in a third party's inbox and must age
    out on its own. No free-text message field, by design.
    """
    email = InviteEmailField()
    expires_in_days = drf_serializers.ChoiceField(
        choices=InviteLink.VALID_TTL_DAYS, required=False, default=7,
    )


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


class AdminBoardInvitePagination(OffsetCountPagination):
    # Same envelope and bounds as the Users list: emailed invites alone can
    # reach 50 per board, so the cross-board list is unbounded without it.
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

    @extend_schema(responses=SiteSettingSerializer)
    def get(self, request):
        setting = SiteSetting.get()
        return Response(SiteSettingSerializer(setting).data)

    @extend_schema(request=SiteSettingSerializer, responses=SiteSettingSerializer)
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

    @extend_schema(
        operation_id="api_v1_admin_action_log_list",
        parameters=[
            OpenApiParameter(
                "action", str, enum=list(AdminActionLog.Action.values), required=False,
                description="Only rows with this action.",
            ),
            OpenApiParameter(
                "offset", int, required=False,
                description="Zero-based row offset (default 0).",
            ),
            OpenApiParameter(
                "page_size", int, required=False,
                description=(
                    f"Rows per page (default {AdminActionLogPagination.default_limit}, "
                    f"max {AdminActionLogPagination.max_limit})."
                ),
            ),
        ],
        responses={
            200: inline_serializer(
                name="AdminActionLogList",
                fields={
                    "count": drf_serializers.IntegerField(),
                    "offset": drf_serializers.IntegerField(),
                    "page_size": drf_serializers.IntegerField(),
                    "results": AdminActionLogSerializer(many=True),
                },
            ),
            400: OpenApiResponse(
                description='Unknown `action` (`{"detail": ..., "code": "invalid_query_param"}`).',
                response=INVALID_QUERY_PARAM_SCHEMA,
            ),
        },
    )
    def get(self, request):
        qs = AdminActionLog.objects.all()

        # Validated against the enum at the boundary rather than passed to the
        # ORM as-is: an unknown value is a caller error worth a 400, not a
        # silently empty page that reads like "nothing ever happened". The
        # body is the API's bad-query-param shape (#1832); this endpoint is
        # new in 1.2, so its field-keyed body appeared only in 1.2
        # pre-releases, never in a GA.
        action = request.query_params.get("action", "").strip()
        if action:
            if action not in AdminActionLog.Action.values:
                raise CodedValidationError(INVALID_QUERY_PARAM, f"'{action}' is not a valid action.")
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

    @extend_schema(
        # An APIView pages by hand, so no paginator publishes these (#1975).
        parameters=[
            OpenApiParameter(
                "search", str, required=False,
                description="Filter by username, display name, or email (partial, case-insensitive).",
            ),
            OpenApiParameter(
                "offset", int, required=False,
                description="Zero-based row offset (default 0).",
            ),
            OpenApiParameter(
                "page_size", int, required=False,
                description=(
                    f"Rows per page (default {AdminUserPagination.default_limit}, "
                    f"max {AdminUserPagination.max_limit})."
                ),
            ),
        ],
        responses={
            200: inline_serializer(
                name="AdminUserList",
                fields={
                    "count": drf_serializers.IntegerField(),
                    "offset": drf_serializers.IntegerField(),
                    "page_size": drf_serializers.IntegerField(),
                    "results": AdminUserSerializer(many=True),
                },
            ),
            400: OpenApiResponse(
                description=(
                    '`search` contains a NUL (0x00) character (`{"detail": ..., '
                    '"code": "invalid_query_param"}`).'
                ),
                response=INVALID_QUERY_PARAM_SCHEMA,
            ),
        },
    )
    def get(self, request):
        qs = User.objects.all().order_by("username")
        search = query_text(request, "search").strip()
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

    @extend_schema(request=AdminCreateUserSerializer, responses={201: AdminUserSerializer})
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
        # Inside this view's transaction, so a failed log write creates no
        # account. Only id and username are stored, never the password.
        AdminActionLog.record(
            action=AdminActionLog.Action.USER_PASSWORD_SET,
            source=AdminActionLog.Source.ADMIN_API,
            actor=request.user,
            metadata={"target_id": user.pk, "target_username": user.username},
        )

        return Response(AdminUserSerializer(user).data, status=status.HTTP_201_CREATED)


def lock_user_row(pk):
    """Return the stored user row, locked until the surrounding transaction ends.

    Callers read the "before" state of an access change through this so a
    concurrent change cannot slip between the read and the save (#1563).

    The lock is ``FOR NO KEY UPDATE``, the mode the deactivate endpoint takes.
    A plain ``FOR UPDATE`` also conflicts with ``FOR KEY SHARE``, which
    PostgreSQL takes on the creator's row when it checks the foreign key of an
    invite link row written by a join. A deactivation holds this lock while it
    revokes the user's invite links (waiting on the link rows), so a join that
    already holds a link row and then needs ``KEY SHARE`` on the same creator
    row would deadlock with it. ``NO KEY UPDATE`` does not conflict with
    ``KEY SHARE`` and still conflicts with itself and with ``FOR UPDATE``, so
    concurrent access changes of one user (and the group admin-minimum guard,
    #1814) still queue. It is sufficient because no caller changes the primary
    key or any unique key a foreign key can reference: they write only
    ``is_active``, ``is_site_admin``, ``can_access_all_content``,
    ``must_change_password`` and ``has_completed_tour``.
    """
    return User.objects.select_for_update(no_key=True).get(pk=pk)


def access_state(user):
    """The fields :func:`apply_access_loss_revocations` compares, from *user*."""
    return {
        "is_active": user.is_active,
        "is_site_admin": user.is_site_admin,
        "can_access_all_content": user.can_access_all_content,
    }


def apply_access_loss_revocations(target, actor, prior):
    """Revoke what a user's lost access should take with it (#1510, #1563).

    *prior* holds the stored ``is_active``, ``is_site_admin`` and
    ``can_access_all_content`` values from before the change; *target* holds
    the saved values. Shared by ``AdminUserDetailView.patch`` and the Django
    admin user form so the routes cannot drift apart. ``set_site_admin --revoke`` shares the
    locked read (:func:`lock_user_row`) but revokes unconditionally. Call inside the
    transaction that saves the change.
    """
    if prior["is_active"] and not target.is_active:
        # Deactivating must revoke the user's invite links exactly like the
        # dedicated deactivate endpoint (#1510): they were refused at
        # preview/join already, but stayed is_active=True in the admin lists
        # and kept counting toward the per-group active-link cap.
        AdminUserDeactivateView._revoke_invite_links(target, actor)
        return
    if (prior["is_site_admin"] and not target.is_site_admin) or (
        prior["can_access_all_content"] and not target.can_access_all_content
    ):
        # can_access_all_content is what makes the account a site admin on
        # every board; share links it enabled through that role end with it
        # (#1865). Standing is re-derived per board, so a link on a board the
        # account still administers by membership or ownership is kept.
        from boards.services.share_links import revoke_lapsed_share_links
        revoke_lapsed_share_links(enabler=target)
    if prior["is_site_admin"] and not target.is_site_admin:
        # Only an active site admin may admit accounts through a site invite
        # (registry Rule 2). Redemption re-checks the creator regardless;
        # revoking here also takes the links off the admin list and the
        # active-link cap.
        revoke_site_invite_links(target)
    if (
        target.is_active
        and prior["can_access_all_content"]
        and not target.can_access_all_content
    ):
        # can_access_all_content is the only flag that confers group-admin
        # rights (_require_group_admin; is_site_admin is admin-panel access
        # only): links held only through it lapse (links where the user is
        # still a group admin by membership are kept).
        from groups.views import _revoke_lapsed_admin_invite_links
        _revoke_lapsed_admin_invite_links(target)


class GuardRefusal(NamedTuple):
    """A refused account change: the HTTP status and body the admin API returns."""

    status: int
    body: dict


def last_active_site_admin(target):
    """True when *target* is the only active site admin left (nobody else could take over)."""
    return not User.objects.filter(is_site_admin=True, is_active=True).exclude(pk=target.pk).exists()


def deactivation_refusal(target, actor, *, include_last_site_admin=False):
    """The one rule set for deactivating *target* by *actor*, or ``None`` if allowed.

    Shared by ``AdminUserDetailView.patch`` and the Django admin user form
    (``accounts/admin.py``) so the two routes cannot drift apart (#1577). The
    API's refusals (status and body) are returned unchanged: an actor may not
    deactivate their own account, and a board owner is not deactivated here
    because the ownership transfers belong to the dedicated deactivate
    endpoint. ``include_last_site_admin`` adds the last-active-site-admin
    refusal, which the Django admin form applies to every actor.
    """
    if target.pk == actor.pk:
        return GuardRefusal(
            status.HTTP_400_BAD_REQUEST,
            {"detail": "You cannot deactivate your own account."},
        )
    from boards.models import Board

    owned = list(Board.objects.filter(owner=target).values("id", "uid", "name"))
    if owned:
        return GuardRefusal(
            status.HTTP_409_CONFLICT,
            {
                "code": "owned_boards",
                "detail": "User owns boards that must be transferred before deactivation.",
                "owned_boards": owned,
            },
        )
    if include_last_site_admin and target.is_site_admin and last_active_site_admin(target):
        return GuardRefusal(
            status.HTTP_400_BAD_REQUEST,
            {"detail": "Cannot deactivate the last active site admin."},
        )
    return None


SUPERUSER_ONLY_CHANGE_MESSAGE = (
    "Only a superuser can change a superuser account's activation, "
    "all-content access or password-change requirement."
)


SUPERUSER_ONLY_LOCKOUT_MESSAGE = (
    "Only a superuser can clear the sign-in lockout on a superuser account."
)


def superuser_target_refusal(target, actor, *, message=SUPERUSER_ONLY_CHANGE_MESSAGE):
    """Refusal when a non-superuser *actor* changes a superuser *target*'s standing.

    A site admin who is not a superuser administers ordinary accounts; a
    superuser's activation, all-content access and forced-password-change
    flag stay with superusers. The callers decide which requested change
    this applies to.
    """
    if target.is_superuser and not actor.is_superuser:
        return GuardRefusal(
            status.HTTP_400_BAD_REQUEST, {"detail": message}
        )
    return None


def demotion_refusal(target, actor):
    """Refusal for removing superuser status from *target* by *actor*, or ``None``.

    Used by the Django admin user form for every actor. Removing superuser
    status also removes site-admin access (``accounts/signals.py``), so the
    refusals mirror the site-admin demotion rules: an actor may not remove
    their own status, and the last active superuser (or last active site
    admin) is kept so that at least one account can always administer the
    instance. *target* is the stored row; callers check the transition first.
    """
    if target.pk == actor.pk:
        return GuardRefusal(
            status.HTTP_400_BAD_REQUEST,
            {"detail": "You cannot remove your own superuser status."},
        )
    if target.is_active:
        other_superusers = User.objects.filter(is_superuser=True, is_active=True).exclude(pk=target.pk)
        if not other_superusers.exists():
            return GuardRefusal(
                status.HTTP_400_BAD_REQUEST,
                {"detail": "Cannot remove superuser status from the last active superuser."},
            )
        if target.is_site_admin and last_active_site_admin(target):
            return GuardRefusal(
                status.HTTP_400_BAD_REQUEST,
                {"detail": "Cannot demote the last active site admin."},
            )
    return None


class AdminUserDetailView(APIView):
    """PATCH /api/admin/users/{id}/ — update is_active, is_site_admin, must_change_password."""
    permission_classes = _ADMIN_PERMISSIONS

    def _get_user_or_404(self, pk):
        try:
            return User.objects.get(pk=pk)
        except User.DoesNotExist:
            return None

    @extend_schema(request=AdminPatchUserSerializer, responses=AdminUserSerializer)
    def patch(self, request, pk):
        target = self._get_user_or_404(pk)
        if target is None:
            return Response({"detail": "User not found."}, status=status.HTTP_404_NOT_FOUND)

        serializer = AdminPatchUserSerializer(
            data=request.data, partial=True, context={"target": target}
        )
        if not serializer.is_valid():
            errors = dict(serializer.errors)
            # The admin UI reads ``detail``; carry the refusal reason there too.
            if SUPERUSER_SITE_ADMIN_MESSAGE in [str(e) for e in errors.get("is_site_admin", [])]:
                errors["detail"] = SUPERUSER_SITE_ADMIN_MESSAGE
            elif SUPERUSER_ALL_CONTENT_MESSAGE in [
                str(e) for e in errors.get("can_access_all_content", [])
            ]:
                errors["detail"] = SUPERUSER_ALL_CONTENT_MESSAGE
            return Response(errors, status=status.HTTP_400_BAD_REQUEST)

        validated = serializer.validated_data
        update_fields = []

        # Guard: a superuser's activation, all-content access and
        # password-change flag are changed by superusers only.
        if (
            "is_active" in validated
            or "can_access_all_content" in validated
            or "must_change_password" in validated
        ):
            refusal = superuser_target_refusal(target, request.user)
            if refusal is not None:
                return Response(refusal.body, status=refusal.status)

        # Guard: cannot deactivate yourself, nor a board owner via PATCH (the
        # dedicated deactivate endpoint carries the ownership transfers).
        if "is_active" in validated and not validated["is_active"]:
            refusal = deactivation_refusal(target, request.user)
            if refusal is not None:
                return Response(refusal.body, status=refusal.status)

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
            # Atomic with the revocations below: a rolled-back deactivation must
            # not leave links revoked (and the on_commit broadcasts never fire).
            with transaction.atomic():
                # Also what serializes a deactivation with the group
                # admin-minimum guard (#1814): a member removal or demotion
                # holds its group's admin account rows while it counts active
                # admins (groups.services.lock_member_accounts), so this
                # waits for it, and it waits for this. The revocations below
                # lock invite and board rows, never a group row, so the lock
                # order (account rows before group rows) holds.
                locked = lock_user_row(target.pk)
                # Re-check on the locked row: the serializer saw an unlocked
                # read, and superuser status may have been granted since.
                if locked.is_superuser and validated.get("is_site_admin") is False:
                    return Response(
                        {
                            "is_site_admin": [SUPERUSER_SITE_ADMIN_MESSAGE],
                            "detail": SUPERUSER_SITE_ADMIN_MESSAGE,
                        },
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                if locked.is_superuser and validated.get("can_access_all_content") is False:
                    return Response(
                        {
                            "can_access_all_content": [SUPERUSER_ALL_CONTENT_MESSAGE],
                            "detail": SUPERUSER_ALL_CONTENT_MESSAGE,
                        },
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                if (
                    "is_active" in validated
                    or "can_access_all_content" in validated
                    or "must_change_password" in validated
                ):
                    # Same rule as above, on the locked row.
                    refusal = superuser_target_refusal(locked, request.user)
                    if refusal is not None:
                        return Response(refusal.body, status=refusal.status)
                # All-content access reads and writes every board and group,
                # which is far more than the admin panel gives. A site admin
                # who could set it would hold that access at will, on their own
                # account or on any account they create, so only a superuser
                # grants it (#1830). A site admin can still revoke it. Judged
                # on the locked row, so a value that is already set stays the
                # no-op every other unchanged field is here, and on a fresh
                # read of the actor: request.user may have lost superuser
                # status or been deactivated since it was loaded.
                if (
                    validated.get("can_access_all_content") is True
                    and not locked.can_access_all_content
                    and not User.objects.filter(
                        pk=request.user.pk, is_superuser=True, is_active=True
                    ).exists()
                ):
                    return Response(
                        {
                            "can_access_all_content": [ALL_CONTENT_GRANT_MESSAGE],
                            "detail": ALL_CONTENT_GRANT_MESSAGE,
                        },
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                prior = access_state(locked)
                # A flag this request does not change takes its value from the
                # locked row: target was read before the lock, and a stale value
                # here would read as a change that nobody made.
                for flag in ("is_site_admin", "can_access_all_content"):
                    if flag not in validated:
                        setattr(target, flag, getattr(locked, flag))
                target.save(update_fields=update_fields)
                record_access_flag_changes(
                    prior=prior,
                    target=target,
                    actor=request.user,
                    source=AdminActionLog.Source.ADMIN_API,
                )
                # Deactivating through PATCH must revoke the user's invite links
                # exactly like the dedicated deactivate endpoint (#1510): they
                # were refused at preview/join already, but stayed
                # is_active=True in the admin lists and kept counting toward
                # the per-group active-link cap.
                apply_access_loss_revocations(target, request.user, prior)

        return Response(AdminUserSerializer(target).data)


# Revoked/used/expired site invite links returned by the admin list, most
# recent first (#1966); pending links are always all returned.
SITE_INVITE_LIST_MAX_PAST = 50


class AdminInviteLinkListCreateView(APIView):
    """
    GET  /api/admin/invite-links/  — list all invite links
    POST /api/admin/invite-links/  — create a new invite link
    """
    permission_classes = _ADMIN_PERMISSIONS

    @extend_schema(responses=InviteLinkSerializer(many=True))
    def get(self, request):
        # Every pending link (bounded by the active-link caps) plus only the
        # most recent past ones (#1966): revoked, used and expired rows are
        # never purged, so the full history grows without bound. Same shape as
        # the board invite list (``BOARD_INVITE_LIST_MAX_PAST``), and still a
        # bare array, so the response stays backward compatible. "Pending"
        # mirrors ``InviteLink.status`` on the stored fields; the computed
        # creator-standing check stays in the serializer.
        now = timezone.now()
        base = InviteLink.objects.select_related("created_by")
        pending_q = Q(revoked_at__isnull=True, used_at__isnull=True) & (
            Q(expires_at__isnull=True) | Q(expires_at__gte=now)
        )
        pending = list(base.filter(pending_q).order_by("-created_at", "-pk"))
        past = list(base.exclude(pending_q).order_by("-created_at", "-pk")[:SITE_INVITE_LIST_MAX_PAST])
        links = sorted(pending + past, key=lambda link: (link.created_at, link.pk), reverse=True)
        return Response(InviteLinkSerializer(links, many=True, context={"creator_memo": {}}).data)

    @extend_schema(request=InviteLinkCreateSerializer, responses={201: InviteLinkCreateResponseSerializer})
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
        # Emailed links (#731) are excluded — they have their own cap in
        # AdminInviteLinkSendView so emailed invites never crowd out the
        # admin's shareable links.
        # A link whose creator may no longer admit accounts does not hold a slot.
        active_count = live_site_invite_count(delivery=InviteLink.Delivery.LINK)
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


class AdminInviteLinkSendView(APIView):
    """POST /api/v1/admin/invite-links/send/ — email a single-use invite (#731).

    Unlike the group endpoint this one may say whether the address already has
    an account (``already_registered``): only site admins can call it, and they
    can already list every user and email address in the admin panel, so it
    reveals nothing new. The mail is still sent either way. The raw token only
    travels in the email and is never returned.
    """
    permission_classes = _ADMIN_PERMISSIONS

    @extend_schema(
        request=InviteLinkEmailSerializer,
        responses={
            202: inline_serializer(
                name="AdminInviteEmailSent",
                fields={
                    "detail": drf_serializers.CharField(),
                    "sent_to": drf_serializers.CharField(),
                    "already_registered": drf_serializers.BooleanField(),
                    "delivery": drf_serializers.CharField(required=False),
                },
            ),
            400: InviteEmailBadRequestSerializer,
            403: InviteEmailErrorSerializer,
            502: InviteEmailErrorSerializer,
        },
    )
    def post(self, request):
        from visiban import invite_email

        if not invite_email.invite_email_enabled():
            return Response(
                {
                    "code": invite_email.CODE_INVITE_EMAIL_DISABLED,
                    "detail": "Sending invites by email is disabled on this instance.",
                },
                status=status.HTTP_403_FORBIDDEN,
            )

        serializer = InviteLinkEmailSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        data = serializer.validated_data

        with transaction.atomic():
            # Same row lock as link creation, so concurrent sends cannot both
            # read a count below the emailed cap and overshoot it.
            SiteSetting.objects.get_or_create(pk=1)
            SiteSetting.objects.select_for_update().get(pk=1)
            pending_emailed = live_site_invite_count(delivery=InviteLink.Delivery.EMAIL)
            if pending_emailed >= MAX_PENDING_EMAILED_INVITE_LINKS:
                return Response(
                    {
                        "code": "invite_email_cap_reached",
                        "detail": (
                            f"Maximum pending emailed invites ({MAX_PENDING_EMAILED_INVITE_LINKS}) "
                            "reached. Revoke some or wait for them to expire."
                        ),
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )
            # Throttles after the cap check so a refused request spends no
            # budget; the site endpoint has its own instance-wide ceiling that
            # group admins cannot drain (see InviteEmailGlobalSiteThrottle).
            recorded_throttles = invite_email.check_send_throttles(request, self, site=True)
            link, raw_token = InviteLink.generate(
                created_by=request.user,
                expires_at=timezone.now() + timedelta(days=int(data["expires_in_days"])),
                single_use=True,
                delivery=InviteLink.Delivery.EMAIL,
                recipient_email=data["email"],
            )
            logger.info(
                "invite_link.created pk=%d prefix=%s created_by=%d single_use=%s delivery=email",
                link.pk, link.prefix, request.user.pk, link.single_use,
            )

        # After commit: the SiteSetting row lock must not be held across an
        # SMTP session (see visiban/invite_email.py).
        message = invite_email.build_site_invite_message(
            inviter_name=request.user.username,
            raw_token=raw_token,
            expires_at=link.expires_at,
            to=data["email"],
        )
        error_code = invite_email.send_invite_message(
            message, link_pk=link.pk, prefix=link.prefix, actor_id=request.user.pk, kind="site",
        )
        if error_code is not None:
            invite_email.refund_send_throttles(recorded_throttles)
            InviteLink.objects.filter(pk=link.pk, revoked_at__isnull=True).update(
                revoked_at=timezone.now()
            )
            logger.info(
                "invite_link.revoked pk=%d prefix=%s revoked_by=%d reason=email_failed",
                link.pk, link.prefix, request.user.pk,
            )
            return Response(
                {
                    "code": error_code,
                    "detail": "The invite email could not be sent. The link was revoked.",
                },
                status=status.HTTP_502_BAD_GATEWAY,
            )

        normalized = invite_email.normalize_invite_email(data["email"])
        body = {
            "detail": "Invite sent",
            "sent_to": data["email"],
            "already_registered": User.objects.filter(email__iexact=normalized).exists(),
        }
        if invite_email.delivers_to_console():
            body["delivery"] = "console"
        return Response(body, status=status.HTTP_202_ACCEPTED)


class AdminInviteLinkRevokeView(APIView):
    """DELETE /api/admin/invite-links/{pk}/ — revoke an invite link.

    Deliberately NOT aligned with the rest of the revoke family (board-scoped,
    group-scoped and ``admin/board-invite-links``: 204 / 404 on a repeat / 400
    on a used link). This route has answered 200 with the revoked link and 400
    on a repeat revoke since 1.1, and changing a shipped status code is a
    breaking change for 1.x clients, so the divergence is permanent for 1.x
    (#1912, decided over #1867). drf-spectacular defaults a DELETE to 204, so
    the real responses are declared explicitly to keep the schema honest.
    """
    permission_classes = _ADMIN_PERMISSIONS

    @extend_schema(
        responses={
            200: InviteLinkSerializer,
            400: inline_serializer(
                name="AdminInviteLinkRevokeRefused", fields={"detail": drf_serializers.CharField()},
            ),
            404: inline_serializer(
                name="AdminInviteLinkNotFound", fields={"detail": drf_serializers.CharField()},
            ),
        },
    )
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


#: ``?status=`` values for the board-invite list (#439). Each is the ORM form of
#: ``BoardInviteLink.status`` — revoked > used > expired > pending — so a row is
#: listed under exactly the status its serialized ``status`` reports, and
#: offset pagination counts the same rows it returns.
BOARD_INVITE_STATUS_FILTERS = ("pending", "used", "expired", "revoked", "all")


def _board_invite_status_q(value, now):
    not_revoked = Q(revoked_at__isnull=True)
    unused = Q(used_at__isnull=True)
    if value == "revoked":
        return Q(revoked_at__isnull=False)
    if value == "used":
        return not_revoked & Q(used_at__isnull=False)
    if value == "expired":
        return not_revoked & unused & Q(expires_at__isnull=False, expires_at__lt=now)
    if value == "pending":
        return not_revoked & unused & (Q(expires_at__isnull=True) | Q(expires_at__gte=now))
    return Q()


class AdminBoardInviteLinkListView(APIView):
    """GET /api/v1/admin/board-invite-links/ — every board's invites (#439).

    Site-admin oversight across all boards, emailed invites and shareable
    links alike. ``?status=pending|used|expired|revoked|all`` (default
    ``pending``) filters in the ORM with the model's status precedence, then
    ``offset``/``page_size`` paginate with ``count`` like the Users list.
    """

    permission_classes = _ADMIN_PERMISSIONS
    pagination_class = AdminBoardInvitePagination

    @extend_schema(
        operation_id="api_v1_admin_board_invite_links_list",
        parameters=[
            OpenApiParameter(
                "status", str, enum=list(BOARD_INVITE_STATUS_FILTERS), required=False,
                description="Filter by status (default pending).",
            ),
            OpenApiParameter(
                "offset", int, required=False,
                description="Zero-based row offset (default 0).",
            ),
            OpenApiParameter(
                "page_size", int, required=False,
                description=(
                    f"Rows per page (default {AdminBoardInvitePagination.default_limit}, "
                    f"max {AdminBoardInvitePagination.max_limit})."
                ),
            ),
        ],
        responses={
            200: inline_serializer(
                name="AdminBoardInviteLinkList",
                fields={
                    "count": drf_serializers.IntegerField(),
                    "offset": drf_serializers.IntegerField(),
                    "page_size": drf_serializers.IntegerField(),
                    "results": AdminBoardInviteLinkSerializer(many=True),
                },
            ),
            400: OpenApiResponse(
                description='Unknown `status` (`{"detail": ..., "code": "invalid_query_param"}`).',
                response=INVALID_QUERY_PARAM_SCHEMA,
            ),
        },
    )
    def get(self, request):
        from boards.models import BoardInviteLink

        value = request.query_params.get("status", "").strip() or "pending"
        # An unknown value is a caller error, not a silently empty page. The
        # body is the API's bad-query-param shape (#1832); this endpoint is
        # new in 1.2, so its field-keyed body appeared only in 1.2
        # pre-releases, never in a GA.
        if value not in BOARD_INVITE_STATUS_FILTERS:
            raise CodedValidationError(INVALID_QUERY_PARAM, f"'{value}' is not a valid status.")
        qs = (
            BoardInviteLink.objects.filter(_board_invite_status_q(value, timezone.now()))
            .select_related("board", "created_by")
            .order_by("-created_at", "-pk")
        )
        paginator = self.pagination_class()
        page = paginator.paginate_queryset(qs, request)
        context = {"registration_mode": get_registration_mode()}
        return paginator.get_paginated_response(
            AdminBoardInviteLinkSerializer(page, many=True, context=context).data
        )


class AdminBoardInviteLinkRevokeView(APIView):
    """DELETE /api/v1/admin/board-invite-links/{pk}/ — revoke any board's invite (#439).

    A site admin may revoke an invite on any board, whether or not they belong
    to it: this is the instance-wide kill switch for a leaked link. Same
    contract as the board-scoped revoke (#1867): 204 with no body on success, 400
    for a consumed invite (it keeps its "used" record), and 404 for an invite
    that is unknown or already revoked (a revoked row is hidden, as there). It
    publishes the same ``invite_link.revoked`` ``{id}`` event on the board's
    channel, so a board admin with the invite list open sees it go.
    """

    permission_classes = _ADMIN_PERMISSIONS

    @extend_schema(
        responses={
            204: None,
            400: inline_serializer(
                name="AdminBoardInviteRevokeRefused", fields={"detail": drf_serializers.CharField()},
            ),
            404: inline_serializer(
                name="AdminBoardInviteNotFound", fields={"detail": drf_serializers.CharField()},
            ),
        },
    )
    def delete(self, request, pk):
        from boards import broadcast as _board_broadcast
        from boards.models import BoardInviteLink

        with transaction.atomic():
            # Lock the bare row: PostgreSQL refuses FOR UPDATE on the nullable
            # side of the outer join select_related("created_by") would add.
            # A revoked row is hidden (404), matching the board-scoped revoke.
            link = BoardInviteLink.objects.select_for_update().filter(pk=pk, revoked_at__isnull=True).first()
            if link is None:
                return Response({"detail": "Invite not found."}, status=status.HTTP_404_NOT_FOUND)
            # Revoking a consumed invite would flip "used" to "revoked" and lose
            # the record that it was redeemed.
            if link.used_at is not None:
                return Response(
                    {"detail": "This invite has already been used and cannot be revoked."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            link.revoked_at = timezone.now()
            link.revoked_by = request.user
            link.save(update_fields=["revoked_at", "revoked_by"])
            # Minimal {id}, like the board-scoped revoke: non-admin
            # subscribers receive it too, so clients refetch the list.
            _board_broadcast.record_board_event(
                link.board_id, _board_broadcast.EVT_INVITE_LINK_REVOKED, {"id": link.pk},
                actor_id=request.user.pk,
            )
        logger.info(
            "board_invite.revoked pk=%d prefix=%s board_id=%d revoked_by=%d via=admin",
            link.pk, link.prefix, link.board_id, request.user.pk,
        )
        return Response(status=status.HTTP_204_NO_CONTENT)


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

        # All transfers valid — execute in bulk. In board pk order, the order
        # every multi-board lock takes (#1632).
        for t in sorted(transfers, key=lambda t: t["board_id"]):
            Board.objects.filter(id=t["board_id"], owner=target).update(
                owner_id=t["transfer_to"]
            )
        return None

    @extend_schema(request=DeactivateSerializer, responses=AdminUserSerializer)
    @transaction.atomic
    def post(self, request, pk):
        try:
            # FOR NO KEY UPDATE, not FOR UPDATE (#1632), as the user admin
            # delete locks its targets (#1616). A card write by this user holds
            # its board row FOR SHARE and needs FOR KEY SHARE on this row at
            # COMMIT (its activity, created_by and assignee foreign keys).
            # FOR UPDATE blocks that, while the owner transfer below UPDATEs
            # the board row and so waits on the card write's FOR SHARE: a
            # deadlock. FOR NO KEY UPDATE still serializes concurrent
            # deactivations and access changes of this user (it conflicts
            # with itself and with FOR UPDATE) and is the mode the is_active
            # UPDATE takes anyway. It is also what serializes a deactivation
            # with the group admin-minimum guard, which holds the group's
            # admin account rows while it counts active admins (#1814).
            target = User.objects.select_for_update(no_key=True).get(pk=pk)
        except User.DoesNotExist:
            return Response({"detail": "User not found."}, status=status.HTTP_404_NOT_FOUND)

        if target.pk == request.user.pk:
            return Response(
                {"detail": "You cannot deactivate your own account."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        refusal = superuser_target_refusal(target, request.user)
        if refusal is not None:
            return Response(refusal.body, status=refusal.status)

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

        self._revoke_invite_links(target, request.user)

        logger.info(
            "user.deactivated pk=%d deactivated_by=%d transfers=%s",
            target.pk, request.user.pk,
            [(t["board_id"], t["transfer_to"]) for t in transfers],
        )
        return Response(AdminUserSerializer(target).data)


    @classmethod
    def _revoke_invite_links(cls, target, actor):
        """Delete the user's PATs and DRF auth token, revoke every pending site, board and group invite they created, and clear the share links they enabled.

        Shared by the deactivate endpoint and ``PATCH is_active=false`` (#1510)
        so the two deactivation paths cannot drift apart.
        """
        # Security: revoke all personal access tokens so a deactivated user
        # cannot retain API access via previously issued tokens — and cannot
        # get them back on reactivation.
        target.personal_access_tokens.all().delete()
        # The DRF auth Token is revoked on the same terms: it never expires, so
        # reactivation must not bring a previously issued key back.
        from .credentials import revoke_auth_token

        revoke_auth_token(target)

        # Security: a departing admin's unused invite links must not remain valid.
        revoke_site_invite_links(target)

        # Same for the board invites they sent (#1444): a deactivated sender's
        # pending invites must stop working, not merely fail the sender
        # re-check at redemption. Each revocation is announced on its board so
        # an admin with the invite list open sees it go.
        cls._revoke_pending_board_invites(target, actor)

        # And their group invite links (#1490), announced on each group channel.
        cls._revoke_group_invite_links(target)

        # And the public share links they enabled (#1865), announced on each
        # board channel.
        from boards.services.share_links import revoke_lapsed_share_links
        revoke_lapsed_share_links(enabler=target)

    @staticmethod
    def _revoke_group_invite_links(target):
        from django.db import transaction as _transaction

        from groups import broadcast as _group_broadcast
        from groups.models import GroupInviteLink

        with _transaction.atomic():
            active = list(
                GroupInviteLink.objects.select_for_update().filter(
                    created_by=target, is_active=True, used_at__isnull=True,
                ).values_list("pk", "group_id")
            )
            if not active:
                return
            # used_at__isnull=True: a consumed single-use link stays "used" —
            # revoking it would erase that history, announce a revocation that
            # changed nothing, and break the register-then-join follow-up (#1445).
            GroupInviteLink.objects.filter(
                pk__in=[pk for pk, _ in active], used_at__isnull=True,
            ).update(is_active=False)

            # Deferred so a rolled-back deactivation never announces a
            # revocation that did not happen. Bounded: a creator holds a
            # capped number of active links per group.
            def _announce():
                for link_id, group_id in active:
                    _group_broadcast.broadcast_group_event(
                        group_id, _group_broadcast.EVT_INVITE_LINK_REVOKED, {"id": link_id},
                    )

            _transaction.on_commit(_announce)

    @staticmethod
    def _revoke_pending_board_invites(target, actor):
        from django.db import transaction as _transaction

        from boards import broadcast as _board_broadcast
        from boards.models import BoardInviteLink

        now = timezone.now()
        with _transaction.atomic():
            pending = list(
                BoardInviteLink.objects.select_for_update().filter(
                    created_by=target, used_at__isnull=True, revoked_at__isnull=True,
                ).values_list("pk", "board_id")
            )
            if not pending:
                return
            BoardInviteLink.objects.filter(pk__in=[pk for pk, _ in pending]).update(
                revoked_at=now, revoked_by=actor,
            )
            # One {id} event per invite keeps the board channel's contract
            # unchanged. The loop is bounded: a board holds at most 50 pending
            # emailed invites and 5 active shareable links (#439), and this
            # runs only on the rare admin action of deactivating an account.
            for link_id, board_id in pending:
                _board_broadcast.record_board_event(
                    board_id, _board_broadcast.EVT_INVITE_LINK_REVOKED, {"id": link_id},
                    actor_id=actor.pk,
                )


class AdminUserClearLockoutView(APIView):
    """POST /api/admin/users/{pk}/clear-lockout/ — clear a user's login lockout (#1203).

    A locked-out user (5 failed attempts / 5 min, per account — #1199) has no
    way to recover before the window expires on their own; a correct password
    reset now clears this automatically (see
    ``accounts.serializers.VisibanPasswordResetConfirmSerializer``), but that
    still requires working email delivery and the user actually completing the
    flow. This gives a site admin an early-recovery lever for the case where
    neither applies — e.g. the user calls support directly.

    Idempotent: clearing an account that isn't currently locked out is a
    harmless no-op (``clear_login_lockout`` deletes cache keys that may not
    exist), so this endpoint never needs to first check lockout state.
    """

    permission_classes = _ADMIN_PERMISSIONS

    @extend_schema(request=None, responses=AdminUserSerializer)
    def post(self, request, pk):
        try:
            target = User.objects.get(pk=pk)
        except User.DoesNotExist:
            return Response({"detail": "User not found."}, status=status.HTTP_404_NOT_FOUND)

        # A superuser account's sign-in protection stays with superusers.
        refusal = superuser_target_refusal(
            target, request.user, message=SUPERUSER_ONLY_LOCKOUT_MESSAGE
        )
        if refusal is not None:
            return Response(refusal.body, status=refusal.status)

        clear_login_lockout(request, target)

        # Same user-targeted admin-action logging shape as
        # AdminUserDeactivateView above: pk-only, no username/email (CLAUDE.md
        # forbids logging PII), recorded so an incident retrospective can see
        # who cleared a lockout and when.
        logger.info(
            "user.lockout_cleared pk=%d cleared_by=%d",
            target.pk, request.user.pk,
        )

        return Response(AdminUserSerializer(target).data)
