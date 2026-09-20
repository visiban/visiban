from dj_rest_auth.registration.serializers import RegisterSerializer
from dj_rest_auth.serializers import PasswordResetSerializer
from django.core.validators import EmailValidator
from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from .models import (
    PAT_SCOPES,
    PersonalAccessToken,
    User,
    get_maintenance_message,
    get_maintenance_state,
    get_uploads_enabled,
)
from .forms import VisibanPasswordResetForm
from .validators import UsernameFormatValidator


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


class VisibanPasswordResetSerializer(PasswordResetSerializer):
    """Wires our custom password-reset form so the reset email link points at
    the frontend SPA rather than reversing the Django built-in URL name."""

    @property
    def password_reset_form_class(self):
        return VisibanPasswordResetForm


class PublicUserSerializer(serializers.ModelSerializer):
    """Minimal user representation returned by the user-search endpoint.

    Intentionally omits email, notification preferences, and other private
    fields — the search endpoint is accessible to all authenticated users
    regardless of whether they share a board with the result.
    """

    avatar_url = AvatarUrlField(max_length=200, allow_blank=True, required=False)

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
        # The auto-generated `username` field already carries the model's
        # UnicodeUsernameValidator, which accepts astral-plane code points
        # (#1120) — append the extra BMP restriction rather than replacing
        # the field, so its other auto-derived behavior (max_length,
        # uniqueness) is untouched.
        self.fields["username"].validators.append(UsernameFormatValidator())
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

    class Meta(UserSerializer.Meta):
        fields = UserSerializer.Meta.fields + [
            "uploads_enabled",
            "git_lens_enabled",
            "maintenance_mode",
            "maintenance_message",
        ]
        read_only_fields = UserSerializer.Meta.read_only_fields + [
            "uploads_enabled",
            "git_lens_enabled",
            "maintenance_mode",
            "maintenance_message",
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
