from rest_framework import serializers
from .models import User


class UserSerializer(serializers.ModelSerializer):
    has_usable_password = serializers.SerializerMethodField()

    def get_has_usable_password(self, obj):
        return obj.has_usable_password()

    class Meta:
        model = User
        fields = ["id", "username", "email", "first_name", "last_name", "avatar_url", "display_name", "is_site_admin", "must_change_password", "has_usable_password", "timezone", "date_format", "time_format", "number_locale", "notif_card_assigned", "notif_mentioned", "notif_due_soon", "notif_card_moved", "notif_comment_added"]
        read_only_fields = ["id", "is_site_admin", "must_change_password", "has_usable_password"]
