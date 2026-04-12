from dj_rest_auth.registration.serializers import RegisterSerializer
from dj_rest_auth.serializers import PasswordResetSerializer
from rest_framework import serializers

from .models import PersonalAccessToken, User, get_uploads_enabled
from .forms import VisibanPasswordResetForm


class RegistrationSerializer(RegisterSerializer):
    # allauth 65.x SIGNUP_FIELDS causes allauth_account_settings.USERNAME_REQUIRED
    # to return None rather than False. DRF normalises required=None to required=True
    # (Field.__init__: if required is None: required = default is empty and not read_only),
    # making username mandatory even when it is not a signup field. Override with an
    # explicit required=False so users can register with only email + passwords.
    username = serializers.CharField(
        max_length=150,
        required=False,
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

    class Meta:
        model = User
        fields = ["id", "username", "display_name", "avatar_url"]


class UserSerializer(serializers.ModelSerializer):
    has_usable_password = serializers.SerializerMethodField()
    # default_board_id is injected as a writable PrimaryKeyRelatedField in
    # __init__ rather than at class level to avoid a premature import of
    # boards.models during test collection (app registry may not be ready when
    # this module is first imported in some Django startup orderings).

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
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

    def get_has_usable_password(self, obj):
        return obj.has_usable_password()

    class Meta:
        model = User
        fields = [
            "id", "username", "email", "first_name", "last_name", "avatar_url",
            "display_name", "is_site_admin", "can_access_all_content",
            "must_change_password", "must_change_username", "has_usable_password",
            "timezone", "date_format", "time_format", "number_locale",
            "close_editor_on_enter",
            "has_completed_tour",
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

    def get_uploads_enabled(self, obj):
        return get_uploads_enabled()

    class Meta(UserSerializer.Meta):
        fields = UserSerializer.Meta.fields + ["uploads_enabled"]
        read_only_fields = UserSerializer.Meta.read_only_fields + ["uploads_enabled"]


class PersonalAccessTokenSerializer(serializers.ModelSerializer):
    class Meta:
        model = PersonalAccessToken
        fields = ["id", "name", "prefix", "created_at", "last_used_at", "expires_at"]
        read_only_fields = ["id", "name", "prefix", "created_at", "last_used_at", "expires_at"]
