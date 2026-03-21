from dj_rest_auth.registration.serializers import RegisterSerializer
from rest_framework import serializers

from .models import User


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


class PublicUserSerializer(serializers.ModelSerializer):
    """Minimal user representation returned by the user-search endpoint.

    Intentionally omits email, notification preferences, and other private
    fields — the search endpoint is accessible to all authenticated users
    regardless of whether they share a board with the result.
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
            "display_name", "is_site_admin", "must_change_password", "has_usable_password",
            "timezone", "date_format", "time_format", "number_locale",
            "close_editor_on_enter",
            "notif_card_assigned", "notif_mentioned", "notif_due_soon",
            "notif_card_moved", "notif_comment_added",
            "default_board_id",
        ]
        read_only_fields = ["id", "is_site_admin", "must_change_password", "has_usable_password"]
