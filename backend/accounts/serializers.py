from dj_rest_auth.registration.serializers import RegisterSerializer
from dj_rest_auth.serializers import LoginSerializer as DjRestAuthLoginSerializer
from dj_rest_auth.serializers import PasswordChangeSerializer as DjRestAuthPasswordChangeSerializer
from dj_rest_auth.serializers import PasswordResetConfirmSerializer as DjRestAuthPasswordResetConfirmSerializer
from dj_rest_auth.serializers import PasswordResetSerializer
from django.core.validators import EmailValidator
from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from .adapter import clear_login_lockout
from .models import (
    PAT_SCOPES,
    PersonalAccessToken,
    User,
    get_maintenance_message,
    get_maintenance_state,
    get_uploads_enabled,
)
from .forms import VisibanPasswordResetForm
from .validators import (
    USERNAME_TAKEN_MESSAGE,
    UsernameFormatValidator,
    is_username_taken,
    normalize_username_field_validators,
)


@extend_schema_field({
    "type": "string",
    "maxLength": 200,
})
class AvatarUrlField(serializers.CharField):
    """``avatar_url`` with the ``format: uri`` constraint dropped from its schema.

    ``User.avatar_url`` is ``models.URLField(blank=True)`` — an empty string is
    a valid "no avatar set" value, not just an absent one. A plain
    ``serializers.URLField`` mapping declares ``format: uri`` regardless of
    ``allow_blank`` (drf-spectacular derives it from the field's attached
    ``URLValidator``, independently of the ``@extend_schema_field`` override
    above — subclassing ``URLField`` and only overriding the *declared* schema
    still leaves the *validator* in place, which re-adds ``format`` from the
    other direction), which is a JSON Schema violation for `""` (schemathesis
    correctly flags it, #1120). Subclassing ``CharField`` instead avoids
    attaching that validator in the first place; avatar URLs are populated
    from OAuth providers, not hand-typed, so strict URL-syntax validation on
    write isn't load-bearing here.
    """


@extend_schema_field({
    "type": "string",
    "maxLength": 254,
    "title": "Email address",
})
class EmailOrBlankField(serializers.CharField):
    """``email`` with the ``format: email`` constraint dropped from its schema.

    ``User.email`` is Django's default ``AbstractUser.email = EmailField(blank=True)``
    — an empty string is a valid "no email on file" value (e.g. an account
    provisioned via SSO without an email claim in the token), not just an absent
    one. A plain ``serializers.EmailField`` mapping declares ``format: email``
    unconditionally (drf-spectacular maps that format from the field class
    itself, same as ``AvatarUrlField`` above), which is a JSON Schema violation
    for `""`: a PATCH to `/api/v1/auth/user/` that wrote a blank email made
    every subsequent read of that user fail schema conformance
    (backend-schema-fuzz). Subclassing ``CharField`` avoids the class-based
    format mapping.

    Unlike ``AvatarUrlField``, format validation on write is *not* dropped —
    drf-spectacular's ``_insert_field_validators`` re-derives ``format: email``
    from any ``EmailValidator`` found in ``field.validators``, independently of
    this field's declared schema, so the validator can't simply be re-attached
    here. See ``UserSerializer.validate_email`` for where it actually lives.
    """


def validate_optional_email_format(value):
    """Run Django's ``EmailValidator`` unless ``value`` is blank.

    Reused as a serializer-level ``validate_<field>`` method rather than a
    ``Field`` validator so drf-spectacular's validator-derived schema (see
    ``EmailOrBlankField`` above) never sees it and re-adds ``format: email``.
    DRF's own ``Field.run_validators`` already skips attached validators for a
    blank value when ``allow_blank=True``; this replicates that behavior
    explicitly since it runs outside that mechanism.
    """
    if value:
        EmailValidator()(value)
    return value


class RegistrationSerializer(RegisterSerializer):
    # allauth 65.x SIGNUP_FIELDS causes allauth_account_settings.USERNAME_REQUIRED
    # to return None rather than False. DRF normalises required=None to required=True
    # (Field.__init__: if required is None: required = default is empty and not read_only),
    # making username mandatory even when it is not a signup field. Override with an
    # explicit required=False so users can register with only email + passwords.
    username = serializers.CharField(
        max_length=150,
        required=False,
        validators=[UsernameFormatValidator()],
    )


class LoginSerializer(DjRestAuthLoginSerializer):
    """Authenticate through allauth's adapter instead of bare Django auth (#1199).

    dj-rest-auth's own ``authenticate()`` calls ``django.contrib.auth.authenticate()``
    directly. That bypasses ``allauth.account.adapter.DefaultAccountAdapter
    .pre_authenticate()`` — the only place ``ACCOUNT_RATE_LIMITS["login_failed"]`` is
    ever consumed — so the per-account lockout allauth is configured for never
    actually engaged on this endpoint (the SPA/API login path every real client
    uses). Only the coarser, per-IP ``LoginRateThrottle`` (#924) applied, which does
    nothing against a distributed attacker spreading failed attempts across many
    source IPs at one target account.

    Routing through ``get_adapter(request).authenticate()`` instead reuses allauth's
    own pre_authenticate -> authenticate -> rollback-on-success sequence, so this
    view now shares the same per-account bucket allauth's own login views consume.
    The adapter still ultimately calls Django's ``authenticate()`` for the actual
    credential check, so the credential check is whatever ``AUTHENTICATION_BACKENDS``
    says — since #1206 that is ``ModelBackend`` plus ``accounts.backends.EmailBackend``,
    so the ``username`` field accepts a username or an email address. The
    per-account lockout key is resolved to the account itself (see
    ``accounts.adapter.RegistrationAdapter._get_login_attempts_cache_key``), so
    failures by username and by email accumulate into one lockout.

    On lockout, ``pre_authenticate()`` raises ``django.core.exceptions.
    ValidationError`` (code ``too_many_login_attempts``) *before* the password is
    checked at all, with allauth's own generic "too many attempts" message -- it
    never reveals whether the account exists, and the account/email used as the
    rate-limit key is SHA-256-hashed by allauth before it ever reaches the cache,
    so nothing PII-bearing is logged. DRF's default field validation converts that
    Django-style ``ValidationError`` into a plain 400 response automatically, same
    as any other login validation failure.

    Demo-mode carve-out (#1199 gate finding): when ``DEMO_MODE`` is on, the demo
    login page publishes ``DEMO_LOGIN_USERNAME``'s password to every visitor
    (that publication is the whole point of a public demo — see
    visiban/settings.py's "Hosted demo mode" block). A per-account lockout on a
    published credential protects nothing — everyone already has the password —
    and instead becomes a trivial, repeatable DoS lever: any anonymous visitor
    can send 5 wrong passwords for that one shared username and lock out every
    other visitor for 5 minutes, indefinitely. So for that one identifier only,
    ``authenticate()`` skips the allauth adapter (and its per-account
    ``login_failed`` consult) and falls back to plain Django ``authenticate()``.
    The per-IP ``LoginRateThrottle`` (#924) still applies regardless, and every
    other account on a demo instance — including any real user accounts — keeps
    the full per-account lockout.
    """

    def authenticate(self, **kwargs):
        from allauth.account.adapter import get_adapter
        from django.conf import settings
        from django.contrib.auth import authenticate as django_authenticate

        request = self.context["request"]
        if settings.DEMO_MODE and self._is_demo_account(kwargs, request):
            return django_authenticate(request, **kwargs)
        return get_adapter(request).authenticate(request, **kwargs)

    @staticmethod
    def _is_demo_account(credentials, request=None):
        """Whether these credentials target the published demo account.

        Mirrors the identifier-precedence order (email over username) that
        ``RegistrationAdapter._get_login_attempts_cache_key`` (#1206) uses to
        *resolve* which account a login attempt is against — the lockout
        itself now keys on that resolved account's pk, not on the identifier
        string, but this carve-out only needs to know which credentials name
        the demo account, so it reuses the same resolution order — plus a
        strip, since a demo visitor pasting the published credential is more
        likely to pick up incidental whitespace than a real login attempt.
        """
        from django.conf import settings

        from .backends import resolve_login_user

        demo_username = settings.DEMO_LOGIN_USERNAME.strip().lower()
        if not demo_username:
            return False
        identifier = credentials.get("email", credentials.get("username", "")) or ""
        if identifier.strip().lower() == demo_username:
            return True
        # #1206: the demo account can also be named by its email address. The
        # lockout now keys on the resolved account, so without this a visitor
        # typing the demo email could lock the shared account's bucket.
        user = resolve_login_user(identifier.strip(), request)
        return user is not None and user.get_username().strip().lower() == demo_username


class VisibanPasswordResetSerializer(PasswordResetSerializer):
    """Wires our custom password-reset form so the reset email link points at
    the frontend SPA rather than reversing the Django built-in URL name."""

    @property
    def password_reset_form_class(self):
        return VisibanPasswordResetForm


class VisibanPasswordResetConfirmSerializer(DjRestAuthPasswordResetConfirmSerializer):
    """Clears the per-account login lockout on a successful password reset (#1203).

    dj-rest-auth's stock ``PasswordResetConfirmSerializer.save()`` calls Django's
    plain ``SetPasswordForm.save()`` and nothing else — it never touches
    allauth's ``login_failed`` rate-limit bucket. Only allauth's own reset flow
    (``finalize_password_reset``) does that, and Visiban's reset-confirm
    endpoint never runs it (see ``accounts.adapter.clear_login_lockout`` for
    the full explanation, including why both the username and email keys are
    cleared). Without this override, a user locked out by 5 failed login
    attempts (#1199) who then successfully reset their password was still
    refused login — including with the brand-new, correct password — until the
    5-minute window expired on its own.

    ``self.user`` and ``self.context["request"]`` are both set by the base
    class's ``validate()`` (the user from the decoded ``uid``/``token``; the
    request via DRF's ``GenericAPIView.get_serializer`` context) before
    ``save()`` ever runs, so both are guaranteed present here.
    """

    def save(self):
        result = super().save()
        clear_login_lockout(self.context["request"], self.user)
        return result


class VisibanPasswordChangeSerializer(DjRestAuthPasswordChangeSerializer):
    """dj-rest-auth's password change, with the current password always verified (#1257).

    dj-rest-auth only checks ``old_password`` when its
    ``OLD_PASSWORD_FIELD_ENABLED`` setting is on; with the default (off) it pops
    the field and changes the password for any authenticated caller. That made
    ``POST /api/v1/auth/password/change/`` a way for anyone holding a session or
    a Personal Access Token to take over the account's password without knowing
    it — while ``/auth/change-password/`` has always required
    ``current_password``. The check is forced on here rather than left to the
    setting alone, so a future edit to ``REST_AUTH`` cannot silently reopen it.

    Making ``old_password`` required is a deliberate break of the "new body
    fields must be optional" API rule: the only client that omits it is one
    relying on the vulnerability. No Visiban client (SPA, docs examples) calls
    this endpoint; the SPA uses ``/auth/change-password/``.

    Social-only accounts (no usable password) are exempt, matching
    ``ChangePasswordView``: they have no current password to prove, and this is
    how they set their first one.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.old_password_field_enabled = True
        if "old_password" not in self.fields:
            self.fields["old_password"] = serializers.CharField(max_length=128)
        if self.user is not None and not self.user.has_usable_password():
            self.fields["old_password"].required = False
            self.fields["old_password"].allow_blank = True

    def validate_old_password(self, value):
        if self.user is not None and self.user.has_usable_password():
            if not self.user.check_password(value):
                raise serializers.ValidationError(
                    "Your old password was entered incorrectly. Please enter it again."
                )
        return value


class PublicUserSerializer(serializers.ModelSerializer):
    """Minimal user representation returned by the user-search endpoint.

    Intentionally omits email, notification preferences, and other private
    fields — the search endpoint is accessible to all authenticated users
    regardless of whether they share a board with the result.
    """

    avatar_url = AvatarUrlField(max_length=200, allow_blank=True, required=False)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        normalize_username_field_validators(self.fields["username"])

    class Meta:
        model = User
        fields = ["id", "username", "display_name", "avatar_url"]


class BoardUserSerializer(serializers.ModelSerializer):
    """Slim user representation for embedding in board resources.

    Exposes only the fields that are safe to share with all board members.
    UserSerializer (full shape) is reserved for /api/auth/me/ only.

    This keeps notification preferences, UI preferences, and the
    can_access_all_content privilege flag private — board members must not
    be able to read these fields for other users via the board API.
    """

    avatar_url = AvatarUrlField(max_length=200, allow_blank=True, required=False)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        normalize_username_field_validators(self.fields["username"])

    class Meta:
        model = User
        fields = ["id", "username", "display_name", "avatar_url"]


class UserSerializer(serializers.ModelSerializer):
    has_usable_password = serializers.SerializerMethodField()
    avatar_url = AvatarUrlField(max_length=200, allow_blank=True, required=False)
    email = EmailOrBlankField(max_length=254, allow_blank=True, required=False)
    # default_board_id is injected as a writable PrimaryKeyRelatedField in
    # __init__ rather than at class level to avoid a premature import of
    # boards.models during test collection (app registry may not be ready when
    # this module is first imported in some Django startup orderings).

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # The auto-generated `username` field carries the model's
        # UnicodeUsernameValidator, which both accepts astral-plane code
        # points (#1120) and, being a RegexValidator, gets its regex
        # surfaced verbatim as a JSON-Schema `pattern` that rejects the
        # Unicode usernames this app intentionally supports (breaks
        # backend-schema-fuzz on every endpoint embedding a user). Swap it
        # for UsernameFormatValidator rather than replacing the field, so
        # its other auto-derived behavior (max_length, uniqueness) is
        # untouched.
        normalize_username_field_validators(self.fields["username"])
        # After super().__init__ the fields BindingDict is built; we can now
        # replace the auto-generated read-only FK field with a writable one.
        from boards.models import Board  # deferred to avoid startup ordering issues
        # Scope to boards the requesting user is a member of to prevent IDOR —
        # without this a user could set any board PK as their default, confirming
        # existence of boards they have no access to.
        request = self.context.get("request")
        if request and request.user.is_authenticated:
            board_qs = Board.objects.filter(memberships__user=request.user)
        else:
            board_qs = Board.objects.none()
        self.fields["default_board_id"] = serializers.PrimaryKeyRelatedField(
            source="default_board",
            queryset=board_qs,
            allow_null=True,
            required=False,
        )

    def get_has_usable_password(self, obj) -> bool:
        return obj.has_usable_password()

    validate_email = staticmethod(validate_optional_email_format)

    def validate_username(self, value):
        """Case-insensitive uniqueness, the same rule as POST /auth/choose-username/ (#1273).

        The auto-generated UniqueValidator only checks an exact match, so on its
        own it let ``Alice`` through next to ``alice`` (then the
        ``unique_username_ci`` index turned the save into a 500).
        """
        exclude_pk = self.instance.pk if self.instance is not None else None
        if is_username_taken(value, exclude_pk=exclude_pk):
            raise serializers.ValidationError(USERNAME_TAKEN_MESSAGE)
        return value

    def update(self, instance, validated_data):
        """Apply a profile update, enforcing the username and email rules (#1273).

        - A changed username satisfies a pending ``must_change_username``, exactly
          as POST /auth/choose-username/ does: it has passed the same format and
          case-insensitive uniqueness checks.
        - A changed email under ``EMAIL_VERIFICATION=mandatory`` is not written to
          ``User.email``; it becomes a pending change confirmed by email (see
          accounts/email_change.py). Otherwise it is written directly, as before.
        """
        from django.db import IntegrityError, transaction

        from .email_change import email_verification_mandatory, request_email_change

        new_username = validated_data.get("username")
        if new_username is not None and new_username != instance.username:
            validated_data["must_change_username"] = False

        pending_email = None
        new_email = validated_data.get("email")
        if (
            new_email
            and new_email.lower() != (instance.email or "").lower()
            and email_verification_mandatory()
        ):
            pending_email = validated_data.pop("email")

        try:
            with transaction.atomic():
                instance = super().update(instance, validated_data)
        except IntegrityError:
            # unique_username_ci is the backstop for a concurrent rename racing
            # validate_username (same TOCTOU handling as ChooseUsernameView).
            if new_username is not None:
                raise serializers.ValidationError({"username": [USERNAME_TAKEN_MESSAGE]})
            raise

        if pending_email is not None:
            request_email_change(self.context.get("request"), instance, pending_email)
            instance.refresh_from_db(fields=["email"])
        return instance

    class Meta:
        model = User
        fields = [
            "id", "username", "email", "first_name", "last_name", "avatar_url",
            "display_name", "is_site_admin", "can_access_all_content",
            "must_change_password", "must_change_username", "has_usable_password",
            "timezone", "date_format", "time_format", "number_locale",
            "close_editor_on_enter",
            "has_completed_tour",
            "theme",
            "notif_card_assigned", "notif_mentioned", "notif_due_soon",
            "notif_card_moved", "notif_comment_added", "notif_board_invite",
            "notif_stale",
            # Email delivery opt-ins (#356). Additive and optional on PATCH, all
            # default False — see the User model for why an upgrade must not
            # start emailing anyone.
            "email_notif_card_assigned", "email_notif_mentioned",
            "email_notif_due_soon", "email_notif_card_moved",
            "default_board_id",
        ]
        read_only_fields = ["id", "is_site_admin", "can_access_all_content", "must_change_password", "must_change_username", "has_usable_password"]


class CurrentUserSerializer(UserSerializer):
    """Extends UserSerializer with site-wide settings for the /api/auth/me/ endpoint.

    Kept separate from UserSerializer because UserSerializer is embedded in
    board/card serializers for assignee, author, and member fields — calling
    get_uploads_enabled() there would issue a SiteSetting DB query on every
    board full response before the cache is warm.
    """

    uploads_enabled = serializers.SerializerMethodField()
    # Surfaces the Issue Board Lens experiment flag to the SPA so it can show or
    # hide the lens entry point. Read from settings (no DB hit), so it stays on
    # CurrentUserSerializer rather than the embedded UserSerializer.
    git_lens_enabled = serializers.SerializerMethodField()
    # Maintenance mode (#783). Lives here for the same reason uploads_enabled
    # does: the SPA bootstraps from GET /auth/user/, so this is where an
    # instance-wide flag reaches it without adding a SiteSetting read to every
    # embedded assignee/member object in a board payload.
    #
    # maintenance_message is always populated when maintenance_mode is True —
    # the built-in default is substituted server-side for a blank operator
    # message — so the client never has to carry a fallback string of its own
    # and the banner can never render empty.
    maintenance_mode = serializers.SerializerMethodField()
    maintenance_message = serializers.SerializerMethodField()
    # Hosted demo (#1179). Here for the same reason as maintenance_mode: the
    # SPA bootstraps from GET /auth/user/, so this is where the in-app demo bar
    # learns the mode and the next reset instant. Settings-only reads — no DB.
    # demo_next_reset_at is null unless DEMO_MODE is on.
    demo_mode = serializers.SerializerMethodField()
    demo_next_reset_at = serializers.SerializerMethodField()
    # #1273: an email change awaiting confirmation (EMAIL_VERIFICATION=mandatory),
    # or null. ``email`` keeps the current, verified value until the link is
    # followed, so this is how a client learns the PATCH was accepted but is not
    # yet in effect. Only on the current-user serializer: it costs a query, and
    # it is nobody else's business.
    pending_email = serializers.SerializerMethodField()

    def get_uploads_enabled(self, obj) -> bool:
        return get_uploads_enabled()

    def get_git_lens_enabled(self, obj) -> bool:
        from django.conf import settings

        return getattr(settings, "GIT_LENS_ENABLED", False)

    def _maintenance_state(self):
        """Read the cached state once per serialization, not once per field.

        Two SerializerMethodFields need the same tuple; without this they would
        each issue their own cache round trip for an identical answer.
        """
        if not hasattr(self, "_cached_maintenance_state"):
            self._cached_maintenance_state = get_maintenance_state()
        return self._cached_maintenance_state

    def get_maintenance_mode(self, obj) -> bool:
        active, _ = self._maintenance_state()
        return active

    def get_maintenance_message(self, obj) -> str:
        active, message = self._maintenance_state()
        return get_maintenance_message(message) if active else ""

    def get_demo_mode(self, obj) -> bool:
        from django.conf import settings

        return bool(getattr(settings, "DEMO_MODE", False))

    @extend_schema_field(serializers.DateTimeField(allow_null=True, read_only=True))
    def get_demo_next_reset_at(self, obj) -> str | None:
        from visiban.demo import demo_next_reset_at_iso

        return demo_next_reset_at_iso()

    @extend_schema_field(serializers.EmailField(allow_null=True, read_only=True))
    def get_pending_email(self, obj) -> str | None:
        from .email_change import get_pending_email

        return get_pending_email(obj)

    class Meta(UserSerializer.Meta):
        fields = UserSerializer.Meta.fields + [
            "uploads_enabled",
            "git_lens_enabled",
            "maintenance_mode",
            "maintenance_message",
            "demo_mode",
            "demo_next_reset_at",
            "pending_email",
        ]
        read_only_fields = UserSerializer.Meta.read_only_fields + [
            "uploads_enabled",
            "git_lens_enabled",
            "maintenance_mode",
            "maintenance_message",
            "demo_mode",
            "demo_next_reset_at",
            "pending_email",
        ]


class PersonalAccessTokenSerializer(serializers.ModelSerializer):
    class Meta:
        model = PersonalAccessToken
        fields = [
            "id",
            "name",
            "prefix",
            "created_at",
            "last_used_at",
            "expires_at",
            "scopes",
        ]
        read_only_fields = [
            "id",
            "name",
            "prefix",
            "created_at",
            "last_used_at",
            "expires_at",
            "scopes",
        ]


class PersonalAccessTokenCreateSerializer(serializers.Serializer):
    """Validate the scopes requested for a new personal access token.

    Validation lives here, not in the view, per the project's
    validate-at-the-boundary rule — `scopes` is the most security-sensitive
    input in the token flow and is the one field that must not be hand-parsed
    out of `request.data`. Shaped after `validate_allowed_priorities` in
    groups/serializers.py.

    The rest of the create payload (name, expires_at) is still parsed in the
    view; moving it here is tracked separately so this change stays scoped.
    """

    scopes = serializers.ListField(
        child=serializers.CharField(),
        required=False,
        allow_empty=False,
    )

    def validate_scopes(self, value):
        """Reject anything outside the known vocabulary.

        An unrecognised scope string is *ambiguous authority*: nothing can
        decide what it grants, so it must not be stored and silently ignored.
        Adding a scope later is a one-line edit to PAT_SCOPES, which is the
        right place for that decision to be visible.
        """
        unknown = sorted(set(value) - set(PAT_SCOPES))
        if unknown:
            raise serializers.ValidationError(
                f"Unknown scope(s): {', '.join(unknown)}. "
                f"Valid scopes are: {', '.join(PAT_SCOPES)}."
            )
        # Preserve the declared vocabulary order and drop duplicates so the
        # stored value is canonical and comparable.
        return [scope for scope in PAT_SCOPES if scope in set(value)]
