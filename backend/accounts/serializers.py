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


class UserSerializer(serializers.ModelSerializer):
    has_usable_password = serializers.SerializerMethodField()

    def get_has_usable_password(self, obj):
        return obj.has_usable_password()

    class Meta:
        model = User
        fields = ["id", "username", "email", "first_name", "last_name", "avatar_url", "display_name", "is_site_admin", "must_change_password", "has_usable_password", "timezone", "date_format", "time_format", "number_locale", "close_editor_on_enter", "notif_card_assigned", "notif_mentioned", "notif_due_soon", "notif_card_moved", "notif_comment_added"]
        read_only_fields = ["id", "is_site_admin", "must_change_password", "has_usable_password"]
